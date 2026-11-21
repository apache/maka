import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type OverlayRow = { id: string } & Record<string, unknown>;

export type OverlayFile = {
  tools: OverlayRow[];
};

export function applyOverlay<T extends { id: string }>(base: T[], patch: T[]): T[] {
  const merged = [...base];
  for (const row of patch) {
    const index = merged.findIndex((item) => item.id === row.id);
    if (index >= 0) {
      merged[index] = row;
    } else {
      merged.push(row);
    }
  }
  return merged;
}

export function loadOverlayFiles(paths: string[]): OverlayFile {
  let tools: OverlayRow[] = [];
  for (const filePath of paths) {
    const parsed = parse(readFileSync(filePath, "utf8")) as { tools?: OverlayRow[] } | null;
    tools = applyOverlay(tools, parsed?.tools ?? []);
  }
  return { tools };
}
