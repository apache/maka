import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { applyOverlay, loadOverlayFiles } from "./overlay";

describe("overlay", () => {
  it("replaces a whole row by id instead of merging fields", () => {
    const merged = applyOverlay(
      [
        { id: "replay", enabled: true, timeout: 10 },
        { id: "import", enabled: true },
      ],
      [{ id: "replay", enabled: false, timeout: 99 }],
    );

    expect(merged).toEqual([
      { id: "replay", enabled: false, timeout: 99 },
      { id: "import", enabled: true },
    ]);
  });

  it("loads yaml files later-wins by id", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tokens-overlay-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "base.yml"),
      "tools:\n  - id: replay\n    enabled: true\n  - id: import\n    enabled: true\n",
    );
    writeFileSync(path.join(dir, "local.yml"), "tools:\n  - id: replay\n    enabled: false\n");

    const overlay = loadOverlayFiles([path.join(dir, "base.yml"), path.join(dir, "local.yml")]);
    expect(overlay.tools).toEqual([
      { id: "replay", enabled: false },
      { id: "import", enabled: true },
    ]);
  });
});
