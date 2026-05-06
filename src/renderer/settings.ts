// Settings window — reads current config + login item, lets user edit, applies on click.
// All edits batch under a single Apply call. Cancel discards.

interface PetManifest {
  id: string;
  displayName: string;
  description: string;
}

interface AppConfig {
  selectedPetId: string | null;
  codexBridgeEnabled?: boolean;
  overlayScale?: number;
  displayScales?: Record<string, number>;
  displayPositions?: Record<string, { x: number; y: number }>;
  idleWanderEnabled?: boolean;
  idleWanderDelayMs?: number;
  idleWanderSpeedPxPerSec?: number;
  bubbleEnabled?: boolean;
  bubbleLifetimeMs?: number;
  bubbleMaxStack?: number;
}

declare global {
  interface Window {
    ash: {
      listPets: () => Promise<PetManifest[]>;
      getSettings: () => Promise<AppConfig>;
      saveSettings: (partial: Partial<AppConfig>) => Promise<AppConfig>;
      getCurrentDisplayId: () => Promise<string | null>;
      getOpenAtLogin: () => Promise<boolean>;
      setOpenAtLogin: (v: boolean) => Promise<boolean>;
    };
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  petSelect:        $<HTMLSelectElement>("pet-select"),
  displayId:        $<HTMLSpanElement>("display-id"),
  scale:            $<HTMLInputElement>("scale"),
  scaleValue:       $<HTMLSpanElement>("scale-value"),
  wanderEnabled:    $<HTMLInputElement>("wander-enabled"),
  wanderDelay:      $<HTMLInputElement>("wander-delay"),
  wanderDelayValue: $<HTMLSpanElement>("wander-delay-value"),
  wanderSpeed:      $<HTMLInputElement>("wander-speed"),
  wanderSpeedValue: $<HTMLSpanElement>("wander-speed-value"),
  bubbleEnabled:    $<HTMLInputElement>("bubble-enabled"),
  bubbleLifetime:   $<HTMLInputElement>("bubble-lifetime"),
  bubbleLifetimeValue: $<HTMLSpanElement>("bubble-lifetime-value"),
  bubbleStack:      $<HTMLInputElement>("bubble-stack"),
  bubbleStackValue: $<HTMLSpanElement>("bubble-stack-value"),
  codexEnabled:     $<HTMLInputElement>("codex-enabled"),
  loginEnabled:     $<HTMLInputElement>("login-enabled"),
  btnCancel:        $<HTMLButtonElement>("btn-cancel"),
  btnApply:         $<HTMLButtonElement>("btn-apply"),
  status:           $<HTMLParagraphElement>("status"),
};

let currentDisplayId: string | null = null;

function bindRangeLabel(input: HTMLInputElement, label: HTMLSpanElement, fmt: (v: number) => string): void {
  const update = () => { label.textContent = fmt(parseFloat(input.value)); };
  input.addEventListener("input", update);
  update();
}

async function loadAll(): Promise<void> {
  const [pets, cfg, displayId, openAtLogin] = await Promise.all([
    window.ash.listPets(),
    window.ash.getSettings(),
    window.ash.getCurrentDisplayId(),
    window.ash.getOpenAtLogin(),
  ]);

  currentDisplayId = displayId;
  els.displayId.textContent = displayId ?? "no overlay";

  els.petSelect.innerHTML = "";
  for (const pet of pets) {
    const opt = document.createElement("option");
    opt.value = pet.id;
    opt.textContent = pet.displayName;
    els.petSelect.appendChild(opt);
  }
  if (cfg.selectedPetId) els.petSelect.value = cfg.selectedPetId;

  // Resolve current display scale (per-display memory falls back to overlayScale, then 1.5)
  const displayScale = (displayId && cfg.displayScales?.[displayId])
    ?? cfg.overlayScale
    ?? 1.5;
  els.scale.value = String(displayScale);

  els.wanderEnabled.checked  = cfg.idleWanderEnabled !== false;
  els.wanderDelay.value      = String(Math.round((cfg.idleWanderDelayMs ?? 60000) / 1000));
  els.wanderSpeed.value      = String(cfg.idleWanderSpeedPxPerSec ?? 150);

  els.bubbleEnabled.checked  = cfg.bubbleEnabled !== false;
  els.bubbleLifetime.value   = String(Math.round((cfg.bubbleLifetimeMs ?? 10000) / 1000));
  els.bubbleStack.value      = String(cfg.bubbleMaxStack ?? 5);

  els.codexEnabled.checked   = cfg.codexBridgeEnabled === true;
  els.loginEnabled.checked   = openAtLogin;

  // Set up live label updates
  bindRangeLabel(els.scale,          els.scaleValue,          v => `${v.toFixed(2)}×`);
  bindRangeLabel(els.wanderDelay,    els.wanderDelayValue,    v => `${v}s`);
  bindRangeLabel(els.wanderSpeed,    els.wanderSpeedValue,    v => `${v} px/s`);
  bindRangeLabel(els.bubbleLifetime, els.bubbleLifetimeValue, v => `${v}s`);
  bindRangeLabel(els.bubbleStack,    els.bubbleStackValue,    v => `${v}`);
}

async function applyChanges(): Promise<void> {
  els.status.textContent = "Saving…";
  els.status.style.color = "#888";

  // Build partial config delta
  const partial: Partial<AppConfig> = {
    selectedPetId: els.petSelect.value || null,
    idleWanderEnabled: els.wanderEnabled.checked,
    idleWanderDelayMs: parseInt(els.wanderDelay.value, 10) * 1000,
    idleWanderSpeedPxPerSec: parseInt(els.wanderSpeed.value, 10),
    bubbleEnabled: els.bubbleEnabled.checked,
    bubbleLifetimeMs: parseInt(els.bubbleLifetime.value, 10) * 1000,
    bubbleMaxStack: parseInt(els.bubbleStack.value, 10),
    codexBridgeEnabled: els.codexEnabled.checked,
  };

  // Per-display scale: write into displayScales for current display only
  if (currentDisplayId) {
    const newScale = parseFloat(els.scale.value);
    const cfg = await window.ash.getSettings();
    const map = { ...(cfg.displayScales ?? {}) };
    map[currentDisplayId] = newScale;
    partial.displayScales = map;
  }

  await window.ash.saveSettings(partial);
  await window.ash.setOpenAtLogin(els.loginEnabled.checked);

  els.status.textContent = "Saved ✓";
  els.status.style.color = "#34c759";
  setTimeout(() => { els.status.textContent = ""; }, 2000);
}

els.btnApply.addEventListener("click", () => { void applyChanges(); });
els.btnCancel.addEventListener("click", () => { window.close(); });

void loadAll();
