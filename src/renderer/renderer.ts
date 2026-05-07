import { ANIMATION_ROWS } from "./animation-rows.js";
import type { PetState } from "../shared/types.js";

// Payload now includes agent + message so the bubble manager can react.
interface StateUpdatePayload {
  state: string;
  agent: string | null;
  message: string | null;
  // Phase 12C — session metadata for deep-link routing on bubble click
  sessionId: string | null;
  sessionPath: string | null;
  sessionType: string | null;
}

// window.ash is injected by preload.ts via contextBridge
declare global {
  interface Window {
    ash: {
      getSpritesheetPath: () => Promise<string | null>;
      onStateUpdate: (callback: (payload: StateUpdatePayload) => void) => void;
      listPets: () => Promise<unknown[]>;
      selectPet: (petId: string) => Promise<string>;
      clickBubble: (agent: string | null, sessionType: string | null, sessionPath: string | null, sessionId: string | null) => void;
      // Phase 10A — relay activity events to main via IPC
      logActivity: (type: string, data: object) => void;
      // Phase 11A — dynamic bubble window layout
      requestBubbleLayout: (count: number) => Promise<string>;
      clearBubbleLayout: () => void;
    };
  }
}

// ── Layout helpers ───────────────────────────────────────────────────────────

// The current bubble side applied to <body>. "no-bubble" = sprite-only window.
type LayoutSide = "no-bubble" | "side-above" | "side-below" | "side-left" | "side-right";
const LAYOUT_CLASSES: LayoutSide[] = ["no-bubble", "side-above", "side-below", "side-left", "side-right"];

function applyLayoutClass(cls: LayoutSide): void {
  document.body.classList.remove(...LAYOUT_CLASSES);
  document.body.classList.add(cls);
}

// Maps the side string returned by main → body class
function sideToLayoutClass(side: string): LayoutSide {
  switch (side) {
    case "above": return "side-above";
    case "below": return "side-below";
    case "left":  return "side-left";
    case "right": return "side-right";
    default:      return "no-bubble";
  }
}

// ── Sprite animator ─────────────────────────────────────────────────────────

const petDiv = document.getElementById("pet") as HTMLDivElement;
const bubbleStack = document.getElementById("bubble-stack") as HTMLDivElement;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let currentState: PetState = "idle";
let animFrame = 0;
let playsDone = 0;
let animTimer: ReturnType<typeof setTimeout> | null = null;

function stopAnimation(): void {
  if (animTimer !== null) {
    clearTimeout(animTimer);
    animTimer = null;
  }
}

function applyFrame(row: number, col: number): void {
  const xPct = (col / 7) * 100;
  const yPct = (row / 8) * 100;
  petDiv.style.backgroundPosition = `${xPct}% ${yPct}%`;
}

function runAnimation(state: PetState): void {
  stopAnimation();
  const anim = ANIMATION_ROWS[state];
  animFrame = 0;
  playsDone = 0;

  if (reducedMotion) {
    applyFrame(anim.row, 0);
    return;
  }

  function tick(): void {
    const anim = ANIMATION_ROWS[currentState];
    const isLastFrame = animFrame === anim.frames - 1;
    applyFrame(anim.row, animFrame);
    const delay = isLastFrame ? anim.lastFrameMs : anim.frameMs;

    animTimer = setTimeout(() => {
      if (isLastFrame) {
        if (anim.playCount === null) {
          animFrame = 0;
        } else {
          playsDone++;
          if (playsDone >= anim.playCount) {
            setSpriteState("idle");
            return;
          }
          animFrame = 0;
        }
      } else {
        animFrame++;
      }
      tick();
    }, delay);
  }
  tick();
}

function setSpriteState(state: PetState): void {
  currentState = state;
  animFrame = 0;
  playsDone = 0;
  runAnimation(state);
}

// ── Bubble manager ──────────────────────────────────────────────────────────

const BUBBLE_LIFETIME_MS = 10000;
const BUBBLE_MAX_STACK = 5;

// Color palette per agent. Background is the agent color at 0.9 opacity;
// border is a slightly darker shade for definition.
interface BubbleColors {
  bg: string;
  border: string;
  tail: string; // matches bg for the speech-bubble tail triangle
}

const AGENT_COLORS: Record<string, BubbleColors> = {
  "claude-code": { bg: "rgba(232, 160, 107, 0.92)", border: "#C97D43", tail: "rgba(232, 160, 107, 0.92)" },
  codex:         { bg: "rgba(20, 184, 166, 0.92)",  border: "#0E8C7B", tail: "rgba(20, 184, 166, 0.92)" },
  wander:        { bg: "rgba(139, 127, 190, 0.92)", border: "#695C9B", tail: "rgba(139, 127, 190, 0.92)" },
};

// Fallback palette for unknown agents — assigned by hash of agent name.
const FALLBACK_PALETTE: BubbleColors[] = [
  { bg: "rgba(99, 102, 241, 0.92)",  border: "#4F46E5", tail: "rgba(99, 102, 241, 0.92)" },   // indigo
  { bg: "rgba(34, 197, 94, 0.92)",   border: "#16A34A", tail: "rgba(34, 197, 94, 0.92)" },    // green
  { bg: "rgba(236, 72, 153, 0.92)",  border: "#BE185D", tail: "rgba(236, 72, 153, 0.92)" },   // pink
  { bg: "rgba(245, 158, 11, 0.92)",  border: "#B45309", tail: "rgba(245, 158, 11, 0.92)" },   // amber
  { bg: "rgba(14, 165, 233, 0.92)",  border: "#0369A1", tail: "rgba(14, 165, 233, 0.92)" },   // sky
  { bg: "rgba(168, 85, 247, 0.92)",  border: "#7E22CE", tail: "rgba(168, 85, 247, 0.92)" },   // violet
];

// Manual / null agent — neutral gray.
const NEUTRAL_COLORS: BubbleColors = {
  bg: "rgba(156, 163, 175, 0.92)",
  border: "#6B7280",
  tail: "rgba(156, 163, 175, 0.92)",
};

function colorForAgent(agent: string | null): BubbleColors {
  if (!agent || agent === "manual") return NEUTRAL_COLORS;
  if (AGENT_COLORS[agent]) return AGENT_COLORS[agent];
  // Hash agent name → palette index for stable assignment per unknown agent
  let hash = 0;
  for (let i = 0; i < agent.length; i++) {
    hash = (hash * 31 + agent.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length]!;
}

// Track active bubbles + their auto-fade timers so we can dismiss/clean up.
// `dismissed` flag is set synchronously when dismissal begins so the cap-evict
// loop doesn't keep picking the same already-fading bubble (would deadlock).
interface ActiveBubble {
  el: HTMLDivElement;
  fadeTimer: ReturnType<typeof setTimeout>;
  dismissed: boolean;
}
const activeBubbles: ActiveBubble[] = [];

function dismissBubble(b: ActiveBubble): void {
  if (b.dismissed) return;
  b.dismissed = true;
  clearTimeout(b.fadeTimer);
  // Remove from active list IMMEDIATELY (synchronous) so spawnBubble's eviction
  // loop sees the new length on the next iteration. The DOM element keeps living
  // for the 400ms fade animation before final removal.
  const idx = activeBubbles.indexOf(b);
  if (idx >= 0) activeBubbles.splice(idx, 1);
  b.el.classList.add("fading");
  setTimeout(() => {
    b.el.remove();
    // After the last bubble fades, notify main to shrink window back to sprite-only.
    if (activeBubbles.length === 0) {
      console.log("[bubble] last bubble gone → BUBBLE_LAYOUT_CLEAR");
      window.ash.clearBubbleLayout();
      applyLayoutClass("no-bubble");
    }
  }, 400);
}

// Apply the correct tail border style for the current layout side.
// CSS handles position/transform; we set the colored border direction here.
function applyTailStyle(tail: HTMLDivElement, colors: BubbleColors): void {
  // Clear all directional borders first
  tail.style.borderTop = "";
  tail.style.borderBottom = "";
  tail.style.borderLeft = "";
  tail.style.borderRight = "";

  const cls = document.body.className;
  if (cls.includes("side-below")) {
    // Tail points up toward sprite — use border-bottom
    tail.style.borderBottom = `8px solid ${colors.tail}`;
  } else if (cls.includes("side-left")) {
    // Tail points right toward sprite — use border-left
    tail.style.borderLeft = `8px solid ${colors.tail}`;
  } else if (cls.includes("side-right")) {
    // Tail points left toward sprite — use border-right
    tail.style.borderRight = `8px solid ${colors.tail}`;
  } else {
    // side-above (default) or no-bubble: tail points down — use border-top
    tail.style.borderTop = `8px solid ${colors.tail}`;
  }
}

async function spawnBubble(agent: string | null, message: string, sessionType: string | null, sessionPath: string | null, sessionId: string | null): Promise<void> {
  // If this is the first bubble of an empty stack, request layout from main.
  // Main picks the optimal side, resizes the window, and returns the side string.
  if (activeBubbles.length === 0) {
    const side = await window.ash.requestBubbleLayout(1);
    console.log(`[bubble] layout side=${side}`);
    applyLayoutClass(sideToLayoutClass(side));
  }

  // Cap stack — force-fade oldest if at limit. Oldest = last in activeBubbles array.
  while (activeBubbles.length >= BUBBLE_MAX_STACK) {
    const oldest = activeBubbles[activeBubbles.length - 1];
    if (oldest) dismissBubble(oldest);
    else break;
  }

  const colors = colorForAgent(agent);
  const el = document.createElement("div");
  el.className = "bubble";
  el.style.backgroundColor = colors.bg;
  el.style.borderColor = colors.border;

  const label = document.createElement("div");
  label.className = "agent-label";
  label.textContent = agent ?? "anon";

  const msg = document.createElement("div");
  msg.className = "message";
  msg.textContent = message;

  const tail = document.createElement("div");
  tail.className = "tail";
  applyTailStyle(tail, colors);

  el.appendChild(label);
  el.appendChild(msg);
  el.appendChild(tail);

  // Newest first (prepend) so it appears at the top/leading edge of the stack.
  bubbleStack.insertBefore(el, bubbleStack.firstChild);

  const active: ActiveBubble = {
    el,
    dismissed: false,
    fadeTimer: setTimeout(() => {
      console.log(`[bubble] auto-fade agent="${agent ?? "anon"}"`);
      dismissBubble(active);
    }, BUBBLE_LIFETIME_MS),
  };
  activeBubbles.unshift(active);

  // Right-click → dismiss this bubble
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    console.log(`[bubble] right-click dismiss agent="${agent ?? "anon"}"`);
    dismissBubble(active);
  });

  // Left-click → deep-link to agent session (Tier 2) or focus app (Tier 1), then dismiss
  el.addEventListener("click", (e) => {
    if (e.button !== 0) return;
    console.log(`[bubble] left-click → agent="${agent ?? "anon"}" sessionType=${sessionType ?? "none"}`);
    window.ash.clickBubble(agent, sessionType, sessionPath, sessionId);
    dismissBubble(active);
  });

  console.log(`[bubble] spawned agent="${agent ?? "anon"}" sessionType=${sessionType ?? "none"} message="${message.slice(0, 40)}…"`);
  // Relay to main for activity log — renderer is sandboxed, so send via IPC bridge.
  window.ash.logActivity("bubble_spawn", { agent, sessionType, sessionId, messageLength: message.length });
}

// ── Wire-up ─────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Defense in depth against right-click crashing the transparent overlay:
  //   1) capture mousedown for right button BEFORE anything else can dispatch it
  //   2) preventDefault on contextmenu (Chromium's browser menu)
  //   3) main process intercepts close events to hide instead of destroy
  // Bubbles still get their own contextmenu handler for right-click dismiss
  // because addEventListener handlers run before this top-level preventDefault.
  document.addEventListener("mousedown", (e) => {
    if (e.button === 2) {
      const target = e.target as HTMLElement | null;
      if (!target?.closest(".bubble")) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }
  }, true /* useCapture — fire before any other handler */);

  document.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest(".bubble")) {
      e.preventDefault();
    }
  });

  const spritesheetPath = await window.ash.getSpritesheetPath();
  if (!spritesheetPath) {
    console.warn("[renderer] no spritesheet path available");
    return;
  }
  petDiv.style.backgroundImage = `url("ash-asset://${spritesheetPath}")`;

  // Compute sprite dims from the SCALE (not window dims), so the pet element
  // is always 192*scale × 208*scale regardless of which side a bubble is on.
  // Reading window.innerWidth was unreliable: in no-bubble the window matches
  // sprite dims, but in side-* layouts the window is larger and stale inline
  // dims would clip the sprite to upper-left of an oversized pet div.
  async function applySpriteSize(): Promise<void> {
    try {
      const [cfg, displayId] = await Promise.all([
        window.ash.getSettings(),
        window.ash.getCurrentDisplayId(),
      ]);
      const scale = (displayId && cfg.displayScales?.[displayId])
        ?? cfg.overlayScale
        ?? 1.5;
      const spriteW = Math.round(192 * scale);
      const spriteH = Math.round(208 * scale);
      petDiv.style.width = `${spriteW}px`;
      petDiv.style.height = `${spriteH}px`;
    } catch {
      // Fallback: no IPC available — use window dims. Should never happen.
      petDiv.style.width = `${window.innerWidth}px`;
      petDiv.style.height = `${window.innerHeight}px`;
    }
  }

  await applySpriteSize();
  // Re-apply on every window resize so scale changes (Cmd+= / Cmd+-) update
  // the sprite element to match the new spriteW/spriteH.
  window.addEventListener("resize", () => { void applySpriteSize(); });

  window.ash.onStateUpdate((payload: StateUpdatePayload) => {
    const state = payload.state as PetState;
    setSpriteState(state);
    // Bubble: only spawn when message is provided (completion events)
    if (payload.message && payload.message.trim().length > 0) {
      spawnBubble(payload.agent, payload.message, payload.sessionType, payload.sessionPath, payload.sessionId).catch(console.error);
    }
  });

  setSpriteState("idle");
}

init().catch(console.error);
