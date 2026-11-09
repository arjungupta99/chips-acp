/**
 * The kinds of ACP agent this bridge knows by name, so the gallery's cards need no config written
 * first: how each is run, the mode that makes it ask, its adapter's package, and how a person
 * signs it in. Any other kind runs from a config that names it.
 */

import type { AgentInfo } from "./acp.js";
import type { StopWords } from "@chipschat/harness";
import type { KindConfig } from "./bridge.js";

interface Known {
  /** The config's file name without `.json`, as the gallery's cards give it: `claude-code`. */
  readonly id: string;
  readonly name: string;
  /** Its ACP adapter's command, and the npm package it comes in. */
  readonly program: string;
  readonly adapter: string;
  /** The adapter's major this bridge speaks to: what `npm install` is asked for. */
  readonly adapterMajor: number;
  /**
   * Whether the bridge may fetch the adapter itself when a person's Connect needs it (Chips ADR
   * 0288). Claude Code's stays off until Anthropic has said whether a product like Chips may reach
   * a claude.ai sign-in through an adapter built on its SDK; turning it on is this one word.
   */
  readonly fetches: boolean;
  /** The agent's own command, which a person installs from its maker, and the maker's line for it. */
  readonly agent: string;
  readonly installLine: string;
  readonly mode: string;
  /** What a person does to sign it in, in a terminal. */
  readonly signIn: string;
  /** The same for Chips for Mac's sheet: the line to copy, and what to do with it. */
  readonly signInLine: string;
  readonly signInDoing: string;
}

const SIGN_IN_DOING = "Run this in Terminal, then try again. Your browser opens to sign in.";

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
    mode: "default",
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
    mode: "workspace-write",
    signIn: "run `codex login`",
    signInLine: "codex login",
    signInDoing: SIGN_IN_DOING,
  },
];

/** The config a known kind runs on when its file isn't there: `claude-code` for `claude-code.json`. */
export function knownConfig(id: string): Omit<KindConfig, "folders"> | undefined {
  const known = KNOWN.find((each) => each.id === id);
  return known === undefined ? undefined : { name: known.name, command: [known.program], mode: known.mode };
}

const knownBy = (kind: KindConfig) => {
  const program = kind.command[0]?.split("/").pop();
  return KNOWN.find((each) => each.program === program);
};

/** What this bridge knows of the kind a config runs, for getting its adapter (`adapter.ts`). */
export const knownOf = (kind: KindConfig): Known | undefined => knownBy(kind);

/** Which of the kinds this bridge knows by name a config runs, by its command: `claude-code`, `codex`. */
export type KnownId = "claude-code" | "codex";

export function knownIdOf(kind: KindConfig): KnownId | undefined {
  return knownBy(kind)?.id as KnownId | undefined;
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
  return known === undefined
    ? "install the agent's ACP adapter its own way, or name it by its path in the config"
    : `install it with \`npm install -g ${known.adapter}\``;
}

/** What to tell a person whose agent refused because it isn't signed in. */
export function signedOutWords(kind: KindConfig, info?: AgentInfo): string {
  const known = knownBy(kind);
  if (known !== undefined) return `${kind.name} isn't signed in on this machine: ${known.signIn} in a terminal.`;
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
    detail: "Not signed in",
    says: `${kind.name} isn't signed in.`,
    ...(known === undefined
      ? { doing: "Sign it in its own way, then try again." }
      : { doing: known.signInDoing, copy: known.signInLine }),
  };
}
