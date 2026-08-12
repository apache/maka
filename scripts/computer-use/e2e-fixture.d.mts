import type { BrowserWindowConstructorOptions } from 'electron';
import type { CuE2eScenario } from './e2e-scenarios.mjs';

interface FixtureWindow {
  id: number;
  isDestroyed(): boolean;
  destroy(): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  getContentBounds(): { x: number; y: number; width: number; height: number };
  showInactive(): void;
  moveTop(): void;
  setMenuBarVisibility(visible: boolean): void;
  loadURL(url: string): Promise<void>;
  webContents: {
    executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;
  };
}

export function createCuE2eFixture(input: {
  BrowserWindow: new (options: BrowserWindowConstructorOptions) => FixtureWindow;
  screen: {
    getPrimaryDisplay(): {
      workArea: { x: number; y: number; width: number; height: number };
    };
  };
  scenario: CuE2eScenario;
}): Promise<{
  scenario: CuE2eScenario;
  staleWindowIds: readonly number[];
  windowIds(): string[];
  getWindow(windowId: string): FixtureWindow;
  getWindowTitle(windowId: string): string;
  readState(windowId: string): Promise<unknown>;
  readAllStates(): Promise<Record<string, unknown>>;
  elementScreenRect(
    windowId: string,
    selector: string,
  ): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  elementScreenPoint(windowId: string, selector: string): Promise<{ x: number; y: number }>;
  destroy(): void;
}>;
