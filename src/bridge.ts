/**
 * ACP agents as one Chips harness. Each configured agent is a Chips agent (ADR 0087), registered
 * by its own key; the first is the harness's Main agent, in the harness's own room, in the place of
 * the default agent Chips gave the harness there. The first agent also answers for that default
 * agent, and any other of the harness's Chips doesn't name here, wherever Chips puts one. A room an
 * agent is in is one ACP session of it, made the first time somebody there speaks to it and kept
 * across restarts.
 *
 * A message for an agent is a run: `session/prompt` with what Chips hands over (the room note,
 * what was said, the words), and what the agent streams back is the run — thoughts as its status,
 * tool calls as steps, its plan, its context gauge and cost — then its words in the room. What it
 * asks permission for is an approval card; what it asks with a form is a question card. Stop is
 * `session/cancel`. A steer is said to it as the next prompt of the same run, after stopping the
 * turn when the steer interrupts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Agent, Chips, Decision, Run, Speaker } from "@chips/harness";
import { promptFor } from "@chips/harness";
import type { MessageNew, RiskClass } from "@chips/protocol";
import {
  AcpClient,
  AcpError,
  type AgentInfo,
  type AgentRequest,
  notOffered,
  type SessionUpdate,
  type Wire,
} from "./acp.js";

export interface AgentConfig {
  /** What a person sees, and its @handle: `Goose`. */
  readonly name: string;
  /** How to run it: `["goose", "acp"]`, `["gemini", "--acp"]`. */
  readonly command: readonly string[];
  /** Where its sessions work: the folder it may read and change. */
  readonly cwd: string;
  /** More environment for its process, beside this one's. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** What the bridge keeps across restarts beside the SDK's own store. */
export interface BridgeState {
  /** `<agent key>|<space id>` → the ACP session that room is. */
  sessions: Record<string, string>;
}

export interface BridgeOptions {
  readonly chips: Chips;
  readonly agents: readonly AgentConfig[];
  /** The harness's own room, where its Main agent lives. */
  readonly home?: string | undefined;
  readonly state: BridgeState;
  readonly saveState: (state: BridgeState) => void;
  /** How to run an agent: its process, unless a test hands in a wire of its own. */
  readonly wireFor: (agent: AgentConfig) => Wire;
  readonly log?: ((line: string) => void) | undefined;
  /** How long to wait before running an agent again after it stopped. */
  readonly respawnMs?: number | undefined;
}

const VERSION = "0.1.0";
/** How often a run's status and context gauge may change, so a stream of thoughts isn't a stream of events. */
const QUIET_MS = 1500;
/** How long a message waits for its agent to be running again before its run fails. */
const WAIT_FOR_AGENT_MS = 15_000;
/** The longest wait before running an agent again that keeps stopping. */
const MOST_RESPAWN_MS = 60_000;

/** A Chips agent's key for a configured agent. */
export function keyOf(agent: Pick<AgentConfig, "name">): string {
  return `acp:${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

interface Running {
  readonly config: AgentConfig;
  readonly key: string;
  agentId: string;
  client?: AcpClient | undefined;
  info?: AgentInfo | undefined;
  /** Sessions loaded or made by this process, so a stored one is loaded once. */
  readonly live: Set<string>;
  stopping: boolean;
  /** How many times in a row it stopped without saying hello: the wait to run it again grows. */
  failures: number;
}

/** A message for one of the harness's Chips agents, and which: the one that answers it. */
interface Asked {
  readonly message: MessageNew;
  /** The Chips agent it was for, or none where Chips named only the harness. */
  readonly speakerId: string | undefined;
}

/** One room's session, and the turn going in it. */
interface Room {
  readonly agent: Running;
  readonly spaceId: string;
  readonly queue: Asked[];
  busy: boolean;
  turn?: Turn | undefined;
}

/** The turn going in a room: its run, and what the agent has streamed into it. */
interface Turn {
  readonly run: Run;
  /** Who it is said as: the Chips agent the message was for. */
  readonly speaker: Speaker;
  /** The room's session, once it is open: empty until then. */
  sessionId: string;
  reply: string;
  thought: string;
  /** More to say to it in this run: a person's steer. */
  readonly next: string[];
  cancelled: boolean;
  costAtStart?: number | undefined;
  cost?: number | undefined;
  saidAt: number;
  gaugeAt: number;
  readonly steps: Map<string, { title: string; tool: string; done: boolean }>;
  /** Tool calls a person allowed, to their approvals: the card says how each went. */
  readonly allowed: Map<string, string>;
}

export class Bridge {
  private readonly agents: Running[] = [];
  private readonly rooms = new Map<string, Room>();
  /** The cost each session has run up, as its agent last said. */
  private readonly costs = new Map<string, number>();
  /** Every Chips agent of the harness's, configured here or not. */
  private ours = new Set<string>();
  private readonly log: (line: string) => void;

  constructor(private readonly options: BridgeOptions) {
    this.log = options.log ?? (() => undefined);
  }

  /** Register the agents, run them, and start hearing what is said to them. */
  async start(): Promise<void> {
    const { chips } = this.options;
    const known = await chips.agents.list();
    // A Main agent Chips has already is kept, under whatever key: a harness has one at most.
    const main = known.find((agent) => agent.lead);
    for (const [index, config] of this.options.agents.entries()) {
      const key = keyOf(config);
      const kept = index === 0 && main !== undefined && main.key !== key ? main : undefined;
      const registered = kept ?? (await chips.agents.register({ key, name: config.name, lead: index === 0 }));
      this.agents.push({ config, key, agentId: registered.agentId, live: new Set(), stopping: false, failures: 0 });
      if (index === 0) await this.goHome(registered, known);
    }
    this.ours = new Set([...known.map((agent) => agent.agentId), ...this.agents.map((agent) => agent.agentId)]);
    chips.on("message.new", (message) => void this.hear(message));
    await Promise.all(this.agents.map((agent) => this.run(agent)));
    await this.sayHowItIs();
  }

  /** The Main agent into the harness's own room, in the place of whichever of ours is there. */
  private async goHome(main: Agent, known: readonly Agent[]): Promise<void> {
    const { chips, home } = this.options;
    if (home === undefined || main.spaces.includes(home)) return;
    const there = known.find((agent) => agent.agentId !== main.agentId && agent.spaces.includes(home));
    await chips.agents
      .attach(main.agentId, { spaceId: home, replacing: there?.agentId ?? chips.harnessId })
      .catch((error: unknown) => this.log(`${main.name} stays out of its home: ${String(error)}`));
  }

  /** Stop every agent and run them again: a person's Restart. */
  async restart(): Promise<void> {
    for (const agent of this.agents) {
      agent.stopping = true;
      agent.client?.close();
    }
    for (const agent of this.agents) agent.stopping = false;
    await Promise.all(this.agents.map((agent) => this.run(agent)));
    await this.sayHowItIs();
  }

  stop(): void {
    for (const agent of this.agents) {
      agent.stopping = true;
      agent.client?.close();
    }
  }

  // ------------------------------------------------------------------ the agents' processes

  private async run(agent: Running): Promise<void> {
    agent.live.clear();
    agent.info = undefined;
    let wire: Wire;
    try {
      wire = this.options.wireFor(agent.config);
    } catch (error) {
      this.log(`${agent.config.name} didn't start: ${String(error)}`);
      return;
    }
    const client = new AcpClient(wire, {
      update: (sessionId, update) => this.updated(sessionId, update),
      request: (request) => this.asked(request),
      exit: (why) => void this.stopped(agent, client, why),
    });
    agent.client = client;
    try {
      agent.info = await client.initialize({ name: "chips-acp", version: VERSION });
      agent.failures = 0;
      this.log(`${agent.config.name} is running${agent.info.name === undefined ? "" : ` (${agent.info.name})`}`);
    } catch (error) {
      this.log(`${agent.config.name} didn't say hello: ${String(error)}`);
      client.close();
    }
  }

  private async stopped(agent: Running, client: AcpClient, why: string): Promise<void> {
    if (agent.client !== client) return;
    agent.client = undefined;
    for (const room of this.rooms.values()) {
      if (room.agent !== agent || room.turn === undefined) continue;
      room.turn.cancelled = true;
      if (!room.turn.run.over) {
        await room.turn.run.fail({ error: `${agent.config.name} stopped (${why}).`, retryable: true }).catch(() => undefined);
      }
    }
    if (agent.stopping) return;
    if (agent.info === undefined) agent.failures += 1;
    this.log(`${agent.config.name} stopped: ${why}`);
    await this.sayHowItIs();
    const wait = Math.min((this.options.respawnMs ?? 2000) * 2 ** agent.failures, MOST_RESPAWN_MS);
    setTimeout(() => {
      if (agent.client === undefined && !agent.stopping) void this.run(agent).then(() => this.sayHowItIs());
    }, wait).unref();
  }

  /** The agent's connection once it is running and has said hello, waiting a while if it is coming back. */
  private async running(agent: Running): Promise<AcpClient | undefined> {
    const by = Date.now() + WAIT_FOR_AGENT_MS;
    while (!agent.stopping) {
      const client = agent.client;
      if (client !== undefined && !client.gone && agent.info !== undefined) return client;
      if (Date.now() > by) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  }

  /** Trouble while an agent isn't running, and fine once all are (ADR 0083). */
  private async sayHowItIs(): Promise<void> {
    const down = this.agents.filter((agent) => agent.client === undefined || agent.client.gone);
    const chips = this.options.chips;
    const said =
      down.length === 0
        ? chips.reportOk()
        : chips.reportTrouble(`${down.map((agent) => agent.config.name).join(", ")} isn't running`);
    await said.catch(() => undefined);
  }

  // ------------------------------------------------------------------ what is said to it

  /** A message for some of its agents: each takes a turn in its room, one after another there. */
  private async hear(message: MessageNew): Promise<void> {
    const spaceId = message.space_id;
    if (spaceId === undefined) return;
    const harnessId = this.options.chips.harnessId;
    for (const taker of message.for ?? [harnessId]) {
      const agent = await this.runnerOf(taker);
      if (agent === undefined) continue;
      const room = this.roomOf(agent, spaceId);
      room.queue.push({ message, speakerId: taker === harnessId ? undefined : taker });
      void this.pump(room);
    }
  }

  /**
   * Which configured agent answers for a Chips agent: its own, or the first for the harness itself
   * and for any other of the harness's — its default agent, one Chips made since — read afresh once
   * when a name is new.
   */
  private async runnerOf(taker: string): Promise<Running | undefined> {
    const own = this.agents.find((agent) => agent.agentId === taker);
    if (own !== undefined) return own;
    if (taker !== this.options.chips.harnessId && !this.ours.has(taker)) {
      const listed = await this.options.chips.agents.list().catch(() => []);
      for (const agent of listed) this.ours.add(agent.agentId);
    }
    return taker === this.options.chips.harnessId || this.ours.has(taker) ? this.agents[0] : undefined;
  }

  private roomOf(agent: Running, spaceId: string): Room {
    const id = `${agent.key}|${spaceId}`;
    let room = this.rooms.get(id);
    if (room === undefined) {
      room = { agent, spaceId, queue: [], busy: false };
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
      this.log(`a turn of ${room.agent.config.name} went wrong: ${String(error)}`);
    } finally {
      room.busy = false;
      room.turn = undefined;
      void this.pump(room);
    }
  }

  private async turn(room: Room, { message, speakerId }: Asked): Promise<void> {
    const { agent, spaceId } = room;
    const speaker = speakerId === undefined ? this.options.chips : this.options.chips.as(speakerId);
    const run = await speaker.runs.start({ spaceId, goal: goalOf(message) });
    const turn: Turn = {
      run,
      speaker,
      sessionId: "",
      reply: "",
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
      if (turn.sessionId !== "") agent.client?.cancel(turn.sessionId);
    });
    run.on("steer", (steer) => {
      turn.next.push(`${steer.from?.display_name ?? "The person"} adds: ${steer.text}`);
      if (steer.mode === "interrupt" && turn.sessionId !== "") agent.client?.cancel(turn.sessionId);
    });
    const client = await this.running(agent);
    if (client === undefined) {
      if (!run.over) await run.fail({ error: `${agent.config.name} isn't running right now.`, retryable: true });
      return;
    }
    try {
      turn.sessionId = await this.sessionFor(agent, client, spaceId);
    } catch (error) {
      if (!run.over) await run.fail({ error: `${agent.config.name} couldn't open a session: ${messageOf(error)}` });
      return;
    }
    const { sessionId } = turn;
    turn.costAtStart = this.costs.get(sessionId);

    let words = promptFor(message, speakerId === undefined ? {} : { taker: speakerId });
    const files = await this.filesFor(agent, message);
    if (files.length > 0) words = `${words}\n\n${files.join("\n")}`;
    if (turn.cancelled) return;
    let stop = "end_turn";
    for (let prompt: string | undefined = words; prompt !== undefined; prompt = turn.next.shift()) {
      try {
        stop = await client.prompt(sessionId, [{ type: "text", text: prompt }]);
      } catch (error) {
        if (!run.over) await run.fail({ error: `${agent.config.name}: ${messageOf(error)}`, retryable: true });
        return;
      }
      if (turn.cancelled) return;
      if (stop === "cancelled" && turn.next.length > 0) continue;
      if (stop !== "end_turn" && stop !== "cancelled") break;
    }
    await this.finish(room, turn, stop);
  }

  /** The room's session: the one it had, loaded once, or a new one. */
  private async sessionFor(agent: Running, client: AcpClient, spaceId: string): Promise<string> {
    const key = `${agent.key}|${spaceId}`;
    const kept = this.options.state.sessions[key];
    if (kept !== undefined && agent.live.has(kept)) return kept;
    if (kept !== undefined && agent.info?.loadSession === true) {
      try {
        await client.loadSession(kept, agent.config.cwd);
        agent.live.add(kept);
        return kept;
      } catch (error) {
        this.log(`${agent.config.name} couldn't load ${kept}: ${messageOf(error)}; starting afresh`);
      }
    }
    const made = await client.newSession(agent.config.cwd);
    agent.live.add(made.sessionId);
    this.options.state.sessions[key] = made.sessionId;
    this.options.saveState(this.options.state);
    return made.sessionId;
  }

  /** The message's files, saved where the agent works, as lines that say where. */
  private async filesFor(agent: Running, message: MessageNew): Promise<string[]> {
    const lines: string[] = [];
    for (const file of message.attachments ?? []) {
      try {
        const folder = join(agent.config.cwd, "chips-files", message.message_id);
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
      await run.usage({ model: room.agent.config.name, outputTokens: 0, costUsd: spent }).catch(() => undefined);
    }
    if (stop === "refusal") {
      await run.fail({ error: `${room.agent.config.name} refused.` });
      return;
    }
    const reply = turn.reply.trim();
    if (reply !== "") await turn.speaker.post({ spaceId: room.spaceId, runId: run.id, text: reply });
    const cut = stop === "max_tokens" || stop === "max_turn_requests";
    const summary = reply === "" ? "Done." : reply.length <= 2000 ? reply : `${reply.slice(0, 1990)}…`;
    await run.complete({
      summary,
      ...(cut ? { followUps: [`${room.agent.config.name} stopped at its limit (${stop}).`] } : {}),
    });
  }

  private async settleSteps(turn: Turn, status: "done" | "failed"): Promise<void> {
    for (const [stepId, step] of turn.steps) {
      if (step.done) continue;
      step.done = true;
      await turn.run.step({ stepId, status, title: step.title, tool: step.tool }).catch(() => undefined);
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

  private gauge(turn: Turn, update: SessionUpdate): void {
    const used = update["used"];
    const size = update["size"];
    if (typeof used !== "number" || typeof size !== "number" || size <= 0) return;
    const now = Date.now();
    if (now - turn.gaugeAt < QUIET_MS) return;
    turn.gaugeAt = now;
    void turn.run.context({ usedTokens: used, limitTokens: size, model: "agent" }).catch(() => undefined);
  }

  private async stepped(turn: Turn, update: SessionUpdate): Promise<void> {
    const stepId = String(update["toolCallId"] ?? "");
    if (stepId === "") return;
    const known = turn.steps.get(stepId);
    const title = typeof update["title"] === "string" ? update["title"] : (known?.title ?? "A tool call");
    const tool = toolOf(update) ?? known?.tool ?? "tool";
    const status = update["status"];
    const done = status === "completed" || status === "failed";
    if (known?.done === true) return;
    turn.steps.set(stepId, { title, tool, done });
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

function goalOf(message: MessageNew): string {
  const first = message.text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  const goal = first.replace(/^@\S+\s*/, "");
  return (goal === "" ? `Answer ${message.from.display_name}` : goal).slice(0, 300);
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
