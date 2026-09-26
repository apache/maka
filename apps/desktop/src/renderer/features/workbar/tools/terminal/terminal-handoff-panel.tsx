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

import { useEffect, useRef, useState } from 'react';
import { Button, useUiLocale } from '@maka/ui';
import { ChatComposer, TextInput, isImeKeyEvent } from '@astryxdesign/core';
import type { RuntimeResourceHandoffResult } from '@maka/runtime-host/protocol';
import { useWorkbarServices } from '../../services-context.js';
import { parseDesktopSessionKey } from '../../../../../shared/runtime-host-identity.js';

const COPY = {
  'en-US': { waiting: 'Your input is private. The agent is waiting.', resumed: 'Control returned to the agent. Output stays private.', input: 'Private terminal input', submit: 'Submit', resume: 'Let the agent continue', cancel: 'Cancel and stop', shared: 'Selected observation shared with the agent.', share: 'Share selected text with the agent', review: 'After continuing, review new output and select only non-sensitive text to share. Sharing records that text in the task.', sent: 'Sent to this terminal. Submit again if another response is needed.', unknown: 'Delivery could not be confirmed. Input was not retried. Inspect the terminal or stop.', failure: 'This terminal is unavailable. Reopen the original task or stop.', select: 'Select the non-sensitive text you want to share.', target: 'Execution host' },
  'zh-CN': { waiting: '输入仅发送给此终端，Agent 正在等待。', resumed: '已交还 Agent，输出仍保持私密。', input: '私密终端输入', submit: '提交', resume: '让 Agent 继续', cancel: '取消并停止', shared: '已将所选观察分享给 Agent。', share: '将所选文字分享给 Agent', review: '继续后，请审阅新输出，只选择非敏感文字分享。分享的文字将记入任务。', sent: '已发送至此终端；如需下一次回应，可继续提交。', unknown: '无法确认投递结果，未自动重试。请检查终端或停止。', failure: '此终端暂不可用，请重新打开原任务或停止。', select: '请选择要分享的非敏感文字。', target: '执行主机' },
  'zh-TW': { waiting: '輸入僅傳送給此終端，Agent 正在等待。', resumed: '已交還 Agent，輸出仍保持私密。', input: '私密終端輸入', submit: '提交', resume: '讓 Agent 繼續', cancel: '取消並停止', shared: '已將所選觀察分享給 Agent。', share: '將所選文字分享給 Agent', review: '繼續後，請審閱新輸出，只選擇非敏感文字分享。分享的文字將記入任務。', sent: '已傳送至此終端；如需下一次回應，可繼續提交。', unknown: '無法確認投遞結果，未自動重試。請檢查終端或停止。', failure: '此終端暫不可用，請重新開啟原任務或停止。', select: '請選擇要分享的非敏感文字。', target: '執行主機' },
};

export function TerminalHandoffPanel(props: {
  sessionId: string;
  request: NonNullable<RuntimeResourceHandoffResult['request']>;
  active: boolean;
}) {
  const { terminal } = useWorkbarServices();
  const locale = useUiLocale();
  const copy = COPY[locale as keyof typeof COPY] ?? COPY['en-US'];
  const [controllerId] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<RuntimeResourceHandoffResult>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  // Component-local only: never reuse chat drafts or generic form responses.
  const [privateInput, setPrivateInput] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const screen = useRef<HTMLPreElement>(null);
  const sending = useRef(false);
  const displayEpoch = useRef(0);
  const identity = { sessionId: props.sessionId, requestId: props.request.requestId, controllerId };
  useEffect(() => {
    if (!terminal.handoff || !props.active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const epoch = displayEpoch.current;
      try {
        const result = await terminal.handoff!({ ...identity, action: 'observe' });
        if (!disposed && epoch === displayEpoch.current) {
          setState(result);
          if (result.status === 'outcome_unknown') { setUncertain(true); setNotice(copy.unknown); }
        }
      } catch { if (!disposed) setNotice(copy.failure); }
      if (!disposed) timer = setTimeout(poll, 300);
    };
    void terminal.handoff({ ...identity, action: 'ready' })
      .then((result) => {
        if (disposed) { void terminal.handoff!({ ...identity, action: 'release' }).catch(() => {}); return; }
        setState(result);
        if (result.status === 'outcome_unknown') { setUncertain(true); setNotice(copy.unknown); }
        void poll();
      })
      .catch(() => { if (!disposed) setNotice(copy.failure); });
    return () => {
      disposed = true;
      displayEpoch.current++;
      clearTimeout(timer);
      if (input.current) input.current.value = '';
      setPrivateInput('');
      setState(undefined);
      void terminal.handoff!({ ...identity, action: 'release' }).catch(() => {});
    };
  }, [terminal, props.sessionId, props.request.requestId, props.active, controllerId, copy.failure, copy.unknown]);

  async function submit() {
    const value = input.current?.value;
    if (sending.current || !value || !state || state.phase !== 'human' || uncertain) return;
    sending.current = true;
    setBusy(true);
    input.current!.value = '';
    setPrivateInput('');
    try {
      const result = await terminal.handoff!({ ...identity, action: 'input', sequence: state.nextSequence, input: value });
      setState((previous) => ({ ...result, ...(previous?.display ? { display: previous.display } : {}) }));
      setUncertain(result.status === 'outcome_unknown');
      setNotice(result.status === 'written' ? copy.sent : copy.unknown);
    } catch { setUncertain(true); setNotice(copy.unknown); }
    finally { sending.current = false; setBusy(false); }
  }

  async function answer(action: 'resume' | 'cancel') {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    if (input.current) input.current.value = '';
    setPrivateInput('');
    try {
      displayEpoch.current++;
      await terminal.answerHandoff!({ ...identity, action });
      displayEpoch.current++;
      setState((previous) => previous ? { ...previous, phase: action === 'resume' ? 'resumed' : 'closed', display: undefined } : previous);
      setNotice(action === 'resume' ? copy.resumed : '');
    } catch { setNotice(copy.failure); }
    finally { sending.current = false; setBusy(false); }
  }

  async function share() {
    const selection = window.getSelection();
    if (!state?.display || !selection?.anchorNode || !screen.current?.contains(selection.anchorNode) || !screen.current.contains(selection.focusNode)) { setNotice(copy.select); return; }
    const text = selection.toString();
    if (!text) { setNotice(copy.select); return; }
    try {
      await terminal.handoff!({ ...identity, action: 'share', sequence: state.display.sequence, text });
      setNotice(copy.shared);
    } catch { setNotice(copy.failure); }
  }

  const human = state?.phase === 'human';
  const host = parseDesktopSessionKey(props.sessionId)?.hostId ?? props.sessionId;
  return <section className="maka-terminal-handoff" data-testid="terminal-handoff">
    <header><strong>{props.request.message}</strong><small title={host}>{copy.target}: {host.slice(0, 12)}</small><code>{props.request.command}</code><small title={props.request.ref}>{props.request.ref}</small></header>
    <p role="status">{human ? copy.waiting : state?.phase === 'resumed' ? copy.resumed : notice}</p>
    <pre ref={screen} className="maka-terminal-handoff-screen" aria-hidden="true" data-private-terminal="true">{props.active ? state?.display?.text : ''}</pre>
    {human && <ChatComposer className="maka-composer-astryx" onSubmit={() => {}}
      input={<TextInput ref={input} label={copy.input} type="password" autoComplete="off"
        value={privateInput} onChange={setPrivateInput} isDisabled={busy || uncertain} width="100%"
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (!isImeKeyEvent(event.nativeEvent)) void submit(); } }} />}
      footerActions={<Button label={copy.cancel} variant="ghost" size="sm" onClick={() => void answer('cancel')} isDisabled={busy} />}
      sendButton={<Button label={copy.submit} size="sm" onClick={() => void submit()} isDisabled={busy || uncertain || !privateInput} />}
    />}
    {notice && <p role="status">{notice}</p>}
    <p>{copy.review}</p>
    <footer>
      {!human && state?.phase !== 'resumed' && state?.phase !== 'closed' && <Button label={copy.cancel} variant="secondary" size="sm" onClick={() => void answer('cancel')} isDisabled={busy} />}
      {human && <Button label={copy.resume} size="sm" onClick={() => void answer('resume')} isDisabled={busy || uncertain} />}
      {state?.phase === 'resumed' && <Button label={copy.share} size="sm" onClick={() => void share()} />}
    </footer>
  </section>;
}
