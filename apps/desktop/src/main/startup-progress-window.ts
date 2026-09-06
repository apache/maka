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
import { MAKA_WORDMARK_PATH } from '@maka/core/maka-wordmark';
import type { UiLocale } from '@maka/core/ui-locale';
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

export type StartupPhase =
  | 'prepare' | 'storage' | 'connect' | 'package'
  | 'checking' | 'staging' | 'retiring' | 'replacing' | 'restart'
  | 'attention' | 'renderer';

const COPY = {
  en: {
    title: 'Opening your workspace',
    detail: 'Maka is preparing your local background service.',
    slow: 'This is taking longer than usual. Updates may need to download or build a package. You can minimize this window while Maka continues.',
    copy: 'Copy diagnostics', copied: 'Diagnostics copied', copyFailed: 'Could not copy diagnostics',
    elapsed: 'Elapsed',
    phases: {
      prepare: 'Preparing Maka', storage: 'Checking local data', connect: 'Connecting to Runtime Host',
      package: 'Preparing the Runtime Host package', checking: 'Checking the managed service',
      staging: 'Installing the update', retiring: 'Safely stopping the previous service',
      replacing: 'Replacing the managed service', restart: 'Restarting Runtime Host',
      attention: 'Waiting for your confirmation', renderer: 'Opening your workspace',
    },
  },
  'zh-CN': {
    title: '正在打开工作区', detail: 'Maka 正在准备本地后台服务。',
    slow: '此次启动耗时较长。更新可能需要下载或构建安装包；你可以最小化此窗口，Maka 会继续处理。',
    copy: '复制诊断信息', copied: '已复制诊断信息', copyFailed: '无法复制诊断信息', elapsed: '已用时',
    phases: {
      prepare: '正在准备 Maka', storage: '正在检查本地数据', connect: '正在连接 Runtime Host',
      package: '正在准备 Runtime Host 安装包', checking: '正在检查托管服务',
      staging: '正在安装更新', retiring: '正在安全停止旧服务',
      replacing: '正在替换托管服务', restart: '正在重启 Runtime Host',
      attention: '等待你的确认', renderer: '正在打开工作区',
    },
  },
  'zh-TW': {
    title: '正在開啟工作區', detail: 'Maka 正在準備本機背景服務。',
    slow: '此次啟動耗時較長。更新可能需要下載或建置安裝套件；你可以最小化此視窗，Maka 會繼續處理。',
    copy: '複製診斷資訊', copied: '已複製診斷資訊', copyFailed: '無法複製診斷資訊', elapsed: '已用時',
    phases: {
      prepare: '正在準備 Maka', storage: '正在檢查本機資料', connect: '正在連線至 Runtime Host',
      package: '正在準備 Runtime Host 安裝套件', checking: '正在檢查託管服務',
      staging: '正在安裝更新', retiring: '正在安全停止舊服務',
      replacing: '正在替換託管服務', restart: '正在重新啟動 Runtime Host',
      attention: '等待你的確認', renderer: '正在開啟工作區',
    },
  },
} as const;

export interface StartupProgressWindow {
  update(phase: StartupPhase): void;
  focus(): void;
  close(): void;
  window(): BrowserWindow | undefined;
}

/** Presentation only: no Host client, application preload, or migration authority. */
export function createStartupProgressWindow(input: {
  locale: UiLocale;
  dark: boolean;
  icon: string;
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  copyDiagnostics(phase: StartupPhase): void | Promise<void>;
  onError(error: unknown): void;
}): StartupProgressWindow {
  const copy = COPY[input.locale];
  const win = input.createWindow({
    width: 520, height: 390, title: 'Maka', icon: input.icon,
    show: false, resizable: false, maximizable: false, fullscreenable: false,
    backgroundColor: input.dark ? '#1c1d21' : '#ffffff',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
    },
  });
  let closed = false;
  let loaded = false;
  let phase: StartupPhase = 'prepare';
  const execute = (source: string) => {
    if (!closed && loaded && !win.isDestroyed()) {
      void win.webContents.executeJavaScript(source).catch(input.onError);
    }
  };
  const publish = () => execute(
    'document.getElementById("phase").textContent = ' + JSON.stringify(copy.phases[phase]) +
    '; document.body.dataset.phase = ' + JSON.stringify(phase) + ';',
  );
  const close = () => {
    if (closed) return;
    closed = true;
    if (!win.isDestroyed()) win.destroy();
  };
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Closing the status window minimizes it; it must not terminate an update.
  win.on('close', (event) => {
    if (closed) return;
    event.preventDefault();
    win.minimize();
  });
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url !== 'maka-startup://copy') return;
    void Promise.resolve().then(() => input.copyDiagnostics(phase)).then(
      () => execute('document.getElementById("copy").textContent = ' + JSON.stringify(copy.copied)),
      (error) => {
        input.onError(error);
        execute('document.getElementById("copy").textContent = ' + JSON.stringify(copy.copyFailed));
      },
    );
  });
  win.webContents.on('will-redirect', (event) => event.preventDefault());
  win.webContents.on('render-process-gone', (_event, details) => {
    input.onError(new Error('Startup renderer exited: ' + details.reason));
    close();
  });
  // No await: failure to present progress must never block Host recovery.
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    renderStartupProgressHtml(input.locale, input.dark),
  )).then(() => {
    if (closed || win.isDestroyed()) return;
    loaded = true;
    publish();
    // A confirmation may already be open; never raise progress above it.
    win.showInactive();
  }).catch((error) => {
    input.onError(error);
    close();
  });
  return {
    update(next) { phase = next; publish(); },
    focus() {
      if (closed || !loaded || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
    close,
    window: () => closed || win.isDestroyed() ? undefined : win,
  };
}

export function renderStartupProgressHtml(locale: UiLocale, dark: boolean): string {
  const copy = COPY[locale];
  const nonce = randomUUID().replaceAll('-', '');
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
<title>Maka</title><style nonce="${nonce}">
:root { color-scheme: ${dark ? 'dark' : 'light'}; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: ${dark ? '#1c1d21' : '#fff'}; color: ${dark ? '#f1f1f3' : '#202127'}; }
* { box-sizing: border-box; } body { margin: 0; padding: 30px 36px; }
svg { width: 94px; height: 30px; fill: currentColor; } h1 { margin: 24px 0 6px; font-size: 21px; font-weight: 600; letter-spacing: -.4px; }
p { margin: 0; opacity: .65; } .status { display: flex; gap: 10px; align-items: center; margin-top: 26px; }
.spinner { width: 15px; height: 15px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; opacity: .6; flex-shrink: 0; }
#slow { margin-top: 12px; font-size: 12px; min-height: 54px; visibility: hidden; }
body[data-phase="attention"] #slow { visibility: hidden !important; }
body[data-phase="attention"] .spinner { animation: none; }
footer { display: flex; justify-content: space-between; align-items: center; margin-top: 18px; font-size: 12px; }
#elapsed { opacity: .55; font-variant-numeric: tabular-nums; }
button { font: inherit; color: inherit; background: transparent; border: 1px solid ${dark ? '#48494f' : '#dedee3'}; border-radius: 7px; padding: 6px 10px; cursor: pointer; }
button:hover { background: ${dark ? '#303137' : '#f4f4f6'}; } button:focus-visible { outline: 2px solid #788aff; outline-offset: 3px; }
@keyframes spin { to { transform: rotate(360deg); } } @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style></head><body>
<svg viewBox="0 0 460 120" role="img" aria-label="Maka"><g transform="translate(0,120) scale(0.1,-0.1)"><path d="${MAKA_WORDMARK_PATH}"/></g></svg>
<h1>${copy.title}</h1><p>${copy.detail}</p>
<div class="status" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span id="phase">${copy.phases.prepare}</span></div>
<p id="slow">${copy.slow}</p>
<footer><span id="elapsed"></span><button id="copy">${copy.copy}</button></footer>
<script nonce="${nonce}">
const started = performance.now();
setInterval(() => {
  const seconds = Math.floor((performance.now() - started) / 1000);
  document.getElementById('elapsed').textContent = ${JSON.stringify(copy.elapsed)} + ' ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  if (seconds >= 20) document.getElementById('slow').style.visibility = 'visible';
}, 1000);
document.getElementById('copy').addEventListener('click', () => { location.href = 'maka-startup://copy'; });
</script></body></html>`;
}
