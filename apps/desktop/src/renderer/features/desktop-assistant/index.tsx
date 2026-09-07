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

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { MarkdownBody, ModelPicker, modelChoiceValue, modelMenuGroups, useUiLocale } from '@maka/ui';
import { ArrowUp, MessageSquare as MessageCircle, MousePointer2, Square, X, Undo2 } from '@maka/ui/icons';
import { Button, IconButton } from '@astryxdesign/core';
import type { UiCatalog } from '@maka/core/ui-locale';
import type { DesktopAssistantSnapshot, DesktopAssistantBridge } from '../../../shared/desktop-assistant.js';

const Services = createContext<DesktopAssistantBridge | null>(null);
export function DesktopAssistantServicesProvider(props: { services: DesktopAssistantBridge; children?: ReactNode }) {
  return <Services.Provider value={props.services}>{props.children}</Services.Provider>;
}
const copy = {
  en: { title: 'Maka assistant', model: 'Assistant model', chooseModel: 'Choose a model', placeholder: 'Ask a question, or change a setting…', hint: 'Try “Switch the interface to English”', stop: 'Stop', close: 'Close', send: 'Send', undo: 'Undo last change', thinking: 'Thinking…', acting: 'Working in your app…', paused: 'Paused · you have control', idle: 'Ready', completed: 'Done', error: 'Could not finish' },
  'zh-CN': { title: 'Maka 助手', model: '助手模型', chooseModel: '选择模型', placeholder: '问个问题，或让我帮你调整设置…', hint: '试试「把界面语言切换为英文」', stop: '停止', close: '关闭', send: '发送', undo: '撤销上次修改', thinking: '思考中…', acting: '正在操作界面…', paused: '已暂停 · 由你接管', idle: '准备就绪', completed: '已完成', error: '未能完成' },
  'zh-TW': { title: 'Maka 助手', model: '助手模型', chooseModel: '選擇模型', placeholder: '問個問題，或讓我幫你調整設定…', hint: '試試「把介面語言切換為英文」', stop: '停止', close: '關閉', send: '傳送', undo: '復原上次修改', thinking: '思考中…', acting: '正在操作介面…', paused: '已暫停 · 由你接管', idle: '準備就緒', completed: '已完成', error: '未能完成' },
} satisfies UiCatalog<Record<string, string>>;

export function DesktopAssistantRoot() {
  const bridge = useContext(Services);
  if (!bridge) throw new Error('Desktop assistant services are required');
  const locale = useUiLocale();
  const t = copy[locale];
  const [snapshot, setSnapshot] = useState<DesktopAssistantSnapshot>({ revision: -1, open: false, expanded: true, phase: 'idle', messages: [], canUndo: false });
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const state = useRef(snapshot);
  state.current = snapshot;
  const call = (task: Promise<unknown>) => { void task.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); };
  useEffect(() => {
    let mounted = true;
    const update = (next: typeof snapshot) => { if (mounted) setSnapshot((previous) => next.revision >= previous.revision ? next : previous); };
    const release = bridge.subscribe(update);
    void bridge.getSnapshot().then(update);
    return () => { mounted = false; release(); };
  }, [bridge]);
  useEffect(() => {
    let expected: { x: number; y: number; until: number; moved: boolean } | undefined;
    const onInput = (event: Event) => {
      if (event instanceof CustomEvent) expected = { ...event.detail, until: performance.now() + 300, moved: false };
    };
    window.addEventListener('maka-assistant:input', onInput);
    const open = () => {
      restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      call(bridge.open());
    };
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'm') { event.preventDefault(); open(); return; }
      if (event.key === 'Escape' && state.current.open) { event.preventDefault(); call(state.current.phase === 'acting' || state.current.phase === 'thinking' ? bridge.stop() : bridge.close()); return; }
      if (state.current.phase === 'acting') call(bridge.stop());
    };
    const takeover = (event: Event) => {
      if (state.current.phase !== 'acting' || !event.isTrusted) return;
      if (event instanceof PointerEvent && event.type === 'pointermove' && event.movementX === 0 && event.movementY === 0) return;
      if (event instanceof PointerEvent && expected && performance.now() <= expected.until && Math.abs(event.clientX - expected.x) <= 1 && Math.abs(event.clientY - expected.y) <= 1) {
        if (event.type === 'pointermove' && !expected.moved) { expected.moved = true; return; }
        if (event.type === 'pointerdown') { expected = undefined; return; }
      }
      if (panel.current?.contains(event.target as Node) && event.type === 'pointermove') return;
      call(bridge.stop());
    };
    window.addEventListener('keydown', key, true);
    for (const type of ['pointerdown', 'pointermove', 'wheel']) window.addEventListener(type, takeover, true);
    return () => {
      window.removeEventListener('maka-assistant:input', onInput); window.removeEventListener('keydown', key, true);
      for (const type of ['pointerdown', 'pointermove', 'wheel']) window.removeEventListener(type, takeover, true);
    };
  }, [bridge]);
  useEffect(() => {
    if (snapshot.open && snapshot.expanded && snapshot.phase !== 'acting') input.current?.focus();
    if (!snapshot.open && restoreFocus.current?.isConnected) restoreFocus.current.focus();
  }, [snapshot.open, snapshot.expanded, snapshot.phase]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [snapshot.messages]);
  const busy = snapshot.phase === 'thinking' || snapshot.phase === 'acting';
  const submit = () => {
    if (!text.trim() || busy || !snapshot.model) return;
    const value = text.trim(); setText(''); setError(undefined); call(bridge.submit(value));
  };
  return <>
    {!snapshot.open && <div className="desktopAssistantLauncher"><IconButton icon={<MessageCircle size={18} />} label={`${t.title} (⌘⇧M / Ctrl+Shift+M)`} variant="secondary" onClick={() => { restoreFocus.current = document.activeElement as HTMLElement; call(bridge.open()); }} /></div>}
    {snapshot.open && <section ref={panel} className={`desktopAssistant ${snapshot.expanded ? '' : 'desktopAssistantCompact'}`} aria-label={t.title}>
      <div className="desktopAssistantHeader">
        <span className="desktopAssistantIdentity"><span className={`desktopAssistantDot ${busy ? 'isBusy' : ''}`} />{t.title}</span>
        <span className="desktopAssistantStatus" role="status">{t[snapshot.phase]}</span>
        {busy && <IconButton variant="ghost" label={t.stop} icon={<Square size={14} />} onClick={() => call(bridge.stop())} />}
        {!snapshot.expanded && <IconButton variant="ghost" label={t.title} icon={<MessageCircle size={16} />} onClick={() => call(bridge.expand())} />}
        <IconButton variant="ghost" label={t.close} icon={<X size={16} />} onClick={() => call(bridge.close())} />
      </div>
      {snapshot.expanded && <>
        {snapshot.messages.length > 0 ? <div className="desktopAssistantMessages" role="log" aria-live="polite">
          {snapshot.messages.map((message) => <div key={message.id} className={`desktopAssistantMessage ${message.role}`}>{message.role === 'user' ? message.text : <MarkdownBody text={message.text} streaming={busy} density="compact" />}</div>)}
          <div ref={bottom} />
        </div> : <p className="desktopAssistantHint">{t.hint}</p>}
        {(error || snapshot.error) && <p className="desktopAssistantError" role="alert">{error ?? snapshot.error}</p>}
        <form className="desktopAssistantComposer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <textarea ref={input} value={text} onChange={(event) => setText(event.target.value)} aria-label={t.placeholder} placeholder={t.placeholder} rows={2} maxLength={8000} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
          <IconButton label={t.send} icon={<ArrowUp size={18} />} variant="primary" isDisabled={!text.trim() || busy || !snapshot.model} type="submit" />
        </form>
        <div className="desktopAssistantFooter">
          <ModelPicker
            groups={modelMenuGroups([...(snapshot.modelChoices ?? [])], locale)}
            value={snapshot.model ? modelChoiceValue(snapshot.model.connectionSlug, snapshot.model.model) : ''}
            leadingOption={snapshot.model ? undefined : { value: '', label: t.chooseModel }}
            ariaLabel={t.model}
            disabled={busy}
            triggerClassName="desktopAssistantModel"
            onValueChange={(value) => {
              const choice = snapshot.modelChoices?.find((candidate) => modelChoiceValue(candidate.connectionSlug, candidate.model) === value);
              if (choice) { setError(undefined); call(bridge.selectModel(choice.connectionId, choice.model)); }
            }}
          />
          {snapshot.canUndo && <Button label={t.undo} icon={<Undo2 size={14} />} variant="ghost" size="sm" isDisabled={busy} onClick={() => call(bridge.undo())} />}
        </div>
      </>}
    </section>}
    {snapshot.cursor && <div className={`desktopAssistantCursor ${snapshot.cursor.clicking ? 'isClicking' : ''}`} style={{ transform: `translate(${snapshot.cursor.x}px, ${snapshot.cursor.y}px)` }} aria-hidden="true"><MousePointer2 size={25} fill="currentColor" /><span>Maka</span></div>}
  </>;
}
