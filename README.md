# chips-acp

An agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) — Claude
Code, Codex, Goose, Gemini — as a Chips harness, one kind per harness. People make its agents from
Chips: a room from the +, a new agent from a room's Add page, a copy with Fork. Each agent works in a
folder of its own; each room it is in is one ACP session of it. There is no Main agent. The bridge
runs the agent's process, so the bridge is the harness (Chips ADR 0041), built on `@chips/harness`.
Phase 4 of Chips's `docs/proposals/open-source-harnesses-plan.md`, and Chips's
`docs/proposals/acp-agents-made-from-chips-plan.md`.

Local only: no remote, nothing published. The `@chips/*` packages come from `vendor/`, packed from
the Chips repo with `pnpm release:sdk`.

## Run it

```bash
npm install
cp config.example.json ~/.chips-acp/claude-code.json   # one config per kind
CHIPS_JOIN_LINK='<a join link made in Chips>' npm start ~/.chips-acp/claude-code.json
```

A join link for it asks for `agents`, `new_spaces`, `new_agents`, `forks` and `restarts`. Without
a link, set `CHIPS_URL` and allow the code it prints from Chips. Its key is kept as `join()` keeps
one (the keychain, under the kind's name); its cursor, unanswered events, unended runs, its agents
and which session each of their rooms is are kept in a folder beside the config, named after it
(`~/.chips-acp/claude-code/`), so a restart picks up where it was.

The config names one kind:

```json
{ "name": "Claude Code", "command": ["claude-agent-acp"], "mode": "default", "folders": "~/chips-acp/claude-code" }
```

- `name` is the harness's name in Chips, and its own agent's.
- `command` is how the agent speaks ACP over stdio: `["claude-agent-acp"]`, `["codex-acp"]`,
  `["goose", "acp"]`, `["gemini", "--acp"]`, `["opencode", "acp"]`.
- `folders` is where each agent gets a folder of its own, named after it (`~/chips-acp/claude-code/nova`),
  made empty. A copy from Fork works on in its original's folder, with the files the conversation it
  remembers expects. A deleted agent's folder stays.
- `folder`, in its place, puts every agent in one folder: a repository they work on together.
- `mode` is the mode its sessions are put in, of those the agent offers (see below). `env` adds to
  its environment.

Installing an agent and signing it in to a model is done the agent's own way, before it is named
here. A second kind is a second config, and a second bridge beside the first.

### Its agents

- **The + in Chips**, with the harness's face: the room is claimed, named from the first words, and
  a new agent (Chips names it) answers them.
- **Add on a room → a new agent**: an agent called what the person asked joins the room.
- **Fork**: the agent's session in the room it is in is copied (`session/fork`), and the copy
  remembers everything up to then. One that never spoke is copied fresh.
- **The harness's own room** has the agent Chips gives every harness, named after it: an ordinary
  agent, which a person can move anywhere.
- A session quiet for 30 minutes is closed (`session/close`) and loaded again on the next word,
  where the agent offers both: each open Claude Code session is a process of its own.

### As a launch agent

Once it has joined (its key is in the keychain, under the server's address), launchd can keep it
running from login, and start it again if it stops: one launch agent per kind.
`~/Library/LaunchAgents/chat.chips.acp.claude-code.plist` runs
`/opt/homebrew/bin/node --import tsx src/main.ts ~/.chips-acp/claude-code.json` in this folder
with `CHIPS_URL` set to the address it joined (so the kept key is found, and no link is needed),
`RunAtLoad` and `KeepAlive`, and logs to `~/Library/Logs/chips-acp-claude-code.log`.

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/chat.chips.acp.claude-code.plist   # load and start
launchctl kickstart -k gui/$(id -u)/chat.chips.acp.claude-code                            # restart
launchctl bootout gui/$(id -u)/chat.chips.acp.claude-code                                 # stop and unload
```

Stop any copy started by hand first: two bridges for one harness answer twice.

### Asking a person

Claude Code's and Codex's adapters start each session in a mode where the agent decides for
itself: Claude Code's `auto`, Codex's `agent` ("Auto review", where Codex's own reviewer answers
its asks). Then nothing reaches Chips as a card. Put them where they ask:

```json
{ "name": "Claude Code", "command": ["claude-agent-acp"], "mode": "default" }
{ "name": "Codex", "command": ["codex-acp"], "mode": "workspace-write" }
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

Later that night, one harness per kind (`~/.chips-acp/claude-code.json`, `codex.json`, launch
agents `chat.chips.acp.claude-code` and `chat.chips.acp.codex`), for each: a room from the +
claimed and answered by a new agent in its own folder; a new agent from Add; a Fork whose copy
remembered what came before and whose original didn't hear the copy; the harness's own agent
moved out of its room; the copy deleted, its folder kept; and a session closed after 30 quiet
minutes and loaded again with its memory. Fourteen runs, none failed, $0.35, all Claude Code's.

## What maps to what

| Chips | ACP |
|---|---|
| A message for an agent | `session/prompt` with the room note and who said it (`promptFor`), files saved under `<folder>/chips-files/` |
| The room | a session in the agent's folder: `session/new` the first time, `session/load` after a restart or an idle close where the agent offers it |
| A room from the + | `claimSpace` under a new key; Chips makes its agent; the first words are its first prompt |
| A new agent (Add) | a record and a folder, registered with `madeFor` and the room |
| Fork | `session/fork` of the original's session in its room, in its folder; the copy registered with `forkedFrom` |
| An agent deleted | its sessions closed (`session/close`), its record forgotten; its folder stays |
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
| Restart | the agent's process stopped and run again |
| Trouble | the agent not running; it is run again after 2 s, longer each time it fails to start |

The agent is offered no file system and no terminal: it works with its own tools, under its own
permissions, and each permission it asks for is an approval card.

## Not built yet

From the plan's Phase 4: agents over WebSocket (`goose serve`); `follows_rooms`; models and effort
from `configOptions`; context files; the bridge's own MCP server (reminders, ask a person, post a
file) and heartbeats; sub-agents as lanes; free-text form fields; approval scopes limited to the
agent's options (a wire change, Phase 6).

## Tests

```bash
npm test
```

A scripted ACP agent (`test/fake-agent.ts`), in process and as a child process, against the
conformance kit's fake Chips, which checks every event against the protocol's schemas; and the kit's
golden scenario with the +, Add and Fork, which
`chips conformance custom --capabilities agents,new_spaces,new_agents,forks,restarts` runs live:
Lives in Chips 5 of 6.
