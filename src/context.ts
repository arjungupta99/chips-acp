/**
 * An agent's context in Chips (Chips ADRs 0134, 0238): the files Claude Code or Codex builds each
 * of this harness's agents from, sent to Chips as a copy so a person sees them on the agent's page,
 * and a person's edit there saved where the agent reads it. Chips adds no context of its own: each
 * kind lists what it gives its agents, and from where.
 *
 * Claude Code reads, when a conversation starts and again after it compacts: `CLAUDE.md`,
 * `CLAUDE.local.md`, `.claude/CLAUDE.md` and `.claude/rules/*.md` in the agent's folder and in
 * each folder above it; the person's own `~/.claude/CLAUDE.md`; and the agent's memory,
 * `~/.claude/projects/<its folder>/memory/MEMORY.md`, whose first 200 lines it reads and which it
 * writes too. Codex reads, when a conversation starts or resumes, the person's own
 * `~/.codex/AGENTS.override.md`, else `~/.codex/AGENTS.md`, and the agent's folder's
 * `AGENTS.override.md`, else its `AGENTS.md`: an agent's folder is in no git repository, so no
 * folder above it counts.
 *
 * An agent's own files are those in its folder, and its memory. The harness's own set is what its
 * agents read beside them: the `CLAUDE.md` of the folder Claude Code's agents are made in, which a
 * person may change for every agent at once; anything above it; and the person's own file, which
 * their own Claude Code or Codex reads too, so it is shown and not changed here.
 *
 * Chips takes an agent's file named as a shared one as given in its place. The agent reads both,
 * so a file of the harness's set is named by where it is (`~ › Chips › Agents › claude-code › CLAUDE.md`)
 * and an agent's by where it is in its folder (`CLAUDE.md`), and no name is in both.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, parse, relative, sep } from "node:path";
import { type AgentContextCopy, type HarnessContextCopy, Refuse } from "@chipschat/harness";
import { CONTEXT_FILE_BYTES, CONTEXT_FILES_SHOWN, contextBytes } from "@chipschat/protocol";
import { memoryOn, memoryPath, settingsLayers } from "./claude-settings.js";
import type { KnownId } from "./kinds.js";

/** Where this machine keeps what the agents read beside their folders. */
export interface Places {
  /** The person's home: `~` in a file's name. */
  readonly home: string;
  /** Claude Code's own folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  readonly claudeHome: string;
  /** Codex's: `CODEX_HOME`, else `~/.codex`. */
  readonly codexHome: string;
}

export function placesOf(env: NodeJS.ProcessEnv, home: string): Places {
  return {
    home,
    claudeHome: env["CLAUDE_CONFIG_DIR"] || join(home, ".claude"),
    codexHome: env["CODEX_HOME"] || join(home, ".codex"),
  };
}

/** One file the agents read: where it is, and how its row says it. */
interface Spot {
  readonly path: string;
  readonly name: string;
  readonly title: string;
  readonly role: "instructions" | "memory";
  readonly about?: string | undefined;
  /** Whether a person may change it here. One not there yet is shown empty, and saving makes it. */
  readonly editable: boolean;
  readonly whyReadOnly?: string | undefined;
  /** For a file of the harness's set: its id, and the folder whose agents read it (all, where none). */
  readonly id?: string | undefined;
  readonly over?: string | undefined;
}

/** What an edit from Chips asks: a file, its new words, and the version they were made from. */
export interface Edit {
  readonly name: string;
  readonly text: string;
  readonly base_hash: string | null;
}

/** The harness's own hash of a file's words, which an edit names as what it was made from. */
export function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function textOf(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Claude Code's files of one folder, those that may be there: `CLAUDE.md` first. */
function claudeFilesIn(dir: string): string[] {
  const rules = join(dir, ".claude", "rules");
  let named: string[] = [];
  try {
    named = readdirSync(rules)
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch {
    named = [];
  }
  return [
    join(dir, "CLAUDE.md"),
    join(dir, "CLAUDE.local.md"),
    join(dir, ".claude", "CLAUDE.md"),
    ...named.map((name) => join(rules, name)),
  ];
}

/** What an agent's own Claude Code file is for, by where it is in its folder. */
function ownTitle(within: string): string {
  if (within === "CLAUDE.md") return "How it works";
  if (within === "CLAUDE.local.md") return "Its local instructions";
  if (within === join(".claude", "CLAUDE.md")) return "More of how it works";
  return `Rule: ${parse(within).name}`.slice(0, 80);
}

/** The words a person reads for when the agent reads these. */
function readNote(name: string): string {
  return `${name} reads these when a conversation starts. A change made here applies from the next message.`;
}

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}${sep}`);

/** A file's parent folders, its own first. */
function* upFrom(dir: string): Generator<string> {
  for (let at = dir; ; at = dirname(at)) {
    yield at;
    if (dirname(at) === at) return;
  }
}

/**
 * Each agent's files and the harness's own set, for one of the two kinds this bridge knows, read
 * from disk each time they are asked for: nothing about them is kept here.
 */
export class ContextFiles {
  constructor(
    private readonly id: KnownId,
    private readonly kind: { readonly name: string; readonly folders: string; readonly folder?: string | undefined },
    private readonly places: Places,
    /** How much of an agent's `AGENTS.md` its Codex reads. */
    private readonly docBytes: number,
  ) {}

  /** `~/Chips/Agents/claude-code/CLAUDE.md`, or the whole path where it isn't in the home. */
  private tilde(path: string): string {
    const { home } = this.places;
    return within(path, home) ? `~${path.slice(home.length)}` : path;
  }

  /** A shared file's name: where it is, a step at a time (`~ › .codex › AGENTS.md`), with no slash. */
  private crumbs(path: string): string {
    const { home } = this.places;
    const steps = within(path, home) ? ["~", ...relative(home, path).split(sep)] : ["/", ...path.split(sep)];
    return steps.filter((step) => step !== "").join(" › ").slice(0, 255);
  }

  /** The harness's own set: what every agent, or every agent below a folder, reads beside its own. */
  private sharedSpots(): Spot[] {
    const { places, kind } = this;
    if (this.id === "codex") {
      const yours = [join(places.codexHome, "AGENTS.override.md"), join(places.codexHome, "AGENTS.md")].find(isFile);
      if (yours === undefined) return [];
      return [
        {
          path: yours,
          name: this.crumbs(yours),
          title: "For all your Codex",
          role: "instructions",
          about: this.tilde(yours),
          editable: false,
          whyReadOnly: "Your own Codex reads it too.",
          id: "yours",
        },
      ];
    }
    const spots: Spot[] = [];
    if (kind.folder === undefined) {
      const path = join(kind.folders, "CLAUDE.md");
      spots.push({
        path,
        name: this.crumbs(path),
        title: `For every ${kind.name} agent`.slice(0, 80),
        role: "instructions",
        about: this.tilde(path),
        editable: true,
        id: "every-agent",
        over: kind.folders,
      });
    }
    const yours = join(places.claudeHome, "CLAUDE.md");
    for (const dir of upFrom(kind.folder === undefined ? kind.folders : dirname(kind.folder))) {
      for (const path of claudeFilesIn(dir)) {
        if (path === yours || spots.some((spot) => spot.path === path) || !isFile(path)) continue;
        spots.push({
          path,
          name: this.crumbs(path),
          title: `From ${this.tilde(dir)}`.slice(0, 80),
          role: "instructions",
          about: this.tilde(path),
          editable: false,
          whyReadOnly: "It sits above the agents' folders.",
          id: `above-${hashOf(path).slice(0, 12)}`,
          over: dir,
        });
      }
    }
    if (isFile(yours)) {
      spots.push({
        path: yours,
        name: this.crumbs(yours),
        title: "For all your Claude Code",
        role: "instructions",
        about: this.tilde(yours),
        editable: false,
        whyReadOnly: "Your own Claude Code reads it too.",
        id: "yours",
      });
    }
    return spots;
  }

  /** An agent's own files: its folder's, and for Claude Code its memory, last. */
  private ownSpots(folder: string): Spot[] {
    if (this.id === "codex") {
      const override = join(folder, "AGENTS.override.md");
      const path = isFile(override) ? override : join(folder, "AGENTS.md");
      return [{ path, name: relative(folder, path), title: "How it works", role: "instructions", editable: true }];
    }
    const spots: Spot[] = claudeFilesIn(folder)
      .filter((path, at) => at === 0 || isFile(path))
      .map((path) => {
        const where = relative(folder, path);
        return { path, name: where.split(sep).join(" › "), title: ownTitle(where), role: "instructions", editable: true };
      });
    const memory = memoryPath(this.places.claudeHome, folder);
    if (memory !== undefined && memoryOn(settingsLayers(this.places.claudeHome, folder))) {
      spots.push({
        path: memory,
        name: "MEMORY.md",
        title: "What it remembers",
        role: "memory",
        about: "Claude Code reads its first 200 lines, and writes to it too.",
        editable: true,
      });
    }
    return spots;
  }

  /** The shared files an agent in `folder` reads. */
  private readBy(folder: string): Spot[] {
    return this.sharedSpots().filter((spot) => spot.over === undefined || within(folder, spot.over));
  }

  /** An agent's copy: its own files and the shared ones it reads, eight at most, and when it reads them. */
  agentCopy(folder: string): AgentContextCopy {
    const own = this.ownSpots(folder);
    const memory = own.filter((spot) => spot.role === "memory");
    const rows: Record<string, unknown>[] = [];
    const notShown: Record<string, unknown>[] = [];
    const add = (row: Record<string, unknown>, text?: string) => {
      const named = { name: row["name"], title: row["title"] };
      if (text !== undefined && contextBytes(text) > CONTEXT_FILE_BYTES) notShown.push({ ...named, reason: "too_large" });
      else if (rows.length >= CONTEXT_FILES_SHOWN) notShown.push({ ...named, reason: "count" });
      else rows.push(row);
    };
    const addOwn = (spot: Spot) => {
      const text = textOf(spot.path) ?? "";
      add(
        {
          name: spot.name,
          title: spot.title,
          role: spot.role,
          ...(spot.about === undefined ? {} : { about: spot.about }),
          text,
          hash: hashOf(text),
          editable: true,
        },
        text,
      );
    };
    for (const spot of own) if (spot.role !== "memory") addOwn(spot);
    for (const spot of this.readBy(folder)) {
      add({
        name: spot.name,
        title: spot.title,
        role: spot.role,
        ...(spot.about === undefined ? {} : { about: spot.about }),
        shared: spot.id,
        replaceable: false,
        editable: false,
      });
    }
    for (const spot of memory) addOwn(spot);
    return {
      files: rows,
      ...(notShown.length === 0 ? {} : { not_shown: notShown }),
      read_note: readNote(this.id === "codex" ? "Codex" : "Claude Code"),
    } as unknown as AgentContextCopy;
  }

  /** The harness's own set, each file with how many of its agents (in `folders`) read it. */
  harnessCopy(folders: readonly string[]): HarnessContextCopy {
    const shared: Record<string, unknown>[] = [];
    const notShown: Record<string, unknown>[] = [];
    for (const spot of this.sharedSpots()) {
      const text = textOf(spot.path) ?? "";
      const named = { name: spot.name, title: spot.title };
      if (contextBytes(text) > CONTEXT_FILE_BYTES) {
        notShown.push({ ...named, reason: "too_large" });
        continue;
      }
      if (shared.length >= CONTEXT_FILES_SHOWN) {
        notShown.push({ ...named, reason: "count" });
        continue;
      }
      const over = spot.over;
      shared.push({
        id: spot.id,
        name: spot.name,
        title: spot.title,
        role: spot.role,
        ...(spot.about === undefined ? {} : { about: spot.about }),
        text,
        hash: hashOf(text),
        editable: spot.editable,
        ...(spot.whyReadOnly === undefined ? {} : { why_read_only: spot.whyReadOnly }),
        used_by: over === undefined ? folders.length : folders.filter((folder) => within(folder, over)).length,
      });
    }
    return { shared, ...(notShown.length === 0 ? {} : { not_shown: notShown }) } as unknown as HarnessContextCopy;
  }

  /**
   * A person's edit of one of an agent's files, saved where the agent reads it, only if it is still
   * the version they changed. Refused, with the copy as it is, for a file that isn't the agent's own
   * to change, for one Codex would not read whole, and as `changed` for one changed since.
   */
  async saveAgent(folder: string, edit: Edit): Promise<void> {
    const now = () => this.agentCopy(folder);
    const spot = this.ownSpots(folder).find((each) => each.name === edit.name);
    if (spot === undefined) {
      const shared = this.readBy(folder).some((each) => each.name === edit.name);
      throw new Refuse(
        shared ? `Every agent reads this one. Change it on ${this.kind.name}'s page.` : `There is no file called ${edit.name} here.`,
        now(),
        "failed",
      );
    }
    if (edit.base_hash === null) {
      throw new Refuse("This file is the agent's own already.", now(), "failed");
    }
    if (this.id === "codex" && contextBytes(edit.text) > this.docBytes) {
      throw new Refuse(`Codex reads only the first ${Math.floor(this.docBytes / 1024)} KB of this file.`, now(), "failed");
    }
    await this.write(spot, edit, now);
  }

  /** A person's edit of one of the harness's own files, read by its agents beside their own. */
  async saveShared(folders: readonly string[], edit: Edit): Promise<void> {
    const now = () => this.harnessCopy(folders);
    const spot = this.sharedSpots().find((each) => each.name === edit.name);
    if (spot === undefined) throw new Refuse(`There is no file called ${edit.name} here.`, now(), "failed");
    if (!spot.editable) throw new Refuse(spot.whyReadOnly ?? "It can't be changed from Chips.", now(), "failed");
    if (edit.base_hash === null) {
      throw new Refuse("Every agent reads this file beside its own, so none can have its own in its place.", now(), "failed");
    }
    await this.write(spot, edit, now);
  }

  private async write(spot: Spot, edit: Edit, now: () => unknown): Promise<void> {
    if (hashOf(textOf(spot.path) ?? "") !== edit.base_hash) throw new Refuse("", now(), "changed");
    try {
      await mkdir(dirname(spot.path), { recursive: true });
      await writeFile(spot.path, edit.text, "utf8");
    } catch (error) {
      throw new Refuse(`It couldn't be saved: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300), now(), "failed");
    }
  }
}
