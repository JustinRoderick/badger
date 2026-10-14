#!/usr/bin/env node
// Agent Pager bridge: a tiny HTTP server the badge polls.
//
//   GET  /badge/state   -> { server, threads[], pending[], prompts[] }
//   POST /badge/action  -> { ok, message }
//
// Backends adapt an agent host (T3 Code, a mock, ...) to that shape. The
// bridge trims everything so responses stay small enough for the badge's RAM.

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config.mjs";

const config = await loadConfig();
const backend = await (async () => {
  switch (config.backend) {
    case "mock":
      return (await import("./backends/mock.mjs")).createMockBackend(config);
    case "t3":
      return (await import("./backends/t3.mjs")).createT3Backend(config);
    default:
      throw new Error(`Unknown backend "${config.backend}" (expected t3 or mock)`);
  }
})();

const LIMITS = { threads: 16, title: 60, project: 32, activity: 220, detail: 360, question: 200, option: 48 };
const STATUS_ORDER = { waiting: 0, running: 1, error: 2, done: 3, idle: 4 };

// Collapses whitespace but keeps line breaks, which the badge wraps on.
const trim = (value, max) => {
  const text = String(value ?? "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
  return text.length > max ? `${text.slice(0, max - 2)}..` : text;
};

// Agent hosts use long IDs (T3 request IDs run to ~300 chars). The badge gets
// short stable aliases instead, and actions are translated back.
const aliases = new Map();
const alias = (id) => {
  if (id === undefined || id === null) return id;
  const short = createHash("sha1").update(String(id)).digest("base64url").slice(0, 10);
  aliases.set(short, id);
  return short;
};
const unalias = (short) => aliases.get(short) ?? short;

const age = (timestamp) => {
  if (!timestamp) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
};

async function badgeState() {
  const { threads, pending } = await backend.snapshot();
  const sorted = [...threads].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
  return {
    server: backend.name,
    threads: sorted.slice(0, LIMITS.threads).map((t) => ({
      id: alias(t.id),
      title: trim(t.title, LIMITS.title),
      project: trim(t.project, LIMITS.project),
      status: t.status,
      activity: trim(t.activity, LIMITS.activity),
      age: age(t.updatedAt),
    })),
    pending: pending.map((p) => ({
      id: alias(p.id),
      thread: alias(p.thread),
      kind: p.kind,
      title: trim(p.title, LIMITS.title),
      tool: trim(p.tool, LIMITS.title),
      detail: trim(p.detail, LIMITS.detail),
      question: trim(p.question, LIMITS.question),
      options: (p.options ?? []).map((o) => trim(o, LIMITS.option)),
    })),
    prompts: config.prompts,
  };
}

const authorized = (req) => {
  const given = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${config.token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const send = (res, status, body) => {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 16_384) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://badge").pathname;
  if (path === "/healthz") return send(res, 200, { ok: true, backend: backend.name });
  if (!authorized(req)) return send(res, 401, { error: "Bad token" });
  try {
    if (req.method === "GET" && path === "/badge/state") {
      return send(res, 200, await badgeState());
    }
    if (req.method === "POST" && path === "/badge/action") {
      const action = await readJson(req);
      console.log(`[action] ${JSON.stringify(action)}`);
      const message = await backend.act({ ...action, id: unalias(action.id), thread: unalias(action.thread) });
      return send(res, 200, { ok: true, message });
    }
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(`[error] ${req.method} ${path}:`, error);
    return send(res, 500, { error: trim(error.message, 60) });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Agent Pager bridge (${backend.name}) on http://${config.host}:${config.port}`);
  console.log(`Badge secrets.py:  PAGER_URL = "http://<this-machine-ip>:${config.port}"`);
});

const shutdown = async () => {
  server.close();
  await backend.close?.();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
