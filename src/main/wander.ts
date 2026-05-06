import { BrowserWindow, screen } from "electron";
import { loadConfig } from "./config.js";
import type { StateQueue } from "./state-queue.js";
import type { PetState } from "../shared/types.js";

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
    console.log(`[wander] ${phase} → dormant (${reason})`);
    clearArmedTimer();
    clearWalkTick();
    clearRestTimer();
    target = null;
    phase = "dormant";
  }

  // Pick a random position within the current display's work area,
  // inset by the window's own half-dimensions so it stays fully on screen.
  // Returns null if the window is destroyed or no valid area exists.
  function pickTarget(): { x: number; y: number } | null {
    if (win.isDestroyed()) return null;
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const wa = display.workArea;

    const halfW = bounds.width / 2;
    const halfH = bounds.height / 2;

    // Usable area for the window's top-left corner
    const minX = wa.x + halfW;
    const maxX = wa.x + wa.width - halfW;
    const minY = wa.y + halfH;
    const maxY = wa.y + wa.height - halfH;

    if (maxX <= minX || maxY <= minY) return null;

    // Keep trying until we get a target at least 100px away (avoid trivial twitches).
    // Cap attempts to avoid infinite loop on tiny displays.
    const cx = bounds.x + halfW;
    const cy = bounds.y + halfH;
    for (let attempt = 0; attempt < 20; attempt++) {
      const tx = Math.round(minX + Math.random() * (maxX - minX));
      const ty = Math.round(minY + Math.random() * (maxY - minY));
      const dist = Math.hypot(tx - cx, ty - cy);
      if (dist >= 100) return { x: tx, y: ty };
    }
    // Fallback: just return any valid point
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
  function homeTargetForCurrentDisplay(): { x: number; y: number } | null {
    if (win.isDestroyed()) return null;
    const cfg = loadConfig();
    const display = screen.getDisplayMatching(win.getBounds());
    const saved = cfg.displayPositions?.[String(display.id)];
    if (!saved) return null;
    // displayPositions stores {x, y} as window top-left (per main.ts saveBoundsForDisplay).
    // Convert to center coordinates so it matches pickTarget's contract.
    const bounds = win.getBounds();
    return {
      x: saved.x + bounds.width / 2,
      y: saved.y + bounds.height / 2,
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
    const cx = bounds.x + bounds.width / 2;
    const dx = target.x - cx;
    const direction: PetState = dx >= 0 ? "running-right" : "running-left";

    // TTL long enough to cover the walk. 150 px/s over a 2000px display ~= 13s max.
    // 20 seconds is a safe ceiling without being so long it blooms the queue log.
    pushWanderState(direction, 20000);
    console.log(`[wander] armed → walking target=(${target.x},${target.y}) dir=${direction}`);
    phase = "walking";

    const stepPx = (speedPxPerSec * 16) / 1000; // distance per 16ms tick

    walkTick = setInterval(() => {
      if (win.isDestroyed()) {
        clearWalkTick();
        phase = "dormant";
        return;
      }

      const cur = win.getBounds();
      // Use window top-left (not center) for setBounds, but navigate by center
      const curCx = cur.x + cur.width / 2;
      const curCy = cur.y + cur.height / 2;

      const tgt = target!;
      const distX = tgt.x - curCx;
      const distY = tgt.y - curCy;
      const dist = Math.hypot(distX, distY);

      if (dist <= stepPx) {
        // Arrived — snap to target. If this was the home-return leg, end session.
        clearWalkTick();
        win.setBounds({
          x: Math.round(tgt.x - cur.width / 2),
          y: Math.round(tgt.y - cur.height / 2),
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

      // Step toward target
      const ratio = stepPx / dist;
      const newCx = curCx + distX * ratio;
      const newCy = curCy + distY * ratio;
      win.setBounds({
        x: Math.round(newCx - cur.width / 2),
        y: Math.round(newCy - cur.height / 2),
        width: cur.width,
        height: cur.height,
      });
    }, 16);
  }

  function enterResting(): void {
    phase = "resting";
    console.log("[wander] walking → resting");

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
  // Public handle
  // ------------------------------------------------------------------

  const handle: WanderHandle = {
    isWandering(): boolean {
      return phase === "walking" || phase === "resting";
    },

    notifyStateChange(state: PetState, agent: string | null): void {
      if (!enabled) return;

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
