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
import { checkGit, connect, fileStore, helloOnce, JoinError, join as joinChips, reportStep } from "@chipschat/harness";
import { processWire } from "./acp.js";
import { Bridge, type BridgeState, type KindConfig, settingsFor } from "./bridge.js";
import { keepIfAsked, stopIfAsked, words } from "./keep.js";
import { adapterEnv, knownIdOf } from "./kinds.js";
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
    reportStep("checking", { detail: `Starting ${kind.name}'s ACP adapter` });
    checkCommand(kind);
    log(`checking that ${kind.name} starts and is signed in`);
    const cwd = kind.folder ?? kind.folders;
    const stderr: string[] = [];
    const wire = processWire(kind.command, cwd, adapterEnv(kind, { ...process.env, ...kind.env }), (line) => stderr.push(line));
    await checkSignIn(kind, wire, cwd, { stderr: () => stderr });
    reportStep("checked", { detail: `${kind.name} opened a session` });
  }
} catch (error) {
  if (!(error instanceof SetupError)) throw error;
  // Where it stopped, in a few words for Chips for Mac's sheet; the whole sentence for a terminal.
  reportStep("failed", error.words);
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
  wants: [
    "agents",
    "new_spaces",
    "new_agents",
    "forks",
    "restarts",
    // Each agent's files and its model, for the kinds whose files and models the bridge knows, and
    // every agent's context window.
    ...(knownIdOf(kind) === undefined ? [] : ["context_files", "models"]),
    "context_windows",
  ],
  onCode: (code) => log(`Allow this harness in Chips: ${code}`),
}).catch(refused);
// Joined, `npm run keep` hands over to a copy kept running, which says the hello. What signs its
// agent in, where it is set, goes with it.
keepIfAsked(LABEL, joined.url, ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_HOME", "CLAUDE_CONFIG_DIR"], log);

const kept = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Partial<BridgeState>) : {};
const state: BridgeState = {
  sessions: kept.sessions ?? {},
  agents: kept.agents ?? {},
  windows: kept.windows ?? {},
  ...(kept.models === undefined ? {} : { models: kept.models }),
};
// The agent's environment: this process's, the config's, and for Codex the room to read a whole AGENTS.md.
const env = adapterEnv(kind, { ...process.env, ...kind.env });

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
  // An agent's files, its context window and its model, changed from its page (Chips ADRs 0134, 0146, 0241).
  settings: settingsFor(kind, () => bridge),
});

// Each agent works on its room's project in a copy of its own (Chips ADR 0221), where git will.
const git = await checkGit();
if (!git.ok) log(`rooms' projects are off: ${git.why}`);

bridge = new Bridge({
  chips,
  kind,
  projects: git.ok,
  // Claude Code's and Codex's adapters offer their models as session options (Chips ADR 0241).
  models: knownIdOf(kind) !== undefined,
  state,
  saveState: (next) => writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }),
  wire: () => processWire(kind.command, kind.folder ?? kind.folders, env, (line) => log(`${kind.name}: ${line}`)),
  env,
  log,
});
await bridge.start();
log(`connected as ${chips.harnessId} (${kind.name}), ${Object.keys(state.agents).length} agent(s)`);

// Its first words in the room it joined, once: the card that followed its link waits for them. A
// kind has no agent of its own until Chips makes one, so the harness says them.
await helloOnce(joined, {
  name: kind.name,
  say: (spaceId) =>
    chips.post({ spaceId, text: `Hi, ${kind.name} here, through chips-acp. Make me an agent from any space, or ask me here.` }),
}).catch((error: unknown) => log(`hello not said: ${String(error)}`));

const stop = () => {
  bridge?.stop();
  chips.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
