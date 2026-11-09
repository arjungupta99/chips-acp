/**
 * A known kind's ACP adapter, fetched when Connect needs it (Chips ADR 0288). A new Mac has no npm,
 * so Chips carries one and says where (`CHIPS_NPM`), and the adapter goes in a folder of the
 * bridge's own, `~/Chips/.bridges/acp/adapters/<kind>`, found again at every start.
 *
 * The agent itself is the person's to install, from its maker, and to sign in to. It is asked for
 * first, so nobody downloads hundreds of megabytes to be told it's missing. An adapter already on
 * the PATH is used as it is, and nothing is fetched for a kind whose `fetches` is off.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { KindConfig } from "./bridge.js";
import { adapterFailedStop, agentMissingStop, knownConfig, knownOf } from "./kinds.js";
import { placesOf } from "./places.js";
import { onPath, runnable, SetupError, STILL_GOOD } from "./setup.js";

/** How long an adapter's download has: they are hundreds of megabytes, on any connection. */
const PATIENCE_MS = 20 * 60_000;

/** Where a kind's fetched adapter lives. */
export const adapterFolder = (id: string, home: string = homedir()): string => join(placesOf(home).settings, "adapters", id);

const fetchedAt = (id: string, program: string, home: string) => join(adapterFolder(id, home), "node_modules", ".bin", program);

const pathOf = (kind: KindConfig, env: NodeJS.ProcessEnv) => ({ ...env, ...kind.env })["PATH"] ?? "";

/** The kind as it should run: on the adapter fetched for it, when its own isn't on the PATH. */
export function withFetchedAdapter(kind: KindConfig, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): KindConfig {
  const known = knownOf(kind);
  if (known === undefined || kind.command[0] !== known.program || onPath(known.program, pathOf(kind, env))) return kind;
  const fetched = fetchedAt(known.id, known.program, home);
  return runnable(fetched) ? { ...kind, command: [fetched, ...kind.command.slice(1)] } : kind;
}

export interface Install {
  readonly node: string;
  readonly npm: string;
  readonly folder: string;
  /** `@agentclientprotocol/codex-acp@2`. */
  readonly spec: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * `npm install` into the adapter's folder, on Chips's Node. No install scripts: what it needs comes
 * as packages, and nothing fetched gets to run before a person has connected it.
 */
function npmInstall(job: Install): Promise<void> {
  return new Promise((resolve, reject) => {
    const registry = job.env["CHIPS_NPM_REGISTRY"];
    const child = spawn(
      job.node,
      [
        job.npm,
        "install",
        job.spec,
        "--prefix",
        job.folder,
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        ...(registry === undefined || registry === "" ? [] : ["--registry", registry]),
      ],
      { env: job.env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let said = "";
    child.stderr.on("data", (chunk: Buffer) => {
      said = `${said}${chunk.toString("utf8")}`.slice(-2000);
    });
    const late = setTimeout(() => child.kill("SIGTERM"), PATIENCE_MS);
    child.on("error", (error) => {
      clearTimeout(late);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(late);
      if (code === 0) resolve();
      else reject(new Error(said.trim() || `npm stopped with ${code ?? "a signal"}`));
    });
  });
}

export interface ReadyOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** Each thing done, in a few words for Chips for Mac's sheet. */
  readonly say?: (detail: string) => void;
  /** The install: npm's, unless a test's. */
  readonly install?: (job: Install) => Promise<void>;
}

/**
 * The kind with its adapter ready, where this bridge can see to that: the agent asked for first,
 * then the adapter fetched where it may be. Where it can't be, the kind comes back as it was and
 * `checkCommand` says what to do. Stops with what to do when the agent isn't there, or the download
 * fails.
 */
export async function readyAdapter(kind: KindConfig, options: ReadyOptions = {}): Promise<KindConfig> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const known = knownOf(kind);
  if (known === undefined || kind.command[0] !== known.program) return kind;
  const path = pathOf(kind, env);
  if (onPath(known.program, path)) return kind;
  if (!onPath(known.agent, path)) {
    throw new SetupError(`${kind.name} isn't installed on this machine: run \`${known.installLine}\`. ${STILL_GOOD}`, agentMissingStop(known));
  }
  const npm = env["CHIPS_NPM"];
  if (!known.fetches || npm === undefined || npm === "") return kind;
  const folder = adapterFolder(known.id, home);
  // Its link stays out of what npm is handed; npm's own node comes first, as the bridge's does.
  const { CHIPS_JOIN_LINK: _link, ...rest } = env;
  const node = process.execPath;
  options.say?.(`Getting what ${kind.name} needs from npm, a large download`);
  try {
    mkdirSync(folder, { recursive: true });
    await (options.install ?? npmInstall)({
      node,
      npm,
      folder,
      spec: `${known.adapter}@${known.adapterMajor}`,
      env: { ...rest, PATH: `${dirname(node)}${delimiter}${rest["PATH"] ?? ""}` },
    });
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    const why = error instanceof Error ? error.message : String(error);
    throw new SetupError(`${kind.name}'s adapter couldn't be downloaded: ${why}. ${STILL_GOOD}`, adapterFailedStop(kind.name));
  }
  const ready = withFetchedAdapter(kind, env, home);
  if (ready.command[0] === known.program) {
    rmSync(folder, { recursive: true, force: true });
    throw new SetupError(`${known.adapter} installed, but it has no ${known.program}. ${STILL_GOOD}`, adapterFailedStop(kind.name));
  }
  return ready;
}

/** A known kind's fetched adapter gone: `chips disconnect` has stopped the bridge that ran it. */
export function forgetAdapter(id: string, home: string = homedir()): void {
  if (knownConfig(id) !== undefined) rmSync(adapterFolder(id, home), { recursive: true, force: true });
}
