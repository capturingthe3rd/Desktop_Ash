# Codex Session JSONL — Event Samples

Captured from `~/.codex/sessions/2026/05/05-06/*.jsonl`.
Sensitive content (system prompts, user messages, command outputs) redacted.
Timestamps and turn IDs are real structure but session content is trimmed.

---

## session_meta

Written at JSONL open (session start). One per file.

```json
{
  "timestamp": "2026-05-06T00:08:00.072Z",
  "type": "session_meta",
  "payload": {
    "id": "019dfa9c-761c-7de1-aeb0-768778a8d4bf",
    "timestamp": "2026-05-06T00:07:31.106Z",
    "cwd": "/Users/.../project",
    "originator": "Codex Desktop",
    "cli_version": "0.128.0-alpha.1",
    "source": "vscode",
    "model_provider": "openai",
    "base_instructions": { "text": "..." }
  }
}
```

Also seen: `source: { subagent: { other: "guardian" } }` for internal Codex review passes.

---

## event_msg / task_started

Fires when the user submits a prompt (turn begins).

```json
{
  "timestamp": "2026-05-06T00:08:00.073Z",
  "type": "event_msg",
  "payload": {
    "type": "task_started",
    "turn_id": "019dfa9c-e627-7420-bc5a-acab0a033a51",
    "started_at": 1778026079,
    "model_context_window": 258400,
    "collaboration_mode_kind": "default"
  }
}
```

---

## event_msg / task_complete

Fires when the model finishes the turn and sends a final message.

```json
{
  "timestamp": "2026-05-06T00:08:31.094Z",
  "type": "event_msg",
  "payload": {
    "type": "task_complete",
    "turn_id": "019dfa9c-e627-7420-bc5a-acab0a033a51",
    "last_agent_message": "...",
    "completed_at": 1778026111,
    "duration_ms": 31197,
    "time_to_first_token_ms": 3761
  }
}
```

---

## event_msg / user_message

The user's raw input. Type only, content not shown.

```json
{
  "timestamp": "...",
  "type": "event_msg",
  "payload": {
    "type": "user_message",
    "turn_id": "...",
    "message": "..."
  }
}
```

---

## event_msg / agent_message

A streamed model response chunk. Appears multiple times per turn as text streams in.

```json
{
  "timestamp": "...",
  "type": "event_msg",
  "payload": {
    "type": "agent_message",
    "turn_id": "...",
    "message": "..."
  }
}
```

---

## event_msg / token_count

Fires between events. Used for cost tracking.

```json
{
  "timestamp": "...",
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "input_tokens": 12345,
    "output_tokens": 234
  }
}
```

---

## response_item / function_call

A tool call the model wants to execute (e.g., shell command).

```json
{
  "timestamp": "2026-05-06T00:08:06.379Z",
  "type": "response_item",
  "payload": {
    "type": "function_call",
    "name": "exec_command",
    "arguments": "{\"cmd\": \"...\", \"workdir\": \"...\", \"yield_time_ms\": 1000}",
    "call_id": "call_XtTPNc5U41RrZaz9wSfD7FiQ"
  }
}
```

The `name` field determines tool type. Observed values: `exec_command`. Others likely exist (file reads, patches) but not observed in this sample set.

---

## event_msg / exec_command_end

Fires after a shell command completes (success or failure).

```json
{
  "timestamp": "2026-05-06T00:08:06.450Z",
  "type": "event_msg",
  "payload": {
    "type": "exec_command_end",
    "call_id": "call_XtTPNc5U41RrZaz9wSfD7FiQ",
    "process_id": "28529",
    "turn_id": "019dfa9c-e627-7420-bc5a-acab0a033a51",
    "command": ["/bin/zsh", "-lc", "..."],
    "cwd": "/Users/.../project",
    "parsed_cmd": [{ "type": "unknown", "cmd": "..." }]
  }
}
```

Exit code is NOT in this event. It is embedded in the function_call_output text ("Process exited with code N").

---

## response_item / function_call_output

The stdout/stderr of an executed command. Contains exit code in text.

```json
{
  "timestamp": "...",
  "type": "response_item",
  "payload": {
    "type": "function_call_output",
    "call_id": "call_XtTPNc5U41RrZaz9wSfD7FiQ",
    "output": "Chunk ID: 0348af\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 1670\nOutput:\n..."
  }
}
```

Exit code parsing: `output.match(/Process exited with code (\d+)/)` — code 0 = success, non-zero = error.

---

## event_msg / error

Fires on session-level errors (auth failures, usage limits). NOT per-command errors.

```json
{
  "timestamp": "2026-05-05T01:11:42.815Z",
  "type": "event_msg",
  "payload": {
    "type": "error",
    "message": "You've hit your usage limit...",
    "codex_error_info": "usage_limit_exceeded"
  }
}
```

Also observed: `codex_error_info: "unauthorized"` for token refresh failures.

---

## turn_context

Fires once per turn with model/policy metadata. Not used for state mapping.

```json
{
  "timestamp": "...",
  "type": "turn_context",
  "payload": {
    "turn_id": "...",
    "cwd": "...",
    "model": "gpt-5.5",
    "approval_policy": "never",
    "sandbox_policy": { "type": "danger-full-access" }
  }
}
```

---

## Observations

- All events share: `{ timestamp: string, type: string, payload: object }`.
- `event_msg` is the main event bus. `response_item` carries model outputs.
- `exec_command_end` does not carry exit code — need `function_call_output` for that.
- Subagent (guardian) sessions interleave with user sessions in the same daily directory.
- File naming: `rollout-<ISO8601>-<UUID>.jsonl`, lexicographically ordered by start time.
