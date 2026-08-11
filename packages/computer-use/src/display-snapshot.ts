import type { ComputerUseDisplayIdentity } from '@maka/core/computer-use';

export interface CuaHostDisplay {
  id: number | string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

export function resolveCuaDisplaySnapshots(input: {
  displays: readonly CuaHostDisplay[];
  primaryDisplayId: number | string;
  screenshotWidthPx: number;
  screenshotHeightPx: number;
}): ComputerUseDisplayIdentity[] {
  const primary = input.displays.find(
    (display) => String(display.id) === String(input.primaryDisplayId),
  );
  if (!primary) return [];
  const primaryMatches =
    Math.round(primary.bounds.width * primary.scaleFactor) === input.screenshotWidthPx &&
    Math.round(primary.bounds.height * primary.scaleFactor) === input.screenshotHeightPx;
  const primarySnapshot = (): ComputerUseDisplayIdentity[] =>
    primaryMatches
      ? [
          {
            displayId: String(primary.id),
            logicalBounds: primary.bounds,
            sourceBoundsPx: {
              x: 0,
              y: 0,
              width: input.screenshotWidthPx,
              height: input.screenshotHeightPx,
            },
            scaleFactor: primary.scaleFactor,
          },
        ]
      : [];
  const scaleFactors = new Set(input.displays.map((display) => display.scaleFactor));
  if (scaleFactors.size !== 1) return primarySnapshot();

  const scaleFactor = primary.scaleFactor;
  const minX = Math.min(...input.displays.map((display) => display.bounds.x));
  const minY = Math.min(...input.displays.map((display) => display.bounds.y));
  const maxX = Math.max(
    ...input.displays.map((display) => display.bounds.x + display.bounds.width),
  );
  const maxY = Math.max(
    ...input.displays.map((display) => display.bounds.y + display.bounds.height),
  );
  const fullAtlasMatches =
    Math.round((maxX - minX) * scaleFactor) === input.screenshotWidthPx &&
    Math.round((maxY - minY) * scaleFactor) === input.screenshotHeightPx;
  if (!fullAtlasMatches) return primarySnapshot();

  return input.displays.map((display) => ({
    displayId: String(display.id),
    logicalBounds: display.bounds,
    sourceBoundsPx: {
      x: (display.bounds.x - minX) * scaleFactor,
      y: (display.bounds.y - minY) * scaleFactor,
      width: display.bounds.width * scaleFactor,
      height: display.bounds.height * scaleFactor,
    },
    scaleFactor,
  }));
}
