/**
 * `npm start [config]`: the bridge as a daemon. It joins Chips once — with a link a person made in
 * Chips (`CHIPS_JOIN_LINK`), or with a code a person allows — and keeps its key; then it connects,
 * registers its agents, runs them, and answers for them until it is stopped.
 *
 * The config is JSON: `{ "agents": [{ "name": "Goose", "command": ["goose", "acp"], "cwd": "~/work" }] }`,
 * `~/.chips-acp/config.json` unless a path is given. What it keeps is beside it: the SDK's state
 * (cursor, unanswered events, runs not ended) and which session each room is.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connect, fileStore, join as joinChips } from "@chips/harness";
import { processWire } from "./acp.js";
import { type AgentConfig, Bridge, type BridgeState } from "./bridge.js";

interface Config {
  readonly name?: string;
  readonly agents: readonly AgentConfig[];
}

const home = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

function readConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; agents?: unknown };
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new Error(`${path} names no agents: { "agents": [{ "name", "command", "cwd" }] }`);
  }
  const agents = (raw.agents as Record<string, unknown>[]).map((agent) => {
    if (typeof agent["name"] !== "string" || !Array.isArray(agent["command"])) {
      throw new Error(`each agent in ${path} has a name and a command`);
    }
    return {
      name: agent["name"],
      command: (agent["command"] as unknown[]).map(String),
      cwd: resolve(home(typeof agent["cwd"] === "string" ? agent["cwd"] : "~/chips-acp/work")),
      ...(typeof agent["mode"] === "string" ? { mode: agent["mode"] } : {}),
      ...(typeof agent["env"] === "object" && agent["env"] !== null
        ? { env: agent["env"] as Record<string, string> }
        : {}),
    };
  });
  return { ...(typeof raw.name === "string" ? { name: raw.name } : {}), agents };
}

const configPath = resolve(home(process.argv[2] ?? "~/.chips-acp/config.json"));
const config = readConfig(configPath);
const folder = dirname(configPath);
const statePath = join(folder, "sessions.json");
const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

for (const agent of config.agents) mkdirSync(agent.cwd, { recursive: true });

const joined = await joinChips({
  link: process.env["CHIPS_JOIN_LINK"],
  url: process.env["CHIPS_URL"],
  name: config.name ?? "ACP agents",
  software: "chips-acp 0.1.0",
  wants: ["agents", "restarts"],
  onCode: (code) => log(`Allow this harness in Chips: ${code}`),
});

const state: BridgeState = existsSync(statePath)
  ? (JSON.parse(readFileSync(statePath, "utf8")) as BridgeState)
  : { sessions: {} };

let bridge: Bridge | undefined;
const chips = await connect({
  url: joined.url,
  token: joined.token,
  client: { name: "chips-acp", version: "0.1.0" },
  store: fileStore(join(folder, "chips-state.json")),
  onRestart: async () => {
    log("a person asked for a restart");
    await bridge?.restart();
  },
});

bridge = new Bridge({
  chips,
  agents: config.agents,
  home: joined.spaceId,
  state,
  saveState: (next) => writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }),
  wireFor: (agent) =>
    processWire(agent.command, agent.cwd, { ...process.env, ...agent.env }, (line) =>
      log(`${agent.name}: ${line}`),
    ),
  log,
});
await bridge.start();
log(`connected as ${chips.harnessId}, ${config.agents.length} agent(s)`);

const stop = () => {
  bridge?.stop();
  chips.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
