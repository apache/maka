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

import { Page } from '@jackwener/opencli/browser/page';
import type { WebContents } from 'electron';
import type { AppSettings } from '@maka/core/settings';
import type { DesktopAssistantAction, DesktopAssistantSnapshot } from '../shared/desktop-assistant.js';

const attr = 'data-maka-assistant-target';
const selector = (target: string) => `[${attr}=${JSON.stringify(target)}]`;
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(finish, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
});

/** OpenCLI's AX formatter, transported directly to this window; no daemon or navigation. */
class WindowPage extends Page {
  constructor(private readonly contents: WebContents) { super('maka-assistant'); }
  override async getCurrentUrl() { return this.contents.getURL(); }
  override async cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === 'Page.getFrameTree') return {};
    if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3');
    if (method !== 'Accessibility.getFullAXTree') return this.contents.debugger.sendCommand(method, params);
    const { root } = await this.contents.debugger.sendCommand('DOM.getDocument', { depth: -1 });
    const allowed = new Set<number>();
    const visit = (node: { backendNodeId: number; attributes?: string[]; children?: typeof node[] }, safe = false) => {
      const attrs = node.attributes ?? [];
      const at = attrs.indexOf(attr);
      const target = at < 0 ? '' : attrs[at + 1] ?? '';
      safe ||= target === 'language' || target.startsWith('displayName.') || target.startsWith('theme.') || target.startsWith('settings.');
      if (safe) allowed.add(node.backendNodeId);
      for (const child of node.children ?? []) visit(child, safe);
    };
    visit(root);
    const result = await this.contents.debugger.sendCommand(method, params);
    // Only app-owned navigation and preference controls are sent to the model.
    // Transcript, credentials, webviews, and the assistant itself are omitted.
    const nodes = result.nodes.filter((node: { backendDOMNodeId?: number; ignored?: boolean }) => !node.ignored && allowed.has(node.backendDOMNodeId ?? -1));
    const childIds = new Set(nodes.flatMap((node: { childIds?: string[] }) => node.childIds ?? []));
    return { nodes: [{ nodeId: 'maka-safe-root', role: { value: 'RootWebArea' }, name: { value: 'Maka controls' }, childIds: nodes.filter((node: { nodeId: string }) => !childIds.has(node.nodeId)).map((node: { nodeId: string }) => node.nodeId) }, ...nodes] };
  }
}

export class DesktopAssistantUi {
  constructor(
    private readonly window: () => WebContents,
    private readonly readSettings: () => Promise<AppSettings>,
    private readonly update: (patch: Partial<DesktopAssistantSnapshot>) => void,
    private readonly readDisplayName: () => Promise<string>,
  ) {}

  async begin(signal: AbortSignal) {
    signal.throwIfAborted();
    const origin = await this.window().executeJavaScript(`(() => {
      const r = document.querySelector('.desktopAssistant')?.getBoundingClientRect();
      return { x: Math.round(r ? r.x + r.width / 2 : innerWidth / 2), y: Math.round(r ? r.y : innerHeight - 80) };
    })()`);
    this.update({ cursor: { ...origin, clicking: false } });
    await delay(80, signal);
  }

  async observe() {
    const wc = this.window();
    const page = new WindowPage(wc);
    const accessibility = await page.snapshot({ source: 'ax' });
    const settings = await this.readSettings();
    const section = await wc.executeJavaScript(`document.querySelector('[data-maka-assistant-section]')?.getAttribute('data-maka-assistant-section') ?? null`);
    return { section, language: settings.personalization.uiLocale, theme: settings.appearance.theme, accessibility };
  }

  async visual() {
    const wc = this.window();
    const rect = await wc.executeJavaScript(`(() => {
      const e = document.querySelector('[data-maka-assistant-target="language"]') ?? document.querySelector('[data-maka-assistant-target^="theme."]');
      if (!e) throw new Error('Open language or appearance settings before requesting visual context');
      const r = e.getBoundingClientRect();
      if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) throw new Error('Preference control is outside the viewport');
      for (const fx of [0.05, 0.5, 0.95]) for (const fy of [0.05, 0.5, 0.95]) {
        if (!e.contains(document.elementFromPoint(r.x + r.width * fx, r.y + r.height * fy))) throw new Error('Preference control is covered; visual context is unavailable');
      }
      return { x: Math.ceil(r.x), y: Math.ceil(r.y), width: Math.floor(r.width), height: Math.floor(r.height) };
    })()`);
    if (rect.width < 1 || rect.height < 1 || rect.x < 0 || rect.y < 0) throw new Error('Preference control is not visible');
    return (await wc.capturePage(rect)).toPNG().toString('base64');
  }

  async execute(action: DesktopAssistantAction, signal: AbortSignal) {
    const section = action.kind === 'navigate' ? action.section : action.target === 'theme' ? 'appearance' : 'general';
    const wc = this.window();
    const opened = await wc.executeJavaScript(`!!document.querySelector('[data-maka-assistant-section]')`);
    if (!opened) {
      if (!await this.point(selector('settings.open'))) {
        await this.click('[data-maka-contract="shell-topbar-rail"] button[aria-expanded="false"]', signal);
      }
      await this.click(selector('settings.open'), signal);
    }
    await this.click(selector(`settings.${section}`), signal);
    await this.waitFor(async () => await wc.executeJavaScript(`document.querySelector('[data-maka-assistant-section]')?.getAttribute('data-maka-assistant-section')`) === section, signal);
    if (action.kind === 'navigate') return { verified: true, section };
    const before = await this.readSettings();
    if (action.target === 'displayName') {
      const previous = await this.readDisplayName();
      if (previous === action.value) return { verified: true, target: action.target, value: action.value, previous };
      await this.click(selector('displayName.edit'), signal);
      await this.type(`${selector('displayName.input')} input`, action.value, signal);
      await this.click(selector('displayName.save'), signal);
      await this.waitFor(async () => await this.readDisplayName() === action.value, signal);
      return { verified: true, target: action.target, value: action.value, previous };
    }
    if (action.target === 'theme') await this.click(selector(`theme.${action.value}`), signal);
    else {
      const trigger = `${selector('language')} [role="combobox"]`;
      await this.click(trigger, signal);
      const index = ['auto', 'zh-CN', 'zh-TW', 'en'].indexOf(action.value);
      // The list belongs to this combobox, not an arbitrary popup elsewhere.
      const listId: string = await wc.executeJavaScript(`document.querySelector(${JSON.stringify(trigger)})?.getAttribute('aria-controls')`);
      if (!listId) throw new Error('Language control did not open');
      await this.click(`[id=${JSON.stringify(listId)}] [role="option"]:nth-of-type(${index + 1})`, signal);
    }
    await this.waitFor(async () => {
      const saved = await this.readSettings();
      return (action.target === 'language' ? saved.personalization.uiLocale : saved.appearance.theme) === action.value;
    }, signal);
    return { verified: true, target: action.target, value: action.value, previous: action.target === 'language' ? before.personalization.uiLocale : before.appearance.theme };
  }

  private async type(css: string, text: string, signal: AbortSignal) {
    await this.click(css, signal);
    const wc = this.window();
    const focused = () => wc.executeJavaScript(`document.activeElement === document.querySelector(${JSON.stringify(css)})`);
    if (!await focused()) throw new Error('Text input did not receive focus');
    signal.throwIfAborted();
    wc.selectAll();
    if (text.length === 0) { wc.delete(); await delay(45, signal); }
    // insertText uses Chromium's native editing path (including IME text), so
    // React receives genuine input events instead of a bypassed value setter.
    for (const character of text) {
      signal.throwIfAborted();
      if (!await focused()) throw new Error('Text input lost focus; typing stopped');
      await wc.insertText(character);
      await delay(45, signal);
    }
    const value = await wc.executeJavaScript(`document.querySelector(${JSON.stringify(css)})?.value`);
    if (value !== text) throw new Error('Text input did not accept the requested value');
  }

  private async waitFor(check: () => Promise<boolean>, signal: AbortSignal) {
    for (let i = 0; i < 30; i++) { signal.throwIfAborted(); if (await check()) return; await delay(100, signal); }
    throw new Error('The interface did not confirm the requested change');
  }

  private async point(css: string) {
    return this.window().executeJavaScript(`(() => {
      const e = document.querySelector(${JSON.stringify(css)});
      if (!e || e.closest('[inert]') || e.matches(':disabled,[aria-disabled="true"]')) return null;
      const r = e.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      if (r.width < 1 || r.height < 1 || !hit || !e.contains(hit)) return null;
      return { x, y };
    })()`);
  }

  private async click(css: string, signal: AbortSignal) {
    let point: { x: number; y: number } | null = null;
    await this.waitFor(async () => { point = await this.point(css); return point !== null; }, signal);
    this.update({ cursor: { ...point!, clicking: false } });
    await delay(350, signal);
    const current = await this.point(css);
    if (!current || current.x !== point!.x || current.y !== point!.y) throw new Error('Control moved or is covered; action stopped');
    signal.throwIfAborted();
    this.update({ cursor: { ...current, clicking: true } });
    const wc = this.window();
    // Await the renderer's synchronous ownership marker before Chromium
    // delivers native input; IPC send and input delivery have different queues.
    await wc.executeJavaScript(`window.dispatchEvent(new CustomEvent('maka-assistant:input', { detail: ${JSON.stringify(current)} }))`);
    signal.throwIfAborted();
    wc.sendInputEvent({ type: 'mouseMove', ...current });
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...current });
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...current });
    await delay(150, signal);
  }
}
