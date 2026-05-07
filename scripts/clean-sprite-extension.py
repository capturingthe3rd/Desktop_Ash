#!/usr/bin/env python3
"""
Cleans an extended sprite sheet (rows 9+) so they match the original
hand-crafted base rows (0-8) in line weight and color crispness.

WHY: Codex AI generates extended sprite rows (e.g., ash-deluxe-v3 rows
9-25) that have soft gradient transitions between color regions —
they look like anti-aliased illustrations rather than pixel art.
The originals have hard color boundaries, which is what gives them
the "clean" pixel-art feel.

WHAT THIS DOES:
1. Extracts a tight palette (default 32 colors) from rows 0-8 via
   k-means clustering.
2. For each opaque pixel in rows 9+, snaps RGB to the nearest
   palette color.
3. Result: hard color transitions throughout the sheet, uniform style.

This does NOT fix:
- Anatomical/proportional inconsistency between AI-generated frames.
- Animation jankness from frames not flowing smoothly.
- Line weight variation that's structural rather than color-edge.

USAGE:
  ./scripts/clean-sprite-extension.py <pet-id> [palette-size]
  ./scripts/clean-sprite-extension.py ash-deluxe-v3
  ./scripts/clean-sprite-extension.py ash-deluxe-v3 48

The script backs up the original to spritesheet.original.png on first
run, then writes the cleaned version to spritesheet.png.
"""
import sys
import shutil
from pathlib import Path
from PIL import Image
import numpy as np
from scipy.cluster.vq import kmeans2

def main(pet_id: str, palette_size: int = 32, base_rows: int = 9):
    pet_dir = Path.home() / ".codex" / "pets" / pet_id
    src = pet_dir / "spritesheet.png"
    backup = pet_dir / "spritesheet.original.png"

    if not src.exists():
        print(f"ERROR: not found: {src}", file=sys.stderr)
        sys.exit(1)

    # Backup once
    if not backup.exists():
        shutil.copy(src, backup)
        print(f"backed up → {backup}")
    else:
        print(f"backup exists → {backup} (will read FROM backup so cleanup is idempotent)")

    # Read from backup if exists, so re-running uses the original source
    img = Image.open(backup if backup.exists() else src).convert("RGBA")
    arr = np.array(img)

    CELL_H = 208
    ext_start = base_rows * CELL_H

    if ext_start >= arr.shape[0]:
        print(f"ERROR: sheet has {arr.shape[0] // CELL_H} rows, less than {base_rows} base rows", file=sys.stderr)
        sys.exit(1)

    # Extract palette from base
    base = arr[:ext_start]
    base_opaque = base[:, :, 3] >= 128
    base_rgb = base[base_opaque][:, :3].astype(np.float64)
    print(f"k-means on {len(base_rgb):,} base pixels → {palette_size}-color palette")
    centroids, _ = kmeans2(base_rgb, palette_size, seed=42, minit='++')
    palette = np.clip(centroids, 0, 255).astype(np.uint8)

    # Snap ext rows
    ext = arr[ext_start:].copy()
    ext_opaque = ext[:, :, 3] >= 128
    ext_rgb = ext[ext_opaque][:, :3].astype(np.float32)
    print(f"snapping {len(ext_rgb):,} ext pixels to palette")

    batch = 50000
    nearest = np.zeros(len(ext_rgb), dtype=np.int32)
    for i in range(0, len(ext_rgb), batch):
        chunk = ext_rgb[i:i+batch]
        dists = np.linalg.norm(chunk[:, np.newaxis] - palette[np.newaxis, :], axis=2)
        nearest[i:i+batch] = np.argmin(dists, axis=1)

    ext[ext_opaque, :3] = palette[nearest]

    # Write
    out_arr = arr.copy()
    out_arr[ext_start:] = ext
    Image.fromarray(out_arr).save(src)
    print(f"saved cleaned → {src}")
    print("restart Desktop Ash to see the cleaned sprites")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    pet_id = sys.argv[1]
    palette_size = int(sys.argv[2]) if len(sys.argv) > 2 else 32
    main(pet_id, palette_size)
