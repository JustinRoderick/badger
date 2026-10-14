import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_PATH = process.env.PAGER_CONFIG ?? join(homedir(), ".config", "agent-pager", "config.json");

const DEFAULT_PROMPTS = [
  "Continue",
  "Run the tests and fix any failures",
  "Summarize what you changed so far",
  "Review your diff for bugs",
  "Commit your work",
  "Stop and wait for me",
];

// Settings come from env vars first, then ~/.config/agent-pager/config.json.
// The first run writes that file with a fresh random token for the badge.
export async function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (!file.token && !process.env.PAGER_TOKEN) {
    file.token = randomBytes(18).toString("base64url");
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    console.log(`Created ${CONFIG_PATH} with a new badge token.`);
  }

  return {
    path: CONFIG_PATH,
    backend: process.env.PAGER_BACKEND ?? file.backend ?? "t3",
    host: process.env.PAGER_HOST ?? file.host ?? "0.0.0.0",
    port: Number(process.env.PAGER_PORT ?? file.port ?? 8787),
    token: process.env.PAGER_TOKEN ?? file.token,
    prompts: file.prompts ?? DEFAULT_PROMPTS,
    t3: { ...file.t3 },
  };
}
