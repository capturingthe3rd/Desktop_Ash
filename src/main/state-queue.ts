import type { PetState } from "../shared/types.js";

interface QueueEntry {
  state: PetState;
  agent: string | null;
  priority: number;
  expiresAt: number | null; // null = sticky (idle)
  pushedAt: number;
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

export class StateQueue {
  private current: QueueEntry;
  private decayTimer: ReturnType<typeof setTimeout> | null = null;
  private onStateChange: (state: PetState) => void;

  constructor(onStateChange: (state: PetState) => void) {
    this.onStateChange = onStateChange;
    this.current = this.makeIdleEntry();
  }

  private makeIdleEntry(): QueueEntry {
    return {
      state: "idle",
      agent: null,
      priority: -1, // idle is always superseded by any real push
      expiresAt: null,
      pushedAt: Date.now(),
    };
  }

  push(
    state: PetState,
    opts: { ttlMs?: number; agent?: string | null; priority?: number } = {}
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

    this.current = { state, agent, priority, expiresAt, pushedAt: Date.now() };

    if (this.decayTimer !== null) {
      clearTimeout(this.decayTimer);
      this.decayTimer = null;
    }

    if (expiresAt !== null) {
      this.decayTimer = setTimeout(() => {
        this.decayToIdle();
      }, rawTtl as number);
    }

    this.onStateChange(state);
    console.log(`[state-queue] → ${state} (agent=${agent ?? "anon"}, ttl=${rawTtl ?? "∞"}ms, priority=${priority})`);
  }

  private decayToIdle(): void {
    this.current = this.makeIdleEntry();
    this.decayTimer = null;
    this.onStateChange("idle");
    console.log("[state-queue] → idle (TTL expired)");
  }

  getCurrent(): QueueEntry {
    return this.current;
  }

  destroy(): void {
    if (this.decayTimer !== null) {
      clearTimeout(this.decayTimer);
    }
  }
}
