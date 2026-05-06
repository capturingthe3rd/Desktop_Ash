import { ANIMATION_ROWS } from "./animation-rows.js";
import type { PetState } from "../shared/types.js";

// window.ash is injected by preload.ts via contextBridge
declare global {
  interface Window {
    ash: {
      getSpritesheetPath: () => Promise<string | null>;
      onStateUpdate: (callback: (state: string) => void) => void;
      listPets: () => Promise<unknown[]>;
      selectPet: (petId: string) => Promise<string>;
    };
  }
}

const petDiv = document.getElementById("pet") as HTMLDivElement;
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
  // background-position math:
  // background-size: 800% 900% means image is 8× wide, 9× tall vs container.
  // position 0% 0% → cell (0,0); 100% 100% → cell (7,8).
  // There are 8 stops across (cols 0-7) and 9 down (rows 0-8).
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
    // Still frame — just show frame 0 of the requested state row
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
          // Idle: loop indefinitely
          animFrame = 0;
        } else {
          playsDone++;
          if (playsDone >= anim.playCount) {
            // Action state complete — drop to idle
            setState("idle");
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

function setState(state: PetState): void {
  currentState = state;
  animFrame = 0;
  playsDone = 0;
  runAnimation(state);
}

async function init(): Promise<void> {
  const spritesheetPath = await window.ash.getSpritesheetPath();

  if (!spritesheetPath) {
    // No pet selected — picker window should have opened instead; nothing to render
    console.warn("[renderer] no spritesheet path available");
    return;
  }

  // Electron serves local files via file:// protocol when loaded as a file
  // but we use the ash:// protocol registered in main.ts for asset serving
  petDiv.style.backgroundImage = `url("ash-asset://${spritesheetPath}")`;

  // Subscribe to state pushes from main process
  window.ash.onStateUpdate((rawState: string) => {
    const state = rawState as PetState;
    setState(state);
  });

  // Start in idle
  setState("idle");
}

init().catch(console.error);
