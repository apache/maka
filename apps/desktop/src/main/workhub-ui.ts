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

import { Page } from "@jackwener/opencli/browser/page";
import type { WebContents } from "electron";
import type { AppSettings } from "@maka/core/settings";
import type { WorkHubAction } from '../shared/workhub-tool-schema.js';
import type { WorkHubControlSnapshot } from '../shared/workhub-control.js';
import { WorkHubSurface, ASSISTANT_EXCLUDED } from "./workhub-surface.js";

const attr = "data-maka-assistant-target";
const selector = (target: string) => `[${attr}=${JSON.stringify(target)}]`;
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });

/** OpenCLI's AX formatter, transported directly to this window; no daemon or navigation. */
class WindowPage extends Page {
  constructor(
    private readonly contents: WebContents,
    private readonly appSurface: WorkHubSurface,
  ) {
    super("maka-assistant");
  }
  override async getCurrentUrl() {
    return this.contents.getURL();
  }
  override async cdp(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (method === "Page.getFrameTree") return {};
    if (!this.contents.debugger.isAttached())
      this.contents.debugger.attach("1.3");
    if (method !== "Accessibility.getFullAXTree")
      return this.contents.debugger.sendCommand(method, params);
    const { root } = await this.contents.debugger.sendCommand(
      "DOM.getDocument",
      { depth: -1 },
    );
    const result = await this.contents.debugger.sendCommand(method, params);
    return this.appSurface.filter(root, result);
  }
}

export class WorkHubUi {
  private cursor?: { x: number; y: number };
  private readonly surface = new WorkHubSurface();
  dispatchedInputs = 0;
  constructor(
    private readonly window: () => WebContents,
    private readonly readSettings: () => Promise<AppSettings>,
    private readonly update: (patch: Partial<WorkHubControlSnapshot>) => void,
    private readonly readDisplayName: () => Promise<string>,
  ) {}

  async begin(signal: AbortSignal) {
    signal.throwIfAborted();
    const origin = await this.window().executeJavaScript(`(() => {
      return { x: Math.round(innerWidth / 2), y: Math.round(innerHeight - 80) };
    })()`);
    this.cursor = origin;
    this.update({ cursor: { ...origin, clicking: false, durationMs: 0 } });
    await delay(80, signal);
  }

  async observe() {
    const wc = this.window();
    await this.surface.prepare(wc);
    const page = new WindowPage(wc, this.surface);
    const accessibility = await page.snapshot({ source: "ax" });
    const settings = await this.readSettings();
    const section = await wc.executeJavaScript(
      `document.querySelector('[data-maka-assistant-section]')?.getAttribute('data-maka-assistant-section') ?? null`,
    );
    return {
      section,
      language: settings.personalization.uiLocale,
      theme: settings.appearance.theme,
      accessibility,
      controls: this.surface.list(),
    };
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
    if (rect.width < 1 || rect.height < 1 || rect.x < 0 || rect.y < 0)
      throw new Error("Preference control is not visible");
    return (await wc.capturePage(rect, { stayHidden: true })).toPNG().toString("base64");
  }

  async execute(
    action: WorkHubAction,
    signal: AbortSignal,
  ): Promise<{
    verified: boolean;
    previous?: string;
    target?: string;
    value?: string;
    section?: string;
    dispatched?: boolean;
  }> {
    if (action.kind === "open") {
      if (await this.point(selector("settings.close")))
        await this.click(selector("settings.close"), signal);
      if (action.area !== "app") {
        if (!(await this.point(selector(`app.${action.area}`))))
          await this.click(
            '[data-maka-contract="shell-topbar-rail"] button[aria-expanded="false"]',
            signal,
          );
        await this.click(selector(`app.${action.area}`), signal);
      }
      return { verified: false, dispatched: true };
    }
    if ("ref" in action) {
      const wc = this.window();
      const target = await this.surface.resolve(wc, action.ref, action.kind);
      signal.throwIfAborted();
      const validate = async () => {
        signal.throwIfAborted();
        await this.surface.resolve(this.window(), action.ref, action.kind);
      };
      if (action.kind === "click")
        await this.click(target.css, signal, validate);
      else if (action.kind === "type")
        await this.type(target.css, action.text, signal, validate);
      else if (action.kind === "key") {
        await this.click(target.css, signal, validate);
        await validate();
        await wc.executeJavaScript(
          `window.dispatchEvent(new CustomEvent('maka-assistant:input', { detail: { key: ${JSON.stringify(action.key === "Space" ? " " : action.key)} } }))`,
        );
        signal.throwIfAborted();
        const keyCode = action.key.replace("Arrow", "");
        this.dispatchedInputs++;
        wc.sendInputEvent({ type: "keyDown", keyCode });
        wc.sendInputEvent({ type: "keyUp", keyCode });
        await delay(150, signal);
      } else {
        const point = await this.move(
          target.css,
          signal,
          validate,
          action.kind === "hover",
        );
        await this.nativeInput(async () => {
          await wc.executeJavaScript(
            `window.dispatchEvent(new CustomEvent('maka-assistant:input', { detail: ${JSON.stringify({ ...point, ...(action.kind === "scroll" ? { wheel: true } : {}) })} }))`,
          );
          signal.throwIfAborted();
          wc.sendInputEvent({ type: "mouseMove", ...point });
          if (action.kind === "scroll") {
            this.dispatchedInputs++;
            wc.sendInputEvent({
              type: "mouseWheel",
              ...point,
              deltaX: 0,
              deltaY: -action.deltaY,
              canScroll: true,
              hasPreciseScrollingDeltas: true,
            });
          }
          await delay(200, signal);
        });
      }
      return { verified: false, dispatched: true };
    }
    const section =
      action.kind === "navigate"
        ? action.section
        : action.target === "theme"
          ? "appearance"
          : "general";
    const wc = this.window();
    const opened = await wc.executeJavaScript(
      `!!document.querySelector('[data-maka-assistant-section]')`,
    );
    if (!opened) {
      if (!(await this.point(selector("settings.open")))) {
        await this.click(
          '[data-maka-contract="shell-topbar-rail"] button[aria-expanded="false"]',
          signal,
        );
      }
      await this.click(selector("settings.open"), signal);
    }
    await this.click(selector(`settings.${section}`), signal);
    await this.waitFor(
      async () =>
        (await wc.executeJavaScript(
          `document.querySelector('[data-maka-assistant-section]')?.getAttribute('data-maka-assistant-section')`,
        )) === section,
      signal,
    );
    if (action.kind === "navigate") return { verified: true, section };
    const before = await this.readSettings();
    if (action.target === "displayName") {
      const previous = await this.readDisplayName();
      if (previous === action.value)
        return {
          verified: true,
          target: action.target,
          value: action.value,
          previous,
        };
      await this.click(selector("displayName.edit"), signal);
      await this.type(
        `${selector("displayName.input")} input`,
        action.value,
        signal,
      );
      await this.click(selector("displayName.save"), signal);
      await this.waitFor(
        async () => (await this.readDisplayName()) === action.value,
        signal,
      );
      return {
        verified: true,
        target: action.target,
        value: action.value,
        previous,
      };
    }
    if (action.target === "theme")
      await this.click(selector(`theme.${action.value}`), signal);
    else {
      const trigger = `${selector("language")} [role="combobox"]`;
      await this.click(trigger, signal);
      const index = ["auto", "zh-CN", "zh-TW", "en"].indexOf(action.value);
      // The list belongs to this combobox, not an arbitrary popup elsewhere.
      const listId: string = await wc.executeJavaScript(
        `document.querySelector(${JSON.stringify(trigger)})?.getAttribute('aria-controls')`,
      );
      if (!listId) throw new Error("Language control did not open");
      await this.click(
        `[id=${JSON.stringify(listId)}] [role="option"]:nth-of-type(${index + 1})`,
        signal,
      );
    }
    await this.waitFor(async () => {
      const saved = await this.readSettings();
      return (
        (action.target === "language"
          ? saved.personalization.uiLocale
          : saved.appearance.theme) === action.value
      );
    }, signal);
    return {
      verified: true,
      target: action.target,
      value: action.value,
      previous:
        action.target === "language"
          ? before.personalization.uiLocale
          : before.appearance.theme,
    };
  }

  private async type(
    css: string,
    text: string,
    signal: AbortSignal,
    validate?: () => Promise<void>,
  ) {
    await this.click(css, signal, validate);
    const wc = this.window();
    const focused = () =>
      this.window().executeJavaScript(
        `document.activeElement === document.querySelector(${JSON.stringify(css)})`,
      );
    if (!(await focused())) throw new Error("Text input did not receive focus");
    signal.throwIfAborted();
    wc.selectAll();
    if (text.length === 0) {
      this.dispatchedInputs++;
      wc.delete();
      await delay(45, signal);
    }
    // insertText uses Chromium's native editing path (including IME text), so
    // React receives genuine input events instead of a bypassed value setter.
    for (const character of text) {
      signal.throwIfAborted();
      await validate?.();
      if (!(await focused()))
        throw new Error("Text input lost focus; typing stopped");
      this.dispatchedInputs++;
      await wc.insertText(character);
      await delay(45, signal);
    }
    const value = await wc.executeJavaScript(
      `(() => { const e = document.querySelector(${JSON.stringify(css)}); return e && ('value' in e ? e.value : e.innerText); })()`,
    );
    if (value !== text)
      throw new Error("Text input did not accept the requested value");
  }

  private async waitFor(check: () => Promise<boolean>, signal: AbortSignal) {
    for (let i = 0; i < 30; i++) {
      signal.throwIfAborted();
      if (await check()) return;
      await delay(100, signal);
    }
    throw new Error("The interface did not confirm the requested change");
  }

  private async point(css: string, hover = false) {
    return this.window().executeJavaScript(`(() => {
      const e = document.querySelector(${JSON.stringify(css)});
      if (!e || e.closest(${JSON.stringify(ASSISTANT_EXCLUDED)}) || e.closest('[inert]') || e.matches(':disabled,[aria-disabled="true"]')) return null;
      const r = e.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      const root = document.documentElement, passing = root.classList.contains('desktopAssistantInput');
      root.classList.add('desktopAssistantInput');
      try {
        const hit = document.elementFromPoint(x, y);
        if (r.width < 1 || r.height < 1 || !hit || hit.closest(${JSON.stringify(ASSISTANT_EXCLUDED)}) || (!${hover} && !e.contains(hit))) return null;
        return { x, y };
      } finally { if (!passing) root.classList.remove('desktopAssistantInput'); }
    })()`);
  }

  /** Reveal typed targets using the same native wheel path a person uses. */
  private async reveal(css: string, signal: AbortSignal) {
    for (let attempt = 0; attempt < 24; attempt++) {
      signal.throwIfAborted();
      const wheel: { x: number; y: number; deltaY: number } | null =
        await this.window().executeJavaScript(`(() => {
        const e = document.querySelector(${JSON.stringify(css)});
        if (!e || e.closest(${JSON.stringify(ASSISTANT_EXCLUDED)}) || e.closest('[inert]')) return null;
        const r = e.getBoundingClientRect();
        for (let ancestor = e.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (!/(auto|scroll)/.test(style.overflowY) || ancestor.scrollHeight <= ancestor.clientHeight) continue;
          const a = ancestor.getBoundingClientRect();
          const top = Math.max(0, a.top), bottom = Math.min(innerHeight, a.bottom);
          if (r.top >= top && r.bottom <= bottom) continue;
          const left = Math.max(0, a.left), right = Math.min(innerWidth, a.right);
          if (bottom - top < 4 || right - left < 4) continue;
          const x = Math.round((left + right) / 2), y = Math.round((top + bottom) / 2);
          const root = document.documentElement, passing = root.classList.contains('desktopAssistantInput');
          root.classList.add('desktopAssistantInput');
          try {
            const hit = document.elementFromPoint(x, y);
            if (!hit || !ancestor.contains(hit) || hit.closest(${JSON.stringify(ASSISTANT_EXCLUDED)})) return null;
            return { x, y, deltaY: r.top < top ? Math.min(600, top - r.top + 24) : -Math.min(600, r.bottom - bottom + 24) };
          } finally { if (!passing) root.classList.remove('desktopAssistantInput'); }
        }
        return null;
      })()`);
      if (!wheel) return;
      const { x, y, deltaY } = wheel;
      this.cursor = { x, y };
      this.update({ cursor: { x, y, clicking: false, durationMs: 180 } });
      await delay(230, signal);
      await this.nativeInput(async () => {
        const wc = this.window();
        await wc.executeJavaScript(
          `window.dispatchEvent(new CustomEvent('maka-assistant:input', { detail: ${JSON.stringify({ x, y, wheel: true })} }))`,
        );
        signal.throwIfAborted();
        this.dispatchedInputs++;
        wc.sendInputEvent({ type: "mouseMove", x, y });
        wc.sendInputEvent({
          type: "mouseWheel",
          x,
          y,
          deltaX: 0,
          deltaY,
          canScroll: true,
          hasPreciseScrollingDeltas: true,
        });
        await delay(180, signal);
      });
    }
    throw new Error("Control could not be revealed through native scrolling");
  }

  private async move(
    css: string,
    signal: AbortSignal,
    validate?: () => Promise<void>,
    hover = false,
  ) {
    if (!validate) await this.reveal(css, signal);
    let point: { x: number; y: number } | null = null;
    await this.waitFor(async () => {
      point = await this.point(css, hover);
      return point !== null;
    }, signal);
    const distance = this.cursor
      ? Math.hypot(point!.x - this.cursor.x, point!.y - this.cursor.y)
      : 0;
    const durationMs =
      distance < 1 ? 0 : Math.round(Math.min(780, 260 + distance * 0.45));
    this.cursor = point!;
    this.update({ cursor: { ...point!, clicking: false, durationMs } });
    await delay(durationMs + 50, signal);
    const current = await this.point(css, hover);
    if (!current || current.x !== point!.x || current.y !== point!.y)
      throw new Error("Control moved or is covered; action stopped");
    signal.throwIfAborted();
    await validate?.();
    return current;
  }

  private async click(
    css: string,
    signal: AbortSignal,
    validate?: () => Promise<void>,
  ) {
    const current = await this.move(css, signal, validate, true);
    const wc = this.window();
    await this.nativeInput(async () => {
      // Await the renderer's synchronous ownership marker before Chromium
      // delivers native input; IPC send and input delivery use different queues.
      await wc.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('maka-assistant:input', { detail: ${JSON.stringify(current)} }))`,
      );
      signal.throwIfAborted();
      wc.sendInputEvent({ type: "mouseMove", ...current });
      // Task-row actions appear on hover. Reveal them before pressing.
      await delay(120, signal);
      const hit = await this.point(css);
      if (!hit || hit.x !== current.x || hit.y !== current.y)
        throw new Error("Control is covered or moved; action stopped");
      await validate?.();
      await wc.executeJavaScript(
        `document.documentElement.classList.add('desktopAssistantInput'); window.dispatchEvent(new CustomEvent('maka-assistant:input', { detail: ${JSON.stringify(current)} }))`,
      );
      signal.throwIfAborted();
      this.update({ cursor: { ...current, clicking: true, durationMs: 0 } });
      this.dispatchedInputs++;
      wc.sendInputEvent({
        type: "mouseDown",
        button: "left",
        clickCount: 1,
        ...current,
      });
      wc.sendInputEvent({
        type: "mouseUp",
        button: "left",
        clickCount: 1,
        ...current,
      });
      await delay(150, signal);
    });
  }

  private async nativeInput(send: () => Promise<void>) {
    const wc = this.window();
    await wc.executeJavaScript(
      `document.documentElement.classList.add('desktopAssistantInput')`,
    );
    try {
      await send();
    } finally {
      if (!wc.isDestroyed())
        await wc.executeJavaScript(
          `document.documentElement.classList.remove('desktopAssistantInput')`,
        );
    }
  }
}
