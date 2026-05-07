import { BrowserWindow, screen } from "electron";
import { loadConfig } from "./config.js";
import { logActivity } from "./activity-log.js";
import type { StateQueue } from "./state-queue.js";
import type { PetState } from "../shared/types.js";

// Fixed side-area dimensions — must match main.ts constants.
// Inlined here to avoid circular imports (wander → main would be circular).
const BUBBLE_AREA_TALL = 280;  // height of bubble area for above/below layouts
const BUBBLE_AREA_WIDE = 240;  // width of bubble area for left/right layouts

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
  const restBehaviorsEnabled = cfg.wanderRestBehaviorsEnabled ?? true;
  const yawnAfterMs = cfg.longIdleYawnAfterMs ?? 300_000;   // 5 min
  const sleepAfterMs = cfg.longIdleSleepAfterMs ?? 1_800_000; // 30 min

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
  // Long-idle tracking (Phase 7D)
  // Tracks when Ash last had any meaningful activity (wander move, real state push,
  // user drag). When this timestamp ages past yawnAfterMs/sleepAfterMs AND the
  // current queue state is idle AND wander is dormant, the long-idle behaviors fire.
  // ------------------------------------------------------------------
  let lastActivityTs = Date.now();
  let longIdleTimer: ReturnType<typeof setTimeout> | null = null;
  // True while a yawn cycle is in progress — prevents stacking yawns.
  let yawnInFlight = false;
  // True while sleeping state is being held. Cleared on any interrupting push.
  let holdingSleep = false;

  function resetActivityClock(): void {
    lastActivityTs = Date.now();
    yawnInFlight = false;
    holdingSleep = false;
    scheduleLongIdleCheck();
  }

  function clearLongIdleTimer(): void {
    if (longIdleTimer !== null) {
      clearTimeout(longIdleTimer);
      longIdleTimer = null;
    }
  }

  function scheduleLongIdleCheck(): void {
    clearLongIdleTimer();
    // Schedule the earliest possible trigger: yawnAfterMs from now.
    // The check itself handles the sleep threshold and yawn-vs-sleep decision.
    longIdleTimer = setTimeout(checkLongIdle, yawnAfterMs);
  }

  function checkLongIdle(): void {
    longIdleTimer = null;
    // Long-idle only fires when wander is truly dormant and the queue is at idle.
    // If wander is active (armed/walking/resting) the activity clock is already
    // being reset by wander itself, so this path won't be reached in steady state.
    if (phase !== "dormant" || queue.getCurrent().state !== "idle") {
      // Not in a quiet idle — reschedule for a shorter recheck (30s).
      longIdleTimer = setTimeout(checkLongIdle, 30_000);
      return;
    }

    const idleDurationMs = Date.now() - lastActivityTs;

    if (idleDurationMs >= sleepAfterMs && !holdingSleep) {
      holdingSleep = true;
      console.log(`[wander] long-idle: ${Math.round(idleDurationMs / 60000)}min idle → entering sleeping (held)`);
      logActivity("wander_long_idle", { trigger: "sleeping", idleDurationMs });
      // Push sleeping at wander priority with no explicit TTL so the queue picks
      // up DEFAULT_TTL_MS["sleeping"] = null (sticky loop). Any real push at
      // priority >= 0 outranks priority -2 and interrupts automatically.
      queue.push("sleeping", { priority: -2, agent: "wander" });
      // No reschedule — we stay sleeping until interrupted (handled in notifyStateChange).
      return;
    }

    if (idleDurationMs >= yawnAfterMs && !yawnInFlight && !holdingSleep) {
      yawnInFlight = true;
      console.log(`[wander] long-idle: ${Math.round(idleDurationMs / 60000)}min idle → yawning`);
      logActivity("wander_long_idle", { trigger: "yawning", idleDurationMs });
      pushWanderState("yawning", 3000);
      // After yawn TTL, return to idle and schedule next check in 30-60s range.
      const nextYawnMs = 30_000 + Math.random() * 30_000;
      longIdleTimer = setTimeout(() => {
        longIdleTimer = null;
        yawnInFlight = false;
        // Push idle to ensure renderer settles back, then reschedule.
        if (queue.getCurrent().state !== "idle") {
          // Something else took over; let notifyStateChange handle rescheduling.
          return;
        }
        // Check if we've crossed into sleep territory by now.
        checkLongIdle();
      }, 3000 + nextYawnMs);
      return;
    }

    // Not yet at yawn threshold — reschedule for the remaining gap.
    const remainingMs = Math.max(1000, yawnAfterMs - idleDurationMs);
    longIdleTimer = setTimeout(checkLongIdle, remainingMs);
  }

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
    // Cancel any pending long-idle check — wander going dormant means the idle
    // clock starts fresh from this moment, not from when Ash last rested.
    clearLongIdleTimer();
    target = null;
    phase = "dormant";
    logActivity("wander_phase", { from, to: "dormant", reason });
  }

  // Derive sprite offset-within-window from current window dims.
  // We infer the layout from the window aspect/size rather than tracking side state
  // here (avoids circular import). The sprite offset is the distance from window
  // top-left to sprite top-left; sprite center = offset + (spriteW/2, spriteH/2).
  function getSpriteOffsetFromBounds(bounds: Electron.Rectangle): { offsetX: number; offsetY: number; spriteW: number; spriteH: number } {
    // For "none" (sprite-only): window dims equal sprite dims exactly.
    // For "above": window is taller by BUBBLE_AREA_TALL, sprite is at bottom.
    // For "below": window is taller by BUBBLE_AREA_TALL, sprite is at top.
    // For "left": window is wider by BUBBLE_AREA_WIDE, sprite is on right.
    // For "right": window is wider by BUBBLE_AREA_WIDE, sprite is on left.
    // We detect the layout from the surplus dimensions.
    const surplusH = bounds.height > bounds.width * 1.2 ? bounds.height - bounds.width : 0; // rough heuristic
    const isTall = bounds.height >= bounds.width + BUBBLE_AREA_TALL - 10;
    const isWide = bounds.width >= bounds.height + BUBBLE_AREA_WIDE - 10;

    if (isTall) {
      // above or below: sprite dims = (bounds.width, bounds.height - BUBBLE_AREA_TALL)
      const spriteH = bounds.height - BUBBLE_AREA_TALL;
      const spriteW = bounds.width;
      // "above": sprite at bottom → offsetY = BUBBLE_AREA_TALL
      // "below": sprite at top → offsetY = 0
      // We can't distinguish without side state, but wander only runs with side="none"
      // (wander cancels on bubble layout change via the existing notifyStateChange path).
      // Default to "above" offset as the historical behavior. Wander is suspended
      // during bubble display anyway so this path is only exercised at side="none".
      void surplusH;
      return { offsetX: 0, offsetY: BUBBLE_AREA_TALL, spriteW, spriteH };
    } else if (isWide) {
      // left or right: sprite dims = (bounds.width - BUBBLE_AREA_WIDE, bounds.height)
      const spriteW = bounds.width - BUBBLE_AREA_WIDE;
      const spriteH = bounds.height;
      return { offsetX: BUBBLE_AREA_WIDE, offsetY: 0, spriteW, spriteH };
    } else {
      // none: sprite = full window
      return { offsetX: 0, offsetY: 0, spriteW: bounds.width, spriteH: bounds.height };
    }
  }

  // Pick a random position within the current display's work area for the SPRITE center
  // (not window center). Keeps the sprite center on screen regardless of layout.
  // Returns sprite-center coordinates (what startWalking navigates toward).
  function pickTarget(): { x: number; y: number } | null {
    if (win.isDestroyed()) return null;
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const wa = display.workArea;

    const { offsetX, offsetY, spriteW, spriteH } = getSpriteOffsetFromBounds(bounds);
    const halfSpriteW = spriteW / 2;
    const halfSpriteH = spriteH / 2;

    // Usable area for sprite center, keeping full window inside work area.
    // Window top-left = spriteCenterX - offsetX - halfSpriteW, spriteCenterY - offsetY - halfSpriteH
    const minX = wa.x + offsetX + halfSpriteW;
    const maxX = wa.x + wa.width - (bounds.width - offsetX - spriteW) - halfSpriteW;
    const minY = wa.y + offsetY + halfSpriteH;
    const maxY = wa.y + wa.height - (bounds.height - offsetY - spriteH) - halfSpriteH;

    if (maxX <= minX || maxY <= minY) return null;

    // Sprite center of current window position
    const cx = bounds.x + offsetX + halfSpriteW;
    const cy = bounds.y + offsetY + halfSpriteH;

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
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const saved = cfg.displayPositions?.[String(display.id)];
    if (!saved) return null;
    // displayPositions stores {x, y} as window top-left (per main.ts saveBoundsForDisplay).
    // Sprite center = window top-left + sprite offset + sprite half-dims.
    // Use current window bounds to infer layout (same as pickTarget).
    const { offsetX, offsetY, spriteW, spriteH } = getSpriteOffsetFromBounds(bounds);
    return {
      x: saved.x + offsetX + spriteW / 2,
      y: saved.y + offsetY + spriteH / 2,
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
    const { offsetX: offsetXDir, offsetY: offsetYDir, spriteW: spriteWDir, spriteH: spriteHForDir } = getSpriteOffsetFromBounds(bounds);
    const curSpriteCxDir = bounds.x + offsetXDir + spriteWDir / 2;
    const curSpriteCyDir = bounds.y + offsetYDir + spriteHForDir / 2;
    const dx = target.x - curSpriteCxDir;
    const dy = target.y - curSpriteCyDir;
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
      // Navigate by sprite center. Derive offset from current window dims.
      const { offsetX, offsetY, spriteW, spriteH } = getSpriteOffsetFromBounds(cur);
      const curSpriteCx = cur.x + offsetX + spriteW / 2;
      const curSpriteCy = cur.y + offsetY + spriteH / 2;

      const tgt = target!;
      const distX = tgt.x - curSpriteCx;
      const distY = tgt.y - curSpriteCy;
      const dist = Math.hypot(distX, distY);

      if (dist <= stepPx) {
        // Arrived — snap to target (tgt is sprite center).
        // Window top-left: x = tgt.x - offsetX - spriteW/2, y = tgt.y - offsetY - spriteH/2.
        clearWalkTick();
        win.setBounds({
          x: Math.round(tgt.x - offsetX - spriteW / 2),
          y: Math.round(tgt.y - offsetY - spriteH / 2),
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
        x: Math.round(newSpriteCx - offsetX - spriteW / 2),
        y: Math.round(newSpriteCy - offsetY - spriteH / 2),
        width: cur.width,
        height: cur.height,
      });
    }, 16);
  }

  // Weighted random rest behavior pick. Returns the behavior key for logging.
  // Weights must sum to 1.0.
  //
  // | Weight | Behavior                                          |
  // |--------|---------------------------------------------------|
  // |  0.40  | idle (pause, head still)                         |
  // |  0.15  | sitting → happy-sit after ~1s (sit then wiggle)  |
  // |  0.10  | looking-around                                    |
  // |  0.10  | sniffing-ground                                   |
  // |  0.08  | stretching                                        |
  // |  0.07  | scratching-ear                                    |
  // |  0.05  | head-tilt-curious                                 |
  // |  0.03  | rolling-belly-up                                  |
  // |  0.02  | skip rest — immediate new walk                    |
  function pickRestBehavior(): {
    action: string;
    restMs: number;
    push: () => void;
  } {
    const r = Math.random();
    // 2-4s hold range shared by most behaviors
    const holdMs = 2000 + Math.random() * 2000;

    if (r < 0.02) {
      // Immediate new walk — no rest
      return { action: "skip-rest", restMs: 0, push: () => {} };
    } else if (r < 0.05) {
      // rolling-belly-up (cumulative 0.02-0.05)
      return {
        action: "rolling-belly-up",
        restMs: holdMs,
        push: () => pushWanderState("rolling-belly-up", holdMs + 500),
      };
    } else if (r < 0.10) {
      // head-tilt-curious (cumulative 0.05-0.10)
      return {
        action: "head-tilt-curious",
        restMs: holdMs,
        push: () => pushWanderState("head-tilt-curious", holdMs + 500),
      };
    } else if (r < 0.17) {
      // scratching-ear (cumulative 0.10-0.17)
      return {
        action: "scratching-ear",
        restMs: holdMs,
        push: () => pushWanderState("scratching-ear", holdMs + 500),
      };
    } else if (r < 0.25) {
      // stretching (cumulative 0.17-0.25)
      return {
        action: "stretching",
        restMs: holdMs,
        push: () => pushWanderState("stretching", holdMs + 500),
      };
    } else if (r < 0.35) {
      // sniffing-ground (cumulative 0.25-0.35)
      return {
        action: "sniffing-ground",
        restMs: holdMs,
        push: () => pushWanderState("sniffing-ground", holdMs + 500),
      };
    } else if (r < 0.45) {
      // looking-around (cumulative 0.35-0.45)
      return {
        action: "looking-around",
        restMs: holdMs,
        push: () => pushWanderState("looking-around", holdMs + 500),
      };
    } else if (r < 0.60) {
      // sitting → happy-sit after ~1s (cumulative 0.45-0.60)
      // Push sitting with explicit 1000ms TTL (overrides the null sticky default
      // just for wander's transition — we want it to decay so happy-sit can follow).
      const sitMs = 1000 + Math.random() * 300;
      return {
        action: "sitting-to-happy-sit",
        restMs: sitMs + holdMs,
        push: () => {
          pushWanderState("sitting", sitMs + 200);
          // happy-sit fires after sitMs via the restTimer in enterResting — no
          // additional timer needed here; the outer restTimer covers the full
          // sitMs + holdMs window. We push happy-sit at the midpoint via a
          // nested setTimeout so it lands as sitting decays.
          setTimeout(() => {
            if (phase !== "resting") return;
            pushWanderState("happy-sit", holdMs + 300);
          }, sitMs);
        },
      };
    } else {
      // idle pause — 40% weight (cumulative 0.60-1.00)
      const idleMs = 2000 + Math.random() * 2000;
      return {
        action: "idle-pause",
        restMs: idleMs,
        push: () => pushWanderState("idle", idleMs + 500),
      };
    }
  }

  function enterResting(): void {
    phase = "resting";
    console.log("[wander] walking → resting");
    logActivity("wander_phase", { from: "walking", to: "resting", reason: "arrived_at_target" });
    // Arriving counts as activity — reset the long-idle clock so yawn/sleep
    // timers don't fire in the middle of an active wander session.
    resetActivityClock();

    // When rest behaviors are disabled, fall back to the original idle-only behavior.
    if (!restBehaviorsEnabled) {
      const idleMs = 2000 + Math.random() * 2000;
      pushWanderState("idle", idleMs + 500);
      restTimer = setTimeout(() => {
        restTimer = null;
        if (phase !== "resting") return;
        if (walksThisSession >= sessionMaxRandomWalks) {
          returnHomeNext = true;
          console.log(`[wander] session cap reached (${walksThisSession}/${sessionMaxRandomWalks}), heading home`);
        }
        phase = "dormant";
        startWalking();
      }, idleMs);
      return;
    }

    const { action, restMs, push } = pickRestBehavior();

    if (action === "skip-rest") {
      console.log("[wander] resting → walking (skip-rest, immediate)");
      phase = "dormant";
      if (walksThisSession >= sessionMaxRandomWalks) returnHomeNext = true;
      startWalking();
      return;
    }

    push();
    console.log(`[wander] resting action=${action} pauseMs=${Math.round(restMs)}`);
    logActivity("wander_rest", { action, restMs: Math.round(restMs) });

    restTimer = setTimeout(() => {
      restTimer = null;
      if (phase !== "resting") return; // interrupted by real push
      if (walksThisSession >= sessionMaxRandomWalks) {
        returnHomeNext = true;
        console.log(`[wander] session cap reached (${walksThisSession}/${sessionMaxRandomWalks}), heading home`);
      } else {
        console.log("[wander] resting → walking (new random target)");
      }
      phase = "dormant";
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
        // Queue settled to idle — arm the wander timer if not already running.
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
        // Already armed or walking/resting — leave as-is.
        // Either way: when the queue returns to idle and wander is not going to fire
        // immediately (because it's already armed/walking/resting), start the
        // long-idle clock so yawn/sleep can trigger if nothing happens for a while.
        scheduleLongIdleCheck();
        return;
      }

      // Non-idle state from a real push (agent !== "wander").
      // Reset the long-idle clock — user or an agent is active.
      // Also clear holdingSleep so sleeping doesn't re-lock after the push decays.
      resetActivityClock();

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
      // Also resets the long-idle clock — a drag is real user interaction.
      resetActivityClock();
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
      clearLongIdleTimer();
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

  // Kick off the long-idle check regardless of wander armed state — even when
  // wander is about to fire, the long-idle timer just gets reset by resetActivityClock
  // on the next walk, so there's no double-fire risk.
  scheduleLongIdleCheck();

  return handle;
}
