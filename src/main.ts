/**
 * `npm start [config]`: one kind of ACP agent as a Chips harness, run as a daemon. It joins Chips
 * once — with a link a person made in Chips (`CHIPS_JOIN_LINK`), or with a code a person allows —
 * and keeps its key under the kind's name; then it connects, runs the agent, and answers for
 * every agent of the kind Chips makes, until it is stopped. A second kind is a second config, run
 * beside it.
 *
 * The config is JSON (Claude Code's and Codex's need none: `claude-code.json` and `codex.json` are theirs):
 * `{ "name": "Claude Code", "command": ["claude-agent-acp"], "mode": "default", "folders": "~/chips-acp/claude-code" }`,
 * `~/.chips-acp/config.json` unless a path is given. What it keeps is in a folder beside it, named
 * after it (`~/.chips-acp/claude-code/` for `claude-code.json`): the SDK's state (cursor,
 * unanswered events, runs not ended), and its agents and which session each of their rooms is.
 *
 * `npm run keep [config]` is the same, then keeps the bridge running from login (`keep.ts`), as
 * the launch agent `chat.chips.acp.<config's name>`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { connect, fileStore, helloOnce, JoinError, join as joinChips } from "@chipschat/harness";
import { processWire } from "./acp.js";
import { Bridge, type BridgeState, type KindConfig } from "./bridge.js";
import { keepIfAsked, stopIfAsked, words } from "./keep.js";
import { checkCommand, checkSignIn, readConfig, SetupError } from "./setup.js";

const home = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
const link = process.env["CHIPS_JOIN_LINK"] || undefined;

const configPath = resolve(home(words[0] ?? "~/.chips-acp/config.json"));
const LABEL = `chat.chips.acp.${basename(configPath, ".json")}`;
stopIfAsked(LABEL);
// What it needs, checked before a link is taken up, which works once.
let kind: KindConfig;
const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
try {
  kind = readConfig(configPath);
  mkdirSync(kind.folder ?? kind.folders, { recursive: true });
  if (link !== undefined) {
    checkCommand(kind);
    log(`checking that ${kind.name} starts and is signed in`);
    const cwd = kind.folder ?? kind.folders;
    const stderr: string[] = [];
    const wire = processWire(kind.command, cwd, { ...process.env, ...kind.env }, (line) => stderr.push(line));
    await checkSignIn(kind, wire, cwd, { stderr: () => stderr });
  }
} catch (error) {
  if (!(error instanceof SetupError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
const folder = join(dirname(configPath), basename(configPath, ".json"));
const statePath = join(folder, "state.json");

mkdirSync(folder, { recursive: true, mode: 0o700 });

/** A link Chips refuses (spent, expired, not a link), said plainly: its words, no stack. */
const refused = (error: unknown): never => {
  if (!(error instanceof JoinError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
};
const joined = await joinChips({
  link,
  url: process.env["CHIPS_URL"],
  name: kind.name,
  software: "chips-acp 1.0.0",
  wants: ["agents", "new_spaces", "new_agents", "forks", "restarts"],
  onCode: (code) => log(`Allow this harness in Chips: ${code}`),
}).catch(refused);
// Joined, `npm run keep` hands over to a copy kept running, which says the hello. What signs its
// agent in, where it is set, goes with it.
keepIfAsked(LABEL, joined.url, ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_HOME", "CLAUDE_CONFIG_DIR"], log);

const kept = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Partial<BridgeState>) : {};
const state: BridgeState = { sessions: kept.sessions ?? {}, agents: kept.agents ?? {} };

let bridge: Bridge | undefined;
const chips = await connect({
  url: joined.url,
  token: joined.token,
  client: { name: "chips-acp", version: "1.0.0" },
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

// Its first words in the room it joined, once: the card that followed its link waits for them. A
// kind has no agent of its own until Chips makes one, so the harness says them.
await helloOnce(joined, {
  name: kind.name,
  say: (spaceId) =>
    chips.post({ spaceId, text: `Hi, ${kind.name} here, through chips-acp. Make me an agent from any room, or ask me here.` }),
}).catch((error: unknown) => log(`hello not said: ${String(error)}`));

const stop = () => {
  bridge?.stop();
  chips.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
