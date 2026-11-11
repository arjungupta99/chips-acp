/**
 * The bridge between Chips's conformance fake — the wire as Chips speaks it, every event checked
 * against the protocol's schemas — and an ACP agent in this process.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FakeChips, type StoredEvent, startFakeChips } from "@chipschat/conformance";
import { type Chips, connect, type Run, SENDING_FILES } from "@chipschat/harness";
import { type Feedback, messageIdOf, newId } from "@chipschat/protocol";
import {
  Bridge,
  type BridgeState,
  forkName,
  goalOf,
  type KindConfig,
  lookAgainGoal,
  lookAgainPrompt,
  questionFor,
  titleFrom,
} from "../src/bridge.ts";
import { type FakeAgent, fakeAgent } from "./fake-agent.ts";

const CAPABILITIES = ["agents", "new_spaces", "new_agents", "forks", "restarts"];

interface Rig {
  readonly chips: FakeChips;
  readonly client: Chips;
  readonly bridge: Bridge;
  readonly agent: FakeAgent;
  readonly state: BridgeState;
  readonly kind: KindConfig;
  /** The agent Chips gave the harness, in its own room. */
  readonly agentId: string;
  /** What the bridge wrote to its log. */
  readonly logs: string[];
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

async function rig(
  options: {
    agent?: FakeAgent;
    state?: BridgeState;
    chips?: FakeChips;
    mode?: string;
    idleMs?: number;
    folders?: string;
    folder?: string;
    projects?: boolean;
  } = {},
): Promise<Rig> {
  const chips = options.chips ?? (await startFakeChips({ capabilities: CAPABILITIES, harnessName: "Fakey" }));
  if (options.chips === undefined) open.push(() => chips.close());
  const client = await connect({ url: chips.address.url, token: chips.address.token });
  const agent = options.agent ?? fakeAgent();
  const state = options.state ?? { sessions: {}, agents: {} };
  const kind: KindConfig = {
    name: "Fakey",
    command: ["fake"],
    folders: options.folders ?? mkdtempSync(join(tmpdir(), "chips-acp-")),
    ...(options.folder === undefined ? {} : { folder: options.folder }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  };
  const logs: string[] = [];
  const bridge = new Bridge({
    chips: client,
    kind,
    state,
    saveState: () => undefined,
    wire: () => agent.wire(),
    log: (line) => logs.push(line),
    respawnMs: 20,
    ...(options.projects === undefined ? {} : { projects: options.projects }),
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  });
  open.push(async () => {
    bridge.stop();
    client.close();
  });
  await bridge.start();
  const agents = await client.agents.list();
  const agentId = agents.find((each) => each.key === chips.address.harnessId)?.agentId ?? "";
  return { chips, client, bridge, agent, state, kind, agentId, logs };
}

/** Once `done` holds, checked every few milliseconds: for what the log doesn't show. */
async function until(done: () => boolean, timeoutMs = 3000): Promise<void> {
  const by = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > by) throw new Error(`not so within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The first event of a type the bridge's agent sent, with more to match when given. */
function sent(
  chips: FakeChips,
  type: string,
  more: (event: StoredEvent) => boolean = () => true,
): Promise<StoredEvent> {
  return chips.waitFor(
    (event) => (event.type === type && more(event) ? event : undefined),
    3000,
  );
}

/** The record of an agent the bridge keeps, by its name. */
function recordNamed(state: BridgeState, name: string) {
  return Object.values(state.agents).find((record) => record.name === name);
}

/**
 * The record that has an agent's id: Chips says the agent joined before `register` answers the
 * bridge, so the record takes its id a moment after.
 */
async function recordOf(state: BridgeState, joined: StoredEvent) {
  const agentId = String(joined.payload["participant_id"]);
  await until(() => Object.values(state.agents).some((record) => record.agentId === agentId));
  return Object.values(state.agents).find((record) => record.agentId === agentId);
}

/** A new agent asked for by name in a room of its own, once it has joined: the room. */
async function newAgent(chips: FakeChips, state: BridgeState, name: string): Promise<string> {
  const spaceId = await chips.openRoom(`${name}'s room`);
  const { askId } = await chips.askForAgent(spaceId, name);
  await recordOf(state, await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId));
  return spaceId;
}

describe("the room's project (Chips ADR 0221)", () => {
  it("hands the agent its copy in its folder, and sends what it left there with its next turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "chips-acp-project-"));
    open.push(async () => rmSync(root, { recursive: true, force: true }));
    const { chips, agent, agentId, logs } = await rig({ folders: root, projects: true });
    await chips.say("start the notes");
    await sent(chips, "run.completed");
    const copy = join(root, "fakey", "room");
    assert.ok(
      (agent.prompts[0] ?? "").includes(`The space's project is a git repository. Your copy is ${copy} (0 files), brought up to date just now.`),
      agent.prompts[0],
    );
    assert.ok(logs.includes("Fakey's project: nothing to send"), logs.join("\n"));

    // The turn that wrote this stopped before it could send it: the next one takes it.
    writeFileSync(join(copy, "notes.md"), "One sentence.\n");
    await chips.say("go on");
    const changed = await sent(chips, "project.changed");
    assert.equal(changed.payload["by"], agentId);
    assert.deepEqual(changed.payload["files"], [{ path: "notes.md", added: 1, removed: 0 }]);
    assert.match(agent.prompts[1] ?? "", /In Markdown, put each sentence on a line of its own\./);
  });

  it("says after its words when its change didn't reach the project (Chips AP-6)", async () => {
    const root = mkdtempSync(join(tmpdir(), "chips-acp-project-"));
    open.push(async () => rmSync(root, { recursive: true, force: true }));
    const { chips } = await rig({ folders: root, projects: true });
    await chips.say("start the notes");
    await sent(chips, "run.completed");
    // A key in the copy holds the whole change back: the reply mustn't read as if it went.
    const key = ["sk-", "ant-", "api03-", "Z".repeat(40)].join("");
    writeFileSync(join(root, "fakey", "room", "config.js"), `export const key = "${key}";\n`);
    await chips.say("go on");
    const posted = await sent(chips, "message.post", (event) => String(event.payload["text"] ?? "").includes("(Not in"));
    assert.match(
      String(posted.payload["text"]),
      /\n\n\(Not in the space's project: config\.js looks like it holds an Anthropic key, so nothing was sent\.\)$/,
    );
    assert.equal(posted.payload["change"], undefined);
  });

  it("leaves an agent the config puts in a folder of the person's working there, with no project", async () => {
    const own = mkdtempSync(join(tmpdir(), "chips-acp-own-"));
    open.push(async () => rmSync(own, { recursive: true, force: true }));
    const { chips, agent } = await rig({ folder: own, projects: true });
    await chips.say("look at my repo");
    await sent(chips, "run.completed");
    assert.doesNotMatch(agent.prompts[0] ?? "", /The space's project/);
    assert.equal(existsSync(join(own, "room")), false);
  });
});

describe("a turn", () => {
  it("names its run by the words after the agent's whole @name", () => {
    const message = (text: string) => ({ text, from: { display_name: "Arjun" } }) as Parameters<typeof goalOf>[0];
    assert.equal(goalOf(message("@Claude Code Delete second.txt"), "Claude Code"), "Delete second.txt");
    assert.equal(goalOf(message("@Codex Run curl"), "Codex"), "Run curl");
    assert.equal(goalOf(message("@Claude Code"), "Claude Code"), "Answer Arjun");
  });

  it("answers with its last words: what it said before a tool call is the bubble's", async () => {
    const { chips } = await rig();
    await chips.say("narrate");
    const started = await sent(chips, "run.started");
    const status = await sent(chips, "run.status", (event) => event.payload["phase"] === "writing");
    assert.equal(status.payload["verb_phrase"], "I'll read the notes first.");
    const words = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    assert.equal(words.payload["text"], "Here is the answer.");
  });

  it("puts each session in the mode the config names, and names the kind on the gauge", async () => {
    const { chips, agent } = await rig({ mode: "default" });
    await chips.say("hello");
    const gauge = await sent(chips, "context.usage");
    assert.equal(gauge.payload["model"], "Fakey");
    await sent(chips, "run.completed");
    assert.deepEqual(agent.modes, [`${agent.made[0]}:default`]);
  });

  // Codex hosted its game on a site, or linked a path nobody in the room could open (Chips TT-7, TT-9).
  it("sends each file a MEDIA: line names from the agent's folder, and says what it couldn't send", async () => {
    const { chips, agent } = await rig();
    await chips.say("send");
    const started = await sent(chips, "run.started");
    const words = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    assert.equal(words.payload["text"], "The page is ready.\n\n(hosts was not attached: it is outside the agent's folder.)");
    const attachments = words.payload["attachments"] as { filename: string }[];
    assert.deepEqual(
      attachments.map((each) => each.filename),
      ["page.html"],
    );
    assert.match(agent.prompts[0] ?? "", /MEDIA:<path> on a line of its own/, "it was told how");
  });

  it("is a run: a status, a step, the words in the room, its cost, and the end", async () => {
    const { chips, agentId } = await rig();
    await chips.say("summarise the notes");
    const started = await sent(chips, "run.started");
    assert.equal(started.actor.id, agentId, "the harness's own agent took it");
    assert.equal(started.payload["goal"], "summarise the notes");
    const step = await sent(chips, "step.log", (event) => event.payload["status"] === "done");
    assert.equal(step.payload["tool"], "read");
    assert.equal(step.payload["kind"], "file", "ACP's read is a file, drawn as one");
    assert.equal(step.payload["title"], "read · Read notes.md");
    const words = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    assert.equal(words.payload["text"], "Here is the answer.");
    const usage = await sent(chips, "usage");
    assert.deepEqual(usage.payload["cost"], { usd: 0.02, estimated: true });
    assert.equal(usage.payload["output_tokens"], undefined, "the cost alone, no made-up tokens");
    const done = await sent(chips, "run.completed");
    assert.equal(done.payload["summary"], "Here is the answer.");
  });

  it("hands the agent the room's note and who said it", async () => {
    const { chips, agent } = await rig();
    await chips.say("hello there");
    await sent(chips, "run.completed");
    const prompt = agent.prompts[0] ?? "";
    assert.match(prompt, /In this space:/);
    assert.match(prompt, /: hello there$/);
  });

  it("hands the agent the message a reply answers, after what was said and before the words (Chips ADR 0219)", async () => {
    const { chips, agent } = await rig();
    await chips.say("summarise the notes");
    const started = await sent(chips, "run.started");
    const answer = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    await sent(chips, "run.completed");
    await chips.say("Shorter, please", undefined, { replyTo: messageIdOf(answer.id) });
    await chips.waitFor((event) => (event.type === "run.completed" && agent.prompts.length === 2 ? event : undefined), 3000);
    const prompt = agent.prompts[1] ?? "";
    const quote = String(answer.payload["text"])
      .split("\n")
      .map((line) => (line === "" ? ">" : `> ${line}`))
      .join("\n");
    // Who replies says their standing, as every line of the turn does (Chips SEC-49).
    assert.match(prompt, /Arjun \(owner\) is replying to your message from today at \d{1,2}:\d{2} [AP]M\.\nYour message:\n/);
    assert.ok(prompt.includes(`Your message:\n${quote}\n\n`), prompt);
    assert.match(prompt, /Shorter, please$/);
  });

  it("tells a session the room's rules once, and again after it compacts (Chips ADR 0250)", async () => {
    const { chips, agent } = await rig({ agent: fakeAgent({ compaction: "claude" }) });
    const turn = async (words: string, count: number) => {
      await chips.say(words);
      await chips.waitFor(
        (event) => (event.type === "run.completed" && agent.prompts.length === count ? event : undefined),
        3000,
      );
    };
    await turn("one", 1);
    await turn("two", 2);
    await turn("fold", 3);
    await turn("three", 4);
    const [first, second, folding, after] = agent.prompts;
    for (const rule of ["Everyone here reads what you write.", "MEDIA:<path>"]) {
      assert.ok(first?.includes(rule), rule);
      assert.ok(!second?.includes(rule), rule);
      assert.ok(!folding?.includes(rule), rule);
      assert.ok(after?.includes(rule), rule);
    }
    assert.match(second ?? "", /In this space:/);
    assert.match(second ?? "", /: two$/);
  });

  it("keeps one session per room, and a second message is the same session", async () => {
    const { chips, agent, state } = await rig();
    await chips.say("one");
    await sent(chips, "run.completed");
    await chips.say("two");
    await chips.waitFor(
      (event) => (event.type === "run.completed" && agent.prompts.length === 2 ? event : undefined),
      3000,
    );
    assert.equal(agent.made.length, 1);
    assert.deepEqual(Object.values(state.sessions), agent.made);
  });

  it("passes when the agent says NO_REPLY, and fails when it refuses", async () => {
    const { chips } = await rig();
    await chips.say("nothing");
    await sent(chips, "turn.passed");
    await sent(chips, "run.completed");
    await chips.say("refuse");
    const failed = await sent(chips, "run.failed");
    assert.match(String(failed.payload["error"]), /refused/);
  });

  it("says how to sign in when the agent refuses the turn, or the session, because it isn't", async () => {
    const words = /^Fakey isn't signed in on this machine: sign it in its own way \(Fake sign-in\)\. Then send this again\.$/;
    for (const agent of [fakeAgent({ auth: "out" }), fakeAgent({ auth: "out", refusesSessions: true })]) {
      const { chips } = await rig({ agent });
      await chips.say("hello");
      const failed = await sent(chips, "run.failed");
      assert.match(String(failed.payload["error"]), words);
      assert.equal(failed.payload["retryable"], true);
    }
  });
});

describe("no Main agent", () => {
  it("registers none: the harness's own agent is an ordinary one, in a folder of its own", async () => {
    const { chips, agent, state, kind, agentId } = await rig();
    const agents = [...chips.workspace.agents.values()];
    assert.ok(agents.length > 0 && agents.every((each) => !each.lead), "nothing is the Main agent");
    const own = recordNamed(state, "Fakey");
    assert.equal(own?.agentId, agentId);
    assert.equal(own?.folder, join(kind.folders, "fakey"));
    assert.ok(existsSync(own?.folder ?? ""), "its folder is made");
    await chips.say("hello");
    await sent(chips, "run.completed");
    assert.equal(agent.cwds.get(agent.made[0] ?? ""), own?.folder, "its session works in its folder");
  });

  it("lets a person move the harness's own agent out of its room", async () => {
    const { chips, agentId } = await rig();
    const elsewhere = await chips.openRoom("Elsewhere");
    const moved = chips.workspace.moveAgent(agentId, elsewhere);
    assert.ok(moved.ok, JSON.stringify(moved));
    await chips.say("over here", elsewhere);
    const started = await sent(chips, "run.started", (event) => event.space_id === elsewhere);
    assert.equal(started.actor.id, agentId);
  });

  it("works every agent in the one folder the config names, where it names one", async () => {
    const folder = mkdtempSync(join(tmpdir(), "chips-acp-shared-"));
    const { chips, agent, state } = await rig({ folder });
    assert.equal(recordNamed(state, "Fakey")?.folder, folder);
    await newAgent(chips, state, "Nova");
    assert.equal(recordNamed(state, "Nova")?.folder, folder);
    await chips.say("hello");
    await sent(chips, "run.completed");
    assert.equal(agent.cwds.get(agent.made[0] ?? ""), folder);
  });
});

describe("a session that goes quiet", () => {
  it("is closed, and loaded again on the next message", async () => {
    const agent = fakeAgent({ loadSession: true, close: true });
    const { chips, state } = await rig({ agent, idleMs: 60 });
    await chips.say("one");
    await sent(chips, "run.completed");
    await until(() => agent.closed.length === 1);
    assert.deepEqual(agent.closed, agent.made, "the room's session, closed");
    await chips.say("two");
    await chips.waitFor(
      (event) => (event.type === "run.completed" && agent.prompts.length === 2 ? event : undefined),
      3000,
    );
    assert.equal(agent.made.length, 1, "no second session");
    assert.deepEqual(agent.loaded, agent.made, "the first one, loaded");
    assert.deepEqual(Object.values(state.sessions), agent.made);
  });

  it("stays open where the agent couldn't load it again", async () => {
    const agent = fakeAgent({ close: true });
    const { chips } = await rig({ agent, idleMs: 30 });
    await chips.say("one");
    await sent(chips, "run.completed");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(agent.closed, []);
  });
});

describe("a new agent a person asks for", () => {
  it("is made in a folder of its own, joins the room, and answers there", async () => {
    const { chips, agent, state, kind } = await rig();
    const spaceId = await chips.openRoom("Fresh eyes");
    const { askId } = await chips.askForAgent(spaceId, "Nova");
    const joined = await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId);
    const nova = await recordOf(state, joined);
    assert.equal(nova?.name, "Nova");
    assert.equal(nova?.folder, join(kind.folders, "nova"));
    assert.ok(existsSync(nova?.folder ?? ""));
    await chips.say("@Nova hello", spaceId);
    const started = await sent(chips, "run.started", (event) => event.space_id === spaceId);
    assert.equal(started.actor.id, nova?.agentId);
    assert.equal(started.payload["goal"], "hello");
    await sent(chips, "run.completed", (event) => event.space_id === spaceId);
    assert.equal(agent.cwds.get(state.sessions[`${nova?.key}|${spaceId}`] ?? ""), nova?.folder);
  });

  it("is forgotten when a person deletes it, and its folder stays", async () => {
    const { chips, state } = await rig();
    const spaceId = await newAgent(chips, state, "Nova");
    await chips.say("@Nova hello", spaceId);
    await sent(chips, "run.completed", (event) => event.space_id === spaceId);
    const nova = recordNamed(state, "Nova");
    assert.ok(nova !== undefined);
    assert.ok(chips.workspace.deleteAgent(nova.agentId));
    await until(() => state.agents[nova.key] === undefined);
    assert.equal(state.sessions[`${nova.key}|${spaceId}`], undefined, "its sessions forgotten");
    assert.ok(existsSync(nova.folder), "what it wrote is kept");
  });

  it("takes a folder no other agent has, nor one a deleted agent left", async () => {
    const { chips, state, kind } = await rig();
    await newAgent(chips, state, "Nova");
    const nova = recordNamed(state, "Nova");
    assert.ok(nova !== undefined);
    chips.workspace.deleteAgent(nova.agentId);
    await until(() => recordNamed(state, "Nova") === undefined);
    await newAgent(chips, state, "Nova");
    // Chips numbers the name (the deleted one keeps "Nova" in what it said); the folder is new too.
    const again = Object.values(state.agents).find((record) => record.name.startsWith("Nova"));
    assert.equal(again?.folder, join(kind.folders, "nova-2"));
  });

  it("takes the name a person gives it", async () => {
    const { chips, state } = await rig();
    await newAgent(chips, state, "Nova");
    const nova = recordNamed(state, "Nova");
    assert.ok(nova !== undefined);
    assert.ok(chips.workspace.renameAgent(nova.agentId, "Vega").ok);
    await until(() => nova.name === "Vega");
  });
});

/**
 * A person's "Not right?" on a message in a room (Chips ADR 0200), as Chips hands it to the
 * harness whose message it is: who gave it is written here, as Chips fills it in.
 */
function feedback(chips: FakeChips, spaceId: string, messageId: string, more: Readonly<Record<string, unknown>>) {
  const { owner } = chips.workspace;
  return chips.asOwner({
    type: "feedback",
    space_id: spaceId,
    message_id: messageId,
    from: { participant_id: owner.participantId, kind: "person", display_name: owner.displayName, role: "owner" },
    ...more,
  });
}

/** The agent's reply to words said in a room: once its run is over. */
async function replyTo(chips: FakeChips, text: string, spaceId = chips.address.spaceId): Promise<StoredEvent> {
  const said = await chips.say(text, spaceId);
  const started = await sent(chips, "run.started", (event) => event.space_id === spaceId && event.seq > said.seq);
  await sent(chips, "run.completed", (event) => event.run_id === started.run_id);
  return sent(chips, "message.post", (event) => event.run_id === started.run_id);
}

/** A second look's run, once it is over: its start, its words and its end. */
async function lookedAgain(chips: FakeChips, goal: string) {
  const started = await sent(chips, "run.started", (event) => event.payload["goal"] === goal);
  const words = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
  const done = await sent(chips, "run.completed", (event) => event.run_id === started.run_id);
  return { started, words, done };
}

const looksAgain = (chips: FakeChips) =>
  chips.workspace.log.filter((event) => event.type === "run.started" && String(event.payload["goal"]).startsWith("Looking again"));

describe("a reply a person says wasn't right", () => {
  const NOTE = "Missed what I asked. Sunday is our flight home.";

  it("is looked at again by the agent who said it, in its session in that room, as a run", async () => {
    const { chips, agent, state } = await rig();
    const room = chips.address.spaceId;
    // Two of the harness's agents in one room: the one who said the reply looks again, not the room's first.
    const { askId } = await chips.askForAgent(room, "Nova");
    const nova = await recordOf(state, await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId));
    assert.ok(nova !== undefined);
    await replyTo(chips, "hello");
    const reply = await replyTo(chips, "@Nova plan Sunday");
    assert.equal(reply.actor.id, nova.agentId);
    const novaSession = state.sessions[`${nova.key}|${room}`];
    const sessions = agent.made.length;

    await feedback(chips, room, messageIdOf(reply.id), { kind: "correction", text: NOTE });
    const { started, words, done } = await lookedAgain(chips, `Looking again: ${NOTE}`);
    assert.equal(started.actor.id, nova.agentId, "Nova said it, and Nova looks again");
    assert.equal(started.space_id, room);
    assert.equal(words.actor.id, nova.agentId);
    assert.equal(words.payload["text"], "Here is the answer.", "its answer, said in the room as any is");
    assert.equal(done.payload["summary"], "Here is the answer.");
    assert.equal(agent.made.length, sessions, "no new session");
    assert.equal(state.sessions[`${nova.key}|${room}`], novaSession, "the session Nova's turns in the room go to");
    const prompt = agent.prompts.at(-1) ?? "";
    // After how a file reaches the room, the words, not said as Arjun's: they name Arjun already.
    assert.ok(prompt.startsWith(`${SENDING_FILES}\n\nArjun says your reply in this space wasn't right.\n\n`), prompt);
    assert.doesNotMatch(prompt, /Arjun:/);
    assert.ok(prompt.includes("Your reply:\n«Here is the answer.»"), prompt);
    assert.ok(prompt.includes(`What wasn't right: «${NOTE}»`), prompt);
    const posted = chips.workspace.log.filter((event) => event.type === "message.post" && event.seq > reply.seq);
    assert.deepEqual(
      posted.map((event) => event.run_id),
      [started.run_id],
      "nothing else is said in the room",
    );
  });

  it("does nothing for a 👍, or any other reaction", async () => {
    const { chips, agent } = await rig();
    const reply = await replyTo(chips, "hello");
    const room = chips.address.spaceId;
    await feedback(chips, room, messageIdOf(reply.id), { kind: "reaction", reaction: "👍" });
    await feedback(chips, room, messageIdOf(reply.id), { kind: "reaction", reaction: "🎉" });
    // A correction after them is looked at; the reactions before it never were.
    await feedback(chips, room, messageIdOf(reply.id), { kind: "correction", text: NOTE });
    await lookedAgain(chips, `Looking again: ${NOTE}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(looksAgain(chips).length, 1);
    assert.equal(agent.prompts.length, 2);
  });

  it("looks again at a bare 👎 from an older device, told they didn't say what", async () => {
    const { chips, agent } = await rig();
    const reply = await replyTo(chips, "hello");
    await feedback(chips, chips.address.spaceId, messageIdOf(reply.id), { kind: "reaction", reaction: "👎" });
    const { started, words } = await lookedAgain(chips, "Looking again at its reply");
    assert.equal(started.actor.id, reply.actor.id);
    assert.equal(words.payload["text"], "Here is the answer.");
    const prompt = agent.prompts.at(-1) ?? "";
    assert.ok(prompt.includes("They didn't say what. Read your reply again and find what was wrong."), prompt);
    assert.ok(prompt.includes("Your reply:\n«Here is the answer.»"), prompt);
    assert.doesNotMatch(prompt, /What wasn't right/);
  });

  it("answers each feedback once, heard again or not", async () => {
    const { chips, client, agent } = await rig();
    const heard: Feedback[] = [];
    client.on("feedback", (event) => void heard.push(event));
    const reply = await replyTo(chips, "hello");
    await feedback(chips, chips.address.spaceId, messageIdOf(reply.id), { kind: "correction", text: NOTE });
    await lookedAgain(chips, `Looking again: ${NOTE}`);
    await until(() => heard.length === 1);
    // The same event again, through the SDK's own way in, as a replay hands it over.
    (client as unknown as { onEvent: (event: unknown) => void }).onEvent(heard[0]);
    await until(() => heard.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(looksAgain(chips).length, 1);
    assert.equal(agent.prompts.length, 2);
  });

  it("is the room's agent's to look at where the room no longer has the reply, without quoting it", async () => {
    const { chips, agent, agentId } = await rig();
    await replyTo(chips, "hello");
    await feedback(chips, chips.address.spaceId, newId("message"), { kind: "correction", text: NOTE });
    const { started, words } = await lookedAgain(chips, `Looking again: ${NOTE}`);
    assert.equal(started.actor.id, agentId, "the room's agent");
    assert.equal(words.payload["text"], "Here is the answer.");
    const prompt = agent.prompts.at(-1) ?? "";
    assert.ok(prompt.includes(`What wasn't right: «${NOTE}»`), prompt);
    assert.doesNotMatch(prompt, /Your reply:/);
  });

  it("quotes at most 1500 characters of the reply, and names its run by the note's first line", () => {
    const prompt = lookAgainPrompt("Arjun", "x".repeat(2000), "Too long");
    const quoted = /«(x+…)»/.exec(prompt)?.[1] ?? "";
    assert.equal(quoted.length, 1500);
    assert.equal(lookAgainGoal("Wrong day.\nSunday is our flight home."), "Looking again: Wrong day.");
    assert.equal(lookAgainGoal("y".repeat(200)).length, 120);
    assert.ok(lookAgainGoal("y".repeat(200)).endsWith("…"));
    assert.equal(lookAgainGoal(undefined), "Looking again at its reply");
  });
});

describe("a room from the +", () => {
  it("is claimed and named, and a new agent in a folder of its own answers the first words", async () => {
    const { chips, agent, state, kind } = await rig();
    const { spaceId } = await chips.askForSpace("Plan a weekend in Lisbon for two");
    const claimed = await sent(chips, "space.claimed", (event) => event.space_id === spaceId);
    assert.equal(claimed.payload["title"], "Plan a weekend in Lisbon for two");
    const words = await sent(chips, "message.post", (event) => event.space_id === spaceId && event.run_id !== null);
    const milo = recordNamed(state, "Milo");
    assert.ok(milo !== undefined, "the agent Chips made for the claim, by the name the room held");
    assert.equal(words.actor.id, milo.agentId);
    assert.equal(milo.folder, join(kind.folders, "milo"));
    const session = state.sessions[`${milo.key}|${spaceId}`] ?? "";
    assert.equal(agent.cwds.get(session), milo.folder);
    assert.match(agent.prompts.at(-1) ?? "", /: Plan a weekend in Lisbon for two$/);
    // Told of the room on its first turn, as Chips wrote it for the harness (Chips ADR 0092's addendum).
    assert.match(agent.prompts.at(-1) ?? "", /In this space: .*and you, Milo/);
    const started = await sent(chips, "run.started", (event) => event.space_id === spaceId);
    assert.equal(started.payload["goal"], "Plan a weekend in Lisbon for two");
  });

  it("names a room from the first line of what it is for", () => {
    assert.equal(titleFrom("Short one\nand more"), "Short one");
    assert.equal(
      titleFrom("Work out why the nightly backup to the NAS keeps failing after midnight"),
      "Work out why the nightly backup to the NAS…",
    );
  });
});

describe("a copy a person asks for", () => {
  it("copies the agent's session in the room it is in, and works on in the same folder", async () => {
    const { chips, agent, state, agentId } = await rig();
    await chips.say("one");
    await sent(chips, "run.completed");
    const original = recordNamed(state, "Fakey");
    assert.ok(original !== undefined);
    const spaceId = await chips.openRoom("Second opinion");
    const { forkId } = await chips.askForFork(agentId, spaceId);
    const joined = await sent(chips, "membership.added", (event) => event.payload["fork_of"] === forkId);
    const copy = await recordOf(state, joined);
    assert.ok(copy !== undefined);
    assert.equal(copy.name, "Fakey · fork");
    assert.equal(copy.forkedFrom, agentId);
    assert.equal(copy.folder, original.folder, "the same files as the conversation it remembers");
    assert.deepEqual(agent.forks, [`${agent.made[0]}>fork-1`]);
    assert.equal(agent.cwds.get("fork-1"), original.folder);
    assert.equal(state.sessions[`${copy.key}|${spaceId}`], "fork-1");
    await chips.say("@Fakey · fork two", spaceId);
    await sent(chips, "run.completed", (event) => event.space_id === spaceId);
    assert.equal(agent.made.length, 1, "the copy speaks in its copied session, not a new one");
  });

  it("copies an agent that never spoke as a new one in the same folder", async () => {
    const { chips, agent, state, agentId } = await rig();
    const spaceId = await chips.openRoom("Second opinion");
    const { forkId } = await chips.askForFork(agentId, spaceId);
    await recordOf(state, await sent(chips, "membership.added", (event) => event.payload["fork_of"] === forkId));
    assert.deepEqual(agent.forks, []);
    assert.equal(recordNamed(state, "Fakey · fork")?.folder, recordNamed(state, "Fakey")?.folder);
  });

  it("makes no copy where the agent can't copy a session", async () => {
    const agent = fakeAgent({ fork: false });
    const { chips, state, agentId } = await rig({ agent });
    await chips.say("one");
    await sent(chips, "run.completed");
    const spaceId = await chips.openRoom("Second opinion");
    await chips.askForFork(agentId, spaceId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(recordNamed(state, "Fakey · fork"), undefined);
  });

  it("is called after its original, as Jacobian calls a fork", () => {
    assert.equal(forkName("Nova"), "Nova · fork");
    assert.equal(forkName("Nova · fork 2"), "Nova · fork");
  });
});

describe("what it asks", () => {
  it("asks permission on a card, and gives a command's Always to the agent as once (Chips ADR 0239)", async () => {
    const { chips } = await rig();
    await chips.say("ask");
    const asked = await sent(chips, "approval.request");
    assert.equal((asked.payload["action"] as { kind: string }).kind, "acp.execute");
    assert.equal(asked.payload["question"], "Allow it to run npm test?");
    await chips.decide(String(asked.payload["approval_id"]), "approved", { scope: "always" });
    const words = await sent(chips, "message.post", (event) => event.run_id === asked.run_id);
    // Chips remembers how the command starts and answers the next one itself.
    assert.equal(words.payload["text"], "Given: once");
  });

  it("asks a command in the agent's own words where it gives them, the command after in mono", async () => {
    const { chips } = await rig();
    await chips.say("ask shell");
    const asked = await sent(chips, "approval.request");
    assert.equal(
      asked.payload["question"],
      "Count class names in game.js? `grep -noE 'card-(front|back)' game.js | sort | uniq -c`",
    );
    const preview = asked.payload["preview"] as { body: string };
    assert.match(preview.body, /"description": "Count class names in game.js"/);
    await chips.decide(String(asked.payload["approval_id"]), "approved");
    const words = await sent(chips, "message.post", (event) => event.run_id === asked.run_id);
    assert.equal(words.payload["text"], "Given: once");
  });

  it("asks a command too long for the question as the protocol takes it, cut short in its span", async () => {
    // Claude Code's own on 1 November, which 1.0.9 asked in 300 characters and Chips refused.
    const command = `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --window-size=1200,4200 --screenshot=/tmp/gshot.png file:///Users/someone/chips-acp/claude-code/miro/room/report.html 2>/dev/null; ls -la /tmp/gshot.png`;
    const { chips } = await rig();
    await chips.say(`ask shell ${command}`);
    const asked = await sent(chips, "approval.request");
    const question = String(asked.payload["question"]);
    assert.equal(question.length, 200);
    assert.ok(question.startsWith('Count class names in game.js? `"/Applications/Google Chrome.app/'));
    assert.ok(question.endsWith("…`"));
    await chips.decide(String(asked.payload["approval_id"]), "approved");
    const words = await sent(chips, "message.post", (event) => event.run_id === asked.run_id);
    assert.equal(words.payload["text"], "Given: once");
  });

  it("words a question from the call's own description, else from its title", () => {
    const command = "node --check game.js && echo ok";
    assert.equal(questionFor(command, { command, description: "Syntax-check game.js." }), `Syntax-check game.js? \`${command}\``);
    // Claude Code's own fields on one line; a command in an argv, as Codex gives one.
    assert.equal(
      questionFor("ls", { command: "ls -a\n  && pwd", description: "  List the folder\nand where it is  " }),
      "List the folder and where it is? `ls -a && pwd`",
    );
    assert.equal(questionFor("x", { command: ["git", "status"], description: "Show changes" }), "Show changes? `git status`");
    // Words with no command, as a subagent's call has.
    assert.equal(questionFor("Task", { description: "Find the tests", prompt: "…" }), "Find the tests?");
    // A command with a backtick of its own is left to the preview.
    assert.equal(questionFor("x", { command: "echo `date`", description: "Print the date" }), "Print the date?");
    // No words of its own, or only blank ones: the title, as before.
    assert.equal(questionFor("Run npm test", { command: "npm test" }), "Allow it to run npm test?");
    assert.equal(questionFor("Run npm test", { command: "npm test", description: " \n " }), "Allow it to run npm test?");
    assert.equal(questionFor("Run npm test", { command: "npm test", description: "..." }), "Allow it to run npm test?");
    assert.equal(questionFor("Run npm test", { command: "npm test", description: 7 }), "Allow it to run npm test?");
    assert.equal(questionFor("Fetch the page", undefined), "Allow it to fetch the page?");
  });

  it("cuts a long command short inside its span, and keeps every question to 200 characters", () => {
    const long = `grep -n ${"x".repeat(400)} game.js`;
    const question = questionFor(long, { command: long, description: "Look for the long word" });
    assert.equal(question.length, 200);
    assert.match(question, /^Look for the long word\? `grep -n x+…`$/);
    // Words that fill the question leave no room for the command.
    const words = "Check ".repeat(40).trim();
    const filled = questionFor(long, { command: long, description: words });
    assert.equal(filled.length, 200);
    assert.match(filled, /…\?$/);
    assert.equal(questionFor(long, { command: long }).length, 200);
  });

  it("gives the agent its always when a person allows always for what is not a command", async () => {
    const { chips } = await rig();
    await chips.say("ask edit");
    const asked = await sent(chips, "approval.request");
    await chips.decide(String(asked.payload["approval_id"]), "approved", { scope: "always" });
    const words = await sent(chips, "message.post", (event) => event.run_id === asked.run_id);
    assert.equal(words.payload["text"], "Given: always");
  });

  it("gives it its reject when a person says no", async () => {
    const { chips } = await rig();
    await chips.say("ask");
    const asked = await sent(chips, "approval.request");
    await chips.decide(String(asked.payload["approval_id"]), "denied");
    const words = await sent(chips, "message.post", (event) => event.run_id === asked.run_id);
    assert.equal(words.payload["text"], "Given: no");
  });

  it("asks a form's choice as a question card, and hands back the answer", async () => {
    const { chips } = await rig();
    await chips.say("form");
    const asked = await sent(chips, "question.ask");
    await chips.answer(String(asked.payload["ask_id"]), { colour: ["blue"] });
    const words = await sent(chips, "message.post", (event) => event.run_id === asked.run_id);
    assert.equal(words.payload["text"], "accept: blue");
  });
});

describe("what a person does to it", () => {
  it("stops the agent's turn when a person stops the run", async () => {
    const { chips, agent } = await rig();
    await chips.say("slow");
    const started = await sent(chips, "run.started");
    await until(() => agent.prompts.length > 0);
    await chips.asOwner({ type: "run.cancel", space_id: started.space_id, run_id: started.run_id });
    await until(() => agent.cancels.length > 0);
    assert.deepEqual(agent.cancels, agent.made, "the room's session, stopped");
  });

  it("drops the words an interrupting steer cut off, so the reply is one answer", async () => {
    const { chips, agent } = await rig();
    await chips.say("cut");
    const started = await sent(chips, "run.started");
    await until(() => agent.prompts.length > 0);
    // Its answer to the steer is words alone, with no tool call to set what came before aside.
    await chips.asOwner({ ...runOf(started), type: "run.steer", mode: "interrupt", text: "early" });
    await sent(chips, "run.completed", (event) => event.run_id === started.run_id);
    assert.equal(agent.prompts[1], "Arjun adds: early");
    assert.deepEqual(postsIn(chips, started.run_id), ["Early."]);
  });
});

/** The words to carry on with, as Chips ADR 0293 has them. */
const CARRY_ON = "You were paused partway through this. Carry on from where you stopped. Nothing you wrote before the pause reached the room, so write your whole reply.";

/** A run's address, for what a person sends it. */
function runOf(started: StoredEvent): { space_id: string | null; run_id: string | null } {
  return { space_id: started.space_id, run_id: started.run_id };
}

/** What a run posted in the room. */
function postsIn(chips: FakeChips, runId: string | null): unknown[] {
  return chips.workspace.log
    .filter((event) => event.type === "message.post" && event.run_id === runId)
    .map((event) => event.payload["text"]);
}

/** How a run ended, if it has. */
function endsOf(chips: FakeChips, runId: string | null): string[] {
  return chips.workspace.log
    .filter((event) => (event.type === "run.completed" || event.type === "run.failed") && event.run_id === runId)
    .map((event) => event.type);
}

/** A moment for anything the bridge shouldn't do to show up. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 150));

/** What the bridge handed its connection's `send`: for a field the fake, a Chips from before, drops before its log. */
function sendsOf(client: Chips): { type: string; envelope: Record<string, unknown>; payload: Record<string, unknown> }[] {
  const sends: { type: string; envelope: Record<string, unknown>; payload: Record<string, unknown> }[] = [];
  const send = client.send.bind(client);
  client.send = (type, envelope, payload, key) => {
    sends.push({ type, envelope: { ...envelope }, payload: { ...payload } });
    return send(type, envelope, payload, key);
  };
  return sends;
}

/**
 * The SDK's run for a run id, to hand it what a person did as the connection does. For a Pause the
 * bridge hears while a card of its waits: Chips refuses one of a run it counts as waiting on a card,
 * and the fake with it, but takes one that reached it first while the card was on its way, and the
 * bridge hears that Pause after asking.
 */
function sdkRun(client: Chips, runId: string | null): Run {
  const run = (client as unknown as { activeRuns: Map<string, Run> }).activeRuns.get(String(runId));
  assert.ok(run !== undefined, `the SDK has run ${String(runId)}`);
  return run;
}

describe("a person's Pause (Chips ADR 0293)", () => {
  it("says each run can pause once, as it starts, in the run's envelope, as the agent it is by", async () => {
    const { chips, client, agentId } = await rig();
    const sends = sendsOf(client);
    // Chips names the room's agent: the run is that agent's.
    await chips.say("hello");
    const first = await sent(chips, "run.completed");
    // A second look at a reply the room no longer has names nobody: the run is the harness's own.
    await feedback(chips, chips.address.spaceId, newId("message"), { kind: "correction", text: "Not that." });
    const second = await sent(chips, "run.completed", (event) => event.run_id !== first.run_id);

    const said = sends.filter((each) => each.type === "run.status" && each.payload["pausable"] === true);
    assert.deepEqual(
      said.map((each) => each.envelope),
      [
        { space_id: first.space_id, run_id: first.run_id, actor: { kind: "agent", id: agentId } },
        { space_id: second.space_id, run_id: second.run_id },
      ],
    );
    for (const each of said) {
      assert.deepEqual(each.payload, { phase: "thinking", verb_phrase: "Thinking…", pausable: true });
    }
    // The fake is a Chips from before ADR 0293: it takes each status, by the run's agent, and drops the word.
    const thinking = chips.workspace.log.filter(
      (event) => event.type === "run.status" && event.payload["verb_phrase"] === "Thinking…",
    );
    assert.deepEqual(
      thinking.map((event) => [event.run_id, event.actor.id]),
      [
        [first.run_id, agentId],
        [second.run_id, agentId],
      ],
    );
    assert.ok(chips.workspace.dropped.some((each) => each.type === "run.status" && each.field === "pausable"));
  });

  it("answers as ever when saying it can pause fails", async () => {
    const { chips, client, logs } = await rig();
    const send = client.send.bind(client);
    client.send = (type, envelope, payload, key) =>
      payload["pausable"] === true ? Promise.reject(new Error("refused")) : send(type, envelope, payload, key);
    await chips.say("hello");
    const done = await sent(chips, "run.completed");
    assert.equal(done.payload["summary"], "Here is the answer.");
    assert.ok(logs.some((line) => line === `couldn't say run ${String(done.run_id)} can pause: refused`), logs.join("\n"));
  });

  it("stops the prompt, posts and ends nothing, and carries on in the same session on Resume", async () => {
    const { chips, agent } = await rig();
    await chips.say("cut");
    const started = await sent(chips, "run.started");
    await until(() => agent.prompts.length === 1);
    await chips.asOwner({ ...runOf(started), type: "run.pause" });
    await until(() => agent.cancels.length === 1);
    await quiet();
    assert.equal(agent.prompts.length, 1, "nothing more said to it while paused");
    assert.deepEqual(postsIn(chips, started.run_id), [], "nothing posted for the half-finished part");
    assert.deepEqual(endsOf(chips, started.run_id), [], "the run isn't ended");

    await chips.asOwner({ ...runOf(started), type: "run.resume" });
    const done = await sent(chips, "run.completed", (event) => event.run_id === started.run_id);
    assert.deepEqual(agent.prompts.slice(1), [CARRY_ON]);
    assert.equal(agent.made.length, 1);
    assert.deepEqual(agent.promptedIn, [agent.made[0], agent.made[0]], "the same session");
    assert.deepEqual(postsIn(chips, started.run_id), ["Here is the answer."], "one answer");
    assert.equal(done.payload["summary"], "Here is the answer.");
  });

  it("ends quietly when a person stops it while it is paused, and takes the next message", async () => {
    const { chips, agent } = await rig();
    await chips.say("cut");
    const started = await sent(chips, "run.started");
    await until(() => agent.prompts.length === 1);
    await chips.asOwner({ ...runOf(started), type: "run.pause" });
    await until(() => agent.cancels.length === 1);
    await chips.asOwner({ ...runOf(started), type: "run.cancel" });
    await quiet();
    assert.equal(agent.prompts.length, 1, "no carry-on");
    assert.equal(agent.cancels.length, 1, "nothing going to stop a second time");
    assert.deepEqual(postsIn(chips, started.run_id), []);
    assert.deepEqual(endsOf(chips, started.run_id), [], "Chips ended it; the bridge says nothing more");

    await chips.say("hello again");
    const next = await sent(chips, "run.completed", (event) => event.run_id !== started.run_id);
    assert.deepEqual(postsIn(chips, next.run_id), ["Here is the answer."]);
  });

  it("holds the first prompt when a Pause lands while the session opens, and sends it as it was on Resume", async () => {
    let open = (): void => undefined;
    const opening = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { chips, client, agent } = await rig({ agent: fakeAgent({ opening }) });
    await chips.say("hello there");
    const started = await sent(chips, "run.started");
    await chips.asOwner({ ...runOf(started), type: "run.pause" });
    // Heard as the run starts, it can come before the bridge's handlers: the run says it is paused all the same.
    await until(() => sdkRun(client, started.run_id).paused);
    open();
    await until(() => agent.made.length === 1);
    await quiet();
    assert.equal(agent.prompts.length, 0, "held");
    assert.equal(agent.cancels.length, 0, "nothing to stop");

    await chips.asOwner({ ...runOf(started), type: "run.resume" });
    await sent(chips, "run.completed", (event) => event.run_id === started.run_id);
    assert.equal(agent.prompts.length, 1);
    assert.match(agent.prompts[0] ?? "", /: hello there$/, "the prompt as it was, with nothing to carry on from");
    assert.ok(!(agent.prompts[0] ?? "").includes(CARRY_ON));
    assert.deepEqual(postsIn(chips, started.run_id), ["Here is the answer."]);
  });

  it("stops nothing on a Pause while a card waits, and hands the agent the answer only on Resume", async () => {
    const { chips, client, agent } = await rig();
    await chips.say("ask");
    const asked = await sent(chips, "approval.request");
    const run = sdkRun(client, asked.run_id);
    run.hear({ ...runOf(asked), type: "run.pause", by: chips.workspace.owner.participantId });
    await chips.decide(String(asked.payload["approval_id"]), "approved");
    await quiet();
    assert.deepEqual(agent.cancels, [], "nothing stopped");
    assert.deepEqual(postsIn(chips, asked.run_id), [], "the answer held: the agent hasn't gone on");

    assert.deepEqual(agent.given, []);
    run.hear({ ...runOf(asked), type: "run.resume", by: chips.workspace.owner.participantId });
    await sent(chips, "run.completed", (event) => event.run_id === asked.run_id);
    assert.deepEqual(agent.given, ["once"]);
    assert.deepEqual(postsIn(chips, asked.run_id), ["Given: once"]);
    assert.equal(agent.prompts.length, 1, "no carry-on: nothing was stopped");
  });

  it("answers a card held by a Pause as cancelled when a person stops the run", async () => {
    const { chips, client, agent } = await rig();
    await chips.say("ask");
    const asked = await sent(chips, "approval.request");
    sdkRun(client, asked.run_id).hear({ ...runOf(asked), type: "run.pause", by: chips.workspace.owner.participantId });
    await chips.decide(String(asked.payload["approval_id"]), "approved");
    await quiet();
    await chips.asOwner({ ...runOf(asked), type: "run.cancel" });
    await until(() => agent.given.length === 1);
    assert.deepEqual(agent.given, ["cancelled"], "as a Stop answers it, though a person allowed it while it was paused");
    assert.deepEqual(agent.cancels, agent.made, "its turn stopped");
    await quiet();
    assert.deepEqual(postsIn(chips, asked.run_id), []);
    assert.deepEqual(endsOf(chips, asked.run_id), []);
  });

  it("takes Pause and Resume again and again, saying what was steered meanwhile after the words to carry on", async () => {
    const { chips, agent } = await rig();
    await chips.say("cut");
    const started = await sent(chips, "run.started");
    await until(() => agent.prompts.length === 1);
    await chips.asOwner({ ...runOf(started), type: "run.pause" });
    await until(() => agent.cancels.length === 1);
    await chips.asOwner({ ...runOf(started), type: "run.steer", mode: "followup", text: "slow" });
    await chips.asOwner({ ...runOf(started), type: "run.resume" });
    await until(() => agent.prompts.length === 2);
    assert.equal(agent.prompts[1], `${CARRY_ON}\n\nArjun adds: slow`);

    await chips.asOwner({ ...runOf(started), type: "run.pause" });
    await until(() => agent.cancels.length === 2);
    await quiet();
    assert.equal(agent.prompts.length, 2);
    assert.deepEqual(endsOf(chips, started.run_id), []);
    // Its answer this time is words alone, with no tool call to set the first prompt's half-sentence aside.
    await chips.asOwner({ ...runOf(started), type: "run.steer", mode: "followup", text: "early" });
    await chips.asOwner({ ...runOf(started), type: "run.resume" });
    await sent(chips, "run.completed", (event) => event.run_id === started.run_id);
    assert.deepEqual(agent.prompts.slice(2), [`${CARRY_ON}\n\nArjun adds: early`]);
    assert.deepEqual(new Set(agent.promptedIn), new Set(agent.made));
    assert.equal(agent.made.length, 1);
    assert.deepEqual(postsIn(chips, started.run_id), ["Early."]);
  });
});

describe("an agent that stops", () => {
  it("fails the turn it was in, says it can't answer, and runs again", async () => {
    const { chips, agent } = await rig();
    await chips.say("die");
    const failed = await sent(chips, "run.failed");
    assert.match(String(failed.payload["error"]), /Fakey stopped/);
    await until(() => agent.starts >= 2);
    await chips.say("back again");
    const words = await sent(chips, "message.post", (event) => event.payload["text"] === "Here is the answer.");
    assert.ok(words);
  });

  it("runs afresh on a person's Restart, and answers after", async () => {
    const { chips, agent, bridge } = await rig();
    await bridge.restart();
    assert.equal(agent.starts, 2);
    await chips.say("after the restart");
    const words = await sent(chips, "message.post", (event) => event.payload["text"] === "Here is the answer.");
    assert.ok(words);
  });

  it("keeps its agents and loads a room's session after a restart, where the agent can", async () => {
    const chips = await startFakeChips({ capabilities: CAPABILITIES, harnessName: "Fakey" });
    open.push(() => chips.close());
    const agent = fakeAgent({ loadSession: true });
    const state: BridgeState = { sessions: {}, agents: {} };
    const folders = mkdtempSync(join(tmpdir(), "chips-acp-"));
    const first = await rig({ chips, agent, state, folders });
    await chips.say("one");
    await sent(chips, "run.completed");
    const before = structuredClone(state.agents);
    first.bridge.stop();
    first.client.close();

    const again = await rig({ chips, agent, state, folders });
    assert.deepEqual(state.agents, before, "the same agents, in the same folders");
    await chips.say("two");
    await chips.waitFor(
      (event) => (event.type === "run.completed" && agent.prompts.length === 2 ? event : undefined),
      3000,
    );
    assert.equal(agent.made.length, 1, "no second session");
    assert.deepEqual(agent.loaded, agent.made, "the first one, loaded");
    again.bridge.stop();
  });

  it("forgets an agent deleted while it was away", async () => {
    const chips = await startFakeChips({ capabilities: CAPABILITIES, harnessName: "Fakey" });
    open.push(() => chips.close());
    const state: BridgeState = { sessions: {}, agents: {} };
    const first = await rig({ chips, state });
    await newAgent(chips, state, "Nova");
    first.bridge.stop();
    first.client.close();
    const nova = recordNamed(state, "Nova");
    assert.ok(nova !== undefined);
    chips.workspace.deleteAgent(nova.agentId);

    await rig({ chips, state });
    assert.equal(recordNamed(state, "Nova"), undefined);
    assert.ok(recordNamed(state, "Fakey") !== undefined);
  });
});
