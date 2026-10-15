/**
 * `npm start [config]`: one kind of ACP agent as a Chips harness, run as a daemon. It joins Chips
 * once — with a link a person made in Chips (`CHIPS_JOIN_LINK`), or with a code a person allows —
 * and keeps its key under the kind's name; then it connects, runs the agent, and answers for
 * every agent of the kind Chips makes, until it is stopped. A second kind is a second config, run
 * beside it.
 *
 * The config is JSON:
 * `{ "name": "Claude Code", "command": ["claude-agent-acp"], "mode": "default", "folders": "~/chips-acp/claude-code" }`,
 * `~/.chips-acp/config.json` unless a path is given. What it keeps is in a folder beside it, named
 * after it (`~/.chips-acp/claude-code/` for `claude-code.json`): the SDK's state (cursor,
 * unanswered events, runs not ended), and its agents and which session each of their rooms is.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { connect, fileStore, join as joinChips } from "@chips/harness";
import { processWire } from "./acp.js";
import { Bridge, type BridgeState, type KindConfig } from "./bridge.js";

const home = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

function readConfig(path: string): KindConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const name = raw["name"];
  const command = raw["command"];
  if (typeof name !== "string" || name.trim() === "" || !Array.isArray(command) || command.length === 0) {
    throw new Error(`${path} names a kind of agent and how to run it: { "name", "command", "folders" }`);
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    name,
    command: command.map(String),
    folders: resolve(home(typeof raw["folders"] === "string" ? raw["folders"] : `~/chips-acp/${slug}`)),
    ...(typeof raw["folder"] === "string" ? { folder: resolve(home(raw["folder"])) } : {}),
    ...(typeof raw["mode"] === "string" ? { mode: raw["mode"] } : {}),
    ...(typeof raw["env"] === "object" && raw["env"] !== null ? { env: raw["env"] as Record<string, string> } : {}),
  };
}

const configPath = resolve(home(process.argv[2] ?? "~/.chips-acp/config.json"));
const kind = readConfig(configPath);
const folder = join(dirname(configPath), basename(configPath, ".json"));
const statePath = join(folder, "state.json");
const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

mkdirSync(folder, { recursive: true, mode: 0o700 });
mkdirSync(kind.folder ?? kind.folders, { recursive: true });

const joined = await joinChips({
  link: process.env["CHIPS_JOIN_LINK"],
  url: process.env["CHIPS_URL"],
  name: kind.name,
  software: "chips-acp 0.2.0",
  wants: ["agents", "new_spaces", "new_agents", "forks", "restarts"],
  onCode: (code) => log(`Allow this harness in Chips: ${code}`),
});

const kept = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Partial<BridgeState>) : {};
const state: BridgeState = { sessions: kept.sessions ?? {}, agents: kept.agents ?? {} };

let bridge: Bridge | undefined;
const chips = await connect({
  url: joined.url,
  token: joined.token,
  client: { name: "chips-acp", version: "0.2.0" },
  store: fileStore(join(folder, "chips-state.json")),
  onRestart: async () => {
    log("a person asked for a restart");
    await bridge?.restart();
  },
});

bridge = new Bridge({
  chips,
  kind,
  state,
  saveState: (next) => writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }),
  wire: () =>
    processWire(kind.command, kind.folder ?? kind.folders, { ...process.env, ...kind.env }, (line) =>
      log(`${kind.name}: ${line}`),
    ),
  log,
});
await bridge.start();
log(`connected as ${chips.harnessId} (${kind.name}), ${Object.keys(state.agents).length} agent(s)`);

const stop = () => {
  bridge?.stop();
  chips.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
