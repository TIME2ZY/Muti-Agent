# CLI Output Structured Events Design

Date: 2026-07-02
Status: Draft for review

## Goal

Upgrade the current CLI output parsing pipeline from "provider JSON -> extracted plain text" to "provider JSON -> normalized structured events -> UI/recall/transcript".

The immediate product goal is to let the main chat UI show both:

- execution-visible events: tool calls, commands, file changes
- reasoning-visible events: thinking, progress, todo updates

without first migrating the memory system to SQLite.

## Non-Goals

- Replacing JSONL transcript storage with SQLite in this phase
- Building a generic provider plugin platform for many providers beyond Codex and OpenCode
- Rewriting session, worktree, or callback routing architecture
- Persisting every structured event into the plain chat history shown by `/api/messages`

## Current Problem

The current architecture already reads structured JSON lines from Codex and OpenCode CLIs inside `src/agents/invoke-cli.js`, but it collapses those provider events into plain assistant text too early.

Current shape:

1. provider CLI emits JSON lines
2. `src/agents/invoke-cli.js` parses those lines
3. provider-specific structure is flattened into plain stdout text
4. `src/server/chat-routes.js` treats stdout as assistant message chunks
5. transcript and recall mostly see stdout/stderr rather than semantic events
6. frontend can only render text streaming plus debug stderr

This means the system loses semantic information such as:

- tool start / finish
- command start / finish
- file changes
- reasoning/thinking events
- todo/progress updates

before the server, transcript, or frontend can consume them.

## Design Summary

Introduce a unified internal event protocol named `AgentEvent`.

Provider-specific raw CLI events are transformed into `AgentEvent` records before leaving `src/agents/invoke-cli.js`. The rest of the stack consumes only that normalized event stream.

New high-level pipeline:

1. provider CLI emits JSON lines
2. provider parser reads raw provider event
3. provider transformer converts raw provider event into `AgentEvent[]`
4. `src/agents/invoke-cli.js` writes `AgentEvent` as NDJSON to stdout
5. server runtime reads NDJSON events instead of plain text chunks
6. server broadcasts `agent-event` SSE
7. transcript stores normalized event kinds
8. frontend renders invocation-level structured run cards

## Architecture

### Layer 1: Provider Parser

Location:

- `src/agents/providers/codex.js`
- `src/agents/providers/opencode.js`
- `src/agents/providers/index.js`

Responsibility:

- parse one stdout line from a provider CLI
- normalize provider-specific line shape into a raw provider event object
- extract provider session ID when present

This layer does not decide UI semantics.

### Layer 2: Provider Transformer

Location:

- same provider modules as above

Responsibility:

- convert a raw provider event into zero or more normalized `AgentEvent` records
- handle provider-specific delta de-duplication
- preserve provider semantics while mapping to a stable internal protocol

This layer is where Codex/OpenCode differences are isolated.

### Layer 3: Runtime Stream

Primary files:

- `src/agents/invoke-cli.js`
- `src/server/index.js`

Responsibility:

- process management
- retries
- timeout and kill behavior
- session resume persistence
- stderr capture
- line-by-line NDJSON transport of normalized `AgentEvent`

This layer must not re-interpret semantic event meaning. It is transport plus lifecycle only.

### Layer 4: Application Consumers

Primary files:

- `src/server/chat-routes.js`
- `src/session/transcript.js`
- `public/chat-client.js`
- `public/app.js`

Responsibility:

- SSE broadcasting
- transcript persistence
- recall querying and rendering
- invocation-level UI aggregation and display

These layers consume `AgentEvent` rather than provider-native event formats.

## Unified Event Protocol

The normalized event protocol for this phase is:

```js
type AgentEvent =
  | { type: "run.started", agent, invocationId, sessionId?, provider, model? }
  | { type: "text.delta", agent, invocationId, text }
  | { type: "text.final", agent, invocationId, text? }
  | { type: "thinking.delta", agent, invocationId, text }
  | { type: "thinking.final", agent, invocationId, text? }
  | { type: "progress.update", agent, invocationId, items }
  | { type: "tool.started", agent, invocationId, toolName, args }
  | { type: "tool.finished", agent, invocationId, toolName, result, status }
  | { type: "command.started", agent, invocationId, command }
  | { type: "command.finished", agent, invocationId, command, exitCode, output? }
  | { type: "file.changed", agent, invocationId, path, changeType }
  | { type: "stderr", agent, invocationId, text }
  | { type: "error", agent, invocationId, message, raw? }
  | { type: "route.a2a", agent, invocationId, to }
  | { type: "run.finished", agent, invocationId, exitCode, signal };
```

### Protocol Rules

- Every event must include `agent` and `invocationId`.
- `text.delta` is incremental only. It must not repeat already-delivered text.
- `text.final` signals completion of the current text stream. It may omit the full text payload if the complete answer can be reconstructed from deltas.
- `thinking.*` is stored in transcript and rendered in the UI, but is not appended into plain chat history.
- `progress.update` uses a normalized array shape so the frontend is independent of provider-native todo schemas.
- `stderr` remains available for debugging and recall, but is not treated as assistant answer text.
- Unknown or not-yet-modeled provider events may be emitted as a low-priority raw diagnostic event in transcript-only contexts if needed later, but this is not part of the first-phase UI contract.

## Provider Mapping

### Codex Mapping

Codex events should be mapped approximately as follows:

- `thread.started` -> `run.started`
- `item.completed` with `agent_message` -> `text.delta` or `text.final`
- `todo_list` -> `progress.update`
- `command_execution` started -> `command.started`
- `command_execution` completed -> `command.finished`
- `mcp_tool_call` started -> `tool.started`
- `mcp_tool_call` completed -> `tool.finished`
- `file_change` completed -> `file.changed`
- `reasoning` -> `thinking.delta` or `thinking.final`
- terminal process exit -> `run.finished`

If Codex only exposes a completion event for a given item type, the transformer emits only the completion-side normalized event instead of inventing a synthetic start event.

### OpenCode Mapping

OpenCode events should be mapped approximately as follows:

- `session.updated` -> used for provider session persistence
- `message.part.updated` -> `text.delta`
- final assistant message -> `text.final`
- future tool or command records -> `tool.*` / `command.*` when available
- terminal process exit -> `run.finished`

The existing part-based de-duplication behavior from `extractAssistantText()` must move into the OpenCode transformer so deltas remain incremental and stable.

## Runtime Changes

### `src/agents/invoke-cli.js`

This file should stop acting as a text extractor and become a normalized event emitter.

New responsibilities:

- parse CLI args
- build invocation command
- spawn child process
- manage retry/timeout/kill/session persistence
- read provider stdout line-by-line
- call provider parser + transformer
- write normalized `AgentEvent` NDJSON to stdout

The file should no longer call a single `extractAssistantText()` helper as the primary output path.

Suggested new supporting modules:

```text
src/agents/
  event-protocol.js
  invoke-cli.js
  providers/
    index.js
    codex.js
    opencode.js
```

### `src/server/index.js`

`runChildStream()` currently treats child stdout as raw text chunks. It should instead:

1. buffer stdout
2. split by newline
3. parse each line as NDJSON `AgentEvent`
4. dispatch the parsed event into server callbacks

The transport abstraction changes from:

- `onStdout(text)`

to something like:

- `onEvent(event)`
- `onStderr(text)`

## Server-Side Consumption

### `src/server/chat-routes.js`

The server should consume normalized `AgentEvent` and route it to three destinations with different rules:

1. SSE realtime stream
2. transcript/recall event log
3. plain chat history

#### SSE

Primary new event:

- `agent-event`

The server broadcasts:

```js
sendSse(res, "agent-event", event)
```

During migration, the server may derive legacy SSE events for backward compatibility:

- `text.delta` -> `message`
- `stderr` -> `stderr`
- `run.finished` -> `agent-exit`

The long-term goal is for the frontend to rely primarily on `agent-event`.

#### Transcript

`src/session/transcript.js` remains JSONL-based in this phase.

However, event persistence changes from generic stdout/stderr emphasis to semantic kinds. The transcript should record normalized event type as the `kind`, for example:

```json
{"ts":"...","kind":"tool.started","payload":{"agent":"planner","invocationId":"abc","toolName":"read_file","args":{"path":"x.js"}}}
```

This keeps recall and search semantic instead of forcing downstream code to infer meaning from raw text.

#### Plain Chat History

`/api/messages` should remain user-oriented rather than execution-log-oriented.

Rules:

- accumulate answer content from `text.delta`
- finalize/store assistant chat message on `text.final` or `run.finished`
- do not append `thinking.*`, `progress.update`, `tool.*`, `command.*`, `file.changed`, or `stderr` into normal chat history

This preserves a readable chat transcript while keeping richer execution data in transcript/recall.

## Frontend Design

### `public/chat-client.js`

Add a new primary SSE branch:

- `case "agent-event":`

The chat client should treat `agent-event` as the canonical event source for active runs. Legacy SSE branches remain only for migration safety.

### `public/app.js`

The UI should stop assuming that one streamed assistant answer is one flat text bubble with optional stderr. Instead, it should maintain invocation-level live state.

Suggested live model:

```js
Map<invocationId, {
  agent,
  text: "",
  thinking: "",
  progressItems: [],
  tools: [],
  commands: [],
  fileChanges: [],
  stderr: [],
  status: "thinking" | "writing" | "done" | "error"
}>
```

### Invocation Card UI

Each invocation renders as a structured run card with sections:

1. header: agent, status, start time
2. answer text area: visible by default
3. thinking section: collapsible
4. progress/todo section: collapsible
5. tools/commands timeline: collapsible
6. file changes section: collapsible
7. stderr/error summary: low emphasis

This lets the chat UI show both requested event classes:

- execution-visible behavior
- reasoning-visible behavior

without forcing all content into one markdown bubble.

## Recall and Search

The recall system should continue using transcript-backed event history in this phase.

Expected improvement:

- recall lists and searches operate on semantic event kinds rather than mostly stdout/stderr text
- invocation replay can show command/tool/file/thinking/progress events with correct kinds

No SQLite migration is required before these improvements.

## Error Handling

### Provider Parse Errors

If a provider stdout line cannot be parsed:

- do not crash the server immediately
- surface a structured `error` event when practical
- keep stderr and process-exit diagnostics

### Unknown Provider Event Types

If a provider emits an event type that the transformer does not yet model:

- ignore it for the main UI if harmless
- optionally preserve it later in diagnostic transcript paths
- do not let one unknown event type break the whole invocation stream

### Transport Failure

If NDJSON framing breaks at the server runtime boundary:

- surface a visible error state in the active invocation card
- preserve the raw stderr/process exit information
- finalize invocation as failed if stream semantics cannot be trusted

## Testing Strategy

### Unit Tests

Add focused tests for:

- provider-specific raw line parsing
- Codex event transformations
- OpenCode delta de-duplication
- protocol rule enforcement for `text.delta` and finalization behavior

Suggested locations:

- `tests/agents/providers/codex.test.js`
- `tests/agents/providers/opencode.test.js`
- `tests/agents/event-protocol.test.js`

### Runtime / Integration Tests

Extend:

- `tests/agents/invoke-cli.test.js`
- `tests/server.test.js`

to verify:

- `invoke-cli.js` writes NDJSON `AgentEvent`
- session IDs are still persisted correctly
- server SSE emits `agent-event`
- transcript records semantic kinds
- plain chat history still stores only user-visible assistant answer text

### Frontend Tests

Add or update tests so they assert:

- `public/chat-client.js` handles `agent-event`
- `public/app.js` maintains invocation-level live state
- thinking/progress/tool/file sections render separately
- legacy text streaming still works during migration

## Migration Plan

### Phase 1: Normalize CLI Output

- add provider parser/transformer modules
- make `src/agents/invoke-cli.js` emit `AgentEvent` NDJSON
- preserve session persistence behavior

### Phase 2: Server Compatibility Bridge

- update `runChildStream()` to consume NDJSON events
- broadcast `agent-event`
- derive legacy SSE events from normalized events for temporary compatibility
- write semantic kinds into transcript

### Phase 3: Frontend Structured Rendering

- make `public/chat-client.js` consume `agent-event`
- make `public/app.js` render invocation cards with structured sections
- keep legacy rendering path until coverage is complete

### Phase 4: Recall and Cleanup

- update recall rendering to rely on semantic event kinds
- shrink legacy `message/stdout/stderr` special handling
- remove old text-only assumptions when stable

## Tradeoffs

### Benefits

- preserves provider-native semantics instead of discarding them at the CLI boundary
- enables structured UI for both reasoning and execution events
- improves recall quality without requiring a storage migration
- isolates provider differences from the rest of the app

### Costs

- higher complexity in `invoke-cli.js` and server runtime transport
- temporary duplication during compatibility phase
- frontend state model becomes invocation-centric rather than message-centric

## Decision

Adopt the middle-layer event unification approach now.

Do not migrate to SQLite first.

The first implementation target is the output boundary in `src/agents/invoke-cli.js`, because that is where semantic information is currently lost.
