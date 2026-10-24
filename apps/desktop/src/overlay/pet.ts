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

import { resolvePetAnimationState } from "@maka/core/pet";
import { PetMessageQueue, PetBubbleView, petMessageText, petMessageDuration, PetBackgroundNotice, shouldClosePetComposer } from "../shared/pet-desktop.js";
import type {
  PetDesktopState,
  PetPublication,
} from "../renderer/application/contracts/pet-desktop.js";
import {
  petFrameSourceRect,
  samplePetAnimation,
} from "../renderer/custom-pet-companion-model.js";

declare global {
  interface Window {
    pet: {
      action(action: string): void;
      layout(height: number, petTop: number, below: boolean): void;
      placement(handler: (below: boolean) => void): void;
      move(dx: number, dy: number): void;
      composeOpen(): Promise<void>;
      composeFocus(handler: () => void): void;
      chatTarget(): Promise<string>;
      send(input: { target: string; id: string; text: string }): Promise<void>;
      state(handler: (state: PetDesktopState) => void): void;
      messages(
        handler: (batch: Extract<PetPublication, { kind: "messages" }>) => void,
      ): void;
    };
  }
}
const canvas = document.querySelector<HTMLCanvasElement>("canvas")!;
const context = canvas.getContext("2d")!;
const bubble = document.querySelector<HTMLElement>("#bubble")!;
const caption = document.querySelector<HTMLElement>("#caption")!;
const content = document.querySelector<HTMLElement>("#content")!;
const count = document.querySelector<HTMLElement>("#count")!;
const pagination = document.querySelector<HTMLElement>("#pagination")!;
const mode = document.querySelector<HTMLButtonElement>("#mode")!;
const background = new PetBackgroundNotice();
const queue = new PetMessageQueue();
const view = new PetBubbleView(queue);
let current: PetDesktopState | undefined;
let image: HTMLImageElement | undefined;
let sprite = "";
let started = 0;
let animationKey = "";
let paused = false;
let elapsed = 0;
let lastTick = 0;
let lastPaint = "";
function paintMessage() { elapsed = 0; renderBubble(performance.now()); }
function renderBubble(now: number) {
  if (!current) return;
  const surface = current.surface;
  const assistant = current.mode === "assistant";
  bubble.hidden = view.mode === 'hidden';
  const petAction = `${bubble.hidden ? (view.unreadCount ? `有 ${view.unreadCount} 条未读消息，单击查看` : '单击显示状态栏') : '单击隐藏上栏'} · 双击打开 Maka`;
  pet.title = `拖动调整位置 · ${petAction}`;
  pet.setAttribute('aria-label', `宠物，${petAction}`);
  document.querySelector<HTMLElement>("#notification")!.hidden = view.unreadCount === 0;
  document.querySelector<HTMLElement>("#unread-count")!.textContent = view.unreadLabel;
  if (bubble.hidden) return;
  const manual = assistant && view.mode === 'messages';
  const message = assistant ? view.message() : undefined;
  const messageIndex = manual ? view.index : queue.index;
  const messageCount = manual ? queue.history.length : queue.messages.length;
  const notice = assistant && !manual ? background.read(surface, now) : undefined;
  const taskList = surface.runningTasks ?? [];
  const task = taskList[Math.floor(now / 5000) % taskList.length];
  const kind = message || manual ? "message" : notice ? "activity" : "status";
  const heading = manual ? "最近消息" : message ? "有新消息" : notice ? notice.title :
    assistant && surface.tasks ? `${surface.tasks.running} 运行   ·   ${surface.tasks.waiting} 等待` : surface.label;
  const text = message ? petMessageText(message) : manual ? "本次还没有收到消息" : notice ? notice.text :
    assistant ? (task ? task.title : '暂时没有任务运行') : '双击我，回到 Maka';
  const key = JSON.stringify([kind, heading, text, messageIndex, messageCount, manual]);
  if (key === lastPaint) return;
  lastPaint = key;
  bubble.dataset.kind = kind;
  bubble.dataset.tone = message ? 'message' : notice ? (notice.title === '记忆维护' ? 'memory' : 'discovery') : 'status';
  caption.textContent = heading;
  const overview = kind === 'status' && assistant && !!surface.tasks;
  document.querySelector<HTMLElement>('.bubble-heading')!.hidden = overview;
  document.querySelector<HTMLElement>('#task-counts')!.hidden = !overview;
  bubble.dataset.overview = String(overview);
  bubble.dataset.empty = String(kind === 'status' && assistant && !task);
  document.querySelector<HTMLElement>('#task-state')!.hidden = !(kind === 'status' && assistant && task);
  if (overview) {
    document.querySelector<HTMLElement>('#running-count')!.textContent = String(surface.tasks!.running);
    document.querySelector<HTMLElement>('#waiting-count')!.textContent = String(surface.tasks!.waiting);
  }
  content.textContent = text;
  content.title = assistant ? (manual || message ? '双击切换状态栏' : '双击切换消息栏') : '会话状态';
  bubble.title = content.title;
  pagination.hidden = !message;
  document.querySelector<HTMLButtonElement>('#previous')!.disabled = messageIndex === 0;
  document.querySelector<HTMLButtonElement>('#next')!.title = messageIndex + 1 < messageCount ? '下一条' : manual ? '已是最后一条' : '收起消息';
  document.querySelector<HTMLButtonElement>('#next')!.disabled = manual && messageIndex + 1 >= messageCount;
  count.textContent = `${messageIndex + 1} / ${messageCount}`;
  document.body.dataset.message = String(!!message);
}
window.pet.state((state) => {
  const changed = current?.surface.sessionId !== state.surface.sessionId || current?.mode !== state.mode;
  if (changed) { queue.clear(); view.reset(); background.reset(); lastPaint = ""; }
  current = state;
  background.update(state.surface, performance.now());
  renderBubble(performance.now());
  mode.dataset.mode = state.mode;
  mode.title = state.mode === 'assistant' ? '助手模式 · 切换为会话宠物' : '会话模式 · 切换为助手宠物';
  mode.setAttribute('aria-label', mode.title);
  document.body.dataset.activity = state.surface.activity;
  if (sprite !== state.sprite) {
    sprite = state.sprite;
    image = new Image();
    image.src = sprite;
    canvas.width = state.manifest.spriteSheet.frameWidth;
    canvas.height = state.manifest.spriteSheet.frameHeight;
    animationKey = "";
  }
});
window.pet.messages((batch) => {
  const wasEmpty = !queue.current();
  const priorLast = queue.history.at(-1)?.id;
  queue.push(batch.sessionId, batch.messages);
  if (queue.history.at(-1)?.id !== priorLast) view.arrival();
  if (wasEmpty) paintMessage();
});
mode.onclick = () => window.pet.action("toggle");
const composer = document.querySelector<HTMLFormElement>("#composer")!;
const draft = document.querySelector<HTMLTextAreaElement>("#draft")!;
const sendButton = document.querySelector<HTMLButtonElement>("#send")!;
const sendStatus = document.querySelector<HTMLElement>("#send-status")!;
const actions = document.querySelector<HTMLElement>("#actions")!;
const toolbar = document.querySelector<HTMLElement>("#toolbar")!;
let lastInput = performance.now();
let composingText = false;
let statusUntil = 0;
function status(text: string, duration = 5000) {
  sendStatus.textContent = text; sendStatus.title = text; sendStatus.hidden = false;
  statusUntil = performance.now() + duration;
}
function closeComposer() {
  ++opening;
  composer.hidden = true; actions.hidden = false; mode.disabled = false;
  toolbar.dataset.composing = 'false'; sendStatus.hidden = true;
  interactive = false;
  window.pet.action('compose-close');
}
document.querySelector('#collapse')!.addEventListener('click', closeComposer);

let target: string | undefined;
let pending: { target: string; id: string; text: string } | undefined;
let sending = false;
let opening = 0;
const failure = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': Error: /, "");
window.pet.composeFocus(() => {
  if (!composer.hidden && !draft.disabled) draft.focus();
});
document.querySelector("#open")!.addEventListener("click", async () => {
  const ticket = ++opening;
  const show = !!composer.hidden;
  composer.hidden = !show;
  mode.disabled = show;
  actions.hidden = show; toolbar.dataset.composing = String(show);
  lastInput = performance.now();
  if (!show) { window.pet.action("compose-close"); return; }
  draft.focus();
  // Preserve an uncertain submission's identity on retry rather than sending twice.
  target = undefined;
  status("正在连接助手…");
  try {
    await window.pet.composeOpen();
    if (ticket !== opening) return;
    draft.focus();
    const resolved = await window.pet.chatTarget();
    if (ticket !== opening) return;
    target = resolved;
    if (pending && pending.target !== resolved) status("助手已切换，请确认草稿后发送");
    else sendStatus.hidden = true;
  } catch (error) { if (ticket === opening) status(failure(error), 10000); }
});
composer.addEventListener("submit", async event => {
  event.preventDefault();
  if (sending || !draft.value.trim()) return;
  if (!target) { status("尚未连接助手，请收起后重试"); return; }
  if (!pending || pending.text !== draft.value || pending.target !== target)
    pending = { target, id: crypto.randomUUID(), text: draft.value };
  sending = true;
  draft.disabled = sendButton.disabled = true;
  status("发送中…", Infinity);
  try {
    await window.pet.send(pending);
    pending = undefined;
    draft.value = "";
    status("已发送", 1600);
    lastInput = performance.now();
  } catch (error) { status(failure(error), 10000); }
  finally { sending = false; draft.disabled = sendButton.disabled = false; if (!composer.hidden) draft.focus(); }
});
draft.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); composer.requestSubmit();
  }
});
draft.addEventListener('input', () => { lastInput = performance.now(); sendStatus.hidden = true; });
draft.addEventListener('compositionstart', () => { composingText = true; lastInput = performance.now(); });
draft.addEventListener('compositionend', () => { composingText = false; lastInput = performance.now(); });
// A single click must not navigate before the second click can flip the card.
let flipping = false;
async function flipBubble(change: () => void) {
  if (flipping) return;
  flipping = true;
  try {
    if (!reduced.matches && !bubble.hidden) {
      await bubble.animate([
        { transform: 'perspective(600px) rotateY(0deg)', opacity: 1 },
        { transform: 'perspective(600px) rotateY(90deg)', opacity: .3 },
      ], { duration: 110, easing: 'ease-in', fill: 'forwards' }).finished;
    }
    change();
    bubble.getAnimations().forEach(animation => animation.cancel());
    lastPaint = '';
    paintMessage();
    if (!reduced.matches && !bubble.hidden) {
      await bubble.animate([
        { transform: 'perspective(600px) rotateY(-90deg)', opacity: .3 },
        { transform: 'perspective(600px) rotateY(0deg)', opacity: 1 },
      ], { duration: 130, easing: 'ease-out' }).finished;
    }
  } finally { flipping = false; }
}
bubble.addEventListener('dblclick', event => {
  if ((event.target as Element).closest('#pagination')) return;
  event.preventDefault();
  void flipBubble(() => {
    if (current?.mode === 'assistant') view.cycle();

  });
});
content.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (current?.mode === 'assistant') void flipBubble(() => view.cycle());
  }
});
const pet = document.querySelector<HTMLElement>('#pet')!;
let dragging: {x:number;y:number;moved:boolean} | undefined;
let clickTimer: ReturnType<typeof setTimeout> | undefined;
let suppressClick = false;
function cancelClick() { clearTimeout(clickTimer); clickTimer = undefined; }
function toggleBubble() {
  view.toggleVisibility();
  lastPaint = '';
  paintMessage();
}
pet.addEventListener('click', event => {
  cancelClick();
  if (suppressClick || event.detail > 1) return;
  // Wait for the second click before hiding/resizing the window under the pointer.
  if (event.detail === 0) toggleBubble();
  else clickTimer = setTimeout(toggleBubble, 500);
});
pet.addEventListener('dblclick', () => {
  cancelClick();
  if (!suppressClick) window.pet.action('open');
});
pet.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  if (event.detail > 1) cancelClick();
  suppressClick = false;
  dragging = {x:event.screenX,y:event.screenY,moved:false}; pet.setPointerCapture(event.pointerId);
});
pet.addEventListener('pointermove', event => {
  if (!dragging) return;
  const dx=event.screenX-dragging.x, dy=event.screenY-dragging.y;
  if (dragging.moved || Math.abs(dx)+Math.abs(dy)>4) {
    suppressClick = true;
    cancelClick();
    dragging = {x:event.screenX,y:event.screenY,moved:true}; window.pet.move(dx,dy);
  }
});
const endDrag = (event: PointerEvent) => {
  if (event.type === 'pointercancel') { suppressClick = true; cancelClick(); }
  dragging=undefined; window.pet.action('drag-end');
};
pet.addEventListener('pointerup', endDrag); pet.addEventListener('pointercancel', endDrag);

document.querySelector("#next")!.addEventListener("click", () => {
  view.next();
  paintMessage();
});
document.querySelector("#previous")!.addEventListener("click", () => {
  view.previous();
  paintMessage();
});
bubble.onmouseenter = () => {
  paused = true;
};
bubble.onmouseleave = () => {
  paused = false;
};
bubble.addEventListener("focusin", () => { paused = true; });
bubble.addEventListener("focusout", () => { paused = false; });
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
function tick(now: number) {
  const dt = lastTick ? Math.min(now - lastTick, 1000) : 0;
  lastTick = now;
  if (!composer.hidden && shouldClosePetComposer(draft.value, now-lastInput, sending, composingText)) closeComposer();
  if (now > statusUntil) sendStatus.hidden = true;
  renderBubble(now);
  if (view.mode === "auto" && queue.current() && !paused && composer.hidden && !flipping) {
    elapsed += dt;
    const duration = petMessageDuration(queue.current()!);
    if (elapsed > duration) {
      queue.next();
      paintMessage();
    }
  }
  if (current && image?.complete && image.naturalWidth) {
    const state = resolvePetAnimationState(
      current.manifest,
      !!view.message() && current.surface.activity === "idle" ? "ready" : current.surface.activity,
    );
    const key = current.manifest.id + ":" + state;
    if (key !== animationKey) {
      animationKey = key;
      started = now;
    }
    const animation =
      current.manifest.animations[state] ?? current.manifest.animations.idle;
    const frame = reduced.matches
      ? animation.frames[0]
      : samplePetAnimation(animation, now - started).frame;
    const rect = petFrameSourceRect(frame, current.manifest.spriteSheet);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      image,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
let interactive = false;
window.addEventListener("mousemove", (event) => {
  const next = !!dragging || !!(event.target as Element).closest("#pet, #toolbar, #bubble");
  if (next !== interactive) {
    interactive = next;
    window.pet.action(next ? "interactive" : "passthrough");
  }
});
window.pet.action("ready");

// Measure only visible content so transparent padding cannot become a drag wall.
let below = false;
let lastLayout = '';
const reportLayout = () => {
  const pet = document.querySelector<HTMLElement>('#pet')!;
  const toolbar = document.querySelector<HTMLElement>('#toolbar')!;
  const bubbleHeight = bubble.hidden ? 0 : bubble.offsetHeight;
  const gap = bubble.hidden ? 0 : 7;
  const height = Math.ceil(24 + bubbleHeight + gap + pet.getBoundingClientRect().height + toolbar.getBoundingClientRect().height);
  const top = below ? 12 : 12 + bubbleHeight + gap;
  const key = `${height}:${top}:${below}`;
  if (key === lastLayout) return;
  lastLayout = key;
  window.pet.layout(height, top, below);
};
const layoutObserver = new ResizeObserver(reportLayout);
for (const element of [bubble, document.querySelector('#toolbar')!, document.querySelector('#pet')!]) layoutObserver.observe(element);
window.pet.placement(value => {
  below = value;
  document.body.dataset.below = String(value);
  reportLayout();
});
