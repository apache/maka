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

import { isAssistantCard, isCardWebUrl } from "@maka/core/assistant-card";
import { app, ipcMain, screen, shell, type BrowserWindow } from "electron";
import { join } from "node:path";
import { createPetPackStore } from "@maka/storage/pet-pack-store";
import type { SettingsStore } from "@maka/storage/settings-store";
import { auxiliaryWindowRegistry } from "./auxiliary-window-registry.js";
import { resolveOverlayAssetDir } from "./overlay-assets.js";
import type { createMainWindowController } from "./main-window.js";
import type {
  PetDesktopState,
  PetMode,
  PetPublication,
  PetSurface,
} from "../renderer/application/contracts/pet-desktop.js";

export function createPetDesktop(input: {
  workspaceRoot: string;
  assistantChat?: {
    target(): Promise<string>;
    cardAction(input: { target: string; cardId: string; actionKey?: string }): Promise<{ selectedKey: string | null }>;
    send(input: { target: string; id: string; text: string }): Promise<void>;
  };
  settingsStore: SettingsStore;
  mainWindowController: ReturnType<typeof createMainWindowController>;
}) {
  const packs = createPetPackStore(input.workspaceRoot);
  let window: BrowserWindow | undefined;
  let state: PetDesktopState | undefined;
  let mode: PetMode = "session";
  let revision = 0;
  let modeSaving = false;
  let selectedId: string | null | undefined;
  let quitting = false;
  let composing = false;
  let dragging = false;
  let hoverTimer: ReturnType<typeof setInterval> | undefined;
  let hitRegions: { x: number; y: number; width: number; height: number }[] = [];
  const stopHover = () => {
    if (hoverTimer !== undefined) clearInterval(hoverTimer);
    hoverTimer = undefined;
    hitRegions = [];
  };
  const ignoreMouse = (ignore: boolean) => window?.setIgnoreMouseEvents(ignore,
    process.platform === 'linux' ? undefined : { forward: true });
  const pollHover = () => {
    if (!window || window.isDestroyed()) return;
    const point = screen.getCursorScreenPoint(), bounds = window.getBounds();
    const x = point.x - bounds.x, y = point.y - bounds.y;
    ignoreMouse(!composing && !dragging && !hitRegions.some(region =>
      x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height));
  };
  let petTop = 190;
  let bubbleBelow = false;
  let aboveSpace = 110;
  let pendingPetY: number | undefined;
  const attached = new WeakSet<BrowserWindow>();
  const syncHostWindow = () => {
    const host = input.mainWindowController.browserWindow();
    if (!host || host.isDestroyed()) return;
    host.webContents.setBackgroundThrottling(!state);
    if (attached.has(host)) return;
    attached.add(host);
    host.on('close', event => {
      // The optional desktop pet needs its presentation subscription even when
      // the chat is closed. Explicit application quit still destroys everything.
      if (state && !quitting) { event.preventDefault(); host.hide(); }
    });
  };
  let session: PetSurface = { activity: "idle", label: "没有打开的会话" };
  let assistant: PetSurface = { activity: "idle", label: "正在读取助手状态" };
  const send = () => {
    if (!state || !window || window.isDestroyed()) return;
    state = {
      ...state,
      mode,
      surface: mode === "session" ? session : assistant,
    };
    window.webContents.send("pet-desktop:state", state);
  };
  const configuration = () => ({ enabled: !!state, mode });
  const notify = () =>
    input.mainWindowController.send(
      "pet-desktop:configuration",
      configuration(),
    );
  const clamp = () => {
    if (!window || window.isDestroyed()) return;
    const bounds = window.getBounds(),
      area = screen.getDisplayMatching(bounds).workArea;
    window.setPosition(
      Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)),
      Math.max(
        area.y,
        Math.min(bounds.y, area.y + area.height - bounds.height),
      ),
    );
  };
  const refresh = async () => {
    if (quitting) return;
    const ticket = ++revision;
    const settings = await input.settingsStore.get();
    const id = settings.personalization.selectedPetId;
    const nextMode =
      settings.personalization.petMode === "assistant"
        ? "assistant"
        : "session";
    const manifest = id ? await packs.get(id) : undefined;
    const asset = manifest
      ? await packs.readSpriteSheet(manifest.id)
      : undefined;
    if (quitting || ticket !== revision) return;
    mode = nextMode;
    const resolvedId = manifest && asset ? manifest.id : null;
    if (selectedId !== resolvedId) {
      selectedId = resolvedId;
      input.mainWindowController.send('pets:changed', { type: 'pet_pack_changed', reason: 'selected', petId: resolvedId, ts: Date.now() });
    }
    if (!manifest || !asset) {
      state = undefined;
      stopHover();
      auxiliaryWindowRegistry.destroy(window);
      window = undefined;
      syncHostWindow();
      notify();
      return;
    }
    state = {
      mode,
      manifest,
      surface: mode === "session" ? session : assistant,
      sprite: `data:image/${asset.format};base64,${Buffer.from(asset.bytes).toString("base64")}`,
    };
    if (!window || window.isDestroyed()) {
      composing = false;
      petTop = 190; bubbleBelow = false; aboveSpace = 110;
      const area = screen.getPrimaryDisplay().workArea;
      const dir = resolveOverlayAssetDir();
      window = auxiliaryWindowRegistry.create("pet", {
        title: "Maka 宠物",
        width: 340,
        height: 390,
        x: area.x + area.width - 364,
        y: area.y + area.height - 414,
        type: process.platform === "darwin" ? "panel" : undefined,
        frame: false,
        acceptFirstMouse: true,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        webPreferences: {
          preload: join(dir, "pet-preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      ignoreMouse(true);
      if (process.platform === 'linux') {
        // Electron cannot forward mousemove through an ignored Linux window.
        // Native pointer observation only hit-tests our own visible controls.
        hoverTimer = setInterval(pollHover, 50);
        hoverTimer.unref();
      }
      window.setAlwaysOnTop(true, "floating");
      if (process.platform === "darwin")
        window.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.on("focus", () => {
        if (composing) window?.webContents.send("pet-desktop:compose-focus");
      });
      window.on("closed", () => {
        stopHover();
        dragging = false;
        window = undefined;
      });
      window.once("ready-to-show", () =>
        auxiliaryWindowRegistry.show("pet", window, "inactive"),
      );
      await window.loadFile(join(dir, "pet.html"));
    }
    syncHostWindow();
    send();
    notify();
  };
  ipcMain.handle("pet-desktop:configuration", (event) => {
    if (!input.mainWindowController.isMainRenderer(event.sender))
      throw Error("Invalid pet client");
    syncHostWindow();
    return configuration();
  });
  ipcMain.on("pet-desktop:publish", (event, value: PetPublication) => {
    if (
      !input.mainWindowController.isMainRenderer(event.sender) ||
      !state ||
      !value
    )
      return;
    if (value.kind === "session" || value.kind === "assistant") {
      const surface = value.surface;
      if (
        !surface ||
        typeof surface.label !== "string" ||
        surface.label.length > 1000 ||
        ![
          "idle",
          "working",
          "needs-input",
          "ready",
          "blocked",
          "swarm",
          "cancelled",
          "poke",
          "wake",
          "sleep",
        ].includes(surface.activity) ||
        (surface.sessionId !== undefined &&
          typeof surface.sessionId !== "string")
      )
        return;
      if (value.kind === "session") session = surface;
      else assistant = surface;
      send();
    } else if (
      value.kind === "messages" &&
      mode === "assistant" &&
      value.sessionId === assistant.sessionId &&
      Array.isArray(value.messages) &&
      value.messages.length <= 100 &&
      value.messages.every(
        (m) =>
          typeof m.id === "string" &&
          typeof m.text === "string" &&
          m.text.length <= 100000 &&
          (m.summary === undefined || typeof m.summary === "string") &&
          (m.card === undefined || isAssistantCard(m.card)),
      )
    ) {
      window?.webContents.send("pet-desktop:messages", value);
    }
  });
  ipcMain.on("pet-desktop:action", (event, action: string) => {
    if (!window || event.sender !== window.webContents) return;
    if (action === "ready") { send(); window.webContents.send("pet-desktop:placement", bubbleBelow); }
    if (action === "drag-start") dragging = true;
    if (action === "drag-end") {
      dragging = false;
      if (pendingPetY !== undefined) return; // The renderer is still repositioning the bubble.
      const bounds = window.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      const below = bounds.y + petTop < area.y + aboveSpace;
      if (below !== bubbleBelow) {
        bubbleBelow = below;
        window.webContents.send("pet-desktop:placement", below);
      } else clamp();
    }
    if (action === "interactive") window.setIgnoreMouseEvents(false);
    if (action === "passthrough" && !composing)
      ignoreMouse(true);
    if (action === "open") {
      window.blur();
      app.focus({ steal: true });
      input.mainWindowController.focus();
      input.mainWindowController.send(
        "pet-desktop:open",
        (mode === "session" ? session : assistant).sessionId,
      );
    }
    if (action === "toggle" && !modeSaving) {
      modeSaving = true;
      const next = mode === "session" ? "assistant" : "session";
      void input.settingsStore
        .update({ personalization: { petMode: next } })
        .then(() => {
          mode = next;
          send();
          notify();
        })
        .catch((error) => console.error("[pet] mode save failed", error))
        .finally(() => {
          modeSaving = false;
        });
    }
    if (action === "compose-close") {
      composing = false;
      ignoreMouse(true);
    }
  });
  ipcMain.on('pet-desktop:hit-regions', (event, value: unknown) => {
    if (process.platform !== 'linux' || !window || event.sender !== window.webContents ||
        !Array.isArray(value) || value.length > 3) return;
    const bounds = window.getBounds();
    if (!value.every(region => region && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(region[key])) &&
        region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 &&
        region.x + region.width <= bounds.width + 1 && region.y + region.height <= bounds.height + 1)) return;
    hitRegions = value.map(({ x, y, width, height }) => ({ x, y, width, height }));
    pollHover();
  });
  ipcMain.on('pet-desktop:layout', (event, value) => {
    if (!window || event.sender !== window.webContents || !value ||
      !Number.isFinite(value.height) || !Number.isFinite(value.petTop) ||
      value.height < 180 || value.height > 500 || value.petTop < 0 || value.petTop > value.height - 100 ||
      value.below !== bubbleBelow) return;
    const bounds = window.getBounds();
    const height = Math.ceil(value.height), top = Math.round(value.petTop);
    if (!bubbleBelow) aboveSpace = top + 16;
    // Resize around the visible pet, not around transparent window padding.
    window.setBounds({ ...bounds, y: (pendingPetY ?? bounds.y + petTop) - top, height });
    pendingPetY = undefined;
    petTop = top;
    clamp();
  });
  ipcMain.on('pet-desktop:move' , (event, delta) => {
    if (!window || event.sender !== window.webContents || !delta ||
      !Number.isFinite(delta.dx) || !Number.isFinite(delta.dy) || Math.abs(delta.dx)>1000 || Math.abs(delta.dy)>1000) return;
    const bounds=window.getBounds();
    const y = Math.round(bounds.y + delta.dy);
    const area = screen.getDisplayMatching(bounds).workArea;
    if (!bubbleBelow && y < area.y) {
      // macOS can clamp setPosition before drag-end: decide from the requested
      // position, otherwise the transparent headroom can never cross the edge.
      pendingPetY = y + petTop;
      bubbleBelow = true;
      window.webContents.send('pet-desktop:placement', true);
    }
    window.setPosition(Math.round(bounds.x+delta.dx), y);
  });
  const assertPet = (sender: Electron.WebContents) => {
    if (!window || sender !== window.webContents) throw Error("Invalid pet client");
  };
  ipcMain.handle("pet-desktop:compose-open", event => {
    assertPet(event.sender);
    composing = true;
    // Focus both the native panel and its renderer before focusing the input.
    // Keep mouse input enabled while editing, including after leaving the panel.
    window!.setIgnoreMouseEvents(false);
    if (process.platform === "darwin") app.focus({ steal: true });
    window!.focus();
    window!.webContents.focus();
  });
  ipcMain.handle("pet-desktop:chat-target", async event => {
    assertPet(event.sender);
    if (!input.assistantChat) throw Error("助手聊天暂不可用");
    const target = await input.assistantChat.target();
    // A deliberate chat action switches presentation, never enables background work.
    await input.settingsStore.update({ personalization: { petMode: "assistant" } });
    mode = "assistant";
    send(); notify();
    return target;
  });
  ipcMain.handle("pet-desktop:chat-send", async (event, value: unknown) => {
    assertPet(event.sender);
    const v = value as { target?: unknown; id?: unknown; text?: unknown } | null;
    if (!v || typeof v.target !== "string" || v.target.length > 1000 ||
        typeof v.id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(v.id) ||
        typeof v.text !== "string" || !v.text.trim() || v.text.length > 20000)
      throw Error("消息内容不正确或过长");
    if (!input.assistantChat) throw Error("助手聊天暂不可用");
    await input.assistantChat.send({ target: v.target, id: v.id, text: v.text });
  });
  ipcMain.handle("pet-desktop:card-action", async (event, value: unknown) => {
    assertPet(event.sender);
    const v = value as { target?: unknown; cardId?: unknown; actionKey?: unknown } | null;
    if (!v || typeof v.target !== 'string' || v.target.length > 1000 ||
        typeof v.cardId !== 'string' || !v.cardId || v.cardId.length > 512 ||
        (v.actionKey !== undefined && (typeof v.actionKey !== 'string' || !/^\d+:\d+$/.test(v.actionKey) || v.actionKey.length > 32)))
      throw Error('卡片参数不正确');
    if (!input.assistantChat || mode !== 'assistant') throw Error('助手聊天暂不可用');
    return input.assistantChat.cardAction({ target: v.target, cardId: v.cardId, ...(v.actionKey === undefined ? {} : { actionKey: v.actionKey }) });
  });
  ipcMain.handle("pet-desktop:open-link", async (event, url: unknown) => {
    assertPet(event.sender);
    if (!isCardWebUrl(url)) throw Error('链接不受支持');
    await shell.openExternal(url);
  });
  screen.on("display-metrics-changed", clamp);
  screen.on("display-removed", clamp);
  const releaseForQuit = () => {
    quitting = true;
    stopHover();
    ++revision;
    auxiliaryWindowRegistry.destroy(window);
  };
  app.on("before-quit", (event) => {
    // The quit coordinator may still be asking the user or cleaning up.
    if (event.defaultPrevented) return;
    releaseForQuit();
  });
  return {
    releaseForQuit,
    refresh: () =>
      refresh().catch((error) => console.error("[pet] refresh failed", error)),
  };
}
