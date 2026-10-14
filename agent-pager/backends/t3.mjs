// Agent Pager backend for T3 Code.
//
// Thread status arrives by push from `orchestration.subscribeShell`. When a
// thread is busy or waiting, the bridge fetches its recent timeline over HTTP
// to describe the current step and any pending approval or question. Actions
// go through `orchestration.dispatchCommand`, the same as the T3 apps.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { T3Rpc } from "./t3-rpc.mjs";

const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const FINISHED_RUN = new Set(["completed", "interrupted", "cancelled", "rolled_back"]);
const DETAIL_REFRESH_MS = 3000;
const DETAIL_TIMEOUT_MS = 2500;
const RECENT_DONE_MS = 15 * 60_000;

const REQUEST_LABELS = {
  command: "Run command",
  "file-read": "Read files",
  "file-change": "Change files",
  permission: "Permission",
  "mcp-elicitation": "MCP request",
};

async function discoverOrigin(config) {
  if (process.env.T3_ORIGIN) return process.env.T3_ORIGIN;
  if (config.t3.origin) return config.t3.origin;
  const home = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
  try {
    const runtime = JSON.parse(await readFile(join(home, "userdata", "server-runtime.json"), "utf8"));
    if (runtime.origin) return runtime.origin;
  } catch {}
  return "http://127.0.0.1:3773";
}

export async function createT3Backend(config) {
  const token = process.env.T3_TOKEN ?? config.t3.token;
  if (!token) {
    throw new Error(
      `No T3 token. Run: t3 auth session issue --scope orchestration:read --scope orchestration:operate ` +
        `--label agent-pager --ttl 90d --token-only, then put it in ${config.path} under "t3": {"token": ...}`,
    );
  }
  const origin = await discoverOrigin(config);
  const rpc = new T3Rpc({ origin, token });
  const maxIdleMs = (config.t3.maxIdleHours ?? 24) * 3_600_000;

  const projects = new Map();
  const threads = new Map();
  const details = new Map(); // threadId -> { updatedAt, fetchedAt, activity, approvals, questions }
  const answers = new Map(); // requestId -> { questionId: value }

  rpc.subscribe("orchestration.subscribeShell", {}, (item) => {
    switch (item.kind) {
      case "snapshot": {
        for (const project of item.snapshot.projects) projects.set(project.id, project);
        // Project-metadata refreshes arrive as snapshots with no threads.
        const metadataOnly =
          item.resolvedRepositoryIdentityRoots !== undefined &&
          item.snapshot.threads.length === 0 &&
          item.snapshot.archivedThreads.length === 0;
        if (!metadataOnly) {
          threads.clear();
          for (const thread of item.snapshot.threads) threads.set(thread.id, thread);
        }
        break;
      }
      case "thread.updated":
        if (item.location === "active" && !item.thread.deletedAt) threads.set(item.thread.id, item.thread);
        else threads.delete(item.thread.id);
        break;
      case "thread.removed":
        threads.delete(item.threadId ?? item.thread?.id);
        break;
      case "project.updated":
        projects.set(item.project.id, item.project);
        break;
      case "project.removed":
        projects.delete(item.projectId ?? item.project?.id);
        break;
    }
  });
  rpc.start();

  const dispatch = (command) => rpc.request("orchestration.dispatchCommand", { commandId: randomUUID(), ...command });

  const badgeStatus = (thread) => {
    const pending = thread.pendingRuntimeRequest;
    if (pending && pending.kind !== "auth_refresh") return "waiting";
    if (ACTIVE_RUN.has(thread.status)) return "running";
    if (thread.status === "failed") return "error";
    if (FINISHED_RUN.has(thread.status)) return "done";
    const completed = Date.parse(thread.latestRunCompletedAt ?? "");
    return Date.now() - completed < RECENT_DONE_MS ? "done" : "idle";
  };

  const needsDetail = (thread) => badgeStatus(thread) === "running" || badgeStatus(thread) === "waiting";

  async function refreshDetail(thread) {
    const cached = details.get(thread.id);
    if (cached && (cached.updatedAt === thread.updatedAt || Date.now() - cached.fetchedAt < DETAIL_REFRESH_MS)) {
      return;
    }
    const snapshot = await rpc.getJson(`/api/orchestration/threads/${encodeURIComponent(thread.id)}/bounded`);
    details.set(thread.id, { updatedAt: thread.updatedAt, fetchedAt: Date.now(), ...describe(snapshot.projection) });
  }

  return {
    name: "t3",

    async snapshot() {
      if (!rpc.connected && threads.size === 0) throw new Error("Connecting to T3 Code...");
      const now = Date.now();
      const visible = [...threads.values()].filter(
        (t) => !t.archivedAt && (needsDetail(t) || now - Date.parse(t.updatedAt) < maxIdleMs),
      );

      // Fetch details for busy threads in parallel, but never hold the badge up for long.
      const busy = visible.filter(needsDetail).slice(0, 6);
      await Promise.race([
        Promise.allSettled(busy.map(refreshDetail)),
        new Promise((r) => setTimeout(r, DETAIL_TIMEOUT_MS)),
      ]);
      for (const id of details.keys()) if (!busy.some((t) => t.id === id)) details.delete(id);

      const pending = [];
      const rows = visible.map((thread) => {
        const status = badgeStatus(thread);
        const detail = details.get(thread.id);
        const project = projects.get(thread.projectId);
        for (const approval of detail?.approvals ?? []) {
          pending.push({ ...approval, thread: thread.id, title: thread.title });
        }
        for (const question of detail?.questions ?? []) {
          if (answers.get(question.requestId)?.[question.questionId] !== undefined) continue;
          pending.push({ ...question, thread: thread.id, title: thread.title });
        }
        return {
          id: thread.id,
          title: thread.title,
          project: project?.title ?? "",
          status,
          activity:
            (status === "error" && thread.lastError) ||
            detail?.activity ||
            thread.latestVisibleMessage?.text ||
            "",
          updatedAt: Date.parse(thread.updatedAt),
        };
      });
      return { threads: rows, pending };
    },

    async act(action) {
      const thread = threads.get(action.thread);
      switch (action.type) {
        case "respond": {
          const approval = findPending(action.id);
          if (!approval) throw new Error("Request already handled");
          await dispatch({
            type: "runtime-request.respond",
            threadId: approval.thread,
            requestId: approval.requestId,
            decision: action.decision === "allow" ? "accept" : "decline",
          });
          details.delete(approval.thread);
          return action.decision === "allow" ? "Allowed" : "Denied";
        }
        case "answer": {
          const question = findPending(action.id);
          if (!question) throw new Error("Question already handled");
          const option = question.optionValues[action.option];
          if (option === undefined) throw new Error("Pick an option");
          const collected = { ...answers.get(question.requestId), [question.questionId]: question.multiSelect ? [option] : option };
          const all = details.get(question.thread)?.questions.filter((q) => q.requestId === question.requestId) ?? [];
          if (all.some((q) => collected[q.questionId] === undefined)) {
            answers.set(question.requestId, collected);
            return "Next question";
          }
          answers.delete(question.requestId);
          await dispatch({
            type: "runtime-request.respond",
            threadId: question.thread,
            requestId: question.requestId,
            answers: collected,
          });
          details.delete(question.thread);
          return "Answered";
        }
        case "interrupt": {
          if (!thread) throw new Error("Unknown thread");
          if (!thread.activeRunId) throw new Error("Not running");
          await interrupt(thread);
          return "Interrupted";
        }
        case "interrupt_all": {
          const active = [...threads.values()].filter((t) => t.activeRunId);
          const results = await Promise.allSettled(active.map(interrupt));
          const stopped = results.filter((r) => r.status === "fulfilled").length;
          return `Stopped ${stopped} agent${stopped === 1 ? "" : "s"}`;
        }
        case "prompt": {
          if (!thread) throw new Error("Unknown thread");
          await dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            threadId: thread.id,
            messageId: randomUUID(),
            text: String(action.text ?? "").slice(0, 2000),
            attachments: [],
            deliveryIntent: "auto",
            dispatchMode: { type: "start_immediately" },
          });
          return "Sent";
        }
        default:
          throw new Error(`Unknown action ${action.type}`);
      }
    },

    close() {
      rpc.close();
    },
  };

  function interrupt(thread) {
    return dispatch({
      type: "run.interrupt",
      threadId: thread.id,
      runId: thread.activeRunId,
      reason: "Stopped from Agent Pager",
      holdQueue: true,
    });
  }

  function findPending(id) {
    for (const [threadId, detail] of details) {
      for (const item of [...detail.approvals, ...detail.questions]) {
        if (item.id === id) return { ...item, thread: threadId };
      }
    }
    return null;
  }
}

// Mirrors derivePendingThreadRequests in T3's client-runtime: join pending
// runtime requests to the timeline items that carry their display data.
export function describe(projection) {
  const items = projection.turnItems ?? [];
  const approvals = [];
  const questions = [];
  for (const request of projection.runtimeRequests ?? []) {
    if (request.status !== "pending") continue;
    if (request.kind === "user_input") {
      const item = items.findLast((i) => i.type === "user_input_request" && i.requestId === request.id);
      for (const question of item?.questions ?? []) {
        questions.push({
          id: `${request.id}::${question.id}`,
          kind: "question",
          requestId: request.id,
          questionId: question.id,
          question: question.header ? `${question.header}: ${question.question}` : question.question,
          options: question.options.map((o) => o.label),
          optionValues: question.options.map((o) => o.value ?? o.label),
          multiSelect: Boolean(question.multiSelect),
        });
      }
      continue;
    }
    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const item = items.findLast((i) => i.type === "approval_request" && i.requestId === request.id);
    const target = approvalTarget(items, item);
    const lines = [item?.prompt, target && !target.endsWith(`/${item?.prompt}`) ? target : undefined].filter(Boolean);
    approvals.push({
      id: request.id,
      kind: "approval",
      requestId: request.id,
      tool: item?.appName ?? REQUEST_LABELS[request.kind] ?? request.kind,
      detail: lines.join("\n"),
    });
  }
  return { activity: currentStep(items), approvals, questions };
}

// The approval item only carries a short description. The command or file it
// gates is the tool item with the same native tool-call ID.
function approvalTarget(items, approval) {
  const nativeId = approval?.nativeItemRef?.nativeId;
  if (!nativeId) return undefined;
  const tool = items.findLast((i) => i !== approval && i.nativeItemRef?.nativeId === nativeId);
  if (tool?.type === "command_execution") return `$ ${tool.input}`;
  if (tool?.type === "file_change") return shortPath(tool.fileName);
  return undefined;
}

function shortPath(path) {
  const parts = String(path).split("/").filter(Boolean);
  return parts.length > 2 ? `../${parts.slice(-2).join("/")}` : path;
}

function currentStep(items) {
  const item = items.findLast((i) => i.status === "running" || i.status === "pending") ?? items.at(-1);
  if (!item) return "";
  switch (item.type) {
    case "command_execution":
      return `$ ${item.input}`;
    case "file_change":
      return `Editing ${shortPath(item.fileName)}`;
    case "reasoning":
      return "Thinking";
    case "assistant_message":
      return item.text ?? item.title ?? "Writing a reply";
    case "web_search":
      return `Searching the web${item.patterns?.length ? `: ${item.patterns[0]}` : ""}`;
    case "file_search":
      return `Searching files${item.pattern ? `: ${item.pattern}` : ""}`;
    case "todo_list": {
      const step = item.steps.find((s) => s.status === "in_progress") ?? item.steps.at(-1);
      return step ? `Plan: ${step.step ?? step.title ?? ""}` : "Planning";
    }
    case "approval_request":
      return `Waiting for approval: ${item.prompt ?? item.requestKind}`;
    case "user_input_request":
      return "Asked you a question";
    default:
      return item.title ?? item.type.replace(/_/g, " ");
  }
}
