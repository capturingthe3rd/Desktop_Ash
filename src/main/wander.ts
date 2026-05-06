import { BrowserWindow, screen } from "electron";
import { loadConfig } from "./config.js";
import { logActivity } from "./activity-log.js";
import type { StateQueue } from "./state-queue.js";
import type { PetState } from "../shared/types.js";

// Must match BUBBLE_AREA_HEIGHT in main.ts. Inlined here to avoid circular imports
// (wander → main would be circular; main → wander is the existing direction).
const BUBBLE_AREA_HEIGHT = 280;

// Internal wander state machine states — distinct from PetState (those are renderer vocab).
type WanderPhase = "dormant" | "armed" | "walking" | "resting";

export interface WanderHandle {
  // True while in walking or resting phase. main.ts move handler reads this
  // to decide whether to save the new position to displayPositions.
  isWandering(): boolean;
  // Called by the StateQueue subscriber on every state transition.
  // Receives the agent label so wander can ignore its own pushes (agent === "wander").
  notifyStateChange(state: PetState, agent: string | null): void;
  // Called by the main.ts move handler when isWandering() === false.
  // Signals a real user drag — cancel any armed timer that was running.
  notifyUserDrag(): void;
  // Pause wander: cancels all timers/ticks and suppresses future arming until resumed.
  // isWandering() returns false while paused. Does not corrupt session counters.
  pause(): void;
  // Resume wander: re-enables arming. Does not restart a walk immediately — waits
  // for the next idle state transition to arm naturally.
  resume(): void;
  // True when wander is currently paused (not stopped — can be resumed).
  isPaused(): boolean;
  // Cleanup on app quit.
  stop(): void;
}

export function startWanderManager(win: BrowserWindow, queue: StateQueue): WanderHandle {
  const cfg = loadConfig();
  const enabled = cfg.idleWanderEnabled ?? true;
  const delayMs = cfg.idleWanderDelayMs ?? 60000;
  const speedPxPerSec = cfg.idleWanderSpeedPxPerSec ?? 150;

  let phase: WanderPhase = "dormant";
  let armedTimer: ReturnType<typeof setTimeout> | null = null;
  let walkTick: ReturnType<typeof setInterval> | null = null;
  let restTimer: ReturnType<typeof setTimeout> | null = null;

  // Target the window is currently walking toward (walking phase only).
  let target: { x: number; y: number } | null = null;

  // Last facing direction (running-left or running-right). Persisted across walks
  // so that purely-vertical or near-vertical moves don't flip Ash's facing on a
  // tiny |dx|. Without this, a target straight above with |dx|=3 would render
  // running-left or running-right based on noise — visually jarring.
  let lastDirection: "running-right" | "running-left" = "running-right";

  // Set true when wander gets interrupted by a real state push. The next walk
  // will target the user's saved home position for the current display rather
  // than picking a random target — Ash heads home after a real action completes.
  let returnHomeNext = false;

  // Session bounds: a wander session is short — 1 to 2 random walks then home.
  // After returning home, cooldown for delayMs before next session can start.
  // walksThisSession is incremented on each random walk; sessionMaxRandomWalks
  // is randomized at the start of each session for variety.
  let walksThisSession = 0;
  let sessionMaxRandomWalks = 0;
  // True for the duration of a single home-return walk; resets after arrival.
  let isReturningHome = false;

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  function clearArmedTimer(): void {
    if (armedTimer !== null) {
      clearTimeout(armedTimer);
      armedTimer = null;
    }
  }

  function clearWalkTick(): void {
    if (walkTick !== null) {
      clearInterval(walkTick);
      walkTick = null;
    }
  }

  function clearRestTimer(): void {
    if (restTimer !== null) {
      clearTimeout(restTimer);
      restTimer = null;
    }
  }

  function enterDormant(reason: string): void {
    if (phase === "dormant") return;
    const from = phase;
    console.log(`[wander] ${from} → dormant (${reason})`);
    clearArmedTimer();
    clearWalkTick();
    clearRestTimer();
    target = null;
    phase = "dormant";
    logActivity("wander_phase", { from, to: "dormant", reason });
  }

  // Pick a random position within the current display's work area for the SPRITE center
  // (not window center). The window is taller than the sprite by BUBBLE_AREA_HEIGHT, so
  // we keep the sprite center on screen rather than the window center, which would let
  // the sprite drift off the bottom edge on short displays.
  // Returns sprite-center coordinates (what startWalking navigates toward).
  function pickTarget(): { x: number; y: number } | null {
    if (win.isDestroyed()) return null;
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const wa = display.workArea;

    const halfW = bounds.width / 2;
    // Sprite occupies the bottom portion of the window; its center is offset from window top.
    const spriteH = bounds.height - BUBBLE_AREA_HEIGHT;
    const halfSpriteH = spriteH / 2;

    // Usable area for the sprite center (not window center)
    // Window top-left = spriteCenterX - halfW, spriteCenterY - BUBBLE_AREA_HEIGHT - halfSpriteH
    // We need that window top-left to stay within work area, so:
    const minX = wa.x + halfW;
    const maxX = wa.x + wa.width - halfW;
    // Window top must be >= wa.y → spriteCenterY - BUBBLE_AREA_HEIGHT - halfSpriteH >= wa.y
    const minY = wa.y + BUBBLE_AREA_HEIGHT + halfSpriteH;
    // Window bottom must be <= wa.y + wa.height → spriteCenterY + halfSpriteH <= wa.y + wa.height
    const maxY = wa.y + wa.height - halfSpriteH;

    if (maxX <= minX || maxY <= minY) return null;

    // Sprite center of current window position
    const cx = bounds.x + halfW;
    const cy = bounds.y + BUBBLE_AREA_HEIGHT + halfSpriteH;

    // Keep trying until we get a target at least 100px away (avoid trivial twitches).
    for (let attempt = 0; attempt < 20; attempt++) {
      const tx = Math.round(minX + Math.random() * (maxX - minX));
      const ty = Math.round(minY + Math.random() * (maxY - minY));
      const dist = Math.hypot(tx - cx, ty - cy);
      if (dist >= 100) return { x: tx, y: ty };
    }
    // Fallback: any valid sprite-center point
    return {
      x: Math.round(minX + Math.random() * (maxX - minX)),
      y: Math.round(minY + Math.random() * (maxY - minY)),
    };
  }

  // Push a wander-internal state to the queue at priority -2 so any real push
  // (priority >= 0) immediately outranks it. TTL is generous enough that the
  // state persists through the full walk — the wander manager transitions away
  // explicitly rather than relying on TTL expiry.
  function pushWanderState(state: PetState, ttlMs: number): void {
    queue.push(state, { priority: -2, ttlMs, agent: "wander" });
  }

  // Read the user's saved home position for the current display, if any.
  // Used when returning home after a real-push interrupt.
  // Returns SPRITE center coordinates to match pickTarget's contract.
  function homeTargetForCurrentDisplay(): { x: number; y: number } | null {
    if (win.isDestroyed()) return null;
    const cfg = loadConfig();
    const display = screen.getDisplayMatching(win.getBounds());
    const saved = cfg.displayPositions?.[String(display.id)];
    if (!saved) return null;
    // displayPositions stores {x, y} as window top-left (per main.ts saveBoundsForDisplay).
    // Sprite center = window top-left + (halfW, BUBBLE_AREA_HEIGHT + halfSpriteH).
    const bounds = win.getBounds();
    const spriteH = bounds.height - BUBBLE_AREA_HEIGHT;
    return {
      x: saved.x + bounds.width / 2,
      y: saved.y + BUBBLE_AREA_HEIGHT + spriteH / 2,
    };
  }

  function startWalking(): void {
    if (win.isDestroyed()) return;
    let t: { x: number; y: number } | null = null;
    isReturningHome = false;

    if (returnHomeNext) {
      const home = homeTargetForCurrentDisplay();
      if (home) {
        t = home;
        isReturningHome = true;
        console.log(`[wander] walk → home (${home.x},${home.y})`);
      } else {
        // No home saved — end the session in place rather than wandering forever
        console.log("[wander] no home saved; ending session in place");
        returnHomeNext = false;
        endSession();
        return;
      }
      returnHomeNext = false;
    } else {
      // Random walk. Start a new session if this is the first walk (counters reset).
      if (walksThisSession === 0) {
        // Randomize session length: 1 or 2 random walks before heading home.
        sessionMaxRandomWalks = 1 + (Math.random() < 0.5 ? 1 : 0);
        console.log(`[wander] session start (max ${sessionMaxRandomWalks} random walks then home)`);
      }
      walksThisSession++;
      t = pickTarget();
      if (t) console.log(`[wander] walk #${walksThisSession}/${sessionMaxRandomWalks} (random) target=(${t.x},${t.y})`);
    }

    if (!t) {
      // Nowhere to walk — stay dormant
      console.log("[wander] no valid target, staying dormant");
      phase = "dormant";
      return;
    }
    target = t;

    const bounds = win.getBounds();
    // Target coords are sprite-center (from pickTarget / homeTargetForCurrentDisplay).
    const dx = target.x - (bounds.x + bounds.width / 2);
    const spriteHForDir = bounds.height - BUBBLE_AREA_HEIGHT;
    const dy = target.y - (bounds.y + BUBBLE_AREA_HEIGHT + spriteHForDir / 2);
    // Smarter direction: when the move is mostly vertical (|dx| small relative to
    // |dy|), keep the previous facing rather than flipping on a tiny dx. This
    // stops Ash from doing a confusing left-right flip when targets are stacked
    // mostly above or below each other. Override prior facing only when |dx| is
    // both meaningful (≥40px) AND a significant fraction of |dy| (≥40%).
    let direction: PetState;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (absDx >= 40 && absDx >= absDy * 0.4) {
      direction = dx >= 0 ? "running-right" : "running-left";
      lastDirection = direction;
    } else {
      direction = lastDirection;
    }

    // TTL long enough to cover the walk. 150 px/s over a 2000px display ~= 13s max.
    // 20 seconds is a safe ceiling without being so long it blooms the queue log.
    pushWanderState(direction, 20000);
    console.log(`[wander] armed → walking target=(${target.x},${target.y}) dir=${direction}`);
    phase = "walking";
    logActivity("wander_phase", { from: "armed", to: "walking", reason: isReturningHome ? "return_home" : "random_walk" });

    const stepPx = (speedPxPerSec * 16) / 1000; // distance per 16ms tick

    walkTick = setInterval(() => {
      if (win.isDestroyed()) {
        clearWalkTick();
        phase = "dormant";
        return;
      }

      const cur = win.getBounds();
      const spriteH = cur.height - BUBBLE_AREA_HEIGHT;
      // Navigate by sprite center, not window center.
      // Sprite center X = window center X (no horizontal bubble offset).
      // Sprite center Y = window.y + BUBBLE_AREA_HEIGHT + spriteH/2.
      const curSpriteCx = cur.x + cur.width / 2;
      const curSpriteCy = cur.y + BUBBLE_AREA_HEIGHT + spriteH / 2;

      const tgt = target!;
      const distX = tgt.x - curSpriteCx;
      const distY = tgt.y - curSpriteCy;
      const dist = Math.hypot(distX, distY);

      if (dist <= stepPx) {
        // Arrived — snap to target (tgt is sprite center).
        // Window top-left: x = tgt.x - halfW, y = tgt.y - BUBBLE_AREA_HEIGHT - spriteH/2.
        clearWalkTick();
        win.setBounds({
          x: Math.round(tgt.x - cur.width / 2),
          y: Math.round(tgt.y - BUBBLE_AREA_HEIGHT - spriteH / 2),
          width: cur.width,
          height: cur.height,
        });
        target = null;
        if (isReturningHome) {
          endSession();
        } else {
          enterResting();
        }
        return;
      }

      // Step toward target by sprite center
      const ratio = stepPx / dist;
      const newSpriteCx = curSpriteCx + distX * ratio;
      const newSpriteCy = curSpriteCy + distY * ratio;
      win.setBounds({
        x: Math.round(newSpriteCx - cur.width / 2),
        y: Math.round(newSpriteCy - BUBBLE_AREA_HEIGHT - spriteH / 2),
        width: cur.width,
        height: cur.height,
      });
    }, 16);
  }

  function enterResting(): void {
    phase = "resting";
    console.log("[wander] walking → resting");
    logActivity("wander_phase", { from: "walking", to: "resting", reason: "arrived_at_target" });

    // Weighted random rest behavior
    const roll = Math.random();
    let restMs: number;
    let nextState: PetState;
    let pause: number;

    if (roll < 0.50) {
      // 50%: idle for 2-4 seconds
      nextState = "idle";
      pause = 2000 + Math.random() * 2000;
      pushWanderState("idle", pause + 500);
      restMs = pause;
    } else if (roll < 0.75) {
      // 25%: waving
      nextState = "idle"; // after wave decays, go walking again
      pause = 1500 + 200; // wave TTL + small buffer
      pushWanderState("waving", 1500);
      restMs = pause;
    } else if (roll < 0.90) {
      // 15%: jumping
      nextState = "idle";
      pause = 1500 + 200;
      pushWanderState("jumping", 1500);
      restMs = pause;
    } else {
      // 10%: immediately pick new target (no pause). Still respect session cap.
      console.log("[wander] resting → walking (immediate, no pause)");
      phase = "dormant"; // startWalking will set it to walking
      if (walksThisSession >= sessionMaxRandomWalks) returnHomeNext = true;
      startWalking();
      return;
    }

    console.log(`[wander] resting action=${nextState === "idle" && roll < 0.50 ? "idle-pause" : roll < 0.75 ? "waving" : "jumping"} pauseMs=${Math.round(restMs)}`);

    restTimer = setTimeout(() => {
      restTimer = null;
      if (phase !== "resting") return; // interrupted
      // Session cap check: if we've done all our random walks, head home next.
      if (walksThisSession >= sessionMaxRandomWalks) {
        returnHomeNext = true;
        console.log(`[wander] session cap reached (${walksThisSession}/${sessionMaxRandomWalks}), heading home`);
      } else {
        console.log("[wander] resting → walking (new random target)");
      }
      phase = "dormant"; // startWalking will set it to walking
      startWalking();
    }, restMs);
  }

  // End the current wander session: reset counters, push idle, and schedule the
  // next session's armed timer (full delayMs cooldown). Called when Ash finishes
  // his home-return walk.
  function endSession(): void {
    console.log("[wander] session complete (arrived home), cooldown for next session");
    logActivity("wander_phase", { from: "walking", to: "dormant", reason: "session_complete" });
    walksThisSession = 0;
    sessionMaxRandomWalks = 0;
    isReturningHome = false;
    target = null;
    clearWalkTick();
    clearRestTimer();
    // Render a brief idle so the renderer settles into idle pose at home.
    pushWanderState("idle", 1000);
    // Schedule next session as if going dormant→armed naturally.
    phase = "armed";
    if (armedTimer !== null) clearTimeout(armedTimer);
    armedTimer = setTimeout(() => {
      armedTimer = null;
      if (phase !== "armed") return;
      startWalking();
    }, delayMs);
  }

  // ------------------------------------------------------------------
  // Pause/resume state — separate from wander phase so pausing does
  // not corrupt session counters. When paused, notifyStateChange
  // suppresses arming; resume re-enables it without jumping ahead.
  // ------------------------------------------------------------------
  let paused = false;

  // ------------------------------------------------------------------
  // Public handle
  // ------------------------------------------------------------------

  const handle: WanderHandle = {
    isWandering(): boolean {
      // Report false while paused — move handler uses this to decide
      // whether to save position. We want position saved while paused.
      if (paused) return false;
      return phase === "walking" || phase === "resting";
    },

    notifyStateChange(state: PetState, agent: string | null): void {
      if (!enabled || paused) return;

      // Ignore wander's own pushes — they would otherwise self-cancel us mid-walk
      // (e.g. when we push running-right while phase is still "armed" before we
      // flip to "walking"). Real external pushes have agent labels like
      // "claude-code", "codex", or null (manual curl with no label).
      if (agent === "wander") return;

      if (state === "idle") {
        // Queue settled to idle — arm the wander timer if not already running
        if (phase === "dormant") {
          phase = "armed";
          console.log(`[wander] dormant → armed (idle, will wander in ${delayMs}ms)`);
          logActivity("wander_phase", { from: "dormant", to: "armed", reason: "idle_state" });
          armedTimer = setTimeout(() => {
            armedTimer = null;
            if (phase !== "armed") return; // cancelled between arm and fire
            startWalking();
          }, delayMs);
        }
        // Already armed or walking/resting — leave as-is
        return;
      }

      // Non-idle state from a real push (agent !== "wander", filtered above).
      // Set returnHomeNext so the next walk after action TTL decay heads back
      // to the user's saved home position rather than picking a random target.
      if (phase === "walking" || phase === "resting") {
        returnHomeNext = true;
        enterDormant(`real state push → ${state}, will return home next`);
        return;
      }

      if (phase === "armed") {
        // Was about to wander; cancel the timer. No "home return" needed since
        // we never left home in the first place.
        enterDormant(`real state push → ${state} (was armed)`);
        return;
      }
    },

    notifyUserDrag(): void {
      // User physically moved the window — cancel any wander activity AND reset
      // session counters. Drag is the user explicitly choosing a new spot, so
      // we want the next wander session to start fresh, not continue from
      // wherever the previous session was counting.
      if (phase === "walking" || phase === "resting") {
        returnHomeNext = false;
        walksThisSession = 0;
        sessionMaxRandomWalks = 0;
        isReturningHome = false;
        enterDormant("user drag interrupted wander");
        return;
      }
      if (phase === "armed") {
        enterDormant("user drag while armed");
      }
    },

    pause(): void {
      if (paused) return;
      paused = true;
      // Cancel all active timers/ticks so Ash stops mid-session cleanly.
      // Session counters are intentionally preserved — resume picks up where
      // we left off (home-return logic still works after unpausing).
      enterDormant("wander paused by user");
      console.log("[wander] paused");
    },

    resume(): void {
      if (!paused) return;
      paused = false;
      console.log("[wander] resumed");
      // Re-arm naturally: if the queue is currently idle, arm now.
      // Otherwise the next idle state transition will arm via notifyStateChange.
      if (queue.getCurrent().state === "idle" && phase === "dormant") {
        handle.notifyStateChange("idle", null);
      }
    },

    isPaused(): boolean {
      return paused;
    },

    stop(): void {
      enterDormant("app quit");
    },
  };

  // Bootstrap: if the queue is already at idle when the manager starts (which
  // it will be on app launch since StateQueue's constructor sets idle without
  // calling notifyAll), arm immediately. Without this, wander would only start
  // after the first real state push followed by a TTL decay back to idle —
  // which never happens if Capt isn't actively using a hooked agent.
  if (queue.getCurrent().state === "idle") {
    handle.notifyStateChange("idle", null);
  }

  return handle;
}
