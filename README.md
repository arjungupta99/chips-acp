# chips-acp

Agents that speak the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), as one Chips
harness. Each configured agent is a Chips agent; each room it is in is one ACP session of it. The
bridge runs the agents' processes, so the bridge is the harness (Chips ADR 0041), built on
`@chips/harness`. Phase 4 of Chips's `docs/proposals/open-source-harnesses-plan.md`.

Local only: no remote, nothing published. The `@chips/*` packages come from `vendor/`, packed from
the Chips repo with `pnpm release:sdk`.

## Run it

```bash
npm install
cp config.example.json ~/.chips-acp/config.json   # then name your agents
CHIPS_JOIN_LINK='<a join link made in Chips>' npm start
```

Without a link, set `CHIPS_URL` and allow the code it prints from Chips. Its key is kept as
`join()` keeps one (the keychain); its cursor, unanswered events, unended runs and which session
each room is are kept beside the config (`~/.chips-acp/`), so a restart picks up where it was.
The first agent is the harness's Main agent, in the harness's own room.

The config:

```json
{
  "name": "ACP agents",
  "agents": [
    { "name": "Goose", "command": ["goose", "acp"], "cwd": "~/chips-acp/goose" },
    { "name": "Gemini", "command": ["gemini", "--acp"], "cwd": "~/chips-acp/gemini" }
  ]
}
```

`command` is how the agent speaks ACP over stdio: `["goose", "acp"]`, `["gemini", "--acp"]`,
`["opencode", "acp"]`, `["npx", "@agentclientprotocol/claude-agent-acp"]`, `["codex-acp"]`. `cwd` is
the folder its sessions work in. `mode` is the mode its sessions are put in, of those the agent
offers (see below). `env` adds to its environment. Installing an agent and signing it
in to a model is done the agent's own way, before it is named here.

### As a launch agent

Once it has joined (its key is in the keychain, under the server's address), launchd can keep it
running from login, and start it again if it stops. `~/Library/LaunchAgents/chat.chips.acp.plist`
runs `/opt/homebrew/bin/node --import tsx src/main.ts` in this folder with `CHIPS_URL` set to the
address it joined (so the kept key is found, and no link is needed), `RunAtLoad` and `KeepAlive`,
and logs to `~/Library/Logs/chips-acp.log`.

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/chat.chips.acp.plist   # load and start
launchctl kickstart -k gui/$(id -u)/chat.chips.acp                            # restart
launchctl bootout gui/$(id -u)/chat.chips.acp                                 # stop and unload
```

Stop any copy started by hand first: two bridges for one harness answer twice.

### Asking a person

Claude Code's and Codex's adapters start each session in a mode where the agent decides for
itself: Claude Code's `auto`, Codex's `agent` ("Auto review", where Codex's own reviewer answers
its asks). Then nothing reaches Chips as a card. Put them where they ask:

```json
{ "name": "Claude Code", "command": ["claude-agent-acp"], "cwd": "~/chips-acp/claude", "mode": "default" },
{ "name": "Codex", "command": ["codex-acp"], "cwd": "~/chips-acp/codex", "mode": "workspace-write" }
```

- Claude Code still follows its own settings (`~/.claude/settings.json`). What they allow, it
  does without asking, and read-only commands never ask.
- Codex in `workspace-write` changes its folder freely and asks before the network or anything
  outside it. `read-only` asks before any change.

## Live

14 October 2026, on Chips's live server: Claude Code (`@agentclientprotocol/claude-agent-acp`
0.90.0, on its own sign-in) and Codex (`@agentclientprotocol/codex-acp` 2.2.2, on a ChatGPT
sign-in). Each took turns with steps, the gauge and the reply. Claude Code's cost came with its
turns; Codex's didn't, as on a ChatGPT sign-in its adapter reports none. An approval went round
from each, asked, approved in Chips, the call run, and said so. Chips's
`testing/scenarios/harnesses/acp-agents-live.md` has the run.

## What maps to what

| Chips | ACP |
|---|---|
| A message for an agent | `session/prompt` with the room note and who said it (`promptFor`), files saved under `<cwd>/chips-files/` |
| The room | a session: `session/new` the first time, `session/load` after a restart where the agent offers it |
| The run | the prompt's turn; `stopReason` ends it (`refusal` fails it, `max_tokens` adds a follow-up) |
| Status | `agent_thought_chunk`, a line at most every 1.5 s |
| Steps | `tool_call` / `tool_call_update` by `toolCallId`, titled with the tool's name or kind |
| Plan | `plan` |
| Context gauge, cost | `usage_update` (`used`/`size`; `cost` in USD, the turn's share) |
| The reply | `agent_message_chunk`s gathered into one message; `NO_REPLY` alone is the turn passed |
| Approval card | `session/request_permission`; allowed always picks `allow_always`, no picks `reject_once`; Stop answers `cancelled`; the card hears how the call went |
| Question card | `elicitation/create` form of up to four choice or yes/no fields; anything else is declined |
| Stop | `session/cancel` |
| Steer | the next prompt of the same run, after `session/cancel` when it interrupts |
| Restart | every agent's process stopped and run again |
| Trouble | an agent not running; it is run again after 2 s, longer each time it fails to start |

The agent is offered no file system and no terminal: it works with its own tools, under its own
permissions, and each permission it asks for is an approval card.

## Not built yet

From the plan's Phase 4: agents over WebSocket (`goose serve`); `new_spaces`, `follows_rooms` and
`new_agents`; models and effort from `configOptions`; context files; the bridge's own MCP server
(reminders, ask a person, post a file) and heartbeats; a folder per room; sub-agents as lanes;
free-text form fields; approval scopes limited to the agent's options (a wire change, Phase 6).

## Tests

```bash
npm test
```

A scripted ACP agent (`test/fake-agent.ts`), in process and as a child process, against the
conformance kit's fake Chips, which checks every event against the protocol's schemas; and the kit's
golden scenario, which `chips conformance custom --capabilities agents,restarts` runs live.
