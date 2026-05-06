import fs from "fs";
import path from "path";
import os from "os";
import type { PetManifest } from "../shared/types.js";

const PETS_BASE = path.join(os.homedir(), ".codex", "pets");

export function scanPets(): PetManifest[] {
  try {
    const entries = fs.readdirSync(PETS_BASE, { withFileTypes: true });
    const manifests: PetManifest[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(PETS_BASE, entry.name, "pet.json");
      try {
        const raw = fs.readFileSync(manifestPath, "utf-8");
        const parsed = JSON.parse(raw) as Omit<PetManifest, "spritesheetAbsolutePath">;
        const manifest: PetManifest = {
          ...parsed,
          spritesheetAbsolutePath: path.join(PETS_BASE, parsed.id, parsed.spritesheetPath),
        };
        manifests.push(manifest);
      } catch {
        // Skip malformed or missing pet.json
        console.warn(`[pet-scanner] skipping ${entry.name}: bad or missing pet.json`);
      }
    }

    return manifests;
  } catch {
    console.warn(`[pet-scanner] could not read ${PETS_BASE}`);
    return [];
  }
}

// Resolve absolute path to a pet's spritesheet — spritesheetPath is relative to pet dir
export function resolveSpritesheetPath(petId: string, spritesheetPath: string): string {
  return path.join(PETS_BASE, petId, spritesheetPath);
}
