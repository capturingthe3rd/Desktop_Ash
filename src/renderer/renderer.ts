import { ANIMATION_ROWS } from "./animation-rows.js";
import type { PetState } from "../shared/types.js";

// Payload now includes agent + message so the bubble manager can react.
interface StateUpdatePayload {
  state: string;
  agent: string | null;
  message: string | null;
}

// window.ash is injected by preload.ts via contextBridge
declare global {
  interface Window {
    ash: {
      getSpritesheetPath: () => Promise<string | null>;
      onStateUpdate: (callback: (payload: StateUpdatePayload) => void) => void;
      listPets: () => Promise<unknown[]>;
      selectPet: (petId: string) => Promise<string>;
      clickBubble: (agent: string | null) => void;
    };
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
  }, 400);
}

function spawnBubble(agent: string | null, message: string): void {
  // Cap stack — force-fade oldest if at limit. Oldest = last in DOM (we prepend new).
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
  tail.style.borderTop = `8px solid ${colors.tail}`;

  el.appendChild(label);
  el.appendChild(msg);
  el.appendChild(tail);

  // Newest first (prepend) so it appears at the top of the stack;
  // older bubbles slide down visually as new ones push in above.
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

  // Left-click → focus the agent's app, then dismiss
  el.addEventListener("click", (e) => {
    if (e.button !== 0) return;
    console.log(`[bubble] left-click → focus app for agent="${agent ?? "anon"}"`);
    window.ash.clickBubble(agent);
    dismissBubble(active);
  });

  console.log(`[bubble] spawned agent="${agent ?? "anon"}" message="${message.slice(0, 40)}…"`);
}

// ── Wire-up ─────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const spritesheetPath = await window.ash.getSpritesheetPath();
  if (!spritesheetPath) {
    console.warn("[renderer] no spritesheet path available");
    return;
  }
  petDiv.style.backgroundImage = `url("ash-asset://${spritesheetPath}")`;

  window.ash.onStateUpdate((payload: StateUpdatePayload) => {
    const state = payload.state as PetState;
    setSpriteState(state);
    // Bubble: only spawn when message is provided (completion events)
    if (payload.message && payload.message.trim().length > 0) {
      spawnBubble(payload.agent, payload.message);
    }
  });

  setSpriteState("idle");
}

init().catch(console.error);
