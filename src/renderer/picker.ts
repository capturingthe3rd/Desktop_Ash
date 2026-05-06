import type { PetManifest } from "../shared/types.js";

declare global {
  interface Window {
    ash: {
      listPets: () => Promise<PetManifest[]>;
      selectPet: (petId: string) => Promise<string>;
      getSpritesheetPath: () => Promise<string | null>;
      onStateUpdate: (callback: (state: string) => void) => void;
    };
  }
}

async function init(): Promise<void> {
  const pets = await window.ash.listPets();
  const list = document.getElementById("pet-list") as HTMLDivElement;
  const status = document.getElementById("status") as HTMLParagraphElement;

  if (pets.length === 0) {
    status.textContent = "No pets found at ~/.codex/pets/ — hatch one in Codex first.";
    return;
  }

  for (const pet of pets) {
    const card = document.createElement("div");
    card.className = "pet-card";
    card.dataset["petId"] = pet.id;

    // Preview: frame 0 of idle (row 0, col 0) via background-position 0% 0%
    const thumb = document.createElement("div");
    thumb.className = "pet-thumb";
    // ash-asset:// expects an absolute filesystem path after the prefix.
    // pet-scanner enriches each manifest with spritesheetAbsolutePath at scan time.
    thumb.style.backgroundImage = `url("ash-asset://${pet.spritesheetAbsolutePath}")`;

    const info = document.createElement("div");
    info.className = "pet-info";

    const name = document.createElement("strong");
    name.textContent = pet.displayName;

    const desc = document.createElement("p");
    desc.textContent = pet.description;

    info.appendChild(name);
    info.appendChild(desc);
    card.appendChild(thumb);
    card.appendChild(info);

    card.addEventListener("click", async () => {
      document.querySelectorAll(".pet-card").forEach((el) => el.classList.remove("selected"));
      card.classList.add("selected");
      status.textContent = "Loading...";

      await window.ash.selectPet(pet.id);
      status.textContent = `Selected: ${pet.displayName}. Launching...`;

      // Small delay so user sees the confirmation before the window closes
      await new Promise((r) => setTimeout(r, 600));
      // Main process listens for pet:select and will close picker + open overlay
    });

    list.appendChild(card);
  }
}

init().catch(console.error);
