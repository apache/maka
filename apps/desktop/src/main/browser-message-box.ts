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
import type {
  BrowserWindow,
  MessageBoxOptions,
  MessageBoxReturnValue,
  Rectangle,
} from 'electron';

const RESPONSE_URL_PREFIX = 'maka-dialog://response/';
const DIALOG_WIDTH = 520;
const INITIAL_HEIGHT = 600;
const MIN_HEIGHT = 280;
const WORK_AREA_MARGIN = 32;
// Same traced brand outline as packages/ui/src/maka-wordmark.tsx. This startup
// surface deliberately cannot depend on the main React renderer bundle.
const MAKA_WORDMARK_PATH =
  'M2639 1187 c-38 -29 -39 -46 -39 -479 0 -400 1 -425 19 -455 23 -37 68 -50 108 -31 41 20 53 53 53 154 0 83 2 92 25 114 l24 23 143 -138 c79 -75 156 -143 171 -151 57 -30 127 14 127 79 0 32 -39 75 -217 238 l-82 75 130 103 c157 125 173 152 123 210 -21 25 -34 31 -65 31 -35 0 -55 -13 -209 -140 l-170 -139 0 229 0 228 -26 31 c-20 24 -34 31 -62 31 -21 0 -44 -6 -53 -13z M1926 969 c-109 -26 -216 -114 -264 -217 -24 -50 -27 -69 -27 -162 0 -95 3 -111 28 -162 39 -79 104 -143 185 -181 62 -29 75 -32 168 -32 94 0 105 2 164 33 35 18 64 31 64 30 18 -50 63 -74 111 -58 57 19 60 32 57 258 -2 176 -6 211 -23 258 -24 63 -100 151 -163 188 -84 49 -205 67 -300 45z m142 -170 c93 -20 171 -113 172 -205 0 -58 -45 -140 -97 -177 -112 -80 -278 -26 -328 107 -43 112 34 247 158 276 45 11 41 11 95 -1z M547 960 c-105 -18 -200 -90 -248 -187 -23 -45 -24 -60 -27 -268 -2 -120 -1 -229 3 -242 7 -30 58 -56 94 -48 16 3 38 16 49 28 19 20 21 36 24 227 3 226 8 248 69 290 69 50 157 44 215 -14 46 -46 54 -88 54 -297 0 -179 1 -186 23 -207 43 -40 100 -37 134 7 9 11 12 71 13 201 0 102 5 202 10 222 32 114 172 160 264 87 55 -44 60 -66 61 -284 1 -110 5 -208 9 -218 13 -27 63 -49 97 -42 16 4 38 18 49 32 19 24 20 40 20 228 0 224 -8 268 -61 348 -60 90 -158 139 -280 139 -62 1 -88 -4 -135 -26 -33 -15 -71 -38 -85 -52 l-27 -26 -50 36 c-82 60 -179 83 -275 66z M3659 960 c-137 -23 -264 -138 -299 -268 -53 -202 61 -407 260 -466 102 -30 242 -14 304 35 15 12 28 20 29 18 1 -2 7 -13 13 -24 26 -48 94 -55 135 -14 19 19 20 30 17 237 -3 214 -3 218 -31 273 -50 103 -163 186 -282 208 -65 12 -79 12 -146 1z m114 -201 c33 -65 48 -81 107 -112 59 -31 61 -49 10 -72 -52 -24 -93 -70 -115 -131 -10 -27 -24 -56 -32 -64 -11 -12 -15 -12 -26 0 -8 8 -19 35 -26 59 -14 48 -67 110 -121 139 -19 10 -35 25 -35 33 0 7 21 23 46 35 52 25 106 82 115 122 8 34 24 54 38 49 6 -2 23 -28 39 -58z';

/**
 * Product-styled replacement for Electron's native MessageBox.
 *
 * BrowserWindow can fail for exactly the class of failures these dialogs
 * report, so the native MessageBox remains the last-resort fallback. A truly
 * pre-ready caller also falls back because BrowserWindow is unavailable by
 * Electron contract; current startup callers wait for ready when they can.
 */
export async function showBrowserMessageBox(
  options: MessageBoxOptions,
  parent?: BrowserWindow,
): Promise<MessageBoxReturnValue> {
  // Keep the presentation helpers importable under plain `node --test`.
  // Electron itself is only required when a dialog is actually presented.
  const electron = await import('electron');
  const visibleParent =
    parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()
      ? parent
      : undefined;
  if (!electron.app.isReady()) return showNativeMessageBox(electron, options, visibleParent);
  try {
    return await presentBrowserMessageBox(electron, options, visibleParent);
  } catch (error) {
    console.error('[dialog] BrowserWindow presentation failed; using native fallback:', error);
    return showNativeMessageBox(electron, options, visibleParent);
  }
}

async function showNativeMessageBox(
  electron: typeof import('electron'),
  options: MessageBoxOptions,
  parent: BrowserWindow | undefined,
): Promise<MessageBoxReturnValue> {
  return parent &&
    !parent.isDestroyed() &&
    parent.isVisible() &&
    !parent.isMinimized()
    ? electron.dialog.showMessageBox(parent, options)
    : electron.dialog.showMessageBox(options);
}

async function presentBrowserMessageBox(
  electron: typeof import('electron'),
  options: MessageBoxOptions,
  parent: BrowserWindow | undefined,
): Promise<MessageBoxReturnValue> {
  const presentation = normalizeBrowserMessageBoxPresentation(
    options,
    electron.nativeTheme.shouldUseDarkColors,
  );
  const workArea = resolveWorkArea(electron, parent);
  const width = Math.max(320, Math.min(DIALOG_WIDTH, workArea.width - WORK_AREA_MARGIN * 2));
  const initialHeight = Math.max(
    MIN_HEIGHT,
    Math.min(INITIAL_HEIGHT, workArea.height - WORK_AREA_MARGIN * 2),
  );
  const initialBounds = centeredBounds(parent?.getBounds(), workArea, width, initialHeight);
  const win = new electron.BrowserWindow({
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
      const finish = (response: number): void => {
        if (settled) return;
        settled = true;
        resolve({ response, checkboxChecked: false });
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };

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
            buildBrowserMessageBoxHtml(presentation),
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
        })
        .catch(fail);
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

export interface BrowserMessageBoxPresentation {
  readonly type: 'none' | 'info' | 'warning' | 'error' | 'question';
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly string[];
  readonly defaultId: number;
  readonly cancelId: number;
  readonly dark: boolean;
  readonly isChinese: boolean;
}

export function normalizeBrowserMessageBoxPresentation(
  options: MessageBoxOptions,
  dark: boolean,
): BrowserMessageBoxPresentation {
  const buttons = options.buttons?.length ? [...options.buttons] : ['OK'];
  const cancelId = validButtonId(options.cancelId, buttons.length)
    ? options.cancelId
    : buttons.length - 1;
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
    dark,
    isChinese: /\p{Script=Han}/u.test(`${title}${message}`),
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

export function buildBrowserMessageBoxHtml(input: BrowserMessageBoxPresentation): string {
  const nonce = randomUUID().replaceAll('-', '');
  const closeLabel = input.isChinese ? '关闭' : 'Close';
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
<html lang="${input.isChinese ? 'zh-CN' : 'en'}" data-theme="${input.dark ? 'dark' : 'light'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(input.title)}</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light;
      --background: oklch(1 0 0);
      --surface-overlay: var(--background);
      --foreground: oklch(0.17 0.005 286);
      --foreground-secondary: color-mix(in oklch, var(--foreground) 74%, var(--background));
      --muted-foreground: color-mix(in oklch, var(--foreground) 54%, var(--background));
      --foreground-3: color-mix(in oklch, var(--foreground) 3%, var(--background));
      --neutral: oklch(from var(--foreground) l c h / 0.06);
      --state-hover-bg: oklch(from var(--foreground) l c h / 0.04);
      --border-soft: oklch(from var(--foreground) l c h / 0.06);
      --border-strong: oklch(from var(--foreground) l c h / 0.16);
      --accent: oklch(0.70 0.135 250);
      --accent-solid: oklch(from var(--accent) 0.52 c h);
      --on-accent: #fff;
      --info: oklch(0.50 0.13 240);
      --warning: oklch(0.50 0.18 55);
      --destructive: oklch(0.50 0.24 28);
      --elevation-overlay: 0 2px 4px oklch(0 0 0 / 0.05), 0 4px 12px oklch(0 0 0 / 0.10);
      --control-overlay-hover: oklch(0 0 0 / 0.05);
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --background: oklch(0.205 0.004 286);
      --surface-overlay: oklch(from var(--background) calc(l + 0.018) c h);
      --foreground: oklch(0.95 0.004 286);
      --foreground-secondary: color-mix(in oklch, var(--foreground) 78%, var(--background));
      --accent: oklch(0.74 0.15 250);
      --accent-solid: oklch(from var(--accent) 0.76 c h);
      --on-accent: #171717;
      --info: oklch(0.74 0.13 240);
      --warning: oklch(0.66 0.18 55);
      --destructive: oklch(0.70 0.19 22);
      --elevation-overlay: 0 2px 4px oklch(0 0 0 / 0.35), 0 4px 12px oklch(0 0 0 / 0.50), inset 0 0 0 1px oklch(1 0 0 / 0.08);
      --control-overlay-hover: oklch(1 0 0 / 0.05);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: transparent; }
    body {
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Microsoft YaHei UI", "Noto Sans CJK SC", "Noto Sans SC", "WenQuanYi Micro Hei", "Source Han Sans SC", "Geist Variable", sans-serif;
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
      border-radius: 12px;
      background: var(--surface-overlay);
      box-shadow: var(--elevation-overlay);
      animation: dialog-enter 300ms cubic-bezier(.2, 0, 0, 1) backwards;
    }
    body.maka-dialog-constrained .card {
      height: calc(100vh - 32px);
      min-height: calc(100vh - 32px);
    }
    .drag-region {
      height: 48px;
      flex: 0 0 48px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 8px 0 24px;
      -webkit-app-region: drag;
    }
    .wordmark {
      width: 68px;
      height: auto;
      color: #71a8fd;
    }
    button { font: inherit; }
    .window-close {
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: 10px;
      background: transparent;
      color: var(--muted-foreground);
      cursor: pointer;
      -webkit-app-region: no-drag;
    }
    .window-close svg {
      width: 16px;
      height: 16px;
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
      padding: 16px 24px 20px;
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
      gap: 12px;
    }
    .icon {
      width: 32px;
      height: 32px;
      flex: 0 0 32px;
      display: grid;
      place-items: center;
      border-radius: 27%;
      color: var(--info);
      background: oklch(from var(--info) l c h / 0.08);
      box-shadow: inset 0 0 0 1px oklch(from var(--info) l c h / 0.24);
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
      background: oklch(from var(--warning) l c h / 0.08);
      box-shadow: inset 0 0 0 1px oklch(from var(--warning) l c h / 0.24);
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
      font-size: 18px;
      line-height: 28px;
      font-weight: 600;
    }
    .message {
      margin-top: 4px;
      color: var(--foreground-secondary);
      font-size: 14px;
      line-height: 20px;
      white-space: pre-wrap;
      user-select: text;
    }
    .detail {
      margin-top: 20px;
      padding: 12px;
      border-radius: 10px;
      background: var(--foreground-3);
      color: var(--foreground-secondary);
      font-size: 14px;
      line-height: 20px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
    }
    .actions {
      flex: 0 0 auto;
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 16px 16px;
    }
    .decision {
      height: 32px;
      padding: 6px 12px;
      border: 0;
      border-radius: 10px;
      color: var(--foreground);
      font-size: 14px;
      line-height: 20px;
      font-weight: 500;
      white-space: nowrap;
      cursor: pointer;
      transition: opacity 125ms ease, transform 125ms ease;
      -webkit-app-region: no-drag;
    }
    .decision:hover { background-image: linear-gradient(var(--control-overlay-hover), var(--control-overlay-hover)); }
    .decision:active { transform: scale(.98); }
    .decision.primary { background-color: var(--accent-solid); color: var(--on-accent); }
    .decision.secondary { background-color: var(--neutral); }
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
