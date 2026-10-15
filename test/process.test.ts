/** The bridge running an agent as a process, as it does for real: `processWire` over stdio. */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { startFakeChips } from "@chips/conformance";
import { connect } from "@chips/harness";
import { processWire } from "../src/acp.ts";
import { Bridge } from "../src/bridge.ts";

it("runs an agent's process, answers through it, and runs it again when it dies", async () => {
  const chips = await startFakeChips({ capabilities: ["agents", "restarts"], harnessName: "Stdio" });
  const client = await connect({ url: chips.address.url, token: chips.address.token });
  const logged: string[] = [];
  const kind = {
    name: "Stdio",
    // tsx by its path: the agent runs in its own folder, where nothing resolves.
    command: [process.execPath, "--import", import.meta.resolve("tsx"), join(import.meta.dirname, "stdio-agent.ts")],
    folders: mkdtempSync(join(tmpdir(), "chips-acp-")),
  };
  const bridge = new Bridge({
    chips: client,
    kind,
    state: { sessions: {}, agents: {} },
    saveState: () => undefined,
    wire: () => processWire(kind.command, kind.folders, process.env, (line) => logged.push(line)),
    respawnMs: 50,
    log: (line) => logged.push(line),
  });
  try {
    await bridge.start();
    await chips.say("hello");
    const words = await chips.waitFor(
      (event) => (event.type === "message.post" && event.run_id !== null ? event : undefined),
      10_000,
    );
    assert.equal(words.payload["text"], "Here is the answer.");
    assert.ok(logged.includes("fake agent up"), "its stderr is in the log");

    await chips.say("die");
    const failed = await chips.waitFor((event) => (event.type === "run.failed" ? event : undefined), 10_000);
    assert.match(String(failed.payload["error"]), /Stdio stopped \(exited 1\)/);
    await chips.say("again");
    await chips.waitFor(
      (event) =>
        event.type === "message.post" && event.run_id !== null && event.run_id !== words.run_id ? event : undefined,
      10_000,
    );
  } catch (error) {
    console.error(logged.join("\n"));
    throw error;
  } finally {
    bridge.stop();
    client.close();
    await chips.close();
  }
});
