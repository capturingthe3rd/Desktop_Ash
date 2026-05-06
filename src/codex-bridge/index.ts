import http from "http";
import { CodexWatcher } from "./watcher.js";
import type { MappedPush } from "./event-mapper.js";

// Re-use the same wire format as Phase 1's HTTP server.
// Every other agent (Claude Code, OpenClaw) goes through POST /state — the bridge
// does the same so the server doesn't need a special code path for Codex events.
const ASH_SERVER_URL = "http://127.0.0.1:7878/state";
const AGENT_LABEL = "codex";

let watcher: CodexWatcher | null = null;

function postState(push: MappedPush): void {
  const body = JSON.stringify({
    state: push.state,
    ttlMs: push.ttlMs,
    agent: AGENT_LABEL,
    priority: 0,
    ...(push.message ? { message: push.message } : {}),
  });

  const req = http.request(
    ASH_SERVER_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      // Log non-200 responses but don't throw — bridge must stay alive
      if (res.statusCode !== undefined && res.statusCode >= 400) {
        console.warn(
          `[codex-bridge] server responded ${res.statusCode} for state=${push.state}`
        );
      }
      // Drain the response body to prevent socket leaks
      res.resume();
    }
  );

  req.on("error", (err: NodeJS.ErrnoException) => {
    // Desktop Ash server may not be ready yet or was restarted — log and move on
    if (err.code !== "ECONNREFUSED") {
      console.warn(`[codex-bridge] POST /state error: ${err.message}`);
    }
  });

  req.write(body);
  req.end();
}

// Start the Codex bridge. Safe to call multiple times — second call is a no-op.
export function start(): void {
  if (watcher !== null) {
    console.warn("[codex-bridge] already running, ignoring start()");
    return;
  }

  console.log("[codex-bridge] starting");
  watcher = new CodexWatcher((push: MappedPush) => {
    console.log(`[codex-bridge] → state=${push.state} ttl=${push.ttlMs}ms`);
    postState(push);
  });
  watcher.start();
}

// Stop the Codex bridge cleanly. Safe to call when already stopped.
export function stop(): void {
  if (watcher === null) {
    return;
  }
  watcher.stop();
  watcher = null;
  console.log("[codex-bridge] stopped");
}
