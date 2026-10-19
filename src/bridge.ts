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
 * what was said, the words), and what the agent streams back is the run — thoughts as its status,
 * tool calls as steps, its plan, its context gauge and cost — then its words in the room. What it
 * asks permission for is an approval card; what it asks with a form is a question card. Stop is
 * `session/cancel`. A steer is said to it as the next prompt of the same run, after stopping the
 * turn when the steer interrupts. A person's "Not right?" on a reply is one more turn of the agent
 * who said it, in that room, looking at it again.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Agent, Chips, Decision, Run, Speaker, SpaceAsked } from "@chipschat/harness";
import { promptFor, sendAnswer } from "@chipschat/harness";
import type { AgentAsked, AgentFork, AnyEvent, Feedback, MessageNew, RiskClass, StepKind } from "@chipschat/protocol";
import {
  AcpClient,
  AcpError,
  type AgentInfo,
  type AgentRequest,
  type AuthStatus,
  isAuthRequired,
  notOffered,
  type SessionUpdate,
  type Wire,
} from "./acp.js";
import { signedOutWords } from "./kinds.js";

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
  /** Where each agent gets a folder of its own, named after it: `~/chips-acp/claude-code`. */
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
}

/** What the bridge keeps across restarts beside the SDK's own store. */
export interface BridgeState {
  /** `<agent key>|<space id>` → the ACP session that room is. */
  sessions: Record<string, string>;
  /** The harness's agents, by key. */
  agents: Record<string, AgentRecord>;
}

export interface BridgeOptions {
  readonly chips: Chips;
  readonly kind: KindConfig;
  readonly state: BridgeState;
  readonly saveState: (state: BridgeState) => void;
  /** How to run the agent: its process, unless a test hands in a wire of its own. */
  readonly wire: () => Wire;
  readonly log?: ((line: string) => void) | undefined;
  /** How long to wait before running the agent again after it stopped. */
  readonly respawnMs?: number | undefined;
  /** How long a session may be quiet before it is closed: half an hour unless said. */
  readonly idleMs?: number | undefined;
}

const VERSION = "0.2.0";
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

/** The agent's process: one for every agent of the kind, a session for each of their rooms. */
interface Process {
  client?: AcpClient | undefined;
  info?: AgentInfo | undefined;
  /** Who it last said it is signed in as, so the log says each change once. */
  auth?: string | undefined;
  /** Sessions open in this process, so a stored one is loaded once. */
  readonly live: Set<string>;
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
}

/** One agent's session in one room, and the turn going in it. */
interface Room {
  readonly record: AgentRecord;
  readonly spaceId: string;
  readonly queue: Asked[];
  busy: boolean;
  turn?: Turn | undefined;
  /** When it last ended a turn, for closing it once it has been quiet a while. */
  usedAt: number;
}

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
  costAtStart?: number | undefined;
  cost?: number | undefined;
  saidAt: number;
  gaugeAt: number;
  readonly steps: Map<string, { title: string; tool: string; kind: StepKind; done: boolean }>;
  /** Tool calls a person allowed, to their approvals: the card says how each went. */
  readonly allowed: Map<string, string>;
}

export class Bridge {
  private readonly process: Process = { live: new Set(), stopping: false, failures: 0 };
  private readonly rooms = new Map<string, Room>();
  /** The cost each session has run up, as the agent last said. */
  private readonly costs = new Map<string, number>();
  private readonly log: (line: string) => void;
  /** What Chips asks waits for the agents to be known: they are read at start. */
  private readonly known: Promise<void>;
  private knew: () => void = () => undefined;
  /** Records are made one at a time, so two never take the same folder. */
  private making: Promise<unknown> = Promise.resolve();
  /** The feedback already answered, oldest first. */
  private readonly answered = new Set<string>();
  private sweeper?: NodeJS.Timeout | undefined;

  constructor(private readonly options: BridgeOptions) {
    this.log = options.log ?? (() => undefined);
    this.known = new Promise((resolve) => {
      this.knew = resolve;
    });
  }

  /** Hear what Chips asks, learn the agents Chips has, run the agent, and close idle sessions. */
  async start(): Promise<void> {
    const { chips } = this.options;
    const after = (what: string, then: () => Promise<void>) => {
      void this.known.then(then).catch((error: unknown) => this.log(`${what} went wrong: ${messageOf(error)}`));
    };
    chips.on("message.new", (message) => after("a message", () => this.hear(message)));
    chips.on("agent.asked", (asked) => after("a new agent", () => this.make(asked)));
    chips.on("agent.fork", (fork) => after("a copy", () => this.copy(fork)));
    chips.on("feedback", (feedback) => after("a second look", () => this.lookAgain(feedback)));
    chips.on("event", (event) => after(event.type, () => this.noted(event)));
    chips.onSpaceAsked((asked) => after("a room from the +", () => this.claim(asked)));
    await this.know(await chips.agents.list(), { forget: true });
    this.knew();
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
  }

  // ------------------------------------------------------------------ the agents

  private records(): AgentRecord[] {
    return Object.values(this.options.state.agents);
  }

  private save(): void {
    this.options.saveState(this.options.state);
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
        };
        changed = true;
      }
      if (changed) this.save();
    });
    if (!forget) return;
    for (const record of this.records()) {
      if (!agents.some((agent) => agent.key === record.key)) await this.forget(record.key);
    }
  }

  /** A record for an agent Chips is about to be asked to register: a new key, and its folder. */
  private made(
    name: string,
    more: { readonly answers: string; readonly folder?: string; readonly forkedFrom?: string },
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
   * the same folder. A session that won't copy makes no copy: Chips tells the person.
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
      let copied: string | undefined;
      if (from !== undefined) {
        const client = await this.running();
        if (client === undefined || this.process.info?.forkSession !== true) {
          this.log(`${original.name} can't be copied: ${client === undefined ? "the agent isn't running" : "the agent doesn't copy sessions"}`);
          return;
        }
        copied = await client.forkSession(from, original.folder);
        this.process.live.add(copied);
        await this.moded(client, copied);
      }
      record = await this.made(forkName(original.name), {
        answers: fork.id,
        folder: original.folder,
        forkedFrom: original.agentId,
      });
      if (copied !== undefined) {
        state.sessions[`${record.key}|${spaceId}`] = copied;
        this.save();
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
        return made;
      }));
    this.log(`${agent.name} claimed ${spaceId}, in ${record.folder}`);
    // The first words are the ask's, not heard again as a message: said to the agent as one.
    const message = {
      type: "message.new",
      space_id: spaceId,
      message_id: firstMessage.messageId,
      text: firstMessage.text,
      from: { participant_id: asked.askedBy, kind: "person", display_name: await this.whoSaid(asked), role: "member" },
      for: [agent.agentId],
    } as unknown as MessageNew;
    const room = this.roomOf(record, spaceId);
    room.queue.push({ message, speakerId: agent.agentId });
    void this.pump(room);
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
    for (const [id, room] of this.rooms) {
      if (room.record.key !== key) continue;
      room.queue.length = 0;
      if (room.turn !== undefined && room.turn.sessionId !== "") this.process.client?.cancel(room.turn.sessionId);
      this.rooms.delete(id);
    }
    for (const [id, sessionId] of Object.entries(state.sessions)) {
      if (!id.startsWith(`${key}|`)) continue;
      delete state.sessions[id];
      if (this.process.live.delete(sessionId) && this.process.info?.closeSession === true) {
        await this.process.client?.closeSession(sessionId).catch(() => undefined);
      }
    }
    this.save();
    this.log(`${record.name} deleted; its folder stays, ${record.folder}`);
  }

  // ------------------------------------------------------------------ the agent's process

  private async run(): Promise<void> {
    const proc = this.process;
    const { name } = this.options.kind;
    proc.live.clear();
    proc.info = undefined;
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

  /** A message for some of its agents: each takes a turn in its room, one after another there. */
  private async hear(message: MessageNew, again?: string): Promise<void> {
    const spaceId = message.space_id;
    if (spaceId === undefined) return;
    const harnessId = this.options.chips.harnessId;
    for (const taker of message.for ?? [harnessId]) {
      const record = taker === harnessId ? await this.inRoom(spaceId) : await this.recordOf(taker);
      if (record === undefined) continue;
      const room = this.roomOf(record, spaceId);
      room.queue.push({ message, speakerId: taker === harnessId ? undefined : taker, again });
      void this.pump(room);
    }
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
      room = { record, spaceId, queue: [], busy: false, usedAt: Date.now() };
      this.rooms.set(id, room);
    }
    return room;
  }

  private async pump(room: Room): Promise<void> {
    if (room.busy) return;
    const asked = room.queue.shift();
    if (asked === undefined) return;
    room.busy = true;
    try {
      await this.turn(room, asked);
    } catch (error) {
      this.log(`a turn of ${room.record.name} went wrong: ${String(error)}`);
    } finally {
      room.busy = false;
      room.turn = undefined;
      room.usedAt = Date.now();
      void this.pump(room);
    }
  }

  private async turn(room: Room, { message, speakerId, again }: Asked): Promise<void> {
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
      saidAt: 0,
      gaugeAt: 0,
      steps: new Map(),
      allowed: new Map(),
    };
    room.turn = turn;
    // Heard from the start, so a Stop while the session is still opening stops it too.
    run.on("cancel", () => {
      turn.cancelled = true;
      if (turn.sessionId !== "") this.process.client?.cancel(turn.sessionId);
    });
    run.on("steer", (steer) => {
      turn.next.push(`${steer.from?.display_name ?? "The person"} adds: ${steer.text}`);
      if (steer.mode === "interrupt" && turn.sessionId !== "") this.process.client?.cancel(turn.sessionId);
    });
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
    turn.costAtStart = this.costs.get(sessionId);

    let words = promptFor(message, {
      ...(speakerId === undefined ? {} : { taker: speakerId }),
      ...(again === undefined ? {} : { sayWho: false }),
      sendsFiles: true,
    });
    const files = await this.filesFor(record, message);
    if (files.length > 0) words = `${words}\n\n${files.join("\n")}`;
    if (turn.cancelled) return;
    let stop = "end_turn";
    for (let prompt: string | undefined = words; prompt !== undefined; prompt = turn.next.shift()) {
      try {
        stop = await client.prompt(sessionId, [{ type: "text", text: prompt }]);
      } catch (error) {
        if (!run.over) await run.fail({ error: this.failure(record, error), retryable: true });
        return;
      }
      if (turn.cancelled) return;
      if (stop === "cancelled" && turn.next.length > 0) continue;
      if (stop !== "end_turn" && stop !== "cancelled") break;
    }
    await this.finish(room, turn, stop);
  }

  /** The room's session: the one it had, loaded once, or a new one, in the agent's folder. */
  private async sessionFor(record: AgentRecord, client: AcpClient, spaceId: string): Promise<string> {
    const { state } = this.options;
    const { live, info } = this.process;
    const key = `${record.key}|${spaceId}`;
    const kept = state.sessions[key];
    if (kept !== undefined && live.has(kept)) return kept;
    if (kept !== undefined && info?.loadSession === true) {
      try {
        await client.loadSession(kept, record.folder);
        live.add(kept);
        await this.moded(client, kept);
        return kept;
      } catch (error) {
        this.log(`${record.name} couldn't load ${kept}: ${messageOf(error)}; starting afresh`);
      }
    }
    const made = await client.newSession(record.folder);
    live.add(made.sessionId);
    await this.moded(client, made.sessionId);
    state.sessions[key] = made.sessionId;
    this.save();
    return made.sessionId;
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

  /** The turn is over: its words in the room, what it cost, and the run ended as it went. */
  private async finish(room: Room, turn: Turn, stop: string): Promise<void> {
    const { run } = turn;
    if (run.over) return;
    await this.settleSteps(turn, "done");
    for (const approvalId of turn.allowed.values()) {
      await run.executed(approvalId, "executed", "The agent didn't say how it went.").catch(() => undefined);
    }
    const spent = (turn.cost ?? 0) - (turn.costAtStart ?? 0);
    if (turn.cost !== undefined && spent > 0) {
      // ACP says what a session has cost, not its tokens: the cost alone (Chips ADR 0162).
      await run.usage({ model: turn.agentName, costUsd: spent }).catch(() => undefined);
    }
    if (stop === "refusal") {
      await run.fail({ error: `${room.record.name} refused.` });
      return;
    }
    // Its last words; when it ended on a tool call, the words before it.
    const answer = turn.reply.trim() || (turn.said.at(-1) ?? "");
    // The files its `MEDIA:` lines name go with its words, from its folder (Chips TT-7).
    const { chips } = this.options;
    const post = await sendAnswer(answer, { folders: [room.record.folder], upload: (input) => chips.upload(input) });
    const reply = post.text;
    if (reply !== "" || post.uploadIds.length > 0) {
      await turn.speaker.post({ spaceId: room.spaceId, runId: run.id, text: reply, uploadIds: post.uploadIds });
    }
    const cut = stop === "max_tokens" || stop === "max_turn_requests";
    const said = post.summary;
    const summary = said === "" ? "Done." : said.length <= 2000 ? said : `${said.slice(0, 1990)}…`;
    await run.complete({
      summary,
      ...(cut ? { followUps: [`${room.record.name} stopped at its limit (${stop}).`] } : {}),
    });
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
    const turn = this.turnOf(sessionId);
    if (turn === undefined) return; // a loaded session's history, or a turn already over
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        turn.reply += textOf(update["content"]);
        return;
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
    this.costs.set(sessionId, cost.amount);
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
    const call = (params["toolCall"] ?? {}) as Record<string, unknown>;
    const kind = toolOf(call) ?? "other";
    const title = typeof call["title"] === "string" ? call["title"] : `use ${kind}`;
    const input = call["rawInput"];
    const asked = turn.run.approval({
      action: { kind: `acp.${slugOf(kind)}`, input: input ?? {} },
      question: `Allow it to ${lowerFirst(title)}?`.slice(0, 300),
      lasts: "once",
      risk: riskOf(kind),
      ...(input === undefined
        ? {}
        : { preview: { format: "json" as const, body: JSON.stringify(input, null, 2).slice(0, 200_000) } }),
      ...(call["toolCallId"] === undefined ? {} : { stepId: String(call["toolCallId"]) }),
    });
    const stopped = new Promise<undefined>((resolve) => turn.run.on("cancel", () => resolve(undefined)));
    const decision = await Promise.race([asked, stopped]);
    if (decision === undefined) return { outcome: { outcome: "cancelled" } };
    const chosen = optionFor(decision, options);
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
    const answer = await turn.run.question({ questions: questions as NonNullable<(typeof questions)[number]>[] });
    if (answer.timedOut) return { action: "cancel" };
    const content: Record<string, unknown> = {};
    for (const [id, field] of properties) {
      const value = answer.answers[id]?.values[0];
      if (value === undefined) continue;
      content[id] = field["type"] === "boolean" ? value === "yes" : value;
    }
    return { action: "accept", content };
  }
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
    `${who} says your reply in this room wasn't right.`,
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

/** Chips's closed risk classes, for the kinds of call that fit one. */
function riskOf(kind: string): RiskClass[] {
  if (kind === "delete") return ["destructive"];
  if (kind === "fetch") return ["external"];
  return [];
}

/** The agent's option for a decision: always where it was allowed always and it has one. */
function optionFor(
  decision: Decision,
  options: readonly { optionId: string; kind: string }[],
): string | undefined {
  const find = (kind: string) => options.find((option) => option.kind === kind)?.optionId;
  if (!decision.allowed) return find("reject_once") ?? find("reject_always");
  if (decision.scope === "always") return find("allow_always") ?? find("allow_once");
  return find("allow_once") ?? find("allow_always");
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
