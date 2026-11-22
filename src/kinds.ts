/**
 * The kinds of ACP agent this bridge knows by name, so the gallery's cards need no config written
 * first: how each is run, the mode that makes it ask, its adapter's package where it needs one, and
 * how a person signs it in. Any other kind runs from a config that names it.
 *
 * Claude Code and Codex speak ACP through an adapter, a second program from npm. The others speak
 * it themselves, the agent's own command with a word or two after it (`goose acp`), so there is
 * nothing to fetch: the person installs the agent from its maker and signs it in, and that is all
 * (Chips ADR 0301).
 */

import { AcpError, type AgentInfo, isAuthRequired } from "./acp.js";
import type { StopWords } from "@chipschat/harness";
import type { KindConfig } from "./bridge.js";

interface Known {
  /** The config's file name without `.json`, as the gallery's cards give it: `claude-code`. */
  readonly id: string;
  readonly name: string;
  /** The command that speaks ACP: its adapter's (`codex-acp`), or the agent's own (`goose`). */
  readonly program: string;
  /** What follows it, for an agent that speaks ACP itself: `["acp"]` for `goose acp`. */
  readonly args?: readonly string[];
  /** The npm package its adapter comes in, for an agent that needs one: none for one that speaks ACP itself. */
  readonly adapter?: string;
  /** The adapter's major this bridge speaks to: what `npm install` is asked for. */
  readonly adapterMajor?: number;
  /**
   * Whether the bridge may fetch the adapter itself when a person's Connect needs it (Chips ADR
   * 0288). Claude Code's stays off until Anthropic has said whether a product like Chips may reach
   * a claude.ai sign-in through an adapter built on its SDK; turning it on is this one word.
   */
  readonly fetches: boolean;
  /** The agent's own command, which a person installs from its maker, and the maker's line for it. */
  readonly agent: string;
  readonly installLine: string;
  /**
   * Where that line puts the agent, under the home folder. The terminal it was run in doesn't know
   * the folder until a new one is opened, so the bridge looks there too (`makersFolder`).
   */
  readonly installedIn: string;
  /**
   * The mode its sessions start in, the one that asks, where Chips may pick one. None leaves each
   * session in the mode the agent's own settings give it, and Chips offers no pick.
   */
  readonly mode?: string;
  /** The modes a person may pick in Chips for its sessions, `mode` among them, in their order. */
  readonly modes: readonly KindMode[];
  /** What a person does to sign it in, in a terminal, and on a machine with no screen where that differs. */
  readonly signIn: string;
  readonly signInNoScreen?: string;
  /** The same for Chips for Mac's sheet: the line to copy, and what to do with it. */
  readonly signInLine: string;
  readonly signInDoing: string;
  /** What signs it in from the environment, where it may be: carried to the copy kept running. */
  readonly keys?: readonly string[];
  /**
   * The ways it signs in with nobody at a browser, the first it offers taken, where it has to be
   * asked to (`authenticate`) before it opens a session; one with `env` only while that is set.
   */
  readonly headless?: readonly { readonly id: string; readonly env?: string }[];
  /**
   * How it refuses a session while it has nothing to run on, where that isn't ACP's sign-in
   * refusal: Goose with no model provider set up says so in an internal error.
   */
  readonly unready?: RegExp;
  /** What it lacks when it can't run, where that isn't a sign-in: Goose's model provider. */
  readonly lacks?: { readonly detail: string; readonly says: string };
  /**
   * A reply it gives in place of an answer when its account can't be used, and what Chips says
   * instead, as a failed turn: Antigravity answers "⚠ Verification Required" while Google wants
   * the account verified, and says nothing of where.
   */
  readonly stops?: { readonly reply: RegExp; readonly says: string };
  /**
   * Where it names a tool call's tool, when it gives neither `name` nor an ACP `kind`: the key in
   * the call's `_meta` that holds `toolCall.toolName`. Goose names its own there ("shell",
   * "write") and calls every ask "other", so without it each Goose ask is one action kind, and an
   * Always for one command would answer every tool Goose has.
   */
  readonly toolMeta?: string;
  /**
   * How it refuses a prompt while a run of its own is still going in the session: Goose, given a
   * session back with a call still waiting from before, runs that call again first, and refuses
   * prompts with "session already has active run" until it ends.
   */
  readonly busy?: RegExp;
}

const SIGN_IN_DOING = "Run this in Terminal, then try again. Your browser opens to sign in.";

/**
 * A mode a person may pick in Chips for a kind's sessions (Chips ADR 0300, addendum of 19 November
 * 2026), as Chips's `own_rules.modes` offers it: its id on the wire, its name, a plain line, and
 * whether the agent never asks in it.
 */
export interface KindMode {
  readonly id: string;
  readonly name: string;
  readonly words: string;
  readonly everything?: true | undefined;
}

/**
 * Claude Code's, as its adapter offers them. Plan is left out: it is a way to work on one task, not
 * how much it may do, and Claude Code asks before it leaves it. Its adapter offers Bypass
 * permissions only where it may (not as root outside a sandbox, nor where settings turn it off).
 */
const CLAUDE_MODES: readonly KindMode[] = [
  { id: "default", name: "Default", words: "Asks before edits and commands its settings don't allow." },
  { id: "acceptEdits", name: "Accept edits", words: "Edits files without asking. Commands still ask." },
  { id: "auto", name: "Auto", words: "Claude Code judges each step and asks only when one looks risky." },
  { id: "bypassPermissions", name: "Bypass permissions", words: "Never asks. Whatever it does just happens.", everything: true },
];

/** Codex's, as codex-acp offers them. */
const CODEX_MODES: readonly KindMode[] = [
  { id: "read-only", name: "Read-only", words: "Reads on its own. Changes nothing without a yes: it asks first, or says it can't." },
  {
    id: "workspace-write",
    name: "Workspace access",
    words: "Edits and runs commands in the agent's folder. Asks before the network or anything outside it.",
  },
  { id: "agent", name: "Auto review", words: "Codex judges each step and asks only when one looks risky." },
  {
    id: "agent-full-access",
    name: "Full access",
    words: "Never asks. Reaches the network and any file on this computer.",
    everything: true,
  },
];

/**
 * Antigravity's, as `agy acp` offers them. Plan is left out, as Claude Code's is. Auto is offered
 * only where Antigravity has it: a personal Google account with its terminal sandbox on. Auto runs
 * every command in that sandbox without asking, an `rm` in its folder included, and checks only
 * those that leave it. It has no mode that never asks.
 */
const ANTIGRAVITY_MODES: readonly KindMode[] = [
  { id: "default", name: "Default", words: "Asks before edits and commands its settings don't allow." },
  { id: "accept-edits", name: "Accept edits", words: "Edits files in its folder without asking. Commands still ask." },
  {
    id: "auto",
    name: "Auto",
    words: "Edits files and runs commands in its sandbox without asking. Asks before a command outside it that it can't undo.",
  },
];

/**
 * Goose's, as it names them. It starts in Auto, which never asks, unless `GOOSE_MODE` says
 * otherwise, so the bridge puts each session in Approve.
 */
const GOOSE_MODES: readonly KindMode[] = [
  { id: "approve", name: "Approve", words: "Asks before every tool call its own permission list doesn't settle." },
  { id: "smart_approve", name: "Smart approve", words: "Reads on its own. Goose judges the rest and asks only about ones it finds risky." },
  { id: "auto", name: "Auto", words: "Never asks. Whatever it does just happens.", everything: true },
];

const KNOWN: readonly Known[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    program: "claude-agent-acp",
    adapter: "@agentclientprotocol/claude-agent-acp",
    adapterMajor: 0,
    fetches: false,
    agent: "claude",
    installLine: "curl -fsSL https://claude.ai/install.sh | bash",
    installedIn: ".local/bin",
    mode: "default",
    modes: CLAUDE_MODES,
    signIn: "run `claude auth login`",
    signInLine: "claude auth login",
    signInDoing: SIGN_IN_DOING,
  },
  {
    id: "codex",
    name: "Codex",
    program: "codex-acp",
    adapter: "@agentclientprotocol/codex-acp",
    adapterMajor: 2,
    fetches: true,
    agent: "codex",
    installLine: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    installedIn: ".local/bin",
    mode: "workspace-write",
    modes: CODEX_MODES,
    signIn: "run `codex login`",
    // Over SSH no browser opens, and the address `codex login` prints calls back to that machine.
    signInNoScreen: "`codex login --device-auth`",
    signInLine: "codex login",
    signInDoing: SIGN_IN_DOING,
  },
  {
    id: "cursor",
    name: "Cursor",
    // The installer links `agent` too, a name other programs use: the legacy one is Cursor's alone.
    program: "cursor-agent",
    args: ["acp"],
    fetches: false,
    agent: "cursor-agent",
    installLine: "curl https://cursor.com/install -fsS | bash",
    installedIn: ".local/bin",
    // Agent, Plan and Ask are ways of working, not how much it may do: that is its own
    // `approvalMode` and permission lists, which edits in its folder never ask past.
    modes: [],
    signIn: "run `cursor-agent login`",
    signInNoScreen: "`NO_OPEN_BROWSER=1 cursor-agent login`, then open the address it prints",
    signInLine: "cursor-agent login",
    signInDoing: SIGN_IN_DOING,
    // Never asked to sign in over ACP: signed out, that opens a browser on this machine each time.
    keys: ["CURSOR_API_KEY"],
  },
  {
    id: "goose",
    name: "Goose",
    program: "goose",
    args: ["acp"],
    fetches: false,
    agent: "goose",
    installLine: "curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash",
    installedIn: ".local/bin",
    mode: "approve",
    modes: GOOSE_MODES,
    // Goose has no account: it runs on a model provider a person picks, with that provider's key.
    signIn: "run `goose configure` and pick a model provider",
    signInLine: "goose configure",
    signInDoing: "Run this in Terminal, then try again. It asks which model provider to use, and for its key.",
    keys: ["GOOSE_PROVIDER", "GOOSE_MODEL", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"],
    unready: /GOOSE_PROVIDER|resolve provider and model/,
    lacks: { detail: "No model provider", says: "has no model provider set up" },
    toolMeta: "goose",
    busy: /already has active run/,
  },
  {
    id: "copilot",
    name: "Copilot",
    program: "copilot",
    args: ["--acp"],
    fetches: false,
    agent: "copilot",
    installLine: "curl -fsSL https://gh.io/copilot-install | bash",
    installedIn: ".local/bin",
    // Its session modes are Agent, Plan and Autopilot, ways of working rather than how much it may
    // do: whether it asks is its Allow all option, off unless the person's settings turn it on.
    // Chips puts it in neither, so each session asks as Copilot's own settings say.
    modes: [],
    signIn: "run `copilot login`",
    signInNoScreen: "`copilot login --device-code`",
    signInLine: "copilot login",
    signInDoing: SIGN_IN_DOING,
    // Only Copilot's own: GH_TOKEN and GITHUB_TOKEN are the gh command's too, and Copilot lets
    // either beat the sign-in it saved.
    keys: ["COPILOT_GITHUB_TOKEN"],
  },
  {
    id: "antigravity",
    name: "Antigravity",
    program: "agy",
    args: ["acp"],
    fetches: false,
    agent: "agy",
    installLine: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    installedIn: ".local/bin",
    mode: "default",
    modes: ANTIGRAVITY_MODES,
    // Its sign-in for ACP gives a link to open and takes back the code Google shows, so it works
    // the same on a machine with no screen.
    signIn: "run `agy acp --login` and paste back the code it asks for",
    signInLine: "agy acp --login",
    signInDoing: "Run this in Terminal, then try again. It gives you a Google sign-in link; paste back the code you get.",
    keys: ["GEMINI_API_KEY"],
    stops: {
      reply: /^[\s⚠\uFE0F]*Verification Required[\s.!]*$/i,
      says:
        "Google wants this Antigravity account verified before it answers. Run `agy -p hi` in a new terminal: it prints a link to verify the account in your browser. Then send this again.",
    },
  },
  {
    id: "grok",
    name: "Grok",
    program: "grok",
    // Left to update itself as it does: xAI's API refuses a Grok too old (it refused 0.2.99 with
    // a 426), and a Grok only Chips runs would never be updated otherwise.
    args: ["agent", "stdio"],
    fetches: false,
    agent: "grok",
    installLine: "curl -fsSL https://x.ai/cli/install.sh | bash",
    installedIn: ".grok/bin",
    // Its Ask, Auto and Always-approve aren't modes its ACP sessions offer to be put in: each
    // session runs in the one Grok's own config gives it, Ask unless the person changed it.
    modes: [],
    signIn: "run `grok login`",
    signInNoScreen: "`grok login --device-auth`",
    signInLine: "grok login",
    signInDoing: SIGN_IN_DOING,
    keys: ["XAI_API_KEY"],
    // It opens no session until asked to sign in, as xAI's own ACP example does: by its API key
    // where one is set, else by what `grok login` saved. Signed out, it offers neither.
    headless: [{ id: "xai.api_key", env: "XAI_API_KEY" }, { id: "cached_token" }],
  },
];

/** The config a known kind runs on when its file isn't there: `claude-code` for `claude-code.json`. */
export function knownConfig(id: string): Omit<KindConfig, "folders"> | undefined {
  const known = KNOWN.find((each) => each.id === id);
  if (known === undefined) return undefined;
  return {
    name: known.name,
    command: [known.program, ...(known.args ?? [])],
    ...(known.mode === undefined ? {} : { mode: known.mode }),
  };
}

const knownBy = (kind: KindConfig) => {
  const program = kind.command[0]?.split("/").pop();
  return KNOWN.find((each) => each.program === program);
};

/** Whether a known kind is an agent that speaks ACP itself, with no adapter to install or fetch. */
export const speaksAcp = (known: Pick<Known, "adapter">): boolean => known.adapter === undefined;

/** What Chips says in place of a reply the kind gives when its account can't be used; nothing for any other. */
export function stoppedWith(kind: KindConfig, reply: string): string | undefined {
  const stops = knownBy(kind)?.stops;
  return stops !== undefined && stops.reply.test(reply) ? stops.says : undefined;
}

/** The tool a call is for, where the kind names it in the call's `_meta` (`toolMeta`). */
export function toolNamedIn(kind: KindConfig, call: Readonly<Record<string, unknown>>): string | undefined {
  const key = knownBy(kind)?.toolMeta;
  const meta = call["_meta"];
  if (key === undefined || typeof meta !== "object" || meta === null) return undefined;
  const own = (meta as Record<string, unknown>)[key];
  const named = typeof own === "object" && own !== null ? (own as Record<string, unknown>)["toolCall"] : undefined;
  const tool = typeof named === "object" && named !== null ? (named as Record<string, unknown>)["toolName"] : undefined;
  return typeof tool === "string" && tool !== "" ? tool : undefined;
}

/** Whether the agent refused a prompt because a run of its own is still going in that session (`busy`). */
export function busyBy(kind: KindConfig, error: unknown): boolean {
  const busy = knownBy(kind)?.busy;
  if (busy === undefined || !(error instanceof AcpError)) return false;
  const data = typeof error.data === "string" ? error.data : JSON.stringify(error.data ?? "");
  return busy.test(`${error.message} ${data}`);
}

/**
 * Whether the agent refused because it isn't signed in or set up: ACP's sign-in refusal, or the
 * kind's own way of saying it has nothing to run on.
 */
export function signedOutBy(kind: KindConfig, error: unknown): boolean {
  if (isAuthRequired(error)) return true;
  const unready = knownBy(kind)?.unready;
  if (unready === undefined || !(error instanceof AcpError)) return false;
  const data = typeof error.data === "string" ? error.data : JSON.stringify(error.data ?? "");
  return unready.test(`${error.message} ${data}`);
}

/**
 * The way the agent is to be asked to sign in before it opens a session, of those it offered at
 * `initialize`: nothing for a kind that needs no asking, or where it offers no way that needs
 * nobody at a browser, which is a signed-out agent, and its first session says so.
 */
export function headlessAuthOf(
  kind: KindConfig,
  offered: readonly { readonly id: string }[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  return knownBy(kind)?.headless?.find(
    (way) => offered.some((method) => method.id === way.id) && (way.env === undefined || (env[way.env] ?? "") !== ""),
  )?.id;
}

/**
 * What signs the agents in from the environment, carried to the copy kept running (`keep.ts`): what
 * Claude Code and Codex read, and the kind's own.
 */
export function keptEnvOf(kind: KindConfig): readonly string[] {
  return ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_HOME", "CLAUDE_CONFIG_DIR", ...(knownBy(kind)?.keys ?? [])];
}

/**
 * The modes a person may pick for a kind's sessions from Chips: a kind this bridge knows by name,
 * started in the mode it knows it by. One run from a config of its own, or in another mode, offers
 * none, and Chips shows its mode as a row it can't change.
 */
export function modesOf(kind: KindConfig): readonly KindMode[] {
  const known = knownBy(kind);
  if (known === undefined || kind.mode !== known.mode) return [];
  return known.modes;
}

/** What this bridge knows of the kind a config runs, for getting its adapter (`adapter.ts`). */
export const knownOf = (kind: KindConfig): Known | undefined => knownBy(kind);

/**
 * Which of the kinds whose files and settings this bridge reads a config runs, by its command:
 * `claude-code`, `codex`. The others it knows by name only for how they're installed, signed in and
 * put in a mode, so their agents' files and own rules aren't read (Chips ADR 0301).
 */
export type KnownId = "claude-code" | "codex";

export function knownIdOf(kind: KindConfig): KnownId | undefined {
  const id = knownBy(kind)?.id;
  return id === "claude-code" || id === "codex" ? id : undefined;
}

/**
 * How much of an agent's `AGENTS.md` Codex reads (`project_doc_max_bytes`): 32 KiB unless its
 * config says, which is less than the 64 KB Chips lets a person write. The bridge's own Codex adapter
 * is given 64 KiB in `CODEX_CONFIG` (`adapterEnv`), which codex-acp lays over Codex's own config for
 * each session it starts, so a file saved from Chips is read whole.
 */
export const CODEX_DOC_BYTES = 65_536;

/** The `CODEX_CONFIG` an environment carries, read as codex-acp reads it: JSON, or nothing. */
function codexConfigOf(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  const raw = env["CODEX_CONFIG"];
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The environment the kind's adapter runs in: `env` as it is, and for Codex, `CODEX_CONFIG` with
 * `project_doc_max_bytes` at 64 KiB where it doesn't say already. A `CODEX_CONFIG` that isn't JSON
 * is left as it is: codex-acp would refuse it, and that is the person's to see.
 */
export function adapterEnv(kind: KindConfig, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (knownIdOf(kind) !== "codex") return env;
  const raw = env["CODEX_CONFIG"];
  const config = codexConfigOf(env);
  if (raw !== undefined && raw.trim() !== "" && config === undefined) return env;
  if (config?.["project_doc_max_bytes"] !== undefined) return env;
  return { ...env, CODEX_CONFIG: JSON.stringify({ ...config, project_doc_max_bytes: CODEX_DOC_BYTES }) };
}

/** How many bytes of an agent's `AGENTS.md` its Codex reads, in the environment it runs in. */
export function codexDocBytes(env: NodeJS.ProcessEnv): number {
  const said = codexConfigOf(env)?.["project_doc_max_bytes"];
  return typeof said === "number" && Number.isFinite(said) && said > 0 ? said : 32_768;
}

/** How to install a kind's adapter, where it is one this bridge knows. */
export function installWords(kind: KindConfig): string {
  const known = knownBy(kind);
  if (known === undefined) return "install the agent's ACP adapter its own way, or name it by its path in the config";
  return speaksAcp(known) ? `install it with \`${known.installLine}\`` : `install it with \`npm install -g ${known.adapter}\``;
}

/** What to tell a person whose agent refused because it isn't signed in. */
export function signedOutWords(kind: KindConfig, info?: AgentInfo): string {
  const known = knownBy(kind);
  // A new terminal, since one the agent was just installed in doesn't know its command yet.
  if (known !== undefined) {
    const noScreen = known.signInNoScreen === undefined ? "" : `, or ${known.signInNoScreen} on a machine with no screen`;
    return `${kind.name} ${known.lacks?.says ?? "isn't signed in"} on this machine: ${known.signIn} in a new terminal${noScreen}.`;
  }
  const ways = (info?.authMethods ?? []).map((method) => method.name);
  return `${kind.name} isn't signed in on this machine: sign it in its own way${ways.length > 0 ? ` (${ways.join(", ")})` : ""}.`;
}

/** Its adapter not installed, in a few words for Chips for Mac's sheet (Chips ADR 0218, phase 5). */
export function notInstalledStop(kind: KindConfig, program: string): StopWords {
  const known = knownBy(kind);
  if (known === undefined) {
    return {
      detail: `${program} isn't on this Mac`,
      says: `${kind.name}'s ACP adapter isn't installed.`,
      doing: "Install the agent's ACP adapter its own way, then try again.",
    };
  }
  // An agent that speaks ACP itself is the program: what's missing is the agent.
  if (speaksAcp(known)) return agentMissingStop(known);
  return {
    detail: `${kind.name} can't join Chips yet`,
    says: `${kind.name} needs one more piece to join Chips.`,
    doing: "Run this in Terminal, then try again. It needs npm, which comes with Node.js (nodejs.org).",
    copy: `npm install -g ${known.adapter}`,
  };
}

/** The agent itself not installed, with its maker's own line. */
export function agentMissingStop(known: Pick<Known, "name" | "installLine">): StopWords {
  return {
    detail: `${known.name} isn't on this Mac`,
    says: `${known.name} isn't installed on this Mac.`,
    doing: "Run this in Terminal, then try again.",
    copy: known.installLine,
  };
}

/** Its adapter's download not finishing. */
export function adapterFailedStop(name: string): StopWords {
  return {
    detail: "The download didn't finish",
    says: `Chips couldn't get what ${name} needs.`,
    doing: "Check your connection, then try again.",
  };
}

/** Not signed in, in a few words for Chips for Mac's sheet. */
export function signedOutStop(kind: KindConfig): StopWords {
  const known = knownBy(kind);
  return {
    detail: known?.lacks?.detail ?? "Not signed in",
    says: `${kind.name} ${known?.lacks?.says ?? "isn't signed in"}.`,
    ...(known === undefined
      ? { doing: "Sign it in its own way, then try again." }
      : { doing: known.signInDoing, copy: known.signInLine }),
  };
}
