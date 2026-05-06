import type { PetState } from "../shared/types.js";

// A parsed Codex JSONL line — only the fields we care about
interface CodexEvent {
  type: string;
  payload: Record<string, unknown>;
}

// The result of mapping a Codex event to a Desktop Ash state push.
// null means "no push for this event" (not every event drives a state change).
export interface MappedPush {
  state: PetState;
  ttlMs: number;
}

// Parse a raw JSONL line string into a CodexEvent, or null on failure.
// Caller should log failures and continue — schema drift should not crash the bridge.
export function parseCodexLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)["type"] !== "string"
    ) {
      return null;
    }
    const obj = parsed as { type: string; payload?: unknown };
    return {
      type: obj.type,
      payload: (typeof obj.payload === "object" && obj.payload !== null
        ? obj.payload
        : {}) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

// Translate a parsed Codex event into a Desktop Ash state push.
// Returns null when the event does not warrant a state change.
export function mapEventToState(event: CodexEvent): MappedPush | null {
  const { type, payload } = event;
  const payloadType =
    typeof payload["type"] === "string" ? payload["type"] : "";

  // session_meta = new Codex session opened → wave hello
  if (type === "session_meta") {
    return { state: "waving", ttlMs: 1500 };
  }

  if (type === "event_msg") {
    switch (payloadType) {
      // task_started = user submitted a prompt, model is thinking → waiting
      case "task_started":
        return { state: "waiting", ttlMs: 3000 };

      // task_complete = turn fully done → celebrate
      case "task_complete":
        return { state: "jumping", ttlMs: 1500 };

      // exec_command_end = shell command finished, model is processing result → keep running
      case "exec_command_end":
        return { state: "running", ttlMs: 3000 };

      // error = session-level failure (auth, quota) → fail state
      case "error":
        return { state: "failed", ttlMs: 2500 };

      // agent_message, user_message, token_count, thread_name_updated, turn_context, etc.
      // Too frequent or not meaningful for state mapping.
      default:
        return null;
    }
  }

  if (type === "response_item") {
    switch (payloadType) {
      // function_call = model is dispatching a tool (shell, file op, etc.) → running
      case "function_call":
        return { state: "running", ttlMs: 3000 };

      // function_call_output = result came back; check exit code
      case "function_call_output": {
        const output =
          typeof payload["output"] === "string" ? payload["output"] : "";
        const exitMatch = output.match(/Process exited with code (\d+)/);
        if (exitMatch && exitMatch[1] !== "0") {
          // Non-zero exit — something the model ran failed
          return { state: "failed", ttlMs: 2500 };
        }
        // Zero exit or no exit code in output — let TTL decay naturally
        return null;
      }

      // message, etc. — system/developer context, not action-bearing
      default:
        return null;
    }
  }

  // turn_context and any unknown future types — ignore
  return null;
}
