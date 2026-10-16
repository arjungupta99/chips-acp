/**
 * The conformance kit's golden scenario, played against the bridge with an ACP agent in this
 * process: what `chips conformance custom --capabilities agents,new_spaces,new_agents,forks,restarts`
 * checks of it live.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { formatReport, runConformance } from "@chipschat/conformance";
import { type Chips, connect } from "@chipschat/harness";
import { Bridge } from "../src/bridge.ts";
import { fakeAgent } from "./fake-agent.ts";

it("passes the golden scenario", async () => {
  let client: Chips | undefined;
  let bridge: Bridge | undefined;
  const agent = fakeAgent({ askFirst: true });
  const report = await runConformance({
    beatTimeoutMs: 3000,
    subject: {
      name: "chips-acp",
      capabilities: ["agents", "new_spaces", "new_agents", "forks", "restarts"],
      start: async (address) => {
        // As main.ts connects: a person's Restart starts the agents again.
        client = await connect({
          url: address.url,
          token: address.token,
          onRestart: async () => {
            await bridge?.restart();
          },
        });
        bridge = new Bridge({
          chips: client,
          kind: { name: "Fakey", command: ["fake"], folders: mkdtempSync(join(tmpdir(), "chips-acp-")) },
          state: { sessions: {}, agents: {} },
          saveState: () => undefined,
          wire: () => agent.wire(),
        });
        await bridge.start();
      },
      stop: async () => {
        bridge?.stop();
        client?.close();
      },
    },
  });
  assert.ok(report.passed, formatReport(report).join("\n"));
  assert.deepEqual(
    report.findings.filter((finding) => finding.severity !== "note"),
    [],
    formatReport(report).join("\n"),
  );
  // Supervised, and in Chips but for following its rooms: the level the gallery says.
  assert.deepEqual(
    report.levels.map((level) => [level.label, level.has]),
    [
      ["Talks", 1],
      ["Supervised", 1],
      ["Lives in Chips", 5],
      ["Managed from Chips", 0],
    ],
  );
  const outcomes = Object.fromEntries(
    (report.levels[2]?.capabilities ?? []).map((each) => [each.capability, each.outcome]),
  );
  assert.deepEqual(outcomes, {
    agents: "declared",
    new_spaces: "passed",
    forks: "passed",
    new_agents: "passed",
    restarts: "passed",
    ...(outcomes["follows_rooms"] === undefined ? {} : { follows_rooms: outcomes["follows_rooms"] }),
  });
  assert.notEqual(outcomes["follows_rooms"], "passed");
});
