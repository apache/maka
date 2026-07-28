import type { CuPoint } from '@maka/core';

export interface CuaWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CuaWindowRecord {
  window_id?: unknown;
  pid?: unknown;
  app_name?: unknown;
  title?: unknown;
  layer?: unknown;
  is_on_screen?: unknown;
  z_index?: unknown;
  bounds?: unknown;
}

export interface CuaResolvedWindow {
  pid: number;
  windowId: number;
  appName?: string;
  title?: string;
  bounds: CuaWindowBounds;
  screenPoint: CuPoint;
  zIndex: number;
}

export interface CuaSnapshotElement {
  element_index?: unknown;
  element_token?: unknown;
  role?: unknown;
  label?: unknown;
  title?: unknown;
  description?: unknown;
  value?: unknown;
  depth?: unknown;
  frame?: unknown;
  enabled?: unknown;
  selected?: unknown;
  parent_index?: unknown;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function windowBounds(value: unknown): CuaWindowBounds | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.x !== 'number' ||
    typeof record.y !== 'number' ||
    !finitePositive(record.width) ||
    !finitePositive(record.height)
  )
    return undefined;
  return {
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
  };
}

export function resolveWindowAtDeclaredPoint(input: {
  declaredPoint: CuPoint;
  desktopFrameWidthPx: number;
  logicalDisplayWidth: number;
  windows: readonly CuaWindowRecord[];
}): CuaResolvedWindow | undefined {
  if (!finitePositive(input.desktopFrameWidthPx) || !finitePositive(input.logicalDisplayWidth)) {
    return undefined;
  }
  const scale = input.desktopFrameWidthPx / input.logicalDisplayWidth;
  const screenPoint = {
    x: input.declaredPoint.x / scale,
    y: input.declaredPoint.y / scale,
  };
  const containing = input.windows
    .flatMap((window) => {
      const bounds = windowBounds(window.bounds);
      if (
        window.layer !== 0 ||
        window.is_on_screen === false ||
        !bounds ||
        typeof window.pid !== 'number' ||
        typeof window.window_id !== 'number'
      )
        return [];
      const inside =
        screenPoint.x >= bounds.x &&
        screenPoint.x < bounds.x + bounds.width &&
        screenPoint.y >= bounds.y &&
        screenPoint.y < bounds.y + bounds.height;
      return inside
        ? [
            {
              pid: window.pid,
              windowId: window.window_id,
              ...(typeof window.app_name === 'string' ? { appName: window.app_name } : {}),
              ...(typeof window.title === 'string' ? { title: window.title } : {}),
              bounds,
              screenPoint,
              zIndex: Number(window.z_index) || 0,
            },
          ]
        : [];
    })
    .sort((a, b) => b.zIndex - a.zIndex);
  const winner = containing[0];
  if (!winner) return undefined;
  return {
    pid: winner.pid,
    windowId: winner.windowId,
    ...(winner.appName !== undefined ? { appName: winner.appName } : {}),
    ...(winner.title !== undefined ? { title: winner.title } : {}),
    bounds: winner.bounds,
    screenPoint: winner.screenPoint,
    zIndex: winner.zIndex,
  };
}

export function windowPointFromSnapshot(input: {
  screenPoint: CuPoint;
  windowBounds: CuaWindowBounds;
  screenshotWidthPx: number;
  screenshotHeightPx: number;
}): CuPoint | undefined {
  const { screenPoint, windowBounds } = input;
  if (
    !finitePositive(windowBounds.width) ||
    !finitePositive(windowBounds.height) ||
    !finitePositive(input.screenshotWidthPx) ||
    !finitePositive(input.screenshotHeightPx)
  )
    return undefined;
  const relativeX = (screenPoint.x - windowBounds.x) / windowBounds.width;
  const relativeY = (screenPoint.y - windowBounds.y) / windowBounds.height;
  if (relativeX < 0 || relativeX >= 1 || relativeY < 0 || relativeY >= 1) return undefined;
  return {
    x: relativeX * input.screenshotWidthPx,
    y: relativeY * input.screenshotHeightPx,
  };
}

export function normalizeCuaSnapshotElement(element: CuaSnapshotElement):
  | {
      element_index: number;
      element_token?: string;
      role: string;
      label?: string;
      value?: string;
      depth: number;
      frame: { x: number; y: number; w: number; h: number };
      enabled?: boolean;
      selected?: boolean;
      parent_index?: number;
    }
  | undefined {
  if (typeof element.element_index !== 'number') return undefined;
  if (!element.frame || typeof element.frame !== 'object') return undefined;
  const frame = element.frame as Record<string, unknown>;
  if (
    typeof frame.x !== 'number' ||
    typeof frame.y !== 'number' ||
    !finitePositive(frame.w) ||
    !finitePositive(frame.h)
  )
    return undefined;
  return {
    element_index: element.element_index,
    ...(typeof element.element_token === 'string' ? { element_token: element.element_token } : {}),
    role: typeof element.role === 'string' ? element.role : '',
    ...(typeof element.label === 'string'
      ? { label: element.label }
      : typeof element.title === 'string'
        ? { label: element.title }
        : typeof element.description === 'string'
          ? { label: element.description }
          : {}),
    ...(typeof element.value === 'string' ? { value: element.value } : {}),
    depth: typeof element.depth === 'number' ? element.depth : 0,
    frame: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
    // Interaction state and tree position. The driver already reports these;
    // dropping them here is what forced the model to treat every row as
    // equally actionable and equally rootless.
    ...(typeof element.enabled === 'boolean' ? { enabled: element.enabled } : {}),
    ...(typeof element.selected === 'boolean' ? { selected: element.selected } : {}),
    ...(typeof element.parent_index === 'number' ? { parent_index: element.parent_index } : {}),
  };
}

function elementsContaining(
  elements: readonly CuaSnapshotElement[],
  point: CuPoint,
): Array<NonNullable<ReturnType<typeof normalizeCuaSnapshotElement>>> {
  return elements
    .flatMap((element) => {
      const normalized = normalizeCuaSnapshotElement(element);
      if (!normalized) return [];
      const { frame } = normalized;
      const inside =
        point.x >= frame.x &&
        point.x < frame.x + frame.w &&
        point.y >= frame.y &&
        point.y < frame.y + frame.h;
      return inside ? [normalized] : [];
    })
    .sort((a, b) => {
      const areaDelta = a.frame.w * a.frame.h - b.frame.w * b.frame.h;
      return areaDelta !== 0 ? areaDelta : b.depth - a.depth;
    });
}

export function elementAtScreenPoint(
  elements: readonly CuaSnapshotElement[],
  point: CuPoint,
): ReturnType<typeof normalizeCuaSnapshotElement> {
  return elementsContaining(elements, point).find((element) => CLICKABLE_ROLES.has(element.role));
}

const CLICKABLE_ROLES = new Set([
  'AXButton',
  'AXCheckBox',
  'AXDisclosureTriangle',
  'AXLink',
  'AXMenuBarItem',
  'AXMenuButton',
  'AXMenuItem',
  'AXPopUpButton',
  'AXRadioButton',
  'AXTab',
]);

const EDITABLE_ROLES = new Set(['AXComboBox', 'AXSearchField', 'AXTextArea', 'AXTextField']);

export function editableElementAtScreenPoint(
  elements: readonly CuaSnapshotElement[],
  point: CuPoint,
): ReturnType<typeof normalizeCuaSnapshotElement> {
  return elementsContaining(elements, point).find((element) => EDITABLE_ROLES.has(element.role));
}
