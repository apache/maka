/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAKA_WORDMARK_PATH } from '@maka/core/maka-wordmark';
import { isThemePalette, type ThemePalette } from '@maka/core/settings';
import type { UiLocale } from '@maka/core/ui-locale';
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  MessageBoxOptions,
  MessageBoxReturnValue,
  Rectangle,
} from 'electron';
import { resolveOverlayAssetDir } from './overlay-assets.js';

const RESPONSE_URL_PREFIX = 'maka-dialog://response/';
const DIALOG_WIDTH = 520;
const INITIAL_HEIGHT = 600;
const MIN_HEIGHT = 280;
const WORK_AREA_MARGIN = 32;
const DIALOG_PRESENTATION_TIMEOUT_MS = 30_000;
const DIALOG_DESIGN_TOKENS_FILE = 'browser-dialog-design-tokens.css';
let cachedDialogDesignTokens: string | undefined;
let activeBrowserMessageBoxPresentations = 0;

export interface BrowserMessageBoxAppearance {
  readonly locale: UiLocale;
  readonly palette?: ThemePalette;
  readonly dark?: boolean;
}

export interface BrowserMessageBoxRuntime {
  readonly shouldUseDarkColors: boolean;
  readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  readonly resolveWorkArea: (parent: BrowserWindow | undefined) => Rectangle;
  readonly showNative: (
    options: MessageBoxOptions,
    parent: BrowserWindow | undefined,
  ) => Promise<MessageBoxReturnValue>;
  readonly onBrowserError: (error: unknown) => void;
  readonly presentationTimeoutMs?: number;
}

/** Whether closing a temporary dialog must not be interpreted as app shutdown. */
export function isBrowserMessageBoxPresentationActive(): boolean {
  return activeBrowserMessageBoxPresentations > 0;
}

/**
 * Product-styled replacement for Electron's native MessageBox.
 *
 * BrowserWindow can fail for exactly the class of failures these dialogs
 * report, so the native MessageBox remains the last-resort fallback.
 */
export async function showBrowserMessageBox(
  options: MessageBoxOptions,
  parent: BrowserWindow | undefined,
  appearance: BrowserMessageBoxAppearance,
): Promise<MessageBoxReturnValue> {
  // Keep the presentation helpers importable under plain `node --test`.
  // Electron itself is only required when a dialog is actually presented.
  const electron = await import('electron');
  return showBrowserMessageBoxWithRuntime(options, parent, appearance, {
    shouldUseDarkColors: electron.nativeTheme.shouldUseDarkColors,
    createWindow: (windowOptions) => new electron.BrowserWindow(windowOptions),
    resolveWorkArea: (nextParent) => resolveWorkArea(electron, nextParent),
    showNative: (nextOptions, nextParent) =>
      showNativeMessageBox(electron, nextOptions, nextParent),
    onBrowserError: (error) => {
      console.error('[dialog] BrowserWindow presentation failed; using native fallback:', error);
    },
  });
}

export async function showBrowserMessageBoxWithRuntime(
  options: MessageBoxOptions,
  parent: BrowserWindow | undefined,
  appearance: BrowserMessageBoxAppearance,
  runtime: BrowserMessageBoxRuntime,
): Promise<MessageBoxReturnValue> {
  activeBrowserMessageBoxPresentations += 1;
  try {
    const visibleParent = (): BrowserWindow | undefined =>
      parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()
        ? parent
        : undefined;
    try {
      return await presentBrowserMessageBox(runtime, options, visibleParent(), appearance);
    } catch (error) {
      runtime.onBrowserError(error);
      return await runtime.showNative(options, visibleParent());
    }
  } finally {
    activeBrowserMessageBoxPresentations -= 1;
  }
}

async function showNativeMessageBox(
  electron: typeof import('electron'),
  options: MessageBoxOptions,
  parent: BrowserWindow | undefined,
): Promise<MessageBoxReturnValue> {
  return parent
    ? electron.dialog.showMessageBox(parent, options)
    : electron.dialog.showMessageBox(options);
}

async function presentBrowserMessageBox(
  runtime: BrowserMessageBoxRuntime,
  options: MessageBoxOptions,
  parent: BrowserWindow | undefined,
  appearance: BrowserMessageBoxAppearance,
): Promise<MessageBoxReturnValue> {
  const presentation = normalizeBrowserMessageBoxPresentation(options, {
    ...appearance,
    dark: appearance.dark ?? runtime.shouldUseDarkColors,
  });
  const workArea = runtime.resolveWorkArea(parent);
  const width = Math.max(320, Math.min(DIALOG_WIDTH, workArea.width - WORK_AREA_MARGIN * 2));
  const initialHeight = Math.max(
    MIN_HEIGHT,
    Math.min(INITIAL_HEIGHT, workArea.height - WORK_AREA_MARGIN * 2),
  );
  const initialBounds = centeredBounds(parent?.getBounds(), workArea, width, initialHeight);
  const win = runtime.createWindow({
    ...initialBounds,
    title: presentation.title,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    roundedCorners: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    ...(parent ? { parent, modal: true, skipTaskbar: true } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  try {
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    return await new Promise<MessageBoxReturnValue>((resolve, reject) => {
      let settled = false;
      let presentationTimeout: ReturnType<typeof setTimeout> | undefined;
      const clearPresentationTimeout = (): void => {
        if (!presentationTimeout) return;
        clearTimeout(presentationTimeout);
        presentationTimeout = undefined;
      };
      const finish = (response: number): void => {
        if (settled) return;
        settled = true;
        clearPresentationTimeout();
        resolve({ response, checkboxChecked: false });
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearPresentationTimeout();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      presentationTimeout = setTimeout(
        () => fail(new Error('Dialog renderer did not become interactive in time')),
        runtime.presentationTimeoutMs ?? DIALOG_PRESENTATION_TIMEOUT_MS,
      );

      win.on('closed', () => finish(presentation.cancelId));
      win.on('unresponsive', () => fail(new Error('Dialog renderer became unresponsive')));
      win.webContents.on('render-process-gone', (_event, details) => {
        fail(new Error(`Dialog renderer exited: ${details.reason}`));
      });
      win.webContents.on('will-navigate', (event, url) => {
        const response = parseBrowserMessageBoxResponse(url, presentation.buttons.length);
        event.preventDefault();
        if (response !== undefined) finish(response);
      });
      void win
        .loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(
            renderBrowserMessageBoxHtml(presentation),
          )}`,
        )
        .then(async () => {
          if (settled || win.isDestroyed()) return;
          const naturalHeight = await measureDialogHeight(win).catch(() => initialHeight);
          const height = Math.max(
            MIN_HEIGHT,
            Math.min(naturalHeight, workArea.height - WORK_AREA_MARGIN * 2),
          );
          win.setBounds(centeredBounds(parent?.getBounds(), workArea, width, height), false);
          await win.webContents.executeJavaScript(
            "document.body.classList.add('maka-dialog-constrained')",
            true,
          );
          if (settled || win.isDestroyed()) return;
          win.show();
          win.focus();
          clearPresentationTimeout();
        })
        .catch(fail);
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

interface BrowserMessageBoxPresentation {
  readonly type: 'none' | 'info' | 'warning' | 'error' | 'question';
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly string[];
  readonly defaultId: number;
  readonly cancelId: number;
  readonly dark: boolean;
  readonly locale: UiLocale;
  readonly palette: ThemePalette;
}

function normalizeBrowserMessageBoxPresentation(
  options: MessageBoxOptions,
  appearance: BrowserMessageBoxAppearance & { readonly dark: boolean },
): BrowserMessageBoxPresentation {
  const buttons = options.buttons?.length ? [...options.buttons] : ['OK'];
  const cancelId = validButtonId(options.cancelId, buttons.length) ? options.cancelId : 0;
  const defaultId = validButtonId(options.defaultId, buttons.length)
    ? options.defaultId
    : 0;
  const title = options.title || 'Maka';
  const message = options.message || title;
  return {
    type: messageBoxType(options.type),
    title,
    message,
    detail: options.detail ?? '',
    buttons,
    defaultId,
    cancelId,
    dark: appearance.dark,
    locale: appearance.locale,
    palette: isThemePalette(appearance.palette) ? appearance.palette : 'default',
  };
}

function validButtonId(value: number | undefined, count: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < count;
}

function resolveWorkArea(
  electron: typeof import('electron'),
  parent: BrowserWindow | undefined,
): Rectangle {
  if (parent && !parent.isDestroyed()) {
    return electron.screen.getDisplayMatching(parent.getBounds()).workArea;
  }
  return electron.screen.getPrimaryDisplay().workArea;
}

export function centeredBounds(
  parentBounds: Rectangle | undefined,
  workArea: Rectangle,
  width: number,
  height: number,
): Rectangle {
  const anchor = parentBounds ?? workArea;
  const preferredX = Math.round(anchor.x + (anchor.width - width) / 2);
  const preferredY = Math.round(anchor.y + (anchor.height - height) / 2);
  return {
    x: clamp(preferredX, workArea.x, workArea.x + workArea.width - width),
    y: clamp(preferredY, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

async function measureDialogHeight(win: BrowserWindow): Promise<number> {
  const measured: unknown = await win.webContents.executeJavaScript(
    "Math.ceil((document.querySelector('.card')?.scrollHeight ?? 0) + 32)",
    true,
  );
  return typeof measured === 'number' && Number.isFinite(measured)
    ? Math.ceil(measured)
    : INITIAL_HEIGHT;
}

function dialogDesignTokens(): string {
  cachedDialogDesignTokens ??= readFileSync(
    join(resolveOverlayAssetDir(import.meta.url), DIALOG_DESIGN_TOKENS_FILE),
    'utf8',
  );
  return cachedDialogDesignTokens;
}

export function parseBrowserMessageBoxResponse(
  value: string,
  buttonCount: number,
): number | undefined {
  if (!value.startsWith(RESPONSE_URL_PREFIX)) return undefined;
  const encodedResponse = value.slice(RESPONSE_URL_PREFIX.length);
  if (!/^(?:0|[1-9]\d*)$/u.test(encodedResponse)) return undefined;
  const response = Number(encodedResponse);
  return Number.isInteger(response) && response >= 0 && response < buttonCount
    ? response
    : undefined;
}

export function buildBrowserMessageBoxHtml(
  options: MessageBoxOptions,
  appearance: BrowserMessageBoxAppearance & { readonly dark: boolean },
): string {
  return renderBrowserMessageBoxHtml(
    normalizeBrowserMessageBoxPresentation(options, appearance),
  );
}

function renderBrowserMessageBoxHtml(input: BrowserMessageBoxPresentation): string {
  const nonce = randomUUID().replaceAll('-', '');
  const closeLabel = input.locale === 'zh-CN' ? '关闭' : input.locale === 'zh-TW' ? '關閉' : 'Close';
  const closeButton = `<button class="window-close" type="button" data-response="${input.cancelId}" aria-label="${closeLabel}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
  </button>`;
  const buttons = input.buttons
    .map((label, index) => ({ label, index }))
    .sort((left, right) => {
      const rank = (index: number): number =>
        index === input.defaultId ? 2 : index === input.cancelId ? 0 : 1;
      return rank(left.index) - rank(right.index);
    })
    .map(({ label, index }) => {
      const classes = [
        'decision',
        index === input.defaultId
          ? 'primary'
          : index === input.cancelId
            ? 'ghost'
            : 'secondary',
      ]
        .filter(Boolean)
        .join(' ');
      return `<button class="${classes}" type="button" data-response="${index}"${
        index === input.defaultId ? ' autofocus' : ''
      }>${escapeHtml(label)}</button>`;
    })
    .join('');
  const detailBlock = input.detail
    ? `<div class="detail" data-testid="dialog-detail">${escapeHtml(input.detail)}</div>`
    : '';
  const statusIcon =
    input.type === 'question'
      ? '<path d="M9.1 9a3 3 0 1 1 5.1 2.1c-1.2 1.1-2.2 1.6-2.2 3.4M12 18h.01" />'
      : input.type === 'info' || input.type === 'none'
        ? '<path d="M12 11v5M12 8h.01" />'
        : '<path d="M12 8v5M12 17h.01" />';

  return `<!doctype html>
<html lang="${input.locale}" data-theme="${input.dark ? 'dark' : 'light'}" data-maka-theme="${input.palette}" data-astryx-theme="maka" class="${input.dark ? 'dark' : ''}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(input.title)}</title>
  <style nonce="${nonce}">
    ${dialogDesignTokens()}
    * { box-sizing: border-box; }
    html, body { margin: 0; background: transparent; }
    body {
      padding: var(--space-4);
      font-family: var(--font-family-body);
      color: var(--foreground);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      user-select: none;
    }
    body.maka-dialog-constrained { height: 100vh; overflow: hidden; }
    .card {
      width: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--border-soft);
      border-radius: var(--radius-container);
      background: var(--surface-overlay);
      box-shadow: var(--elevation-overlay);
      animation: dialog-enter var(--duration-medium) var(--ease-out-strong) backwards;
    }
    body.maka-dialog-constrained .card {
      height: calc(100vh - var(--space-8));
      min-height: calc(100vh - var(--space-8));
    }
    .drag-region {
      height: var(--space-12);
      flex: 0 0 var(--space-12);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-2) var(--space-2) 0 var(--space-6);
      -webkit-app-region: drag;
    }
    .wordmark {
      width: 68px;
      height: auto;
      color: var(--maka-brand);
    }
    button { font: inherit; }
    .window-close {
      width: var(--space-8);
      height: var(--space-8);
      display: grid;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: var(--radius-element);
      background: transparent;
      color: var(--muted-foreground);
      cursor: pointer;
      -webkit-app-region: no-drag;
    }
    .window-close svg {
      width: var(--space-4);
      height: var(--space-4);
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
    }
    .window-close:hover { background: var(--state-hover-bg); color: var(--foreground); }
    .window-close:focus-visible,
    .decision:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .content {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      padding: var(--space-4) var(--space-6) var(--space-5);
      scrollbar-width: thin;
      scrollbar-color: var(--border-strong) transparent;
    }
    .content::-webkit-scrollbar { width: 10px; }
    .content::-webkit-scrollbar-track { background: transparent; }
    .content::-webkit-scrollbar-thumb {
      border: 2px solid transparent;
      border-radius: 999px;
      background: var(--border-strong);
      background-clip: content-box;
    }
    .heading-row {
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
    }
    .icon {
      width: var(--space-8);
      height: var(--space-8);
      flex: 0 0 var(--space-8);
      display: grid;
      place-items: center;
      border-radius: 27%;
      color: var(--info);
      background: var(--info-wash);
      box-shadow: inset 0 0 0 1px var(--info-wash-border);
    }
    .icon svg {
      width: 18px;
      height: 18px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .warning .icon {
      color: var(--warning);
      background: var(--warning-wash);
      box-shadow: inset 0 0 0 1px var(--warning-wash-border);
    }
    .error .icon {
      color: var(--destructive);
      background: oklch(from var(--destructive) l c h / 0.08);
      box-shadow: inset 0 0 0 1px oklch(from var(--destructive) l c h / 0.24);
    }
    .question .icon {
      color: var(--accent-solid);
      background: oklch(from var(--accent) l c h / 0.08);
      box-shadow: inset 0 0 0 1px oklch(from var(--accent) l c h / 0.24);
    }
    .heading-copy { min-width: 0; padding-top: 1px; }
    h1 {
      margin: 0;
      font-size: var(--text-heading-2-size);
      line-height: var(--text-heading-2-leading);
      font-weight: var(--text-heading-2-weight);
    }
    .message {
      margin-top: 4px;
      color: var(--foreground-secondary);
      font-size: var(--text-body-size);
      line-height: var(--text-body-leading);
      white-space: pre-wrap;
      user-select: text;
    }
    .detail {
      margin-top: var(--space-5);
      padding: var(--space-3);
      border-radius: var(--radius-element);
      background: var(--foreground-3);
      color: var(--foreground-secondary);
      font-size: var(--text-body-size);
      line-height: var(--text-body-leading);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
    }
    .actions {
      flex: 0 0 auto;
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-4) var(--space-4);
    }
    .decision {
      height: var(--space-8);
      padding: var(--space-1-5) var(--space-3);
      border: 0;
      border-radius: var(--radius-element);
      color: var(--foreground);
      font-size: var(--text-label-size);
      line-height: var(--text-label-leading);
      font-weight: var(--text-label-weight);
      white-space: nowrap;
      cursor: pointer;
      transition: opacity var(--duration-quick) var(--ease-out-strong), transform var(--duration-quick) var(--ease-out-strong);
      -webkit-app-region: no-drag;
    }
    .decision:hover { background-image: linear-gradient(var(--color-overlay-hover), var(--color-overlay-hover)); }
    .decision:active { transform: scale(.98); }
    .decision.primary { background-color: var(--accent-solid); color: var(--color-on-accent); }
    .decision.secondary { background-color: var(--color-neutral); }
    .decision.ghost { background-color: transparent; }
    @keyframes dialog-enter {
      from { opacity: 0; transform: translateY(10px) scale(.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .card { animation: none; }
      .decision { transition: none; }
    }
  </style>
</head>
<body>
  <main class="card ${input.type}" role="alertdialog" aria-labelledby="dialog-title" aria-describedby="dialog-message">
    <div class="drag-region">
      <svg class="wordmark" viewBox="0 0 460 120" aria-hidden="true"><g transform="translate(0,120) scale(0.1,-0.1)" fill="currentColor"><path d="${MAKA_WORDMARK_PATH}" /></g></svg>
      ${closeButton}
    </div>
    <section class="content">
      <div class="heading-row">
        <div class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${statusIcon}</svg></div>
        <div class="heading-copy">
          <h1 id="dialog-title">${escapeHtml(input.title)}</h1>
          <div class="message" id="dialog-message">${escapeHtml(input.message)}</div>
        </div>
      </div>
      ${detailBlock}
    </section>
    <footer class="actions">${buttons}</footer>
  </main>
  <script nonce="${nonce}">
    const respond = (value) => window.location.assign('${RESPONSE_URL_PREFIX}' + value);
    document.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-response]') : null;
      if (button) respond(button.getAttribute('data-response'));
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        respond('${input.cancelId}');
      } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        respond('${input.defaultId}');
      }
    });
  </script>
</body>
</html>`;
}

function messageBoxType(value: MessageBoxOptions['type']): BrowserMessageBoxPresentation['type'] {
  return value === 'warning' || value === 'error' || value === 'question' || value === 'info'
    ? value
    : 'none';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });
}
