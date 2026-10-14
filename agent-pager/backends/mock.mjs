// Fake agents for exercising the badge without a real agent host.

const TITLES = [
  ["Fix flaky checkout test", "shop-web"],
  ["Add dark mode to settings", "shop-web"],
  ["Migrate users table to UUIDs", "accounts-api"],
  ["Write release notes for v2.4", "docs"],
];

const COMMANDS = [
  ["Bash", "pnpm db:migrate --env staging"],
  ["Bash", "rm -rf node_modules/.cache && pnpm build"],
  ["Edit", "src/settings/theme.ts"],
  ["WebFetch", "https://api.github.com/repos/acme/shop-web/pulls"],
];

export function createMockBackend() {
  let nextId = 1;
  const threads = TITLES.map(([title, project], i) => ({
    id: `thread-${i + 1}`,
    title,
    project,
    status: i === 3 ? "done" : "running",
    activity: i === 3 ? "Finished: release notes drafted" : "Reading files",
    updatedAt: Date.now(),
  }));
  const pending = [];

  const tick = () => {
    const running = threads.filter((t) => t.status === "running");
    if (running.length === 0) return;
    const thread = running[Math.floor(Math.random() * running.length)];
    if (Math.random() < 0.35 && !pending.some((p) => p.thread === thread.id)) {
      const [tool, detail] = COMMANDS[Math.floor(Math.random() * COMMANDS.length)];
      pending.push({ id: `req-${nextId++}`, thread: thread.id, kind: "approval", tool, detail });
      thread.status = "waiting";
      thread.activity = `Waiting for approval: ${tool}`;
    } else if (Math.random() < 0.15) {
      pending.push({
        id: `req-${nextId++}`,
        thread: thread.id,
        kind: "question",
        question: "Which database should the migration target first?",
        options: ["staging", "production", "both, staging first"],
      });
      thread.status = "waiting";
      thread.activity = "Asked you a question";
    } else {
      thread.activity = ["Running tests", "Editing files", "Reading the diff"][Math.floor(Math.random() * 3)];
    }
    thread.updatedAt = Date.now();
  };
  const timer = setInterval(tick, 8000);
  timer.unref();

  const settle = (request, outcome) => {
    pending.splice(pending.indexOf(request), 1);
    const thread = threads.find((t) => t.id === request.thread);
    if (thread) {
      thread.status = "running";
      thread.activity = outcome;
      thread.updatedAt = Date.now();
    }
  };

  return {
    name: "mock",
    async snapshot() {
      return {
        threads: threads.map((t) => ({ ...t })),
        pending: pending.map((p) => ({
          ...p,
          title: threads.find((t) => t.id === p.thread)?.title ?? "",
        })),
      };
    },
    async act(action) {
      const request = pending.find((p) => p.id === action.id);
      const thread = threads.find((t) => t.id === action.thread);
      switch (action.type) {
        case "respond":
          if (!request) throw new Error("Request is gone");
          settle(request, action.decision === "allow" ? `Approved ${request.tool}` : `Denied ${request.tool}`);
          return action.decision === "allow" ? "Allowed" : "Denied";
        case "answer":
          if (!request) throw new Error("Request is gone");
          settle(request, `You chose: ${request.options[action.option]}`);
          return "Answered";
        case "interrupt":
          if (!thread) throw new Error("Unknown thread");
          thread.status = "idle";
          thread.activity = "Interrupted from badge";
          return "Interrupted";
        case "interrupt_all":
          for (const t of threads) if (t.status === "running" || t.status === "waiting") t.status = "idle";
          pending.length = 0;
          return "Stopped all agents";
        case "prompt":
          if (!thread) throw new Error("Unknown thread");
          thread.status = "running";
          thread.activity = `You said: ${action.text}`;
          return "Sent";
        default:
          throw new Error(`Unknown action ${action.type}`);
      }
    },
  };
}
