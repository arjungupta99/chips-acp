/**
 * What a person sees and changes of the harness's agents from their pages (Chips ADRs 0134, 0146,
 * 0238, 0241): their files and their models, for Claude Code and Codex, and their context windows. Against Chips's
 * conformance fake, which checks every copy against the protocol's schemas, with an ACP agent in
 * this process and a home of the test's own, so nobody's `~/.claude` or `~/.codex` is read.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FakeChips, type StoredEvent, startFakeChips } from "@chipschat/conformance";
import { type Chips, connect } from "@chipschat/harness";
import { newId } from "@chipschat/protocol";
import { Bridge, type BridgeState, type KindConfig, settingsFor } from "../src/bridge.ts";
import { ContextFiles, hashOf } from "../src/context.ts";
import { adapterEnv, codexDocBytes } from "../src/kinds.ts";
import { type FakeAgent, type FakeModels, fakeAgent } from "./fake-agent.ts";

const CAPABILITIES = ["agents", "new_spaces", "new_agents", "forks", "restarts", "context_files", "context_windows", "models"];

const KINDS = {
  claude: { name: "Claude Code", program: "claude-agent-acp", folder: "claude-code" },
  codex: { name: "Codex", program: "codex-acp", folder: "codex" },
  other: { name: "Fakey", program: "fake", folder: "fakey" },
} as const;

type Body = Record<string, unknown>;

interface Rig {
  readonly chips: FakeChips;
  readonly client: Chips;
  readonly bridge: Bridge;
  readonly agent: FakeAgent;
  readonly state: BridgeState;
  readonly kind: KindConfig;
  readonly home: string;
  /** The harness's own agent, and its folder. */
  readonly agentId: string;
  readonly folder: string;
  /** Every copy the bridge sent, oldest first. */
  readonly puts: { readonly kind: string; readonly id: string; readonly body: Body }[];
  readonly logs: string[];
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

async function rig(
  which: keyof typeof KINDS,
  options: { agent?: FakeAgent; state?: BridgeState; chips?: FakeChips; home?: string; env?: NodeJS.ProcessEnv; models?: boolean } = {},
): Promise<Rig> {
  const known = KINDS[which];
  const chips = options.chips ?? (await startFakeChips({ capabilities: CAPABILITIES, harnessName: known.name }));
  if (options.chips === undefined) open.push(() => chips.close());
  const puts: Rig["puts"][number][] = [];
  if (options.chips === undefined) {
    const put = chips.settings.put.bind(chips.settings);
    chips.settings.put = (kind, id, body) => {
      puts.push({ kind, id, body: body as Body });
      return put(kind, id, body);
    };
  }
  const home = options.home ?? mkdtempSync(join(tmpdir(), "chips-acp-home-"));
  const kind: KindConfig = { name: known.name, command: [known.program], folders: join(home, "chips-acp", known.folder) };
  const agent = options.agent ?? fakeAgent({ loadSession: true, close: true });
  const state = options.state ?? { sessions: {}, agents: {} };
  const logs: string[] = [];
  let bridge: Bridge | undefined;
  const client = await connect({
    url: chips.address.url,
    token: chips.address.token,
    settings: settingsFor(kind, () => bridge),
  });
  bridge = new Bridge({
    chips: client,
    kind,
    state,
    saveState: () => undefined,
    wire: () => agent.wire(),
    log: (line) => logs.push(line),
    respawnMs: 20,
    env: options.env ?? {},
    home,
    models: options.models,
  });
  const running = bridge;
  open.push(async () => {
    running.stop();
    client.close();
  });
  await bridge.start();
  const agents = await client.agents.list();
  const agentId = agents.find((each) => each.key === chips.address.harnessId)?.agentId ?? "";
  const folder = Object.values(state.agents).find((record) => record.agentId === agentId)?.folder ?? "";
  return { chips, client, bridge, agent, state, kind, home, agentId, folder, puts, logs };
}

/** Once `done` holds, checked every few milliseconds. */
async function until<T>(done: () => T | undefined | false, timeoutMs = 4000): Promise<T> {
  const by = Date.now() + timeoutMs;
  for (;;) {
    const value = done();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > by) throw new Error(`not so within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A turn of the harness's agent in its room, once it is over. */
async function turn(chips: FakeChips, text: string): Promise<StoredEvent> {
  const said = await chips.say(text);
  const started = await chips.waitFor((event) => (event.type === "run.started" && event.seq > said.seq ? event : undefined), 3000);
  return chips.waitFor((event) => (event.type === "run.completed" && event.run_id === started.run_id ? event : undefined), 3000);
}

/** A frame as Chips sends it down the harness's socket, heard by the SDK as it hears one, and answered. */
async function hear(rig: Rig, frame: Body): Promise<void> {
  await rig.client.settings.hear({
    harness_id: rig.chips.address.harnessId,
    asked_by: rig.chips.workspace.owner.participantId,
    asked_at: new Date().toISOString(),
    ...frame,
  });
}

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const windowOf = (rig: Rig) => rig.chips.settings.copy("context-window", rig.agentId) as Body | undefined;
const windowPuts = (rig: Rig) => rig.puts.filter((each) => each.kind === "context-window" && each.id === rig.agentId);
const notSent = (rig: Rig) => rig.logs.filter((line) => line.includes("not sent"));

describe("an agent's files (Chips ADRs 0134, 0238)", () => {
  it("lists Claude Code's where it reads them: its own, every agent's, yours read only, and its memory", async () => {
    const home = mkdtempSync(join(tmpdir(), "chips-acp-home-"));
    write(join(home, ".claude", "CLAUDE.md"), "Be brief.\n");
    write(join(home, "chips-acp", "claude-code", "CLAUDE.md"), "Plain words, every one of you.\n");
    const at = await rig("claude", { home });
    const copy = await until(() => at.chips.settings.copy("context", at.agentId));
    const files = copy["files"] as Body[];
    assert.deepEqual(
      files.map((file) => [file["name"], file["title"], file["shared"] ?? null, file["editable"]]),
      [
        ["CLAUDE.md", "How it works", null, true],
        ["~ › chips-acp › claude-code › CLAUDE.md", "For every Claude Code agent", "every-agent", false],
        ["~ › .claude › CLAUDE.md", "For all your Claude Code", "yours", false],
        ["MEMORY.md", "What it remembers", null, true],
      ],
    );
    assert.equal(files[0]?.["text"], "", "not there yet: empty, and saving makes it");
    assert.equal(files[0]?.["hash"], hashOf(""));
    assert.equal(files[1]?.["replaceable"], false, "it reads both: neither is in the other's place");
    assert.equal(
      copy["read_note"],
      "Claude Code reads these when a conversation starts. A change made here applies from the next message.",
    );
    const set = await until(() => at.chips.settings.copy("harness-context", at.chips.address.harnessId));
    assert.deepEqual(
      (set["shared"] as Body[]).map((file) => [file["id"], file["text"], file["editable"], file["used_by"]]),
      [
        ["every-agent", "Plain words, every one of you.\n", true, 1],
        ["yours", "Be brief.\n", false, 1],
      ],
    );
    assert.equal((set["shared"] as Body[])[1]?.["why_read_only"], "Your own Claude Code reads it too.");
    assert.deepEqual(notSent(at), []);
  });

  it("lists Codex's: its own AGENTS.md, and yours read only", async () => {
    const home = mkdtempSync(join(tmpdir(), "chips-acp-home-"));
    write(join(home, ".codex", "AGENTS.md"), "");
    const at = await rig("codex", { home });
    const copy = await until(() => at.chips.settings.copy("context", at.agentId));
    assert.deepEqual(
      (copy["files"] as Body[]).map((file) => [file["name"], file["shared"] ?? null, file["editable"]]),
      [
        ["AGENTS.md", null, true],
        ["~ › .codex › AGENTS.md", "yours", false],
      ],
    );
    assert.match(String(copy["read_note"]), /^Codex reads these when a conversation starts\./);
    // A folder's AGENTS.override.md is read in place of its AGENTS.md.
    write(join(at.folder, "AGENTS.override.md"), "Override.");
    const files = new ContextFiles("codex", at.kind, { home, claudeHome: join(home, ".claude"), codexHome: join(home, ".codex") }, 65_536);
    assert.deepEqual(
      (files.agentCopy(at.folder).files as Body[]).map((file) => file["name"]),
      ["AGENTS.override.md", "~ › .codex › AGENTS.md"],
    );
  });

  it("saves an edit, refuses one made from an older version, and starts the agent's session again before its next turn", async () => {
    const at = await rig("claude");
    await turn(at.chips, "hello");
    const session = at.agent.made[0] ?? "";
    const editId = newId("edit");
    await hear(at, { frame: "context.edit", edit_id: editId, agent_id: at.agentId, name: "CLAUDE.md", text: "Answer in French.\n", base_hash: hashOf("") });
    assert.equal(at.chips.settings.answerTo(editId)?.made, true);
    assert.equal(readFileSync(join(at.folder, "CLAUDE.md"), "utf8"), "Answer in French.\n");
    const saved = (at.chips.settings.copy("context", at.agentId)?.["files"] as Body[])[0];
    assert.equal(saved?.["text"], "Answer in French.\n");

    // Made from what was there before: refused, and the copy beside it says what is there now.
    const stale = newId("edit");
    await hear(at, { frame: "context.edit", edit_id: stale, agent_id: at.agentId, name: "CLAUDE.md", text: "Answer in Hindi.\n", base_hash: hashOf("") });
    assert.equal(at.chips.settings.answerTo(stale)?.made, false);
    const refused = at.puts.find((each) => (each.body["refuses"] as Body | undefined)?.["edit_id"] === stale);
    assert.equal((refused?.body["refuses"] as Body)["reason"], "changed");
    assert.equal(readFileSync(join(at.folder, "CLAUDE.md"), "utf8"), "Answer in French.\n");

    // A file every agent reads, from the harness's page; one that is the person's own is not changed.
    const shared = newId("edit");
    await hear(at, { frame: "context.edit", edit_id: shared, name: "~ › chips-acp › claude-code › CLAUDE.md", text: "Be kind.\n", base_hash: hashOf("") });
    assert.equal(at.chips.settings.answerTo(shared)?.made, true);
    assert.equal(readFileSync(join(at.kind.folders, "CLAUDE.md"), "utf8"), "Be kind.\n");

    assert.deepEqual(at.agent.closed, [], "not while it is quiet");
    await turn(at.chips, "again");
    assert.deepEqual(at.agent.closed, [session], "closed before its next turn");
    assert.deepEqual(at.agent.loaded, [session], "and loaded again, reading what changed");
    assert.equal(at.agent.made.length, 1);
    assert.deepEqual(notSent(at), []);
  });

  it("refuses a change to a file the person's own Claude Code reads too", async () => {
    const home = mkdtempSync(join(tmpdir(), "chips-acp-home-"));
    write(join(home, ".claude", "CLAUDE.md"), "Mine.\n");
    const at = await rig("claude", { home });
    await until(() => at.chips.settings.copy("harness-context", at.chips.address.harnessId));
    const editId = newId("edit");
    await hear(at, { frame: "context.edit", edit_id: editId, name: "~ › .claude › CLAUDE.md", text: "Not mine.\n", base_hash: hashOf("Mine.\n") });
    assert.equal(at.chips.settings.answerTo(editId)?.made, false);
    assert.equal(at.chips.settings.answerTo(editId)?.message, "Your own Claude Code reads it too.");
    assert.equal(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8"), "Mine.\n");
  });

  it("says context in its hello for the two kinds it knows, and not for another", async () => {
    const at = await rig("claude");
    await until(() => at.chips.settings.copy("context", at.agentId));
    assert.ok((at.chips.askToChange("context", at.agentId)?.heard ?? 0) > 0);
    const other: KindConfig = { name: "Fakey", command: ["fake"], folders: tmpdir() };
    assert.equal(settingsFor(other, () => undefined).context, undefined);
    assert.notEqual(settingsFor(other, () => undefined).contextWindows, undefined);
  });

  it("gives its Codex room to read a whole file, over the config it has", () => {
    const codex: KindConfig = { name: "Codex", command: ["codex-acp"], folders: tmpdir() };
    assert.equal(adapterEnv(codex, {})["CODEX_CONFIG"], '{"project_doc_max_bytes":65536}');
    assert.equal(adapterEnv(codex, { CODEX_CONFIG: '{"model":"o9"}' })["CODEX_CONFIG"], '{"model":"o9","project_doc_max_bytes":65536}');
    assert.equal(adapterEnv(codex, { CODEX_CONFIG: '{"project_doc_max_bytes":1000}' })["CODEX_CONFIG"], '{"project_doc_max_bytes":1000}');
    assert.equal(codexDocBytes({ CODEX_CONFIG: '{"project_doc_max_bytes":1000}' }), 1000);
    assert.equal(codexDocBytes({}), 32_768);
    const claude: KindConfig = { name: "Claude Code", command: ["claude-agent-acp"], folders: tmpdir() };
    assert.equal(adapterEnv(claude, {})["CODEX_CONFIG"], undefined);
  });
});

describe("an agent's context window (Chips ADR 0146)", () => {
  it("is sent once the agent says how full it is, and again after a restart", async () => {
    const chips = await startFakeChips({ capabilities: CAPABILITIES, harnessName: "Claude Code" });
    open.push(() => chips.close());
    const puts: Body[] = [];
    const put = chips.settings.put.bind(chips.settings);
    chips.settings.put = (kind, id, body) => {
      if (kind === "context-window") puts.push(body as Body);
      return put(kind, id, body);
    };
    const home = mkdtempSync(join(tmpdir(), "chips-acp-home-"));
    const state: BridgeState = { sessions: {}, agents: {} };
    const agent = fakeAgent({ model: "claude-opus-5-5" });
    const first = await rig("claude", { chips, home, state, agent });
    assert.equal(windowOf(first), undefined, "nothing said yet: no copy");
    await turn(chips, "hello");
    const copy = await until(() => windowOf(first));
    assert.equal(copy["used"], 1200);
    assert.equal(copy["window"], 200_000);
    assert.equal(copy["model"], "claude-opus-5-5");
    assert.equal(copy["compacts"], true);
    assert.equal(copy["editable"], true);
    // No setting says: Claude Code compacts 33,000 short of its model's window.
    assert.deepEqual(copy["limit"], { at: 84, choices: [50, 60, 70, 80, 84], default: 84, may_turn_off: true });
    first.bridge.stop();
    first.client.close();

    const sent = puts.length;
    await rig("claude", { chips, home, state, agent });
    await until(() => puts.length > sent);
    assert.equal(puts.at(-1)?.["used"], 1200, "what it said last, sent again");
  });

  it("takes Claude Code's window only from a turn's result: before, its size may be a guess", async () => {
    const at = await rig("claude");
    await turn(at.chips, "early");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(windowOf(at), undefined);
  });

  it("compacts now: waiting for the turn going, then running, then done with from and to", async () => {
    const at = await rig("claude", { agent: fakeAgent({ compaction: "claude", model: "claude-opus-5-5" }) });
    await turn(at.chips, "hello");
    await until(() => windowOf(at));
    const said = await at.chips.say("pause");
    await at.chips.waitFor((event) => (event.type === "run.started" && event.seq > said.seq ? event : undefined), 3000);
    const changeId = newId("change");
    const before = windowPuts(at).length;
    await hear(at, { frame: "context_window.compact", change_id: changeId, agent_id: at.agentId });
    assert.equal(at.chips.settings.answerTo(changeId)?.made, true);
    const done = await until(() => windowPuts(at).find((each) => (each.body["last"] as Body | undefined)?.["by"] === "asked"));
    assert.deepEqual(done.body["last"], { at: (done.body["last"] as Body)["at"], from: 1300, to: 325, by: "asked" });
    await until(() => windowOf(at)?.["compacting"] === undefined && windowOf(at));
    const states = windowPuts(at)
      .slice(before)
      .map((each) => each.body["compacting"] ?? "done");
    assert.deepEqual([...new Set(states)], ["queued", "running", "done"]);
    assert.equal(at.agent.prompts.at(-1), "/compact", "said to it on its own, as a command");
    const posts = at.chips.workspace.log.filter((event) => event.type === "message.post");
    assert.ok(posts.every((event) => !String(event.payload["text"]).includes("Compacted")), "its words go nowhere");
    assert.deepEqual(notSent(at), []);
  });

  it("refuses Compact now when the agent doesn't compact, with its words", async () => {
    const at = await rig("codex");
    await turn(at.chips, "hello");
    await until(() => windowOf(at));
    const changeId = newId("change");
    await hear(at, { frame: "context_window.compact", change_id: changeId, agent_id: at.agentId });
    const answer = await until(() => at.chips.settings.answers.find((each) => each.changeId === changeId && !each.made));
    assert.equal(answer.message, "Unknown command: /compact");
    assert.equal(windowOf(at)?.["compacting"], undefined);
  });

  it("compacts Codex itself after a turn that ends past the limit the bridge keeps", async () => {
    const at = await rig("codex", { agent: fakeAgent({ compaction: "codex" }) });
    await turn(at.chips, "hello");
    const copy = await until(() => windowOf(at));
    assert.deepEqual(copy["limit"], { at: null, choices: [50, 60, 70, 80, 90], default: null, may_turn_off: true });
    const changeId = newId("change");
    await hear(at, { frame: "context_window.change", change_id: changeId, agent_id: at.agentId, at: 50 });
    assert.equal(at.chips.settings.answerTo(changeId)?.made, true);
    assert.equal((windowOf(at)?.["limit"] as Body)["at"], 50);
    await turn(at.chips, "big");
    const last = await until(() => windowOf(at)?.["last"] as Body | undefined);
    assert.equal(last["by"], "itself");
    assert.equal(last["from"], 150_000);
    assert.equal(last["to"], 37_500);
    assert.equal(at.agent.prompts.at(-1), "/compact");
  });

  it("starts Claude Code's sessions again with the limit picked, over its own, read from its settings", async () => {
    const home = mkdtempSync(join(tmpdir(), "chips-acp-home-"));
    write(join(home, ".claude", "settings.json"), JSON.stringify({ modelSettings: { "claude-opus-5-5": { autoCompactWindow: 150_000 } } }));
    const at = await rig("claude", { home, agent: fakeAgent({ loadSession: true, close: true, model: "claude-opus-5-5" }) });
    await turn(at.chips, "hello");
    const copy = await until(() => windowOf(at));
    // (150,000 − 33,000) of 200,000.
    assert.deepEqual(copy["limit"], { at: 59, choices: [50, 59, 60, 70, 80], default: 59, may_turn_off: true });
    assert.deepEqual(at.agent.metas, [{ call: `new ${at.agent.made[0]}`, meta: undefined }], "its own, untouched");

    await hear(at, { frame: "context_window.change", change_id: newId("change"), agent_id: at.agentId, at: 70 });
    assert.equal((windowOf(at)?.["limit"] as Body)["at"], 70);
    await turn(at.chips, "again");
    const session = at.agent.made[0] ?? "";
    assert.deepEqual(at.agent.closed, [session]);
    assert.deepEqual(at.agent.metas.at(-1), {
      call: `load ${session}`,
      meta: { claudeCode: { options: { settings: { autoCompactEnabled: true, autoCompactWindow: 173_000 } } } },
    });

    // Its own again: nothing picked, and the session starts with its own settings.
    await hear(at, { frame: "context_window.change", change_id: newId("change"), agent_id: at.agentId, at: 59 });
    await turn(at.chips, "once more");
    assert.deepEqual(at.agent.metas.at(-1), { call: `load ${session}`, meta: undefined });
    assert.equal(at.state.windows?.[Object.keys(at.state.agents)[0] ?? ""]?.limit, undefined);
  });

  it("can't change Claude Code's limit where its environment sets it", async () => {
    const at = await rig("claude", { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "133000" } });
    await turn(at.chips, "hello");
    const copy = await until(() => windowOf(at));
    assert.equal(copy["editable"], false);
    assert.equal(copy["why_read_only"], "CLAUDE_CODE_AUTO_COMPACT_WINDOW sets it for this harness.");
    assert.equal((copy["limit"] as Body)["at"], 50);
    const changeId = newId("change");
    await hear(at, { frame: "context_window.change", change_id: changeId, agent_id: at.agentId, at: 60 });
    assert.equal(at.chips.settings.answerTo(changeId)?.made, false);
  });

  it("counts a compaction of its own in a long turn, and says how full that turn got", async () => {
    for (const [which, compaction] of [
      ["claude", "claude"],
      ["codex", "codex"],
    ] as const) {
      const at = await rig(which, { agent: fakeAgent({ compaction }) });
      const done = await turn(at.chips, "fold");
      const copy = await until(() => (windowOf(at)?.["long_turn"] === undefined ? undefined : windowOf(at)));
      assert.deepEqual({ ...(copy["long_turn"] as Body), at: 0 }, { at: 0, peak: 150_000, folds: 1 }, which);
      assert.equal((copy["last"] as Body)["by"], "itself");
      assert.equal((copy["last"] as Body)["from"], 150_000);
      assert.equal((copy["last"] as Body)["to"], 30_000, which);
      const words = at.chips.workspace.log.find((event) => event.type === "message.post" && event.run_id === done.run_id);
      assert.equal(words?.payload["text"], "Here is the answer.", `${which}: no word of its compaction in the reply`);
    }
  });

  it("offers another kind's window, and Compact now only where it has the command", async () => {
    const without = await rig("other", { agent: fakeAgent() });
    await turn(without.chips, "hello");
    const plain = await until(() => windowOf(without));
    assert.equal(plain["compacts"], false);
    assert.equal(plain["why_not"], "This agent has no compact command.");
    assert.equal(plain["limit"], undefined);
    assert.equal(plain["editable"], false);
    assert.equal(without.chips.settings.copy("context", without.agentId), undefined, "no files: it isn't one this bridge knows");

    const withIt = await rig("other", { agent: fakeAgent({ commands: ["compact"], compaction: "codex" }) });
    await turn(withIt.chips, "hello");
    const copy = await until(() => windowOf(withIt));
    assert.equal(copy["compacts"], true);
    assert.equal((copy["limit"] as Body)["default"], null);
  });

  it("forgets a deleted agent's window", async () => {
    const at = await rig("claude");
    await turn(at.chips, "hello");
    await until(() => windowOf(at));
    const key = Object.keys(at.state.agents)[0] ?? "";
    assert.notEqual(at.state.windows?.[key], undefined);
    at.chips.workspace.deleteAgent(at.agentId);
    await until(() => at.state.agents[key] === undefined);
    assert.equal(at.state.windows?.[key], undefined);
    assert.ok(existsSync(at.folder), "its folder stays");
  });
});

const LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** Claude Code's, as its adapter offered them on 28 October 2026: its own `default` first, and one it won't be put on. */
const CLAUDE_MODELS: FakeModels = {
  current: "default",
  effort: "high",
  settingsLevel: true,
  choices: [
    { id: "default", name: "Default (recommended)", efforts: LEVELS },
    { id: "opus", name: "Opus 5.5", efforts: LEVELS },
    { id: "claude-fable-5-1[1m]", name: "Fable 5.1", efforts: LEVELS },
    { id: "sonnet", name: "Sonnet 5.5", efforts: LEVELS },
    { id: "haiku", name: "Haiku 5.5", efforts: LEVELS },
  ],
  refuses: ["claude-fable-5-1[1m]"],
};

/** Codex's: a new session on a model its list leaves out, with no levels, which it won't be put back on. */
const CODEX_MODELS: FakeModels = {
  current: "gpt-6.1-sol",
  effortId: "reasoning_effort",
  choices: [
    { id: "gpt-6-luna", name: "6 Luna", efforts: LEVELS },
    { id: "gpt-5.6-terra", name: "5.6 Terra", efforts: [...LEVELS, "ultra"] },
  ],
};

const modelOf = (rig: Rig, agentId = rig.agentId) => rig.chips.settings.copy("model", agentId) as Body | undefined;
const choicesOf = (copy: Body) => copy["choices"] as { id: string; label: string; efforts: { id: string; label: string }[] }[];

/** A person's pick from the agent's page, answered. */
async function pick(rig: Rig, model: string | null, effort: string | null, agentId = rig.agentId) {
  const changeId = newId("change");
  await hear(rig, { frame: "model.change", change_id: changeId, agent_id: agentId, model, effort });
  return rig.chips.settings.answerTo(changeId);
}

describe("an agent's model (Chips ADRs 0140, 0241)", () => {
  it("looks at what Claude Code offers as it starts, and shows each agent on the default", async () => {
    const agent = fakeAgent({ loadSession: true, close: true, models: CLAUDE_MODELS });
    const at = await rig("claude", { agent, models: true });
    const copy = await until(() => modelOf(at));
    assert.deepEqual(
      choicesOf(copy).map((choice) => [choice.id, choice.label]),
      [
        ["default", "Default (recommended)"],
        ["opus", "Opus 5.5"],
        ["sonnet", "Sonnet 5.5"],
        ["haiku", "Haiku 5.5"],
      ],
      "Fable left out: it won't be put on it",
    );
    assert.deepEqual(
      choicesOf(copy)[1]?.efforts.map((level) => level.label),
      ["Low", "Medium", "High", "Extra high", "Max"],
      "its levels, without Claude Code's own default",
    );
    assert.deepEqual(copy["default"], { label: "Claude Code's default", model: "default", effort: "high" });
    assert.equal(copy["model"], "default");
    assert.equal(copy["effort"], "high");
    assert.equal(copy["own"], false);
    assert.equal(copy["editable"], true);
    assert.ok(at.logs.some((line) => line.includes("won't be put on claude-fable-5-1[1m]")));

    // The look: one session in the harness's folder, let go, with nothing said to it.
    const look = agent.made[0] ?? "";
    assert.equal(agent.cwds.get(look), at.kind.folders);
    // The copy can reach Chips before the look is let go: a loaded machine showed it so.
    assert.deepEqual(await until(() => agent.closed.length > 0 && agent.closed), [look]);
    assert.deepEqual(agent.prompts, []);
    assert.deepEqual(at.state.models?.default, { model: "default", effort: "high" });
  });

  it("sets a pick on the agent's sessions and on each it opens after, and drops it back to Claude Code's own", async () => {
    const agent = fakeAgent({ loadSession: true, close: true, models: CLAUDE_MODELS });
    const at = await rig("claude", { agent, models: true });
    await until(() => modelOf(at));
    await turn(at.chips, "hello");
    const session = agent.made.at(-1) ?? "";
    assert.deepEqual(agent.sets.filter((each) => each.startsWith(session)), [], "on the default already: nothing set");

    assert.equal((await pick(at, "sonnet", "low"))?.made, true);
    assert.deepEqual(agent.sets.slice(-2), [`${session} model=sonnet`, `${session} effort=low`]);
    const picked = modelOf(at) ?? {};
    assert.deepEqual([picked["model"], picked["effort"], picked["own"]], ["sonnet", "low", true]);
    const key = Object.keys(at.state.agents).find((each) => at.state.agents[each]?.agentId === at.agentId) ?? "";
    assert.deepEqual(at.state.agents[key]?.model, { model: "sonnet", effort: "low" }, "kept with the agent");

    // Started again, its session is loaded back on the default, and put on the pick as it opens.
    await at.bridge.restart();
    agent.sets.length = 0;
    await turn(at.chips, "again");
    assert.deepEqual(agent.loaded, [session]);
    assert.deepEqual(
      agent.sets.filter((each) => each.startsWith(session)),
      [`${session} model=sonnet`, `${session} effort=low`],
    );

    // Dropped: the model and the level back to Claude Code's own.
    assert.equal((await pick(at, null, null))?.made, true);
    assert.deepEqual(agent.sets.slice(-2), [`${session} model=default`, `${session} effort=default`]);
    const dropped = modelOf(at) ?? {};
    assert.deepEqual([dropped["model"], dropped["effort"], dropped["own"]], ["default", "high", false]);
    assert.equal(at.state.agents[key]?.model, undefined);
    assert.deepEqual(notSent(at), []);
  });

  it("gives a copy its original's pick, and a pick to one agent only", async () => {
    const agent = fakeAgent({ loadSession: true, close: true, models: CLAUDE_MODELS });
    const at = await rig("claude", { agent, models: true });
    await until(() => modelOf(at));
    await turn(at.chips, "hello");
    await pick(at, "opus", "max");
    const spaceId = await at.chips.openRoom("Second opinion");
    const { forkId } = await at.chips.askForFork(at.agentId, spaceId);
    const joined = await at.chips.waitFor(
      (event) => (event.type === "membership.added" && event.payload["fork_of"] === forkId ? event : undefined),
      3000,
    );
    const copyId = String(joined.payload["agent_id"] ?? joined.payload["participant_id"]);
    const copied = await until(() => modelOf(at, copyId));
    assert.deepEqual([copied["model"], copied["effort"], copied["own"]], ["opus", "max", true]);
    assert.ok(agent.sets.includes("fork-1 effort=max"), "its copied session holds the level too");

    assert.equal((await pick(at, "haiku", "low", copyId))?.made, true);
    assert.deepEqual(agent.sets.slice(-2), ["fork-1 model=haiku", "fork-1 effort=low"]);
    assert.deepEqual([modelOf(at)?.["model"], modelOf(at)?.["effort"]], ["opus", "max"], "the original's stays");
    assert.ok(!agent.sets.some((each) => each.startsWith(agent.made.at(-1) ?? "") && each.endsWith("=haiku")));
  });

  it("refuses a model the agent doesn't offer, or a level its model hasn't", async () => {
    const at = await rig("claude", { agent: fakeAgent({ models: CLAUDE_MODELS }), models: true });
    await until(() => modelOf(at));
    for (const [model, effort] of [
      ["gpt-6-luna", null],
      ["claude-fable-5-1[1m]", "high"],
      ["sonnet", "ultra"],
    ] as const) {
      const answer = await pick(at, model, effort);
      assert.equal(answer?.made, false, model);
      assert.equal(answer?.message, "Claude Code doesn't offer that.");
    }
    assert.equal(modelOf(at)?.["own"], false);
  });

  it("puts Codex back on its default where it will, and loads a session again where it won't", async () => {
    const agent = fakeAgent({ loadSession: true, close: true, models: CODEX_MODELS });
    const at = await rig("codex", { agent, models: true });
    const copy = await until(() => modelOf(at));
    assert.deepEqual(
      choicesOf(copy).map((choice) => [choice.id, choice.efforts.length]),
      [
        ["gpt-6.1-sol", 0],
        ["gpt-6-luna", 5],
        ["gpt-5.6-terra", 6],
      ],
    );
    assert.deepEqual(copy["default"], { label: "Codex's default", model: "gpt-6.1-sol" });
    assert.equal(copy["effort"], undefined);
    await turn(at.chips, "hello");
    const session = agent.made.at(-1) ?? "";

    assert.equal((await pick(at, "gpt-6-luna", "high"))?.made, true);
    assert.deepEqual(agent.sets.slice(-2), [`${session} model=gpt-6-luna`, `${session} reasoning_effort=high`]);

    // Codex won't put a session back on a model it doesn't list: it is loaded again before its next turn.
    assert.equal((await pick(at, null, null))?.made, true);
    assert.equal(agent.sets.at(-1), `${session} model=gpt-6.1-sol`);
    assert.equal(modelOf(at)?.["own"], false);
    assert.ok(!agent.closed.includes(session), "not while it is quiet");
    await turn(at.chips, "again");
    assert.ok(agent.closed.includes(session), "closed before its next turn");
    assert.deepEqual(agent.loaded, [session], "and loaded again");
  });
});
