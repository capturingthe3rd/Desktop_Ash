import type { PetState } from "../shared/types.js";

interface QueueEntry {
  state: PetState;
  agent: string | null;
  priority: number;
  expiresAt: number | null; // null = sticky (idle)
  pushedAt: number;
  message: string | null;  // optional completion message for speech bubble
}

// Default TTLs per state as specified in the plan
const DEFAULT_TTL_MS: Record<PetState, number | null> = {
  idle: null,          // sticky, no expiry
  waving: 1500,
  jumping: 1500,
  failed: 2500,
  running: 3000,
  "running-left": 3000,
  "running-right": 3000,
  review: 3000,
  waiting: 3000,
};

// Subscribers receive state, agent label, and optional message.
// Wander manager ignores its own pushes (agent === "wander") and ignores message.
// Renderer broadcast forwards all three to the renderer process.
type StateChangeCallback = (state: PetState, agent: string | null, message: string | null) => void;

export class StateQueue {
  private current: QueueEntry;
  private decayTimer: ReturnType<typeof setTimeout> | null = null;
  // Multiple subscribers share the same state-change event. Two concrete
  // subscribers exist: (1) renderer broadcast in main.ts, (2) wander manager.
  // That's n=2 — enough to justify a subscribe/unsubscribe surface over a
  // single constructor callback.
  private subscribers: Set<StateChangeCallback> = new Set();

  constructor(initialSubscriber: StateChangeCallback) {
    this.subscribers.add(initialSubscriber);
    this.current = this.makeIdleEntry();
  }

  // Subscribe to state-change events. Returns an unsubscribe function.
  subscribe(callback: StateChangeCallback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private makeIdleEntry(): QueueEntry {
    return {
      state: "idle",
      agent: null,
      priority: -1, // idle is always superseded by any real push
      expiresAt: null,
      pushedAt: Date.now(),
      message: null,
    };
  }

  push(
    state: PetState,
    opts: { ttlMs?: number; agent?: string | null; priority?: number; message?: string | null } = {}
  ): void {
    const priority = opts.priority ?? 0;
    const agent = opts.agent ?? null;

    // Highest priority wins; on tie, latest push wins (always accept newer)
    if (state !== "idle" && this.current.state !== "idle" && priority < this.current.priority) {
      console.log(`[state-queue] push "${state}" (p=${priority}) rejected — current "${this.current.state}" (p=${this.current.priority}) has higher priority`);
      return;
    }

    const rawTtl = opts.ttlMs ?? DEFAULT_TTL_MS[state];
    const expiresAt = rawTtl !== null ? Date.now() + rawTtl : null;

    // Truncate message at 200 chars with ellipsis
    let message: string | null = opts.message ?? null;
    if (typeof message === "string" && message.length > 200) {
      message = message.slice(0, 199) + "…";
    }
    if (message === "") message = null;

    this.current = { state, agent, priority, expiresAt, pushedAt: Date.now(), message };

    if (this.decayTimer !== null) {
      clearTimeout(this.decayTimer);
      this.decayTimer = null;
    }

    if (expiresAt !== null) {
      this.decayTimer = setTimeout(() => {
        this.decayToIdle();
      }, rawTtl as number);
    }

    this.notifyAll(state, agent, message);
    console.log(`[state-queue] → ${state} (agent=${agent ?? "anon"}, ttl=${rawTtl ?? "∞"}ms, priority=${priority}, message=${message ? `"${message.slice(0, 40)}…"` : "none"})`);
  }

  private decayToIdle(): void {
    this.current = this.makeIdleEntry();
    this.decayTimer = null;
    this.notifyAll("idle", null, null);
    console.log("[state-queue] → idle (TTL expired)");
  }

  private notifyAll(state: PetState, agent: string | null, message: string | null): void {
    for (const cb of this.subscribers) {
      cb(state, agent, message);
    }
  }

  getCurrent(): QueueEntry {
    return this.current;
  }

  destroy(): void {
    if (this.decayTimer !== null) {
      clearTimeout(this.decayTimer);
    }
    this.subscribers.clear();
  }
}
