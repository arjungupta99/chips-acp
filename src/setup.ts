/**
 * What the bridge checks before it takes up a link, which works once (Chips ADR 0122): the config
 * naming a kind of agent and how to run it, and that command found on this machine. Anything
 * missing stops it with what to do, and the link is still good for the same command run again.
 */

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { KindConfig } from "./bridge.js";

/** Something to put right before the bridge starts, said so a person can. */
export class SetupError extends Error {
  override readonly name = "SetupError";
}

export const STILL_GOOD = "The link is still good: run the same command again once that's done.";

const EXAMPLE = '{ "name": "Claude Code", "command": ["claude-agent-acp"], "folders": "~/chips-acp/claude-code" }';

const home = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

/** The kind of agent the config at `path` names. */
export function readConfig(path: string): KindConfig {
  if (!existsSync(path)) {
    throw new SetupError(`There is no config at ${path}. Write ${EXAMPLE} there. ${STILL_GOOD}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const name = raw["name"];
  const command = raw["command"];
  if (typeof name !== "string" || name.trim() === "" || !Array.isArray(command) || command.length === 0) {
    throw new SetupError(`${path} names a kind of agent and how to run it: ${EXAMPLE}. ${STILL_GOOD}`);
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

const runnable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The kind's command found where it will be run from: a path, or a name on its `PATH`. */
export function checkCommand(kind: KindConfig, env: NodeJS.ProcessEnv = process.env): void {
  const [program] = kind.command;
  if (program === undefined) throw new SetupError(`${kind.name} has no command to run. ${STILL_GOOD}`);
  const path = { ...env, ...kind.env }["PATH"] ?? "";
  const found = program.includes("/")
    ? runnable(isAbsolute(program) ? program : resolve(home(program)))
    : path.split(delimiter).some((dir) => dir !== "" && runnable(join(dir, program)));
  if (!found) {
    throw new SetupError(
      `${kind.name}'s command, ${program}, isn't on this machine's PATH: install the agent's ACP adapter its own way (Claude Code's is @agentclientprotocol/claude-agent-acp, Codex's @agentclientprotocol/codex-acp), or name it by its path in the config. ${STILL_GOOD}`,
    );
  }
}
