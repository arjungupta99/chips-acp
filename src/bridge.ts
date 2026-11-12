/**
 * One kind of ACP agent as a Chips harness: Claude Code, or Codex, or Goose, each run as its own
 * harness. Its agents are made from Chips — a room from the +, a new agent from a room's Add page,
 * a copy from Fork — and the bridge keeps each as a record: Chips's id, its key, its name, and the
 * folder it works in, its own unless it is a copy, which works on in its original's. There is no
 * Main agent: the agent Chips gives every harness, in the harness's own room, is one more of them,
 * and goes wherever a person moves it.
 *
 * One ACP process serves every agent. A room an agent is in is one ACP session of it, in its
 * folder, made the first time somebody there speaks to it and kept across restarts; a session
 * quiet for a while is closed, and loaded again on the next word.
 *
 * A message for an agent is a run: `session/prompt` with what Chips hands over (the room note,
 * what was said, the words; the room's rules once a session, and again after it compacts, Chips
 * ADR 0250), and what the agent streams back is the run — thoughts as its status,
 * tool calls as steps, its plan, its context gauge and cost — then its words in the room. What it
 * asks permission for is an approval card; what it asks with a form is a question card. Stop is
 * `session/cancel`. A steer is said to it as the next prompt of the same run, after stopping the
 * turn when the steer interrupts. Pause stops the turn as Stop does but keeps the run, and Resume
 * tells the same session to carry on (Chips ADR 0293). A person's "Not right?" on a reply is one
 * more turn of the agent who said it, in that room, looking at it again.
 *
 * An agent takes one turn at a time in a room. What is said to it meanwhile, and all it was sent
 * while the bridge was away, is one turn once it is free, not one each (Chips ADR 0294): the
 * newest message's, with those that waited ahead of it said in full, and what was said in the room
 * after, to others, said last. The Chips SDK words it (`promptFor`); `fold.ts` is what the bridge
 * keeps to make it.
 *
 * Each agent's page shows its context window, kept by the bridge from what the agent says
 * (`windows.ts`), and for Claude Code and Codex the files the agent is built from (`context.ts`)
 * and the model it runs on (`models.ts`). A person's Compact now is `/compact` said to the agent's
 * session as a turn of its own; a person's edit of a file starts that agent's sessions again before
 * its next turn, so it reads what changed; a person's pick of its model is set on its sessions.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Ack,
  Agent,
  AgentContextCopy,
  AgentContextWindowCopy,
  AgentModelCopy,
  Chips,
  Decision,
  HarnessContextCopy,
  Project,
  Run,
  SettingsHandlers,
  Speaker,
  SpaceAsked,
} from "@chipschat/harness";
import {
  firstTurnOf,
  heldNote,
  promptFor,
  pushedInWords,
  Refuse,
  rulesFor,
  sendAnswer,
  SessionRules,
} from "@chipschat/harness";
import {
  type AgentAsked,
  type AgentAttached,
  type AgentFork,
  type AnyEvent,
  type ContextEditFrame,
  type Feedback,
  type LastCompaction,
  LONG_TURN_FOLDS_MAX,
  type MessageNew,
  type MessageOverheard,
  type ModelChangeFrame,
  type ProjectFacts,
  type RiskClass,
  type RoomContext,
  type StepKind,
  type WindowChangeFrame,
  type WindowCompactFrame,
} from "@chipschat/protocol";
import {
  AcpClient,
  AcpError,
  type AgentInfo,
  type AgentRequest,
  type AuthStatus,
  type ConfigOption,
  configOptionsOf,
  isAuthRequired,
  notOffered,
  type SessionUpdate,
  type Wire,
} from "./acp.js";
import { settingsLayers } from "./claude-settings.js";
import { ContextFiles, type Places, placesOf } from "./context.js";
import { folds, GATHER_MS, type Heard, keepAnswered, keepHeard } from "./fold.js";
import { adapterEnv, codexDocBytes, type KnownId, knownIdOf, signedOutWords } from "./kinds.js";
import { VERSION } from "./version.js";
import {
  type Catalog,
  effortOption,
  lookAt,
  modelCopy,
  modelOption,
  type ModelPick,
  offers,
  pickFrom,
  pickIn,
  SETTINGS_LEVEL,
} from "./models.js";
import {
  bridgeLimit,
  CODEX_COMPACTED,
  claudeLimit,
  claudeOwn,
  claudeSessionSettings,
  compactionFacts,
  isCompaction,
  type KeptWindow,
  pastLimit,
  windowCopy,
} from "./windows.js";

/** The kind of agent this harness is, and how to run it. */
export interface KindConfig {
  /** The harness's name in Chips, and its own agent's: `Claude Code`. */
  readonly name: string;
  /** How to run it: `["claude-agent-acp"]`, `["codex-acp"]`, `["goose", "acp"]`. */
  readonly command: readonly string[];
  /** More environment for its process, beside this one's. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /**
   * The mode its sessions are put in, of those it offers. Claude Code's `default` asks before each
   * change and Codex's `workspace-write` before the network or outside its folder, so the asks reach
   * Chips as cards; their own modes (`auto`, `agent`) let the agent decide. Its own when absent.
   */
  readonly mode?: string | undefined;
  /** Where each agent gets a folder of its own, named after it: `~/Chips/Agents/claude-code`. */
  readonly folders: string;
  /** One folder every agent works in, in the place of one each: a repository they share. */
  readonly folder?: string | undefined;
}

/** One of the harness's agents, as the bridge keeps it. */
export interface AgentRecord {
  /** The bridge's name for it in Chips. */
  readonly key: string;
  /** Chips's id for it: empty until Chips has it. */
  agentId: string;
  /** What it is called in Chips, where a person may rename it. */
  name: string;
  /** Where its sessions work. */
  readonly folder: string;
  /** The agent it is a copy of. */
  readonly forkedFrom?: string | undefined;
  /** What it was made for — an `agent.asked`, an `agent.fork`, a room from the + — so an ask heard twice makes one. */
  readonly answers?: string | undefined;
  /** The model and effort a person picked for it in Chips (Chips ADR 0241); none, and it runs on the default. */
  model?: ModelPick | undefined;
}

/** What the bridge keeps across restarts beside the SDK's own store. */
export interface BridgeState {
  /** `<agent key>|<space id>` → the ACP session that room is. */
  sessions: Record<string, string>;
  /** The harness's agents, by key. */
  agents: Record<string, AgentRecord>;
  /** Each agent's context window as it last said, by key (Chips ADR 0146): sent again after a restart. */
  windows?: Record<string, KeptWindow>;
  /** What the agent offers to run on, as it said when the bridge last looked (Chips ADR 0241). */
  models?: Catalog;
  /**
   * What each session has cost in all, as the agent last said, by session: what its next turn's
   * cost is counted from. Kept here, not only in memory, because Claude Code's total goes on across
   * a restart: a bridge that forgot it took the session's whole cost for its next turn's.
   */
  costs?: Record<string, number>;
}

export interface BridgeOptions {
  readonly chips: Chips;
  readonly kind: KindConfig;
  readonly state: BridgeState;
  readonly saveState: (state: BridgeState) => void;
  /** How to run the agent: its process, unless a test hands in a wire of its own. */
  readonly wire: () => Wire;
  readonly log?: ((line: string) => void) | undefined;
  /**
   * Whether each agent works on its room's project in a copy in its own folder (Chips ADR 0221):
   * true when this machine has a git new enough. Agents the config puts in one `folder` of the
   * person's work there as they always have.
   */
  readonly projects?: boolean | undefined;
  /**
   * Whether each agent's model is shown in Chips and picked there (Chips ADR 0241): true for Claude
   * Code and Codex, whose adapters offer their models as session options. The bridge looks at what
   * the agent offers each time it starts it.
   */
  readonly models?: boolean | undefined;
  /** How long to wait before running the agent again after it stopped. */
  readonly respawnMs?: number | undefined;
  /** How long a session may be quiet before it is closed: half an hour unless said. */
  readonly idleMs?: number | undefined;
  /** How long an idle agent waits before it starts, so all it is sent at once is one turn: 150 ms unless said. */
  readonly gatherMs?: number | undefined;
  /**
   * The environment the agent runs in, for where its files are (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`)
   * and what beats its settings: this process's with the kind's, unless a test hands in its own.
   */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The person's home, where `~/.claude` and `~/.codex` are: this machine's unless said. */
  readonly home?: string | undefined;
}

/** How often a run's status and context gauge may change, so a stream of thoughts isn't a stream of events. */
const QUIET_MS = 1500;
/** How long a message waits for the agent to be running again before its run fails. */
const WAIT_FOR_AGENT_MS = 15_000;
/** The longest wait before running the agent again when it keeps stopping. */
const MOST_RESPAWN_MS = 60_000;
const IDLE_MS = 30 * 60_000;
/** How many feedback ids are kept as answered, so a replay or a repeat looks again once. */
const ANSWERED = 500;
/** The most of a reply quoted back to the agent that said it. */
const QUOTED = 1500;
/** What a paused run's agent is told on Resume (Chips ADR 0293), before anything steered meanwhile. */
const CARRY_ON = "You were paused partway through this. Carry on from where you stopped. Nothing you wrote before the pause reached the room, so write your whole reply.";

/** The agent's process: one for every agent of the kind, a session for each of their rooms. */
interface Process {
  client?: AcpClient | undefined;
  info?: AgentInfo | undefined;
  /** Who it last said it is signed in as, so the log says each change once. */
  auth?: string | undefined;
  /** Sessions open in this process, so a stored one is loaded once. */
  readonly live: Set<string>;
  /**
   * Live sessions to close and load again before their next turn: a file they read was changed
   * from Chips, or the settings they start with. The agent reads its files when a session starts.
   */
  readonly stale: Set<string>;
  stopping: boolean;
  /** How many times in a row it stopped without saying hello: the wait to run it again grows. */
  failures: number;
}

/** A message for one of the harness's agents, and which: the one that answers it. */
interface Asked {
  readonly message: MessageNew;
  /** The agent it was for, or none where Chips named only the harness. */
  readonly speakerId: string | undefined;
  /**
   * A second look's (Chips ADR 0200): what its run is called, in the place of the message's first
   * line. Its words name who asked already, so they aren't said as theirs.
   */
  readonly again?: string | undefined;
  /**
   * What was said in the room to others after it arrived, while it waited as the newest (Chips ADR
   * 0294): its turn is told, so it starts on the room as it is.
   */
  readonly since: Heard[];
}

/** Whether a waiting message may share a turn with others: not a second look, nor one Chips handed over. */
function shares(asked: Asked): boolean {
  return asked.again === undefined && folds(asked.message);
}

/**
 * The waiting messages that make an agent's next turn (Chips ADR 0294), taken off its queue, oldest
 * first: all of them, up to one that is a turn of its own, which is the turn after.
 */
function nextTurn(queue: Asked[]): Asked[] {
  const first = queue.shift();
  if (first === undefined) return [];
  const taken = [first];
  if (!shares(first)) return taken;
  while (queue[0] !== undefined && shares(queue[0]) && queue[0].speakerId === first.speakerId) {
    taken.push(queue.shift() as Asked);
  }
  return taken;
}

/** A compaction a room's session is to have, after the turn going in it: a person's, or past its limit. */
interface CompactAsk {
  readonly by: LastCompaction["by"];
  /** The person's Compact now it answers. */
  readonly changeId?: string | undefined;
}

/** One agent's session in one room, and the turn going in it. */
interface Room {
  readonly record: AgentRecord;
  readonly spaceId: string;
  readonly queue: Asked[];
  busy: boolean;
  turn?: Turn | undefined;
  /** A compaction to run before the next message. */
  compact?: CompactAsk | undefined;
  /** When it last ended a turn, for closing it once it has been quiet a while. */
  usedAt: number;
  /** It is about to start: a moment in which all it is sent at once gathers (Chips ADR 0294). */
  gathering?: NodeJS.Timeout | undefined;
  /**
   * The messages its session has been given, the newest of them: one that arrives while their turn
   * goes is sent with them among the lines since, and its turn leaves them out (Chips ADR 0294).
   */
  readonly answered: string[];
  /**
   * What Chips answered when it held the agent's last words here from the agents they named (Chips
   * ADR 0097): its next turn in the room is told, first.
   */
  heldPost?: Pick<Ack, "held" | "exchange"> | undefined;
}

/** How many rooms' lines from before an agent joined are kept for its first turn there. */
const CAUGHT_UP_MOST = 200;

/** The turn going in a room: its run, and what the agent has streamed into it. */
interface Turn {
  readonly run: Run;
  /** Who it is said as: the Chips agent the message was for. */
  readonly speaker: Speaker;
  /** What it ran on, for the gauge and the cost: ACP doesn't say the model, so the kind. */
  readonly agentName: string;
  /** The room's session, once it is open: empty until then. */
  sessionId: string;
  /** Its words since its last tool call: the reply, unless more come after another. */
  reply: string;
  /** Its words before a tool call, which were on the way. */
  readonly said: string[];
  thought: string;
  /** More to say to it in this run: a person's steer. */
  readonly next: string[];
  cancelled: boolean;
  /** A prompt is in the agent's hands: what Stop, Pause and an interrupting steer stop. */
  prompting: boolean;
  /** That prompt was told to stop (`session/cancel`), so it is told once. */
  stopping: boolean;
  /** A person's Pause stopped that prompt partway (Chips ADR 0293): what follows is "carry on", not the end. */
  pausing: boolean;
  /** How many of its asks wait on a person: a Pause while one does stops nothing. */
  asking: number;
  /** What the session had cost in all when the turn began; none when the bridge doesn't know. */
  costAtStart?: number | undefined;
  /** What the session has cost in all, as the agent last said in the turn. */
  cost?: number | undefined;
  saidAt: number;
  gaugeAt: number;
  readonly steps: Map<string, { title: string; tool: string; kind: StepKind; done: boolean }>;
  /** Tool calls a person allowed, to their approvals: the card says how each went. */
  readonly allowed: Map<string, string>;
  /** The agent's copy of the room's project, brought up to date as the turn began (Chips ADR 0221). */
  project?: Project | undefined;
  /** The most its session held during the turn, and how many times it compacted itself in it. */
  peak: number;
  folds: number;
}

/** A compaction a session is in, or last had, by its tool call (or its words, Codex's old way). */
interface Compaction {
  readonly id: string;
  from?: number | undefined;
  to?: number | undefined;
  /** Who asked, where the agent says (Claude Code's `trigger`). */
  by?: LastCompaction["by"] | undefined;
  done: boolean;
  /** What the session said it held while compacting: Codex says its after-size just before it is done. */
  latest?: number | undefined;
  /** What it came to, once it has. */
  finished?: LastCompaction | undefined;
}

/** One of the bridge's own `/compact` turns: who it is for, and what came of it. */
interface CompactRun {
  readonly by: LastCompaction["by"];
  words: string;
  done: boolean;
}

export class Bridge {
  private readonly process: Process = { live: new Set(), stale: new Set(), stopping: false, failures: 0 };
  private readonly rooms = new Map<string, Room>();
  private readonly log: (line: string) => void;
  /** What Chips asks waits for the agents to be known: they are read at start. */
  private readonly known: Promise<void>;
  private knew: () => void = () => undefined;
  /** What is said in the rooms is taken in the order it came: a message, then what was overheard after it. */
  private arriving: Promise<unknown> = Promise.resolve();
  /**
   * What was said in a room before one of its agents joined it (Chips ADR 0088), by the agent and
   * the room: said at the agent's first turn there, and kept no longer.
   */
  private readonly caughtUp = new Map<string, Pick<RoomContext, "lines">>();
  /** Records are made one at a time, so two never take the same folder. */
  private making: Promise<unknown> = Promise.resolve();
  /** The feedback already answered, oldest first. */
  private readonly answered = new Set<string>();
  private sweeper?: NodeJS.Timeout | undefined;
  /** The environment the agent runs in. */
  private readonly env: NodeJS.ProcessEnv;
  private readonly places: Places;
  /** Claude Code or Codex, whose files and limits this bridge knows; nothing for any other kind. */
  private readonly knownKind: KnownId | undefined;
  /** The files the agents are built from (Chips ADR 0134), for the two kinds this bridge knows. */
  private readonly files: ContextFiles | undefined;
  /** Whether the agent said it takes `/compact` (`available_commands_update`): any kind but the two known. */
  private offersCompact = false;
  /** Each session's last `used`, for where a compaction began. */
  private readonly sessionUsed = new Map<string, number>();
  /** The room's rules each session holds (Chips ADR 0250): said once, and again after it compacts. */
  private readonly rules = new SessionRules();
  private readonly compactions = new Map<string, Compaction>();
  /** The bridge's own `/compact` turns, by session. */
  private readonly compactRuns = new Map<string, CompactRun>();
  /** Agents compacting now, by key: waiting for a turn to end, or under way. */
  private readonly compacting = new Map<string, "queued" | "running">();
  /** A window copy to send in a moment, by agent key: readings come in bursts. */
  private readonly windowTimers = new Map<string, NodeJS.Timeout>();
  /** Each live session's options as the agent last said them: its model and effort among them. */
  private readonly sessionOptions = new Map<string, readonly ConfigOption[]>();

  constructor(private readonly options: BridgeOptions) {
    this.log = options.log ?? (() => undefined);
    this.known = new Promise((resolve) => {
      this.knew = resolve;
    });
    this.env = options.env ?? adapterEnv(options.kind, { ...process.env, ...options.kind.env });
    this.places = placesOf(this.env, options.home ?? homedir());
    this.knownKind = knownIdOf(options.kind);
    this.files =
      this.knownKind === undefined
        ? undefined
        : new ContextFiles(this.knownKind, options.kind, this.places, codexDocBytes(this.env));
  }

  /** Hear what Chips asks, learn the agents Chips has, run the agent, and close idle sessions. */
  async start(): Promise<void> {
    const { chips } = this.options;
    const after = (what: string, then: () => Promise<void>) => {
      void this.known.then(then).catch((error: unknown) => this.log(`${what} went wrong: ${messageOf(error)}`));
    };
    const inOrder = (what: string, then: () => Promise<void>) => {
      this.arriving = this.arriving
        .then(() => this.known)
        .then(then)
        .catch((error: unknown) => this.log(`${what} went wrong: ${messageOf(error)}`));
    };
    chips.on("message.new", (message) => inOrder("a message", () => this.hear(message)));
    chips.on("message.overheard", (message) => inOrder("words overheard", async () => this.overheard(message)));
    chips.on("agent.attached", (attached) => this.attached(attached));
    chips.on("agent.asked", (asked) => after("a new agent", () => this.make(asked)));
    chips.on("agent.fork", (fork) => after("a copy", () => this.copy(fork)));
    chips.on("feedback", (feedback) => after("a second look", () => this.lookAgain(feedback)));
    chips.on("event", (event) => after(event.type, () => this.noted(event)));
    chips.onSpaceAsked((asked) => after("a room from the +", () => this.claim(asked)));
    await this.know(await chips.agents.list(), { forget: true });
    this.knew();
    // What each agent is built from, how full it last said it was, and what it runs on (Chips ADRs 0134, 0146, 0241).
    await this.sendContexts();
    for (const record of this.records()) await this.sendWindow(record);
    await this.sendModels();
    await this.run();
    const idleMs = this.options.idleMs ?? IDLE_MS;
    this.sweeper = setInterval(() => void this.sweep(idleMs), Math.max(10, Math.min(60_000, idleMs / 2)));
    this.sweeper.unref();
    await this.sayHowItIs();
  }

  /** Stop the agent and run it again: a person's Restart. */
  async restart(): Promise<void> {
    this.process.stopping = true;
    this.process.client?.close();
    this.process.stopping = false;
    await this.run();
    await this.sayHowItIs();
  }

  stop(): void {
    this.process.stopping = true;
    this.process.client?.close();
    clearInterval(this.sweeper);
    for (const room of this.rooms.values()) clearTimeout(room.gathering);
    for (const timer of this.windowTimers.values()) clearTimeout(timer);
    this.windowTimers.clear();
  }

  // ------------------------------------------------------------------ the agents

  private records(): AgentRecord[] {
    return Object.values(this.options.state.agents);
  }

  private save(): void {
    const { state } = this.options;
    // A session no room has any more needs no cost kept.
    if (state.costs !== undefined) {
      const kept = new Set(Object.values(state.sessions));
      for (const sessionId of Object.keys(state.costs)) if (!kept.has(sessionId)) delete state.costs[sessionId];
    }
    this.options.saveState(state);
  }

  /** One record made at a time. */
  private one<T>(make: () => Promise<T>): Promise<T> {
    const made = this.making.then(make, make);
    this.making = made.catch(() => undefined);
    return made;
  }

  /**
   * The agents Chips has, each kept as a record: a new one — the harness's own, the agent a claim
   * made, one made while the bridge was away — gets a folder; a renamed one its name. At start, a
   * record Chips no longer has is forgotten: its agent was deleted while the bridge was away.
   */
  private async know(agents: readonly Agent[], { forget = false } = {}): Promise<void> {
    await this.one(async () => {
      const { state } = this.options;
      let changed = false;
      for (const agent of agents) {
        const kept = state.agents[agent.key];
        if (kept !== undefined) {
          if (kept.agentId === agent.agentId && kept.name === agent.name) continue;
          kept.agentId = agent.agentId;
          kept.name = agent.name;
          changed = true;
          continue;
        }
        // A copy made while the bridge was away works on in its original's folder.
        const forkedFrom = agent.forkedFrom ?? undefined;
        const original = this.records().find((each) => forkedFrom !== undefined && each.agentId === forkedFrom);
        state.agents[agent.key] = {
          key: agent.key,
          agentId: agent.agentId,
          name: agent.name,
          folder: original?.folder ?? (await this.folderFor(agent.name)),
          ...(forkedFrom === undefined ? {} : { forkedFrom }),
          ...(original?.model === undefined ? {} : { model: original.model }),
        };
        changed = true;
      }
      if (changed) {
        this.save();
        this.agentsChanged();
      }
    });
    if (!forget) return;
    for (const record of this.records()) {
      if (!agents.some((agent) => agent.key === record.key)) await this.forget(record.key);
    }
  }

  /** A record for an agent Chips is about to be asked to register: a new key, and its folder. */
  private made(
    name: string,
    more: { readonly answers: string; readonly folder?: string; readonly forkedFrom?: string; readonly model?: ModelPick | undefined },
  ): Promise<AgentRecord> {
    return this.one(async () => {
      const kept = this.records().find((record) => record.answers === more.answers);
      if (kept !== undefined) return kept;
      const record: AgentRecord = {
        key: `acp:${randomBytes(6).toString("hex")}`,
        agentId: "",
        name,
        folder: more.folder ?? (await this.folderFor(name)),
        answers: more.answers,
        ...(more.forkedFrom === undefined ? {} : { forkedFrom: more.forkedFrom }),
        ...(more.model === undefined ? {} : { model: more.model }),
      };
      this.options.state.agents[record.key] = record;
      this.save();
      return record;
    });
  }

  /**
   * A folder of the agent's own, named after it, made empty: never one another agent has, nor one
   * on disk already, which a deleted agent may have left. The config's one folder, where it names one.
   */
  private async folderFor(name: string): Promise<string> {
    const { kind } = this.options;
    if (kind.folder !== undefined) {
      await mkdir(kind.folder, { recursive: true });
      return kind.folder;
    }
    const base = slugOf(name).replace(/_/g, "-") || "agent";
    const taken = new Set(this.records().map((record) => record.folder));
    for (let n = 1; ; n += 1) {
      const folder = join(kind.folders, n === 1 ? base : `${base}-${n}`);
      if (taken.has(folder) || existsSync(folder)) continue;
      await mkdir(folder, { recursive: true });
      return folder;
    }
  }

  /** The record a Chips agent is, read afresh once when it is new to the bridge. */
  private async recordOf(agentId: string): Promise<AgentRecord | undefined> {
    const find = () => this.records().find((record) => record.agentId === agentId);
    const found = find();
    if (found !== undefined) return found;
    await this.know(await this.options.chips.agents.list().catch(() => []));
    return find();
  }

  /** Registered: the record takes Chips's id and name, which Chips may have numbered. */
  private registered(record: AgentRecord, agent: Agent): void {
    record.agentId = agent.agentId;
    record.name = agent.name;
    this.save();
    this.agentsChanged();
  }

  /**
   * A person asked for a new agent in a room (ADR 0108): a record and a folder of its own, then
   * registered for the room, which Chips puts it in.
   */
  private async make(asked: AgentAsked): Promise<void> {
    const { chips } = this.options;
    if (asked.harness_id !== chips.harnessId || asked.space_id === undefined) return;
    const record = await this.made(asked.name, { answers: asked.id });
    try {
      const agent = await chips.agents.register({
        key: record.key,
        name: asked.name,
        madeFor: asked.id,
        spaceId: asked.space_id,
      });
      this.registered(record, agent);
      this.log(`${agent.name} made, in ${record.folder}${agent.attached === false ? `; not in the room: ${agent.why ?? "late"}` : ""}`);
    } catch (error) {
      if (record.agentId === "") delete this.options.state.agents[record.key];
      this.save();
      throw error;
    }
  }

  /**
   * A person asked for a copy of an agent in a room (ADR 0087, Fork): the agent's session in the
   * room it is in, copied with `session/fork` in the same folder, is the copy's session in the room
   * asked; the copy is registered for it. One that never spoke there is copied as a new agent in
   * the same folder. A session that won't copy makes no copy: Chips tells the person. The copy
   * starts with its original's pick of a model.
   */
  private async copy(fork: AgentFork): Promise<void> {
    const { chips, state } = this.options;
    const spaceId = fork.space_id;
    if (spaceId === undefined) return;
    const original = await this.recordOf(fork.agent_id);
    if (original === undefined) return;
    let record = this.records().find((each) => each.answers === fork.id);
    if (record === undefined) {
      const from = await this.sessionOf(original);
      let copied: { client: AcpClient; sessionId: string } | undefined;
      if (from !== undefined) {
        const client = await this.running();
        if (client === undefined || this.process.info?.forkSession !== true) {
          this.log(`${original.name} can't be copied: ${client === undefined ? "the agent isn't running" : "the agent doesn't copy sessions"}`);
          return;
        }
        const forked = await client.forkSession(from, original.folder);
        copied = { client, sessionId: forked.sessionId };
        this.process.live.add(forked.sessionId);
        this.sessionOptions.set(forked.sessionId, forked.configOptions);
        await this.moded(client, forked.sessionId);
      }
      record = await this.made(forkName(original.name), {
        answers: fork.id,
        folder: original.folder,
        forkedFrom: original.agentId,
        model: original.model,
      });
      if (copied !== undefined) {
        state.sessions[`${record.key}|${spaceId}`] = copied.sessionId;
        this.save();
        await this.modelled(copied.client, record, copied.sessionId);
      }
    }
    const agent = await chips.agents.register({
      key: record.key,
      name: record.name,
      forkedFrom: original.agentId,
      spaceId,
    });
    this.registered(record, agent);
    this.log(`${agent.name}, a copy of ${original.name}, made${agent.attached === false ? `; not in the room: ${agent.why ?? "late"}` : ""}`);
  }

  /** The session to copy of an agent: its room's, or where it is in none, the last it had. */
  private async sessionOf(record: AgentRecord): Promise<string | undefined> {
    const { chips, state } = this.options;
    const room = (await chips.agents.list().catch(() => [])).find((agent) => agent.agentId === record.agentId)?.room;
    if (room !== undefined && room !== null) return state.sessions[`${record.key}|${room}`];
    return Object.entries(state.sessions).findLast(([id]) => id.startsWith(`${record.key}|`))?.[1];
  }

  /**
   * A room a person asked for from the + (or beside another harness): claimed under a new key,
   * which Chips makes an agent for and puts in the room; the agent gets a record and a folder, and
   * answers the first words.
   */
  private async claim(asked: SpaceAsked): Promise<void> {
    const { chips } = this.options;
    const { spaceId, firstMessage } = asked;
    const key = this.records().find((record) => record.answers === spaceId)?.key ?? `acp:${randomBytes(6).toString("hex")}`;
    await chips.claimSpace(spaceId, key, titleFrom(firstMessage.text));
    const agent = (await chips.agents.list()).find((each) => each.key === key);
    if (agent === undefined) {
      this.log(`claimed ${spaceId}, and Chips put no agent there`);
      return;
    }
    const record =
      this.options.state.agents[key] ??
      (await this.one(async () => {
        const made: AgentRecord = {
          key,
          agentId: agent.agentId,
          name: agent.name,
          folder: await this.folderFor(agent.name),
          answers: spaceId,
        };
        this.options.state.agents[key] = made;
        this.save();
        this.agentsChanged();
        return made;
      }));
    this.log(`${agent.name} claimed ${spaceId}, in ${record.folder}`);
    // The first words are the ask's, not heard again as a message: said to the agent as one, with
    // the room's note Chips wrote for the harness before the agent was made (Chips ADR 0092's
    // addendum), or alone when they were read from the room's history.
    const message =
      firstTurnOf(asked, agent.agentId) ??
      ({
        type: "message.new",
        space_id: spaceId,
        message_id: firstMessage.messageId,
        text: firstMessage.text,
        from: { participant_id: asked.askedBy, kind: "person", display_name: await this.whoSaid(asked), role: "member" },
        for: [agent.agentId],
      } as unknown as MessageNew);
    const room = this.roomOf(record, spaceId);
    room.queue.push({ message, speakerId: agent.agentId, since: [] });
    this.soon(room);
  }

  /** Who said a room's first words, from the room's lines. */
  private async whoSaid(asked: SpaceAsked): Promise<string> {
    const context = await this.options.chips.roomContext(asked.spaceId, { limit: 20 }).catch(() => undefined);
    return context?.lines.find((line) => line.message_id === asked.firstMessage.messageId)?.from.name ?? "Someone";
  }

  /**
   * What else of the harness's agents a person changed: a delete forgets one, a rename names it.
   * Workspace events, which the SDK's own list of a harness's events doesn't type.
   */
  private async noted(event: AnyEvent): Promise<void> {
    const heard = event as unknown as Readonly<Record<string, unknown>>;
    if (heard["type"] === "agent.deleted") {
      if (heard["harness_id"] === this.options.chips.harnessId) await this.forget(String(heard["key"]));
      return;
    }
    const name = heard["name"];
    if (heard["type"] !== "agent.updated" || typeof name !== "string") return;
    const record = this.records().find((each) => each.agentId === heard["agent_id"]);
    if (record === undefined || record.name === name) return;
    this.log(`${record.name} is ${name} now`);
    record.name = name;
    this.save();
  }

  /** A deleted agent: its sessions closed and its record gone. Its folder stays: what it wrote is a person's to delete. */
  private async forget(key: string): Promise<void> {
    const { state } = this.options;
    const record = state.agents[key];
    if (record === undefined) return;
    delete state.agents[key];
    delete state.windows?.[key];
    this.compacting.delete(key);
    clearTimeout(this.windowTimers.get(key));
    this.windowTimers.delete(key);
    if (record.agentId !== "") this.options.chips.settings.forget(record.agentId);
    for (const [id, room] of this.rooms) {
      if (room.record.key !== key) continue;
      room.queue.length = 0;
      if (room.turn !== undefined && room.turn.sessionId !== "") this.process.client?.cancel(room.turn.sessionId);
      this.rooms.delete(id);
    }
    for (const [id, sessionId] of Object.entries(state.sessions)) {
      if (!id.startsWith(`${key}|`)) continue;
      delete state.sessions[id];
      this.sessionOptions.delete(sessionId);
      if (this.process.live.delete(sessionId) && this.process.info?.closeSession === true) {
        await this.process.client?.closeSession(sessionId).catch(() => undefined);
      }
    }
    this.save();
    this.agentsChanged();
    this.log(`${record.name} deleted; its folder stays, ${record.folder}`);
  }

  // ------------------------------------------------------------------ the agent's process

  private async run(): Promise<void> {
    const proc = this.process;
    const { name } = this.options.kind;
    proc.live.clear();
    proc.stale.clear();
    proc.info = undefined;
    this.sessionOptions.clear();
    let wire: Wire;
    try {
      wire = this.options.wire();
    } catch (error) {
      this.log(`${name} didn't start: ${String(error)}`);
      return;
    }
    const client = new AcpClient(wire, {
      update: (sessionId, update) => this.updated(sessionId, update),
      request: (request) => this.asked(request),
      exit: (why) => void this.stopped(client, why),
      auth: (status) => this.signedIn(status),
    });
    proc.client = client;
    try {
      proc.info = await client.initialize({ name: "chips-acp", version: VERSION });
      proc.failures = 0;
      this.log(`${name} is running${proc.info.name === undefined ? "" : ` (${proc.info.name})`}`);
      // What it offers to run on, each time it starts: an update may have changed it (Chips ADR 0241).
      if (this.options.models === true) void this.look(client);
    } catch (error) {
      this.log(`${name} didn't say hello: ${String(error)}`);
      client.close();
    }
  }

  /** Its sign-in in the log, once a change: a signed-out agent fails every turn until it's put right. */
  private signedIn(status: AuthStatus): void {
    const said = status.kind === "none" ? "none" : `${status.kind} ${status.label ?? ""}`;
    if (this.process.auth === said) return;
    this.process.auth = said;
    const { kind } = this.options;
    this.log(
      status.kind === "none"
        ? `${signedOutWords(kind, this.process.info)} Its turns fail until then.`
        : `${kind.name} is signed in${status.label === undefined ? "" : `: ${status.label}`}`,
    );
  }

  /** What a turn's failure says: how to sign in when that's why, else the agent's own words. */
  private failure(record: AgentRecord, error: unknown, what = ""): string {
    if (isAuthRequired(error)) return `${signedOutWords(this.options.kind, this.process.info)} Then send this again.`;
    return `${record.name}${what}: ${messageOf(error)}`;
  }

  private async stopped(client: AcpClient, why: string): Promise<void> {
    const proc = this.process;
    const { name } = this.options.kind;
    if (proc.client !== client) return;
    proc.client = undefined;
    for (const room of this.rooms.values()) {
      if (room.turn === undefined) continue;
      room.turn.cancelled = true;
      if (!room.turn.run.over) {
        await room.turn.run.fail({ error: `${name} stopped (${why}).`, retryable: true }).catch(() => undefined);
      }
    }
    if (proc.stopping) return;
    if (proc.info === undefined) proc.failures += 1;
    this.log(`${name} stopped: ${why}`);
    await this.sayHowItIs();
    const wait = Math.min((this.options.respawnMs ?? 2000) * 2 ** proc.failures, MOST_RESPAWN_MS);
    setTimeout(() => {
      if (proc.client === undefined && !proc.stopping) void this.run().then(() => this.sayHowItIs());
    }, wait).unref();
  }

  /** The agent's connection once it is running and has said hello, waiting a while if it is coming back. */
  private async running(): Promise<AcpClient | undefined> {
    const by = Date.now() + WAIT_FOR_AGENT_MS;
    while (!this.process.stopping) {
      const client = this.process.client;
      if (client !== undefined && !client.gone && this.process.info !== undefined) return client;
      if (Date.now() > by) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  }

  /** Trouble while the agent isn't running, and fine once it is (ADR 0083). */
  private async sayHowItIs(): Promise<void> {
    const { chips, kind } = this.options;
    const client = this.process.client;
    const said = client === undefined || client.gone ? chips.reportTrouble(`${kind.name} isn't running`) : chips.reportOk();
    await said.catch(() => undefined);
  }

  /**
   * Sessions quiet for `idleMs`, closed: each open Claude Code session keeps a process of its own.
   * Only where the agent loads them again, so nothing it remembers is lost.
   */
  private async sweep(idleMs: number): Promise<void> {
    const { client, info, live } = this.process;
    if (client === undefined || client.gone || info?.closeSession !== true || !info.loadSession) return;
    const quietSince = Date.now() - idleMs;
    for (const [id, room] of this.rooms) {
      if (room.busy || room.queue.length > 0 || room.usedAt > quietSince) continue;
      const sessionId = this.options.state.sessions[id];
      if (sessionId === undefined || !live.has(sessionId)) continue;
      room.busy = true;
      try {
        await client.closeSession(sessionId);
        live.delete(sessionId);
        this.process.stale.delete(sessionId);
        this.sessionOptions.delete(sessionId);
        this.log(`${room.record.name}'s session in ${room.spaceId} closed, quiet ${Math.round(idleMs / 60_000)} min`);
      } catch (error) {
        this.log(`${room.record.name}'s session in ${room.spaceId} stays open: ${messageOf(error)}`);
      } finally {
        room.busy = false;
        void this.pump(room);
      }
    }
  }

  // ------------------------------------------------------------------ what is said to it

  /**
   * A message for some of its agents: each takes it in its room, one turn at a time there. It waits
   * while a turn is going, and is in the next with whatever else waits (Chips ADR 0294).
   */
  private async hear(message: MessageNew, again?: string): Promise<void> {
    const spaceId = message.space_id;
    if (spaceId === undefined) return;
    const harnessId = this.options.chips.harnessId;
    const takes = new Set<Room>();
    for (const taker of message.for ?? [harnessId]) {
      const record = taker === harnessId ? await this.inRoom(spaceId) : await this.recordOf(taker);
      if (record === undefined) continue;
      const room = this.roomOf(record, spaceId);
      takes.add(room);
      room.queue.push({ message, speakerId: taker === harnessId ? undefined : taker, again, since: [] });
      this.soon(room);
    }
    // To its other agents in the room it was said to somebody else, as what they overhear is.
    if (again === undefined) this.saidToOthers(spaceId, message, takes);
  }

  /**
   * One of its agents put in a room (Chips ADR 0088): the room's last lines before it joined come
   * with the news, and are kept for the agent's first turn there, which says them once.
   */
  private attached(attached: AgentAttached): void {
    const { agent_id: agentId, space_id: spaceId, catch_up: before } = attached;
    if (spaceId === undefined || before === undefined || before.lines.length === 0) return;
    this.caughtUp.set(`${agentId}|${spaceId}`, before);
    for (const oldest of this.caughtUp.keys()) {
      if (this.caughtUp.size <= CAUGHT_UP_MOST) break;
      this.caughtUp.delete(oldest);
    }
  }

  /**
   * Words said in a room to others (Chips ADR 0294): kept where a message waits for one of its
   * agents there, as said after the newest of them, and told to the turn that takes it. Chips
   * hands a turn what was said before its message; this is what is said while the message waits.
   */
  private overheard(message: MessageOverheard): void {
    if (message.space_id !== undefined) this.saidToOthers(message.space_id, message, new Set());
  }

  /** Kept by each of its agents in the room with a message waiting, but those it is for, and the one who said it. */
  private saidToOthers(spaceId: string, said: Heard, takes: ReadonlySet<Room>): void {
    for (const room of this.rooms.values()) {
      const newest = room.queue.at(-1);
      if (newest === undefined || room.spaceId !== spaceId || takes.has(room)) continue;
      if (said.from.participant_id === room.record.agentId) continue;
      keepHeard(newest.since, { from: said.from, text: said.text, attachments: said.attachments, held: said.held });
    }
  }

  /**
   * An idle agent starts in a moment, not at once (Chips ADR 0294): a bridge that comes back is
   * sent all it missed together, and what waits when a turn starts is one turn.
   */
  private soon(room: Room): void {
    if (room.busy || room.gathering !== undefined) return;
    room.gathering = setTimeout(() => {
      room.gathering = undefined;
      void this.pump(room);
    }, this.options.gatherMs ?? GATHER_MS);
  }

  /**
   * A person said a reply of one of its agents wasn't right (Chips ADR 0200): a correction, or an
   * older device's 👎. The agent who said it, found by the reply's id in the room's lines, looks
   * again as one more turn in that room's session, told its reply and what was wrong; its answer
   * goes in the room as any does. A reply not in the lines is the room's agent's to look at. A 👍,
   * or any other reaction, is nothing, and each feedback is answered once.
   */
  private async lookAgain(feedback: Feedback): Promise<void> {
    const { space_id: spaceId, message_id: messageId } = feedback;
    const note = feedback.kind === "correction" ? feedback.text?.trim() || undefined : undefined;
    const thumbsDown = feedback.kind === "reaction" && feedback.reaction === "👎";
    if (spaceId === undefined || !messageId || (note === undefined && !thumbsDown)) return;
    if (this.answered.has(feedback.id)) return;
    this.answered.add(feedback.id);
    for (const old of this.answered) {
      if (this.answered.size <= ANSWERED) break;
      this.answered.delete(old);
    }
    const context = await this.options.chips.roomContext(spaceId, { limit: 200 }).catch(() => undefined);
    const line = context?.lines.find((each) => each.message_id === messageId);
    // Said to the agent as a message of the person's, under an id of its own, as a claim's first words are.
    const message = {
      type: "message.new",
      space_id: spaceId,
      message_id: `again-${feedback.id}`,
      text: lookAgainPrompt(feedback.from.display_name, line?.text, note),
      from: feedback.from,
      ...(line === undefined ? {} : { for: [line.from.id] }),
    } as unknown as MessageNew;
    await this.hear(message, lookAgainGoal(note));
  }

  /** For the harness itself: its agent in the room, else its own. */
  private async inRoom(spaceId: string): Promise<AgentRecord | undefined> {
    const agents = await this.options.chips.agents.list().catch(() => []);
    await this.know(agents);
    const here = agents.find((agent) => agent.room === spaceId)?.key ?? this.options.chips.harnessId;
    return this.options.state.agents[here];
  }

  private roomOf(record: AgentRecord, spaceId: string): Room {
    const id = `${record.key}|${spaceId}`;
    let room = this.rooms.get(id);
    if (room === undefined) {
      room = { record, spaceId, queue: [], busy: false, usedAt: Date.now(), answered: [] };
      this.rooms.set(id, room);
    }
    return room;
  }

  private async pump(room: Room): Promise<void> {
    if (room.busy) return;
    const compact = room.compact;
    if (compact !== undefined) {
      // A compaction asked for while a turn ran goes before the next message.
      room.compact = undefined;
      room.busy = true;
      try {
        await this.compactIn(room, compact);
      } catch (error) {
        this.compacting.delete(room.record.key);
        this.log(`${room.record.name} not compacted: ${messageOf(error)}`);
      } finally {
        room.busy = false;
        room.usedAt = Date.now();
        void this.pump(room);
      }
      return;
    }
    const waiting = nextTurn(room.queue);
    if (waiting.length === 0) return;
    room.busy = true;
    try {
      await this.turn(room, waiting);
    } catch (error) {
      this.log(`a turn of ${room.record.name} went wrong: ${String(error)}`);
    } finally {
      room.busy = false;
      const ended = room.turn;
      room.turn = undefined;
      room.usedAt = Date.now();
      if (ended !== undefined) this.turnEnded(room, ended);
      void this.pump(room);
    }
  }

  /**
   * One turn on what waited (Chips ADR 0294): the newest message's, whose note and lines it is
   * handed, with those that waited ahead of it said in full, and what was said after to others.
   */
  private async turn(room: Room, waiting: readonly Asked[]): Promise<void> {
    const { message, speakerId, again, since } = waiting.at(-1) as Asked;
    const earlier = waiting.slice(0, -1).map((each) => each.message);
    const { record, spaceId } = room;
    const { kind } = this.options;
    const speaker = speakerId === undefined ? this.options.chips : this.options.chips.as(speakerId);
    const run = await speaker.runs.start({ spaceId, goal: again ?? goalOf(message, record.name) });
    const turn: Turn = {
      run,
      speaker,
      agentName: kind.name,
      sessionId: "",
      reply: "",
      said: [],
      thought: "",
      next: [],
      cancelled: false,
      prompting: false,
      stopping: false,
      pausing: false,
      asking: 0,
      saidAt: 0,
      gaugeAt: 0,
      steps: new Map(),
      allowed: new Map(),
      peak: 0,
      folds: 0,
    };
    room.turn = turn;
    this.sayPausable(run, speakerId);
    // Stop, Pause and an interrupting steer all stop the prompt going, if one is: once, however many come.
    const interrupt = () => {
      if (!turn.prompting || turn.stopping) return;
      turn.stopping = true;
      this.process.client?.cancel(turn.sessionId);
    };
    // Heard from the start, so a Stop while the session is still opening stops it too.
    run.on("cancel", () => {
      turn.cancelled = true;
      interrupt();
    });
    run.on("steer", (steer) => {
      turn.next.push(`${steer.from?.display_name ?? "The person"} adds: ${steer.text}`);
      if (steer.mode === "interrupt") interrupt();
    });
    // A Pause stops the prompt where it is and keeps the run (Chips ADR 0293). One while the agent
    // waits on a person's answer stops nothing: the agent is only waiting, and the answer is held.
    run.on("pause", () => {
      this.log(`${record.name} paused in ${spaceId}`);
      if (turn.asking > 0 || !turn.prompting) return;
      turn.pausing = true;
      interrupt();
    });
    run.on("resume", () => this.log(`${record.name} resumed in ${spaceId}`));
    const client = await this.running();
    if (client === undefined) {
      if (!run.over) await run.fail({ error: `${kind.name} isn't running right now.`, retryable: true });
      return;
    }
    try {
      turn.sessionId = await this.sessionFor(record, client, spaceId);
    } catch (error) {
      if (!run.over) await run.fail({ error: this.failure(record, error, " couldn't open a session"), retryable: isAuthRequired(error) });
      return;
    }
    const { sessionId } = turn;
    turn.costAtStart = this.options.state.costs?.[sessionId];

    const project = await this.projectFor(turn, record, spaceId, speakerId ?? record.agentId);
    const asked = {
      ...(speakerId === undefined ? {} : { taker: speakerId }),
      ...(again === undefined ? {} : { sayWho: false }),
      sendsFiles: true,
      project,
    };
    // A session told the room's rules isn't told them again until they change or it compacts.
    const rules = rulesFor(message, asked);
    // What was said before the agent joined, at its first turn here; and that Chips held its last words.
    const joined = `${speakerId ?? record.agentId}|${spaceId}`;
    let words = promptFor(message, {
      ...asked,
      rulesHeld: this.rules.holds(sessionId, rules),
      earlier,
      since,
      answered: room.answered,
      before: this.caughtUp.get(joined),
      heldPost: room.heldPost,
    });
    const files: string[] = [];
    for (const each of [...earlier, message]) files.push(...(await this.filesFor(record, each)));
    if (files.length > 0) words = `${words}\n\n${files.join("\n")}`;
    if (earlier.length > 0) this.log(`${record.name} takes ${waiting.length} messages that waited in ${spaceId} as one turn`);
    // A Pause while the session opened holds the first prompt, and the rules aren't told until it goes.
    if (!(await this.unpaused(turn))) return;
    // Told as it is given, so a compaction during the turn, heard after, forgets them.
    this.rules.told(sessionId, rules);
    let stop = "end_turn";
    let prompt: string | undefined = words;
    while (prompt !== undefined) {
      // And one between two prompts holds the next.
      if (!(await this.unpaused(turn))) return;
      turn.prompting = true;
      turn.stopping = false;
      try {
        stop = await client.prompt(sessionId, [{ type: "text", text: prompt }]);
      } catch (error) {
        turn.prompting = false;
        this.rules.forget(sessionId);
        if (!run.over) await run.fail({ error: this.failure(record, error), retryable: true });
        return;
      }
      turn.prompting = false;
      // Its session holds them now, however the turn goes on from here.
      if (prompt === words) {
        keepAnswered(room.answered, [...earlier, message]);
        this.caughtUp.delete(joined);
        room.heldPost = undefined;
      }
      if (turn.cancelled) return;
      const paused = turn.pausing;
      turn.pausing = false;
      // Paused as it stopped, or just after: nothing is posted, and the run isn't ended, until Resume.
      if (!(await this.unpaused(turn))) return;
      if (stop === "cancelled" && (paused || turn.next.length > 0)) {
        // Stopped partway, by a Pause or an interrupting steer. What it was in the middle of saying
        // is dropped, so the reply is what it says from here: one answer, not a half-sentence with
        // its next words joined straight on.
        turn.reply = "";
        prompt = paused ? [CARRY_ON, ...turn.next.splice(0)].join("\n\n") : turn.next.shift();
        continue;
      }
      if (stop !== "end_turn" && stop !== "cancelled") break;
      prompt = turn.next.shift();
    }
    await this.finish(room, turn, stop);
  }

  /**
   * Once the run isn't paused (Chips ADR 0293): true to go on, false when it was stopped, before or
   * while it waited, which ends the turn with nothing more said, as a Stop does.
   */
  private async unpaused(turn: Turn): Promise<boolean> {
    if (turn.run.paused) await turn.run.whenRunning();
    return !turn.cancelled && !turn.run.over;
  }

  /**
   * That the run can pause (Chips ADR 0293), said once as it starts on a status of "Thinking…".
   * The SDK this is built on, 1.0.4, has no word for it in `run.status()`, so it goes on the
   * connection in the run's own envelope, as one of its agents' when it is theirs. A server from
   * before drops the word, and a send that fails costs the turn nothing.
   */
  private sayPausable(run: Run, speakerId: string | undefined): void {
    const envelope = {
      space_id: run.spaceId,
      run_id: run.id,
      ...(speakerId === undefined ? {} : { actor: { kind: "agent", id: speakerId } }),
    };
    const unsaid = (error: unknown) => this.log(`couldn't say run ${run.id} can pause: ${messageOf(error)}`);
    try {
      void this.options.chips
        .send("run.status", envelope, { phase: "thinking", verb_phrase: "Thinking…", pausable: true })
        .catch(unsaid);
    } catch (error) {
      unsaid(error);
    }
  }

  /**
   * The room's session: the one it had, loaded once, or a new one, in the agent's folder, put on
   * the agent's model. One a change from Chips made stale is closed and loaded again first, so the
   * agent reads what changed.
   */
  private async sessionFor(record: AgentRecord, client: AcpClient, spaceId: string): Promise<string> {
    const { state } = this.options;
    const { live, info } = this.process;
    const key = `${record.key}|${spaceId}`;
    const kept = state.sessions[key];
    if (kept !== undefined && live.has(kept) && this.process.stale.has(kept)) await this.reopen(client, record, kept);
    if (kept !== undefined && live.has(kept)) return kept;
    if (kept !== undefined && info?.loadSession === true) {
      try {
        const loaded = await client.loadSession(kept, record.folder, [], this.sessionMeta(record));
        live.add(kept);
        this.sessionOptions.set(kept, loaded.configOptions);
        await this.moded(client, kept);
        await this.modelled(client, record, kept);
        return kept;
      } catch (error) {
        this.log(`${record.name} couldn't load ${kept}: ${messageOf(error)}; starting afresh`);
      }
    }
    const made = await client.newSession(record.folder, [], this.sessionMeta(record));
    live.add(made.sessionId);
    this.sessionOptions.set(made.sessionId, made.configOptions);
    await this.moded(client, made.sessionId);
    await this.modelled(client, record, made.sessionId);
    state.sessions[key] = made.sessionId;
    // A new session has cost nothing yet: its first turn counts from nought.
    (state.costs ??= {})[made.sessionId] = 0;
    this.save();
    return made.sessionId;
  }

  /**
   * A stale session closed, where the agent closes and loads them, so its next turn loads it again
   * and the agent reads its files and its settings afresh. Elsewhere it goes on as it is.
   */
  private async reopen(client: AcpClient, record: AgentRecord, sessionId: string): Promise<void> {
    const { info, live, stale } = this.process;
    stale.delete(sessionId);
    if (info?.closeSession !== true || !info.loadSession) return;
    try {
      await client.closeSession(sessionId);
      live.delete(sessionId);
      this.sessionOptions.delete(sessionId);
      this.log(`${record.name}'s session ${sessionId} closed, to start again with what changed`);
    } catch (error) {
      this.log(`${record.name}'s session ${sessionId} stays open: ${messageOf(error)}`);
    }
  }

  /** What a session of the agent starts with beside its folder: Claude Code's settings for the limit a person picked. */
  private sessionMeta(record: AgentRecord): Record<string, unknown> | undefined {
    if (this.knownKind !== "claude-code" || this.claudeFixed()) return undefined;
    const settings = claudeSessionSettings(this.options.state.windows?.[record.key]);
    return settings === undefined ? undefined : { claudeCode: { options: { settings } } };
  }

  /** The session into the mode the config names, or left in its own when the agent won't. */
  private async moded(client: AcpClient, sessionId: string): Promise<void> {
    const { mode, name } = this.options.kind;
    if (mode === undefined) return;
    await client
      .setMode(sessionId, mode)
      .catch((error: unknown) => this.log(`${name} stays in its own mode, not ${mode}: ${messageOf(error)}`));
  }

  /** The message's files, saved where the agent works, as lines that say where. */
  private async filesFor(record: AgentRecord, message: MessageNew): Promise<string[]> {
    const lines: string[] = [];
    for (const file of message.attachments ?? []) {
      try {
        const folder = join(record.folder, "chips-files", message.message_id);
        await mkdir(folder, { recursive: true });
        const path = join(folder, file.filename.replace(/[/\\]/g, "_"));
        await writeFile(path, await this.options.chips.download(file));
        lines.push(`(${file.filename} is saved at ${path})`);
      } catch (error) {
        lines.push(`(${file.filename} could not be fetched: ${messageOf(error)})`);
      }
    }
    return lines;
  }

  /**
   * What the turn cost. ACP says what a session has cost in all, not its tokens (Chips ADR 0162):
   * the turn's cost is what that grew by while it ran. With nothing to count from (a session from
   * before the bridge kept its costs, or whose count was lost), or where the total went down, the
   * turn says it ran without saying a cost rather than give the session's whole cost as its own;
   * the next turn counts from what this one ended at.
   */
  private async sayCost(room: Room, turn: Turn, total: number): Promise<void> {
    const { run, costAtStart } = turn;
    const spent = costAtStart === undefined ? undefined : total - costAtStart;
    if (spent !== undefined && spent >= 0) {
      if (spent > 0) await run.usage({ model: turn.agentName, costUsd: spent }).catch(() => undefined);
      return;
    }
    const why = costAtStart === undefined ? "nothing to count it from" : "the session's total went down";
    this.log(`${room.record.name}'s turn says no cost: ${why} ($${total.toFixed(2)} in all now)`);
    await run.usage({ model: turn.agentName }).catch(() => undefined);
  }

  /** The turn is over: its words in the room, what it cost, and the run ended as it went. */
  private async finish(room: Room, turn: Turn, stop: string): Promise<void> {
    const { run } = turn;
    if (run.over) return;
    await this.settleSteps(turn, "done");
    for (const approvalId of turn.allowed.values()) {
      await run.executed(approvalId, "executed", "The agent didn't say how it went.").catch(() => undefined);
    }
    if (turn.cost !== undefined) await this.sayCost(room, turn, turn.cost);
    if (stop === "refusal") {
      await run.fail({ error: `${room.record.name} refused.` });
      return;
    }
    // Its last words; when it ended on a tool call, the words before it.
    const answer = turn.reply.trim() || (turn.said.at(-1) ?? "");
    const { change, note } = await this.sendProject(room, turn, answer);
    // The files its `MEDIA:` lines name go with its words, from its folder (Chips TT-7).
    const { chips } = this.options;
    const words = [answer, note ?? ""].filter((part) => part !== "").join("\n\n");
    const post = await sendAnswer(words, { folders: [room.record.folder], upload: (input) => chips.upload(input) });
    const reply = post.text;
    if (reply !== "" || post.uploadIds.length > 0) {
      const taken = await turn.speaker.post({ spaceId: room.spaceId, runId: run.id, text: reply, uploadIds: post.uploadIds, change });
      // Held from the agents it named (Chips ADR 0097): its next turn here is told, so it doesn't wait on them.
      if (taken.held === true) {
        room.heldPost = { held: true, ...(taken.exchange === undefined ? {} : { exchange: taken.exchange }) };
        this.log(`Chips held what ${room.record.name} said in ${room.spaceId} from the agents it named`);
      }
    }
    const cut = stop === "max_tokens" || stop === "max_turn_requests";
    const said = post.summary;
    const summary = said === "" ? "Done." : said.length <= 2000 ? said : `${said.slice(0, 1990)}…`;
    await run.complete({
      summary,
      ...(cut ? { followUps: [`${room.record.name} stopped at its limit (${stop}).`] } : {}),
    });
  }

  /**
   * The room's project for a turn (Chips ADR 0221): the agent's copy in its own folder, brought up
   * to date, and what the turn is told of it. None for agents the config puts in one folder of the
   * person's, nor where this machine has no git for it.
   */
  private async projectFor(
    turn: Turn,
    record: AgentRecord,
    spaceId: string,
    agentId: string,
  ): Promise<ProjectFacts | undefined> {
    if (this.options.projects !== true || this.options.kind.folder !== undefined) return undefined;
    try {
      const project = this.options.chips.project({
        spaceId,
        agentId,
        name: record.name,
        folder: record.folder,
        log: (line) => this.log(line),
      });
      const facts = await project.pull();
      turn.project = project;
      return facts;
    } catch (error) {
      this.log(`${record.name}'s copy of the room's project couldn't be readied: ${messageOf(error)}`);
      return undefined;
    }
  }

  /**
   * What the turn changed in its copy, sent to the room's project before its words are posted: the
   * commit it left `main` at, for the reply to carry (Chips ADR 0222), when it sent one; else, when
   * the change didn't go, the line the reply says so in (Chips AP-6).
   */
  private async sendProject(room: Room, turn: Turn, words: string): Promise<{ change?: string; note?: string }> {
    if (turn.project === undefined) return {};
    const name = room.record.name;
    try {
      const pushed = await turn.project.push({ words });
      this.log(`${name}'s project: ${pushedInWords(pushed)}`);
      if (pushed.state === "sent") return { change: pushed.commit };
      const note = heldNote(pushed, name);
      return note === undefined ? {} : { note };
    } catch (error) {
      this.log(`${name}'s project couldn't be sent: ${messageOf(error)}`);
      const note = heldNote({ state: "failed", why: messageOf(error) }, name);
      return note === undefined ? {} : { note };
    }
  }

  private async settleSteps(turn: Turn, status: "done" | "failed"): Promise<void> {
    for (const [stepId, step] of turn.steps) {
      if (step.done) continue;
      step.done = true;
      await turn.run
        .step({ stepId, status, title: step.title, tool: step.tool, kind: step.kind })
        .catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ what the agent streams

  private turnOf(sessionId: string): Turn | undefined {
    for (const room of this.rooms.values()) {
      if (room.turn?.sessionId === sessionId && !room.turn.run.over) return room.turn;
    }
    return undefined;
  }

  private updated(sessionId: string, update: SessionUpdate): void {
    if (update.sessionUpdate === "usage_update") this.costed(sessionId, update);
    // How full it is, and its compactions, whether a turn of Chips's is going or not.
    this.watched(sessionId, update);
    const turn = this.turnOf(sessionId);
    if (turn === undefined) return; // a loaded session's history, a turn already over, or a compaction
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textOf(update["content"]);
        // Codex saying it compacted itself is no word of its reply: the window says it.
        if (text.trim() === CODEX_COMPACTED) return;
        turn.reply += text;
        return;
      }
      case "agent_thought_chunk":
        turn.thought += textOf(update["content"]);
        this.sayThought(turn);
        return;
      case "tool_call":
        this.onTheWay(turn);
        void this.stepped(turn, update);
        return;
      case "tool_call_update":
        void this.stepped(turn, update);
        return;
      case "plan":
        void this.planned(turn, update);
        return;
      case "usage_update":
        this.gauge(turn, update);
        return;
      default:
        return;
    }
  }

  private costed(sessionId: string, update: SessionUpdate): void {
    const cost = update["cost"] as { amount?: unknown; currency?: unknown } | undefined;
    if (typeof cost?.amount !== "number" || (cost.currency !== undefined && cost.currency !== "USD")) return;
    (this.options.state.costs ??= {})[sessionId] = cost.amount;
    this.save();
    const turn = this.turnOf(sessionId);
    if (turn !== undefined) turn.cost = cost.amount;
  }

  private sayThought(turn: Turn): void {
    const now = Date.now();
    if (now - turn.saidAt < QUIET_MS) return;
    const line = lastLine(turn.thought);
    if (line === "") return;
    turn.saidAt = now;
    void turn.run.status({ phase: "thinking", verbPhrase: line.slice(0, 200) }).catch(() => undefined);
  }

  /** Words said before a tool call were on the way: the bubble's now, and the reply is what comes after. */
  private onTheWay(turn: Turn): void {
    const words = turn.reply.trim();
    if (words === "") return;
    turn.said.push(words);
    turn.reply = "";
    const line = lastLine(words);
    if (line === "") return;
    turn.saidAt = Date.now();
    void turn.run.status({ phase: "writing", verbPhrase: line.slice(0, 200) }).catch(() => undefined);
  }

  private gauge(turn: Turn, update: SessionUpdate): void {
    const used = update["used"];
    const size = update["size"];
    if (typeof used !== "number" || typeof size !== "number" || size <= 0) return;
    const now = Date.now();
    if (now - turn.gaugeAt < QUIET_MS) return;
    turn.gaugeAt = now;
    void turn.run.context({ usedTokens: used, limitTokens: size, model: turn.agentName }).catch(() => undefined);
  }

  private async stepped(turn: Turn, update: SessionUpdate): Promise<void> {
    const stepId = String(update["toolCallId"] ?? "");
    if (stepId === "") return;
    const known = turn.steps.get(stepId);
    const title = typeof update["title"] === "string" ? update["title"] : (known?.title ?? "A tool call");
    const tool = toolOf(update) ?? known?.tool ?? "tool";
    const kind = kindOf(update["kind"]) ?? known?.kind ?? "other";
    const status = update["status"];
    const done = status === "completed" || status === "failed";
    if (known?.done === true) return;
    turn.steps.set(stepId, { title, tool, kind, done });
    const approvalId = turn.allowed.get(stepId);
    if (done && approvalId !== undefined) {
      turn.allowed.delete(stepId);
      await turn.run.executed(approvalId, status === "failed" ? "failed" : "executed").catch(() => undefined);
    }
    if (known !== undefined && !done && update["title"] === undefined) return;
    await turn.run
      .step({
        stepId,
        status: status === "failed" ? "failed" : done ? "done" : "started",
        title: `${tool} · ${title}`.slice(0, 300),
        tool,
        kind,
      })
      .catch(() => undefined);
  }

  private async planned(turn: Turn, update: SessionUpdate): Promise<void> {
    const entries = Array.isArray(update["entries"]) ? (update["entries"] as Record<string, unknown>[]) : [];
    const steps = entries
      .filter((entry) => entry["status"] !== "completed")
      .slice(0, 20)
      .map((entry, index) => ({ stepId: `plan-${index + 1}`, title: String(entry["content"] ?? "").slice(0, 300) }))
      .filter((step) => step.title !== "");
    if (steps.length > 0) await turn.run.plan(steps).catch(() => undefined);
  }

  // ------------------------------------------------------------------ what the agents read (Chips ADRs 0134, 0238)

  /** The folders of the agents Chips has, for how many of them read each shared file. */
  private folders(): string[] {
    return this.records()
      .filter((record) => record.agentId !== "")
      .map((record) => record.folder);
  }

  /** The agents came or went: the copies sent again where they changed (Chips takes the same copy once). */
  private agentsChanged(): void {
    if (this.files !== undefined) void this.sendContexts();
    void this.sendModels();
  }

  /** The harness's own set and each agent's files, as they are on disk now. */
  private async sendContexts(): Promise<void> {
    const files = this.files;
    if (files === undefined) return;
    await this.options.chips.settings
      .harnessContext(files.harnessCopy(this.folders()))
      .catch((error: unknown) => this.log(`${this.options.kind.name}'s shared files not sent: ${messageOf(error)}`));
    for (const record of this.records()) await this.sendContext(record);
  }

  private async sendContext(record: AgentRecord): Promise<void> {
    if (this.files === undefined || record.agentId === "") return;
    await this.options.chips.settings
      .context(record.agentId, this.files.agentCopy(record.folder))
      .catch((error: unknown) => this.log(`${record.name}'s files not sent: ${messageOf(error)}`));
  }

  /**
   * A person's edit of a file from Chips: saved where the agent reads it, and answered with the copy
   * as it is now. Each agent that reads it starts its sessions again before its next turn, so the
   * change applies from the next message: an agent and its copies share a folder, and every agent
   * reads the harness's own set.
   */
  async contextEdited(edit: ContextEditFrame): Promise<AgentContextCopy | HarnessContextCopy> {
    const files = this.files;
    if (files === undefined) throw new Refuse(`${this.options.kind.name} keeps no files of its agents here.`);
    await this.known;
    if (edit.agent_id === undefined) {
      await files.saveShared(this.folders(), edit);
      this.log(`${this.options.kind.name}'s ${edit.name} saved from Chips`);
      this.reload(this.records());
      return files.harnessCopy(this.folders());
    }
    const record = await this.recordOf(edit.agent_id);
    if (record === undefined) throw new Refuse("This harness has no such agent.");
    await files.saveAgent(record.folder, edit);
    this.log(`${record.name}'s ${edit.name} saved from Chips`);
    const sharing = this.records().filter((each) => each.folder === record.folder);
    this.reload(sharing);
    for (const each of sharing) if (each !== record) void this.sendContext(each);
    return files.agentCopy(record.folder);
  }

  /** The agents' live sessions marked to start again before their next turn. */
  private reload(records: readonly AgentRecord[]): void {
    const { live, stale } = this.process;
    for (const record of records) {
      for (const [id, sessionId] of Object.entries(this.options.state.sessions)) {
        if (id.startsWith(`${record.key}|`) && live.has(sessionId)) stale.add(sessionId);
      }
    }
  }

  // ------------------------------------------------------------------ how full each agent is (Chips ADR 0146)

  /** The agent and room a session is. */
  private placeOf(sessionId: string): { record: AgentRecord; spaceId: string } | undefined {
    for (const [id, each] of Object.entries(this.options.state.sessions)) {
      if (each !== sessionId) continue;
      const at = id.indexOf("|");
      const record = this.options.state.agents[id.slice(0, at)];
      if (record !== undefined) return { record, spaceId: id.slice(at + 1) };
    }
    return undefined;
  }

  private kept(): Record<string, KeptWindow> {
    this.options.state.windows ??= {};
    return this.options.state.windows;
  }

  /** Whether `CLAUDE_CODE_AUTO_COMPACT_WINDOW` sets Claude Code's limit, which nothing here beats. */
  private claudeFixed(): boolean {
    return this.knownKind === "claude-code" && claudeOwn(this.env, [], undefined, 1_000_000).fixed;
  }

  /** Whether the bridge keeps the agents' limit and compacts past it: every kind but Claude Code, which keeps its own. */
  private keepsLimit(): boolean {
    return this.knownKind === "codex" || (this.knownKind === undefined && this.offersCompact);
  }

  /** An agent's copy, from what it last said: nothing until it has said. */
  private windowCopy(record: AgentRecord): AgentContextWindowCopy | undefined {
    const kept = this.options.state.windows?.[record.key];
    if (kept === undefined) return undefined;
    const compacts = this.knownKind !== undefined || this.offersCompact;
    const limit =
      this.knownKind === "claude-code"
        ? claudeLimit(kept, claudeOwn(this.env, settingsLayers(this.places.claudeHome, record.folder), kept.model, kept.window))
        : compacts
          ? bridgeLimit(kept)
          : { editable: false };
    return windowCopy(kept, {
      compacting: this.compacting.get(record.key),
      compacts,
      whyNot: "This agent has no compact command.",
      ...limit,
    });
  }

  /** An agent's copy sent now, and kept with the bridge's agents. */
  private async sendWindow(record: AgentRecord): Promise<void> {
    clearTimeout(this.windowTimers.get(record.key));
    this.windowTimers.delete(record.key);
    const copy = this.windowCopy(record);
    if (copy === undefined || record.agentId === "") return;
    this.save();
    await this.options.chips.settings
      .contextWindow(record.agentId, copy)
      .catch((error: unknown) => this.log(`${record.name}'s context window not sent: ${messageOf(error)}`));
  }

  /** An agent's copy sent in a moment: a turn says how full it is after each step. */
  private windowSoon(record: AgentRecord): void {
    if (this.windowTimers.has(record.key)) return;
    const timer = setTimeout(() => {
      this.windowTimers.delete(record.key);
      void this.sendWindow(record);
    }, QUIET_MS);
    timer.unref();
    this.windowTimers.set(record.key, timer);
  }

  /** What any session says of its window and its compactions, heard whether a turn of Chips's is going or not. */
  private watched(sessionId: string, update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "usage_update":
        this.reading(sessionId, update);
        return;
      case "tool_call":
      case "tool_call_update":
        this.compactionStep(sessionId, update);
        return;
      case "agent_message_chunk": {
        const text = textOf(update["content"]);
        const run = this.compactRuns.get(sessionId);
        if (run !== undefined) run.words += text;
        if (text.trim() === CODEX_COMPACTED) this.saidCompacted(sessionId);
        return;
      }
      case "config_option_update": {
        // The agent moved a session itself: Claude Code, off a model that refused a turn.
        const options = configOptionsOf(update);
        if (this.sessionOptions.has(sessionId) && options.length > 0) this.sessionOptions.set(sessionId, options);
        return;
      }
      case "available_commands_update": {
        const commands = update["availableCommands"];
        if (Array.isArray(commands) && commands.some((each) => (each as { name?: unknown } | null)?.name === "compact")) {
          this.offersCompact = true;
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * How full a session is: the turn's height, where a compaction came to, and the agent's reading.
   * Claude Code's `size` is its model's window once a turn has a result (the update with the cost);
   * before that it may be a guess, so its window is the one it said last.
   */
  private reading(sessionId: string, update: SessionUpdate): void {
    const used = update["used"];
    const size = update["size"];
    if (typeof used !== "number" || typeof size !== "number" || !(used >= 0) || !(size > 0)) return;
    const turn = this.turnOf(sessionId);
    if (turn !== undefined) turn.peak = Math.max(turn.peak, used);
    this.sessionUsed.set(sessionId, used);
    const compaction = this.compactions.get(sessionId);
    if (compaction !== undefined && compaction.finished === undefined) {
      if (!compaction.done) compaction.latest = used;
      else if (compaction.to === undefined) {
        compaction.to = used;
        this.compacted(sessionId, compaction);
      }
    }
    const record = this.placeOf(sessionId)?.record;
    if (record === undefined) return;
    const windows = this.kept();
    const kept = windows[record.key];
    const trusted = this.knownKind !== "claude-code" || update["cost"] !== undefined;
    const window = trusted ? size : kept?.window;
    if (window === undefined) return;
    const meta = update["_meta"] as Record<string, unknown> | undefined;
    const model = typeof meta?.["_claude/model"] === "string" ? meta["_claude/model"] : kept?.model;
    // A compaction before its first reading Claude Code could be sure of (in its first turn) is its last.
    const before = kept === undefined ? this.compactions.get(sessionId)?.finished : undefined;
    windows[record.key] = {
      ...(before === undefined ? {} : { last: before }),
      ...kept,
      used: Math.round(used),
      window: Math.round(window),
      ...(model === undefined ? {} : { model }),
      asOf: new Date().toISOString(),
      session: sessionId,
    };
    this.windowSoon(record);
  }

  /**
   * A tool call of a compaction: begun, where Claude Code says from how much and to how much
   * (`rawOutput`, after it says it completed), done. Another tool call is nothing here.
   */
  private compactionStep(sessionId: string, update: SessionUpdate): void {
    const id = String(update["toolCallId"] ?? "");
    if (id === "") return;
    let compaction = this.compactions.get(sessionId);
    if (compaction?.id !== id) {
      if (update.sessionUpdate !== "tool_call" || !isCompaction(update)) return;
      compaction = { id, from: this.sessionUsed.get(sessionId), done: false };
      this.compactions.set(sessionId, compaction);
      // What it keeps of the room's rules is its summary's to say: they are said again.
      this.rules.forget(sessionId);
    }
    const facts = compactionFacts(update);
    if (facts.from !== undefined) compaction.from = facts.from;
    if (facts.to !== undefined) compaction.to = facts.to;
    if (facts.by !== undefined) compaction.by = facts.by;
    if (compaction.finished !== undefined) {
      if (facts.from !== undefined || facts.to !== undefined) this.corrected(sessionId, compaction);
      return;
    }
    const status = update["status"];
    if (status === "failed") {
      this.compactions.delete(sessionId);
      return;
    }
    if (status === "completed") {
      compaction.done = true;
      compaction.to ??= compaction.latest;
    }
    if (compaction.done && compaction.to !== undefined) this.compacted(sessionId, compaction);
  }

  /** Codex's old way, its words that it compacted, with no tool call: one done, to what it says next. */
  private saidCompacted(sessionId: string): void {
    const last = this.compactions.get(sessionId);
    const lately = last?.finished !== undefined && Date.now() - Date.parse(last.finished.at) < 5000;
    if (last !== undefined && (last.finished === undefined || lately)) return;
    this.compactions.set(sessionId, { id: `said-${Date.now()}`, from: this.sessionUsed.get(sessionId), done: true });
    this.rules.forget(sessionId);
  }

  /** A compaction done: its agent's last, counted in the turn it was in, and the copy sent. */
  private compacted(sessionId: string, compaction: Compaction): void {
    const run = this.compactRuns.get(sessionId);
    const to = Math.round(compaction.to ?? 0);
    const last: LastCompaction = {
      at: new Date().toISOString(),
      from: Math.round(compaction.from ?? to),
      to,
      by: run?.by ?? compaction.by ?? "itself",
    };
    compaction.finished = last;
    if (run !== undefined) run.done = true;
    const turn = this.turnOf(sessionId);
    if (turn !== undefined && last.by === "itself") turn.folds += 1;
    this.sessionUsed.set(sessionId, to);
    const record = this.placeOf(sessionId)?.record;
    const kept = record === undefined ? undefined : this.options.state.windows?.[record.key];
    if (record === undefined || kept === undefined) return;
    kept.last = last;
    kept.used = to;
    kept.asOf = last.at;
    kept.session = sessionId;
    this.log(`${record.name} compacted (${last.by}), ${last.from} to ${last.to} tokens`);
    void this.sendWindow(record);
  }

  /** Claude Code's own count of a compaction, heard after it said it was done: the last put right. */
  private corrected(sessionId: string, compaction: Compaction): void {
    const before = compaction.finished;
    if (before === undefined) return;
    const last: LastCompaction = {
      ...before,
      from: Math.round(compaction.from ?? before.from),
      to: Math.round(compaction.to ?? before.to),
    };
    compaction.finished = last;
    const record = this.placeOf(sessionId)?.record;
    const kept = record === undefined ? undefined : this.options.state.windows?.[record.key];
    if (record === undefined || kept?.last?.at !== before.at) return;
    kept.last = last;
    void this.sendWindow(record);
  }

  /**
   * A turn of Chips's ended: the agent's files read again, in case it changed them (Claude Code
   * writes its memory), how full it got if that passed half its window, and, where the bridge
   * keeps its limit, a compaction when it ended at or past it.
   */
  private turnEnded(room: Room, turn: Turn): void {
    const { record } = room;
    void this.sendContext(record);
    const kept = this.options.state.windows?.[record.key];
    if (kept === undefined) return;
    if (turn.peak > kept.window / 2) {
      kept.longTurn = {
        at: new Date().toISOString(),
        peak: Math.round(turn.peak),
        folds: Math.min(turn.folds, LONG_TURN_FOLDS_MAX),
      };
    }
    const here = this.options.state.sessions[`${record.key}|${room.spaceId}`] === kept.session;
    if (here && room.compact === undefined && !this.compacting.has(record.key) && this.keepsLimit() && pastLimit(kept)) {
      this.log(`${record.name} is past its limit, ${kept.used} of ${kept.window} tokens: compacting`);
      room.compact = { by: "itself" };
    }
    void this.sendWindow(record);
  }

  /**
   * A person's Compact now (Chips ADR 0146): taken at once, with the copy saying so; run in the
   * session the agent said it was in last, now, or once the turn going there ends.
   */
  async windowCompact(ask: WindowCompactFrame): Promise<AgentContextWindowCopy> {
    await this.known;
    const record = await this.recordOf(ask.agent_id);
    if (record === undefined) throw new Refuse("This harness has no such agent.");
    const copy = this.windowCopy(record);
    const kept = this.options.state.windows?.[record.key];
    if (copy === undefined || kept === undefined) throw new Refuse(`${record.name} hasn't said how full it is yet.`);
    if (!copy.compacts) throw new Refuse(copy.why_not ?? "It doesn't compact from Chips.", copy);
    if (this.compacting.has(record.key)) throw new Refuse("It is compacting already.", copy);
    const place = this.placeOf(kept.session);
    if (place === undefined) throw new Refuse("The conversation it was in isn't open here any more.", copy);
    const room = this.roomOf(place.record, place.spaceId);
    this.compacting.set(record.key, room.busy ? "queued" : "running");
    room.compact = { by: "asked", changeId: ask.change_id };
    this.log(`${record.name} compacts ${room.busy ? "when its turn ends" : "now"}, from Chips`);
    // After the answer is on its way: what the compaction sends comes after it.
    if (!room.busy) setImmediate(() => void this.pump(room));
    return this.windowCopy(record) ?? copy;
  }

  /**
   * A person's limit (Chips ADR 0146): kept with the agent. Claude Code's sessions start again with
   * it before their next turn; for the others the bridge compacts past it after a turn. Picking the
   * harness's own clears what a person picked.
   */
  async windowChange(ask: WindowChangeFrame): Promise<AgentContextWindowCopy> {
    await this.known;
    const record = await this.recordOf(ask.agent_id);
    if (record === undefined) throw new Refuse("This harness has no such agent.");
    const copy = this.windowCopy(record);
    const kept = this.options.state.windows?.[record.key];
    if (copy === undefined || kept === undefined) throw new Refuse(`${record.name} hasn't said how full it is yet.`);
    if (!copy.editable || copy.limit === undefined) {
      throw new Refuse(copy.why_read_only ?? "Its limit can't be changed from Chips.", copy);
    }
    const offered = ask.at === null ? copy.limit.may_turn_off : copy.limit.choices.includes(ask.at);
    if (!offered) throw new Refuse("That limit isn't one it offers.", copy);
    const before = kept.limit;
    kept.limit = ask.at === copy.limit.default ? undefined : ask.at;
    this.save();
    if (this.knownKind === "claude-code" && kept.limit !== before) this.reload([record]);
    this.log(`${record.name} compacts itself ${ask.at === null ? "only when asked" : `at ${ask.at}%`}, from Chips`);
    return this.windowCopy(record) ?? copy;
  }

  /**
   * Compact a room's session now: `/compact`, said to the agent as a turn of its own, whose words go
   * nowhere. Done when the agent says it compacted; refused with its words when it doesn't.
   */
  private async compactIn(room: Room, ask: CompactAsk): Promise<void> {
    const { record } = room;
    const { kind, chips } = this.options;
    this.compacting.set(record.key, "running");
    void this.sendWindow(record);
    const notDone = async (why: string) => {
      this.compacting.delete(record.key);
      this.log(`${record.name} not compacted: ${why}`);
      if (ask.changeId === undefined || record.agentId === "") {
        await this.sendWindow(record);
        return;
      }
      await chips.settings
        .contextWindowFailed(record.agentId, ask.changeId, why, this.windowCopy(record))
        .catch((error: unknown) => this.log(`${record.name}'s context window not sent: ${messageOf(error)}`));
    };
    const client = await this.running();
    if (client === undefined) return notDone(`${kind.name} isn't running.`);
    let sessionId: string;
    try {
      sessionId = await this.sessionFor(record, client, room.spaceId);
    } catch (error) {
      return notDone(this.failure(record, error));
    }
    const run: CompactRun = { by: ask.by, words: "", done: false };
    this.compactRuns.set(sessionId, run);
    let failed: string | undefined;
    try {
      await client.prompt(sessionId, [{ type: "text", text: "/compact" }]);
    } catch (error) {
      failed = this.failure(record, error);
    }
    // Done, with no after-size said since: what the session last said is it.
    const compaction = this.compactions.get(sessionId);
    if (!run.done && compaction?.done === true && compaction.finished === undefined) {
      compaction.to ??= this.sessionUsed.get(sessionId);
      if (compaction.to !== undefined) this.compacted(sessionId, compaction);
    }
    this.compactRuns.delete(sessionId);
    if (!run.done) return notDone(failed ?? (cut(run.words.trim(), 300) || `${kind.name} didn't compact.`));
    this.compacting.delete(record.key);
    await this.sendWindow(record);
  }

  // ------------------------------------------------------------------ what each agent runs on (Chips ADRs 0140, 0241)

  /**
   * What the agent offers to run on, looked at each time it starts (`models.ts`): a session opened
   * in the harness's folder, put on each of its models in turn for that model's levels, and let go,
   * with nothing said to it. Kept with the bridge's agents, and each agent's copy sent from it.
   */
  private async look(client: AcpClient): Promise<void> {
    const { kind } = this.options;
    let sessionId: string | undefined;
    try {
      const made = await client.newSession(kind.folder ?? kind.folders);
      sessionId = made.sessionId;
      const { catalog, refused } = await lookAt(made.configOptions, (configId, value) =>
        client.setConfigOption(made.sessionId, configId, value),
      );
      for (const each of refused) this.log(`${kind.name} won't be put on ${each.model}, so it isn't offered: ${each.why}`);
      if (catalog === undefined) {
        this.log(`${kind.name} offers no model to pick`);
        return;
      }
      this.options.state.models = catalog;
      this.save();
      this.log(`${kind.name} offers ${catalog.choices.map((choice) => choice.id).join(", ")}; a new session runs on ${catalog.default.model}`);
      await this.sendModels();
    } catch (error) {
      this.log(`${kind.name}'s models not looked at: ${messageOf(error)}`);
    } finally {
      if (sessionId !== undefined && this.process.info?.closeSession === true) {
        await client.closeSession(sessionId).catch(() => undefined);
      }
    }
  }

  /** Each agent's copy, from what the agent offered when the bridge last looked: none before it has. */
  private async sendModels(): Promise<void> {
    for (const record of this.records()) await this.sendModel(record);
  }

  private async sendModel(record: AgentRecord): Promise<void> {
    const catalog = this.options.state.models;
    if (this.options.models !== true || catalog === undefined || record.agentId === "") return;
    await this.options.chips.settings
      .model(record.agentId, modelCopy(catalog, record.model, this.options.kind.name))
      .catch((error: unknown) => this.log(`${record.name}'s model not sent: ${messageOf(error)}`));
  }

  /** A session just opened, put on its agent's model; where the agent won't, left as it is, and said so. */
  private async modelled(client: AcpClient, record: AgentRecord, sessionId: string): Promise<void> {
    await this.putOnModel(client, record, sessionId).catch((error: unknown) =>
      this.log(`${record.name}'s session ${sessionId} stays on what ${this.options.kind.name} opened it on: ${messageOf(error)}`),
    );
  }

  /**
   * A session on its agent's model and effort: its pick, else the default. The model is set where
   * the session is on another, and a picked level always, so the agent's settings don't move it.
   * With no pick the level is left as the agent puts it, unless the pick was just dropped (`back`):
   * then it goes back too, to Claude Code's own `default`, or else the default's. Throws the agent's
   * refusal.
   */
  private async putOnModel(client: AcpClient, record: AgentRecord, sessionId: string, back = false): Promise<void> {
    const catalog = this.options.state.models;
    let now = this.sessionOptions.get(sessionId);
    if (this.options.models !== true || catalog === undefined || now === undefined) return;
    const pick = pickIn(catalog, record.model);
    const target = pick ?? catalog.default;
    const set = async (option: ConfigOption, value: string) => {
      const answered = await client.setConfigOption(sessionId, option.id, value);
      const before = now ?? [];
      now = answered.length > 0 ? answered : before.map((each) => (each.id === option.id ? { ...each, currentValue: value } : each));
      this.sessionOptions.set(sessionId, now);
    };
    const model = modelOption(now);
    if (model !== undefined && model.currentValue !== target.model) await set(model, target.model);
    const effort = effortOption(now);
    const level =
      pick !== undefined ? pick.effort : back ? (offers(effort, SETTINGS_LEVEL) ? SETTINGS_LEVEL : target.effort) : undefined;
    if (effort !== undefined && level !== undefined && offers(effort, level)) await set(effort, level);
  }

  /**
   * Each of an agent's live sessions on its model now. Put back on the default (`back`), a session
   * the agent won't move (Codex, off a model it doesn't list) is let go before its next turn and
   * loaded again; any other refusal is thrown.
   */
  private async putSessionsOnModel(record: AgentRecord, back: boolean): Promise<void> {
    const client = this.process.client;
    if (client === undefined || client.gone) return;
    for (const [id, sessionId] of Object.entries(this.options.state.sessions)) {
      if (!id.startsWith(`${record.key}|`) || !this.process.live.has(sessionId)) continue;
      try {
        await this.putOnModel(client, record, sessionId, back);
      } catch (error) {
        if (!back) throw error;
        this.process.stale.add(sessionId);
        this.log(`${record.name}'s session ${sessionId} starts again before its next turn: ${messageOf(error)}`);
      }
    }
  }

  /**
   * A person's pick of an agent's model and effort from Chips (Chips ADR 0241), or `null` for the
   * default: kept with the agent and set on each of its live sessions now, and on each it opens
   * after. One the agent refuses is refused with its words, and the sessions go back to what they
   * were on. A pick applies to that agent only.
   */
  async modelChange(change: ModelChangeFrame): Promise<AgentModelCopy> {
    await this.known;
    const { kind } = this.options;
    const catalog = this.options.state.models;
    if (this.options.models !== true || catalog === undefined) throw new Refuse(`${kind.name} hasn't said what it runs on yet.`);
    const record = await this.recordOf(change.agent_id);
    if (record === undefined) throw new Refuse("This harness has no such agent.");
    const pick = pickFrom(catalog, change);
    if (pick === undefined) throw new Refuse(`${kind.name} doesn't offer that.`, modelCopy(catalog, record.model, kind.name));
    const before = record.model;
    record.model = pick ?? undefined;
    try {
      await this.putSessionsOnModel(record, pick === null);
    } catch (error) {
      record.model = before;
      await this.putSessionsOnModel(record, before === undefined).catch(() => undefined);
      throw new Refuse(`${kind.name} refused: ${messageOf(error)}`, modelCopy(catalog, before, kind.name));
    }
    this.save();
    const now = pick === null ? `${kind.name}'s default` : `${pick.model}${pick.effort === undefined ? "" : ` at ${pick.effort}`}`;
    this.log(`${record.name} runs on ${now}, from Chips`);
    return modelCopy(catalog, record.model, kind.name);
  }

  // ------------------------------------------------------------------ what the agent asks

  private async asked(request: AgentRequest): Promise<unknown> {
    switch (request.method) {
      case "session/request_permission":
        return await this.permission(request.params);
      case "elicitation/create":
        return await this.form(request.params);
      default:
        throw notOffered(request.method);
    }
  }

  /** Permission to run a tool, as an approval card; the answer picks the agent's option. */
  private async permission(params: Readonly<Record<string, unknown>>): Promise<unknown> {
    const turn = this.turnOf(String(params["sessionId"]));
    const options = (Array.isArray(params["options"]) ? params["options"] : []) as {
      optionId: string;
      kind: string;
      name?: string;
    }[];
    if (turn === undefined) return { outcome: { outcome: "cancelled" } };
    // Asked as its prompt was being stopped for a Pause: ACP has what it still asks answered cancelled.
    if (turn.pausing) return { outcome: { outcome: "cancelled" } };
    const call = (params["toolCall"] ?? {}) as Record<string, unknown>;
    const kind = toolOf(call) ?? "other";
    const title = typeof call["title"] === "string" ? call["title"] : `use ${kind}`;
    const input = call["rawInput"];
    const asked = turn.run.approval({
      action: { kind: `acp.${slugOf(kind)}`, input: input ?? {} },
      question: questionFor(title, input),
      lasts: "once",
      risk: riskOf(kind),
      ...(input === undefined
        ? {}
        : { preview: { format: "json" as const, body: JSON.stringify(input, null, 2).slice(0, 200_000) } }),
      ...(call["toolCallId"] === undefined ? {} : { stepId: String(call["toolCallId"]) }),
    });
    const decision = await this.answerOf(turn, asked);
    if (decision === undefined) return { outcome: { outcome: "cancelled" } };
    const chosen = optionFor(decision, options, carriesCommand(input));
    if (decision.allowed && chosen !== undefined && call["toolCallId"] !== undefined) {
      turn.allowed.set(String(call["toolCallId"]), decision.approvalId);
    }
    return chosen === undefined
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId: chosen } };
  }

  /**
   * A form, as a question card: each choice field a question, its choices the card's options.
   * A field Chips can't ask (free text, a number) declines the whole form.
   */
  private async form(params: Readonly<Record<string, unknown>>): Promise<unknown> {
    const turn = typeof params["sessionId"] === "string" ? this.turnOf(params["sessionId"]) : undefined;
    const schema = (params["requestedSchema"] ?? {}) as Record<string, unknown>;
    const properties = Object.entries((schema["properties"] ?? {}) as Record<string, Record<string, unknown>>);
    const questions = properties.map(([id, field]) => questionOf(id, field, String(params["message"] ?? "")));
    if (turn === undefined || questions.length === 0 || questions.length > 4 || questions.some((q) => q === undefined)) {
      return { action: "decline" };
    }
    if (turn.pausing) return { action: "cancel" };
    const asked = turn.run.question({ questions: questions as NonNullable<(typeof questions)[number]>[] });
    const answer = await this.answerOf(turn, asked);
    if (answer === undefined || answer.timedOut) return { action: "cancel" };
    const content: Record<string, unknown> = {};
    for (const [id, field] of properties) {
      const value = answer.answers[id]?.values[0];
      if (value === undefined) continue;
      content[id] = field["type"] === "boolean" ? value === "yes" : value;
    }
    return { action: "accept", content };
  }

  /**
   * A person's answer to what the agent asked, once the agent may have it: one given while the run
   * is paused waits for Resume (Chips ADR 0293), and a Stop, before the answer or while it waits,
   * leaves none. While an ask waits, a Pause stops nothing.
   */
  private async answerOf<T>(turn: Turn, asked: Promise<T>): Promise<T | undefined> {
    let off = (): void => undefined;
    const stopped = new Promise<undefined>((resolve) => {
      off = turn.run.on("cancel", () => resolve(undefined));
    });
    turn.asking += 1;
    try {
      const answer = await Promise.race([asked, stopped]);
      if (answer === undefined) return undefined;
      return (await this.unpaused(turn)) ? answer : undefined;
    } finally {
      off();
      turn.asking -= 1;
    }
  }
}

/**
 * What a person changes about the harness's agents from their pages (Chips ADRs 0134, 0146, 0241),
 * for `connect({ settings })`: their files and their models, for Claude Code and Codex, whose files
 * and model options this bridge knows; and their context windows, for any kind. `bridge` is the one
 * running, once it is.
 */
export function settingsFor(kind: KindConfig, bridge: () => Bridge | undefined): SettingsHandlers {
  const active = (): Bridge => {
    const running = bridge();
    if (running === undefined) throw new Refuse("The harness is still starting.");
    return running;
  };
  return {
    ...(knownIdOf(kind) === undefined
      ? {}
      : {
          context: (edit: ContextEditFrame) => active().contextEdited(edit),
          models: (change: ModelChangeFrame) => active().modelChange(change),
        }),
    contextWindows: {
      compact: (ask) => active().windowCompact(ask),
      change: (ask) => active().windowChange(ask),
    },
  };
}

// ------------------------------------------------------------------ small words

function messageOf(error: unknown): string {
  if (error instanceof AcpError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** The run's goal: the message's first line, without the @ it opened with — the agent's whole name. */
export function goalOf(message: MessageNew, name: string): string {
  const first = message.text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  const named = first.toLowerCase().startsWith(`@${name.toLowerCase()}`);
  const goal = named ? first.slice(name.length + 1).trim() : first.replace(/^@\S+\s*/, "");
  return (goal === "" ? `Answer ${message.from.display_name}` : goal).slice(0, 300);
}

/**
 * What an agent is told when a person says its reply wasn't right (Chips ADR 0200): who said so,
 * its reply where the room still has it, what was wrong, or that they didn't say, and to look again.
 */
export function lookAgainPrompt(who: string, reply: string | undefined, note: string | undefined): string {
  const quoted = reply === undefined || reply.trim() === "" ? undefined : `Your reply:\n«${cut(reply.trim(), QUOTED)}»`;
  const wrong =
    note === undefined
      ? "They didn't say what. Read your reply again and find what was wrong."
      : `What wasn't right: «${note}»`;
  return [
    `${who} says your reply in this space wasn't right.`,
    quoted,
    wrong,
    "Look at it again and answer properly in its place. If it is not clear what was wrong, ask them in one short line. Say plainly what you changed.",
  ]
    .filter((part) => part !== undefined)
    .join("\n\n");
}

/** A second look's run, as the thinking bubble says it: what was wrong, by its first line. */
export function lookAgainGoal(note: string | undefined): string {
  const first = note?.split("\n").find((line) => line.trim() !== "")?.trim();
  return first === undefined ? "Looking again at its reply" : cut(`Looking again: ${first}`, 120);
}

/** At most `most` characters, the last an ellipsis where it was cut. */
function cut(text: string, most: number): string {
  return text.length <= most ? text : `${text.slice(0, most - 1)}…`;
}

function textOf(content: unknown): string {
  const block = content as { type?: unknown; text?: unknown } | undefined;
  return block?.type === "text" && typeof block.text === "string" ? block.text : "";
}

function lastLine(text: string): string {
  const lines = text.split(/(?<=[.!?])\s+|\n+/).map((line) => line.trim()).filter((line) => line !== "");
  return lines.at(-1) ?? "";
}

/** The tool's own name where the agent gives one, else what kind of call it is. */
function toolOf(call: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof call["name"] === "string" && call["name"] !== "") return call["name"];
  return typeof call["kind"] === "string" ? call["kind"] : undefined;
}

/**
 * What kind of call an ACP tool call is, in Chips's words (Chips ADR 0162), so the thinking
 * bubble draws it as what it does: ACP names a call's kind, rarely its tool.
 */
const KINDS: Readonly<Record<string, StepKind>> = {
  read: "file",
  move: "file",
  edit: "edit",
  delete: "edit",
  search: "search",
  execute: "shell",
  fetch: "web",
  think: "other",
  switch_mode: "other",
  other: "other",
};

function kindOf(kind: unknown): StepKind | undefined {
  return typeof kind === "string" ? KINDS[kind] : undefined;
}

function slugOf(word: string): string {
  const slug = word.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "");
  return slug === "" ? "other" : slug.slice(0, 60);
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toLowerCase() ?? ""}${text.slice(1)}`;
}

/** The most an approval's question holds: the protocol's `maxLength`, past which the ask is refused. */
const QUESTION_MAX = 200;

/**
 * An approval's question. Where the agent says what the call does in its own words (Claude Code's
 * `description`), those words are the question and its command follows in a `code` span, which
 * Chips draws in mono: "Syntax-check game.js? `node --check game.js`". Else "Allow it to" and the
 * call's title. A command too long for what is left is cut short; the preview holds all of it.
 */
export function questionFor(title: string, input: unknown): string {
  const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const said = oneLine(fields["description"])?.replace(/[\s.?!:;,]+$/, "");
  if (said === undefined || said === "") return `Allow it to ${lowerFirst(title)}?`.slice(0, QUESTION_MAX);
  const asked = `${clip(said, QUESTION_MAX - 1)}?`;
  const command = oneLine(Array.isArray(fields["command"]) ? fields["command"].join(" ") : fields["command"]);
  // A command with a backtick of its own can't sit in a span.
  const room = QUESTION_MAX - asked.length - 3;
  if (command === undefined || command.includes("`") || room < 12) return asked;
  return `${asked} \`${clip(command, room)}\``;
}

/** A string on one line, where it is one and isn't blank. */
function oneLine(value: unknown): string | undefined {
  const line = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return line === "" ? undefined : line;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Chips's closed risk classes, for the kinds of call that fit one. */
function riskOf(kind: string): RiskClass[] {
  if (kind === "delete") return ["destructive"];
  if (kind === "fetch") return ["external"];
  return [];
}

/**
 * The agent's option for a decision: always where it was allowed always and it has one. A
 * command's Always is the agent's once (Chips ADR 0239): Chips remembers it by how each part
 * starts and answers the next ask itself, where the agent's own always would let through more.
 */
function optionFor(
  decision: Decision,
  options: readonly { optionId: string; kind: string }[],
  command: boolean,
): string | undefined {
  const find = (kind: string) => options.find((option) => option.kind === kind)?.optionId;
  if (!decision.allowed) return find("reject_once") ?? find("reject_always");
  if (decision.scope === "always" && !command) return find("allow_always") ?? find("allow_once");
  return find("allow_once") ?? find("allow_always");
}

/** Whether a tool call's input carries a command, as a shell runs it: a string or its words. */
function carriesCommand(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const command = (input as Record<string, unknown>)["command"];
  return typeof command === "string" || Array.isArray(command);
}

function questionOf(
  id: string,
  field: Readonly<Record<string, unknown>>,
  message: string,
):
  | { questionId: string; prompt: string; options: { value: string; label: string }[] }
  | undefined {
  const prompt = String(field["title"] ?? field["description"] ?? message ?? id).slice(0, 500);
  if (field["type"] === "boolean") {
    return { questionId: id, prompt, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] };
  }
  const choices = Array.isArray(field["enum"]) ? (field["enum"] as unknown[]).map(String) : [];
  if (choices.length < 2 || choices.length > 4) return undefined;
  const names = Array.isArray(field["enumNames"]) ? (field["enumNames"] as unknown[]).map(String) : choices;
  return {
    questionId: id,
    prompt,
    options: choices.map((value, index) => ({ value, label: names[index] ?? value })),
  };
}

/** A room's title from its first words: their first line, cut at a word near 48 characters. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 24))}…`;
}

/** A copy's name, as Jacobian names its forks: `Nova · fork`, which Chips numbers when it is taken. */
export function forkName(original: string): string {
  return `${original.trim().replace(/ · fork( \d+)?$/, "")} · fork`;
}
