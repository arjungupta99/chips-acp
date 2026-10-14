/** The fake agent as a process of its own, speaking ACP over its stdin and stdout. */

import { createInterface } from "node:readline";
import { fakeAgent } from "./fake-agent.ts";

const wire = fakeAgent().wire();
wire.onLine((line) => process.stdout.write(`${line}\n`));
wire.onClose(() => process.exit(1));
createInterface({ input: process.stdin }).on("line", (line) => wire.write(line));
process.stderr.write("fake agent up\n");
