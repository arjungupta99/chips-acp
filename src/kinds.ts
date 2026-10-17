/**
 * The kinds of ACP agent this bridge knows by name, so the gallery's cards need no config written
 * first: how each is run, the mode that makes it ask, its adapter's package, and how a person
 * signs it in. Any other kind runs from a config that names it.
 */

import type { AgentInfo } from "./acp.js";
import type { KindConfig } from "./bridge.js";

interface Known {
  /** The config's file name without `.json`, as the gallery's cards give it: `claude-code`. */
  readonly id: string;
  readonly name: string;
  /** Its ACP adapter's command, and the npm package it comes in. */
  readonly program: string;
  readonly adapter: string;
  readonly mode: string;
  /** What a person does to sign it in, in a terminal. */
  readonly signIn: string;
}

const KNOWN: readonly Known[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    program: "claude-agent-acp",
    adapter: "@agentclientprotocol/claude-agent-acp",
    mode: "default",
    signIn: "run `claude`, then /login",
  },
  {
    id: "codex",
    name: "Codex",
    program: "codex-acp",
    adapter: "@agentclientprotocol/codex-acp",
    mode: "workspace-write",
    signIn: "run `codex login`",
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
