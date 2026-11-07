/**
 * What the bridge checks before it takes up a link, which works once (Chips ADR 0122): the config
 * naming a kind of agent and how to run it (Claude Code and Codex need none), that command found
 * on this machine, and the agent started and signed in. Anything missing stops it with what to do,
 * and the link is still good for the same command run again.
 */

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import type { StopWords } from "@chipschat/harness";
import { AcpClient, type AgentInfo, type AuthStatus, isAuthRequired, notOffered, type Wire } from "./acp.js";
import type { KindConfig } from "./bridge.js";
import { installWords, knownConfig, notInstalledStop, signedOutStop, signedOutWords } from "./kinds.js";
import { foldersPathOf, fromHome } from "./places.js";
import { VERSION } from "./version.js";

/**
 * Something to put right before the bridge starts, said so a person can: the message in a terminal,
 * `words` on Chips for Mac's sheet (Chips ADR 0218, phase 5).
 */
export class SetupError extends Error {
  override readonly name = "SetupError";
  constructor(
    message: string,
    readonly words: StopWords = {},
  ) {
    super(message);
  }
}

export const STILL_GOOD = "The link is still good: run the same command again once that's done.";

const EXAMPLE = '{ "name": "Claude Code", "command": ["claude-agent-acp"], "folders": "~/Chips/Agents/claude-code" }';

/** The kind of agent the config at `path` names: Claude Code's or Codex's own, by its file's name, when it isn't there. */
export function readConfig(path: string): KindConfig {
  const known = knownConfig(basename(path, ".json"));
  if (!existsSync(path) && known === undefined) {
    throw new SetupError(
      `There is no config at ${path}. Write ${EXAMPLE} there, or name claude-code.json or codex.json, which need none. ${STILL_GOOD}`,
    );
  }
  const raw = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : known) as Record<string, unknown>;
  const name = raw["name"];
  const command = raw["command"];
  if (typeof name !== "string" || name.trim() === "" || !Array.isArray(command) || command.length === 0) {
    throw new SetupError(`${path} names a kind of agent and how to run it: ${EXAMPLE}. ${STILL_GOOD}`);
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    name,
    command: command.map(String),
    folders: foldersPathOf(typeof raw["folders"] === "string" ? raw["folders"] : `~/Chips/Agents/${slug}`),
    ...(typeof raw["folder"] === "string" ? { folder: foldersPathOf(raw["folder"]) } : {}),
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
    ? runnable(isAbsolute(program) ? program : resolve(fromHome(program)))
    : path.split(delimiter).some((dir) => dir !== "" && runnable(join(dir, program)));
  if (!found) {
    throw new SetupError(
      `${kind.name}'s command, ${program}, isn't on this machine's PATH: ${installWords(kind)}. ${STILL_GOOD}`,
      notInstalledStop(kind, program),
    );
  }
}

const MINUTE = 60_000;

/** `promise`, or an error saying `what` once `ms` have gone by. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(what)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const wordsOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The agent started and signed in, over `wire`: it says hello, makes a session in `cwd` (let go
 * again), and, when it says who it is signed in as, says it is someone. Codex refuses the session
 * while signed out; Claude Code makes it and refuses each turn, but says it is signed in as nobody.
 */
export async function checkSignIn(
  kind: KindConfig,
  wire: Wire,
  cwd: string,
  options: { waitMs?: number; stderr?: () => readonly string[] } = {},
): Promise<void> {
  let status: AuthStatus | undefined;
  let heard = () => {};
  const said = new Promise<void>((resolve) => {
    heard = resolve;
  });
  const client = new AcpClient(wire, {
    update: () => undefined,
    request: async (request) => {
      throw notOffered(request.method);
    },
    exit: () => heard(),
    auth: (now) => {
      status = now;
      heard();
    },
  });
  try {
    let info: AgentInfo;
    try {
      info = await within(client.initialize({ name: "chips-acp", version: VERSION }), MINUTE, "it didn't answer within a minute");
    } catch (error) {
      const last = options.stderr?.().slice(-3).join(" ") ?? "";
      throw new SetupError(`${kind.name} didn't start: ${wordsOf(error)}.${last === "" ? "" : ` It said: ${last}`} ${STILL_GOOD}`, {
        detail: "Its ACP adapter didn't start",
        says: `${kind.name} didn't start: ${wordsOf(error)}.`,
        ...(last === "" ? {} : { doing: `It said: ${last}` }),
      });
    }
    try {
      const { sessionId } = await within(client.newSession(cwd), MINUTE, "it didn't answer within a minute");
      if (info.closeSession) await client.closeSession(sessionId).catch(() => undefined);
    } catch (error) {
      if (isAuthRequired(error)) throw new SetupError(`${signedOutWords(kind, info)} ${STILL_GOOD}`, signedOutStop(kind));
      throw new SetupError(`${kind.name} couldn't open a session: ${wordsOf(error)}. ${STILL_GOOD}`, {
        detail: "It couldn't open a session",
        says: `${kind.name} couldn't open a session: ${wordsOf(error)}.`,
      });
    }
    if (info.reportsAuth && status === undefined) await within(said, options.waitMs ?? 6000, "").catch(() => undefined);
    if (status?.kind === "none") throw new SetupError(`${signedOutWords(kind, info)} ${STILL_GOOD}`, signedOutStop(kind));
  } finally {
    client.close();
  }
}
