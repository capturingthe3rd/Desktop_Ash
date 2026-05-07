import { app } from "electron";
import fs from "fs";
import path from "path";
import type { AppConfig } from "../shared/types.js";

// app.getPath() is only valid after the app module is initialized.
// Use a getter so it's evaluated lazily at call time, not at import time.
function configFile(): string {
  return path.join(app.getPath("userData"), "config.json");
}

const DEFAULT_CONFIG: AppConfig = {
  selectedPetId: null,
  // Bridge disabled by default. User opts in via config.json.
  codexBridgeEnabled: false,
  idleWanderEnabled: true,
  idleWanderDelayMs: 60000,
  idleWanderSpeedPxPerSec: 150,
  bubbleEnabled: true,
  bubbleLifetimeMs: 10000,
  bubbleMaxStack: 5,
  // displayPositions and displayScales intentionally absent — avoid
  // empty-object noise in config.json before the first save.
  // Outbound webhooks — off by default. User opts in via Settings > Webhooks.
  webhookOutbound: {
    enabled: false,
    urls: [],
    eventFilter: {
      stateChanges: true,
      bubbles: false,
      errors: true,
    },
  },
};

export function loadConfig(): AppConfig {
  try {
    const raw = fs.readFileSync(configFile(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    // First run or corrupted config — start fresh
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: AppConfig): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf-8");
}
