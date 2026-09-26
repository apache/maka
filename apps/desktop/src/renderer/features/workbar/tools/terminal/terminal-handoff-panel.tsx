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
import type { UiCatalog } from '@maka/core/ui-locale';
import { Banner, ChatComposer, CheckboxInput, TextInput, isImeKeyEvent } from '@astryxdesign/core';
import type { RuntimeResourceHandoffResult } from '@maka/runtime-host/protocol';
import { useWorkbarServices } from '../../services-context.js';
import { parseDesktopSessionKey } from '../../../../../shared/runtime-host-identity.js';
import { isValidPrivateTerminalInput, terminalFeedback } from './terminal-handoff-feedback.js';

const COPY = {
  en: {
    waiting: 'Your input is private. The agent is waiting.', resumed: 'Control returned to the agent. Output stays private.',
    input: 'Private terminal input', submit: 'Submit', resume: 'Let the agent continue', cancel: 'Cancel and stop',
    shared: 'Selected observation shared with the agent.', share: 'Share selected text with the agent',
    review: 'Review new output and select only non-sensitive text to share. Sharing records that text in the task.',
    sent: 'Submitted. Check the terminal response; if it asks you to retry, enter another response. Submission does not confirm authentication.',
    unknown: 'Delivery could not be confirmed. Input was not retried. Stop this terminal to avoid duplicate input.',
    disconnected: 'Connection to this terminal was lost. Input and Resume are paused. Reconnect to check the original process; nothing will be resent.',
    reconnect: 'Reconnect to original terminal', invalid: 'Not sent. Enter one line without control characters, up to 32 KB.',
    select: 'Select current non-sensitive text to share. The output may have changed; select it again.',
    target: 'Execution host', confirm: 'I checked the terminal and it is ready for the agent to continue',
    confirmHelp: 'Finish authentication and check the terminal response before returning control. Clear or submit any draft first.',
    password: 'SSH is requesting a password. Enter it below.', authentication_retry: 'SSH rejected authentication and is asking for the password again. Check the account and retry.',
    exited: 'The original terminal process exited. This handoff has ended; no replacement was started.',
    cancelled: 'Terminal stopped. This handoff was cancelled.', unavailable: 'The original terminal is no longer available. Control was not returned to the agent.',
  },
  'zh-CN': {
    waiting: '输入仅发送给此终端，Agent 正在等待。', resumed: '已交还 Agent，输出仍保持私密。',
    input: '私密终端输入', submit: '提交', resume: '让 Agent 继续', cancel: '取消并停止',
    shared: '已将所选观察分享给 Agent。', share: '将所选文字分享给 Agent', review: '请审阅新输出，只选择非敏感文字分享。分享的文字将记入任务。',
    sent: '已提交，请查看终端回应；如要求重试，请重新输入。提交不代表验证通过。',
    unknown: '无法确认投递结果，未自动重试。请停止此终端，避免重复输入。',
    disconnected: '与终端的连接已中断，已暂停输入和交还。请重新连接以检查原进程，不会重发输入。',
    reconnect: '重新连接原终端', invalid: '尚未发送。请输入不含控制字符的单行内容，最多 32 KB。',
    select: '请选择当前的非敏感文字。输出可能已变化，请重新选择。', target: '执行主机',
    confirm: '我已检查终端，确认可以让 Agent 继续操作', confirmHelp: '请完成验证并检查终端回应后再交还；先提交或清空尚未发送的内容。',
    password: 'SSH 正在请求密码，请在下方输入。', authentication_retry: 'SSH 拒绝了本次验证，正在重新请求密码。请核对账户后重试。',
    exited: '原终端进程已退出，本次接管已结束，未启动替代进程。', cancelled: '已停止终端并取消本次接管。', unavailable: '原终端已不可用，未将控制权交还 Agent。',
  },
  'zh-TW': {
    waiting: '輸入僅傳送給此終端，Agent 正在等待。', resumed: '已交還 Agent，輸出仍保持私密。',
    input: '私密終端輸入', submit: '提交', resume: '讓 Agent 繼續', cancel: '取消並停止',
    shared: '已將所選觀察分享給 Agent。', share: '將所選文字分享給 Agent', review: '請審閱新輸出，只選擇非敏感文字分享。分享的文字將記入任務。',
    sent: '已提交，請查看終端回應；如要求重試，請重新輸入。提交不代表驗證通過。',
    unknown: '無法確認投遞結果，未自動重試。請停止此終端，避免重複輸入。',
    disconnected: '與終端的連線已中斷，已暫停輸入及交還。請重新連線以檢查原行程，不會重送輸入。',
    reconnect: '重新連線原終端', invalid: '尚未傳送。請輸入不含控制字元的單行內容，最多 32 KB。',
    select: '請選擇目前的非敏感文字。輸出可能已變更，請重新選擇。', target: '執行主機',
    confirm: '我已檢查終端，確認可以讓 Agent 繼續操作', confirmHelp: '請完成驗證並檢查終端回應後再交還；先提交或清空尚未傳送的內容。',
    password: 'SSH 正在要求密碼，請在下方輸入。', authentication_retry: 'SSH 拒絕了本次驗證，正在重新要求密碼。請核對帳戶後重試。',
    exited: '原終端行程已結束，本次接管已結束，未啟動替代行程。', cancelled: '已停止終端並取消本次接管。', unavailable: '原終端已無法使用，未將控制權交還 Agent。',
  },
} satisfies UiCatalog<Record<string, string>>;
type Notice = '' | 'sent' | 'unknown' | 'invalid' | 'shared' | 'select';

export function TerminalHandoffPanel(props: {
  sessionId: string;
  request: NonNullable<RuntimeResourceHandoffResult['request']>;
  active: boolean;
}) {
  const { terminal } = useWorkbarServices();
  const locale = useUiLocale();
  const copy = COPY[locale];
  const [controllerId] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<RuntimeResourceHandoffResult>();
  const [notice, setNotice] = useState<Notice>('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [connected, setConnected] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [revision, setRevision] = useState(0);
  // Component-local only: never reuse chat drafts or generic form responses.
  const [privateInput, setPrivateInput] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const screen = useRef<HTMLPreElement>(null);
  const sending = useRef(false);
  const displayEpoch = useRef(0);
  const identity = { sessionId: props.sessionId, requestId: props.request.requestId, controllerId };

  function accept(result: RuntimeResourceHandoffResult) {
    setState(result);
    if (result.status === 'outcome_unknown') { setUncertain(true); setNotice('unknown'); }
    if (result.status === 'closed') { setNotice(''); setConfirmed(false); }
    if (result.rejection === 'controller_expired') { setConnected(false); setDisconnected(true); setConfirmed(false); }
    if (result.rejection === 'invalid_input') setNotice('invalid');
    if (result.rejection === 'observation_expired') setNotice('select');
  }

  useEffect(() => {
    if (!terminal.handoff || !props.active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const failed = () => {
      if (disposed) return;
      setConnected(false); setDisconnected(true); setConfirmed(false);
      if (input.current) input.current.value = '';
      setPrivateInput(''); setState((previous) => previous ? { ...previous, display: undefined } : previous);
    };
    const poll = async () => {
      const epoch = displayEpoch.current;
      try {
        const result = await terminal.handoff!({ ...identity, action: 'observe' });
        if (!disposed && epoch === displayEpoch.current) accept(result);
        if (!disposed && result.phase !== 'closed' && result.rejection !== 'controller_expired') timer = setTimeout(poll, 300);
      } catch { failed(); }
    };
    // Reclaim only the original resource. Input is never replayed on recovery.
    void terminal.handoff({ action: 'surface', sessionId: props.sessionId, available: true })
      .then(() => terminal.handoff!({ ...identity, action: 'ready' }))
      .then((result) => {
        if (disposed) { void terminal.handoff!({ ...identity, action: 'release' }).catch(() => {}); return; }
        setConnected(true); setDisconnected(false); accept(result);
        if (result.phase !== 'closed') void poll();
      }).catch(failed);
    return () => {
      disposed = true; displayEpoch.current++; clearTimeout(timer);
      if (input.current) input.current.value = '';
      setPrivateInput(''); setState(undefined); setConnected(false); setConfirmed(false);
      void terminal.handoff!({ ...identity, action: 'release' }).catch(() => {});
    };
  }, [terminal, props.sessionId, props.request.requestId, props.active, controllerId, revision]);

  async function submit() {
    const value = input.current?.value ?? '';
    if (sending.current || !state || state.phase !== 'human' || uncertain || !connected) return;
    if (!isValidPrivateTerminalInput(value)) { setNotice('invalid'); return; }
    sending.current = true; setBusy(true); setConfirmed(false);
    input.current!.value = ''; setPrivateInput('');
    const epoch = ++displayEpoch.current;
    try {
      const result = await terminal.handoff!({ ...identity, action: 'input', sequence: state.nextSequence, input: value });
      if (epoch !== displayEpoch.current) return;
      accept(result);
      if (result.status === 'written') setNotice('sent');
    } catch {
      if (epoch !== displayEpoch.current) return;
      setUncertain(true); setNotice('unknown'); setConnected(false); setDisconnected(true);
    } finally { sending.current = false; setBusy(false); }
  }

  async function answer(action: 'resume' | 'cancel') {
    if (sending.current || (action === 'resume' && (!connected || uncertain || !confirmed || privateInput || !state?.display || terminalFeedback(props.request.command, state.display.text)))) return;
    sending.current = true; setBusy(true);
    if (input.current) input.current.value = '';
    setPrivateInput(''); setConfirmed(false);
    const epoch = ++displayEpoch.current;
    setState((previous) => previous ? { ...previous, display: undefined } : previous);
    try {
      await terminal.answerHandoff!({ ...identity, action });
      const result = await terminal.handoff!({ ...identity, action: 'observe' });
      if (epoch !== displayEpoch.current) return;
      displayEpoch.current++; accept(result); setNotice('');
    } catch {
      if (epoch === displayEpoch.current) { setConnected(false); setDisconnected(true); }
    } finally { sending.current = false; setBusy(false); }
  }

  async function share() {
    const selection = window.getSelection();
    if (!state?.display || !selection?.anchorNode || !screen.current?.contains(selection.anchorNode) || !screen.current.contains(selection.focusNode)) { setNotice('select'); return; }
    const text = selection.toString();
    if (!text) { setNotice('select'); return; }
    try {
      const result = await terminal.handoff!({ ...identity, action: 'share', sequence: state.display.sequence, text });
      if (result.status === 'shared') setNotice('shared'); else accept(result);
    } catch { setNotice('select'); }
  }

  const human = state?.phase === 'human';
  const closed = state?.phase === 'closed';
  const host = parseDesktopSessionKey(props.sessionId)?.hostId ?? props.sessionId;
  const hint = human && connected && state?.display ? terminalFeedback(props.request.command, state.display.text) : undefined;
  return <section className="maka-terminal-handoff" data-testid="terminal-handoff">
    <header><strong>{props.request.message}</strong><small title={host}>{copy.target}: {host.slice(0, 12)}</small><code>{props.request.command}</code><small title={props.request.ref}>{props.request.ref}</small></header>
    {closed ? <Banner status={state.closure === 'cancelled' ? 'info' : 'warning'} title={copy[state.closure ?? 'unavailable']} /> :
      <p role="status">{human ? copy.waiting : state?.phase === 'resumed' ? copy.resumed : ''}</p>}
    <pre ref={screen} className="maka-terminal-handoff-screen" aria-hidden="true" data-private-terminal="true">{props.active ? state?.display?.text : ''}</pre>
    {disconnected && !closed && <Banner status="warning" title={copy.disconnected} />}
    {hint && <Banner status={hint === 'authentication_retry' ? 'error' : 'info'} title={copy[hint]} />}
    {notice && !closed && <Banner status={notice === 'invalid' || notice === 'unknown' ? 'error' : 'info'} title={copy[notice]} />}
    {human && <ChatComposer className="maka-composer-astryx" onSubmit={() => {}}
      input={<TextInput ref={input} label={copy.input} type="password" autoComplete="off"
        value={privateInput} onChange={(value) => { setPrivateInput(value); setConfirmed(false); if (notice === 'invalid') setNotice(''); }} isDisabled={busy || uncertain || !connected} width="100%"
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (!isImeKeyEvent(event.nativeEvent)) void submit(); } }} />}
      footerActions={<Button label={copy.cancel} variant="ghost" size="sm" onClick={() => void answer('cancel')} isDisabled={busy} />}
      sendButton={<Button label={copy.submit} size="sm" onClick={() => void submit()} isDisabled={busy || uncertain || !connected || !privateInput} />}
    />}
    {human && <><p>{copy.confirmHelp}</p><CheckboxInput label={copy.confirm} value={confirmed} onChange={setConfirmed} isDisabled={busy || uncertain || !connected || Boolean(privateInput) || Boolean(hint) || !state?.display} /></>}
    {state?.phase === 'resumed' && <p>{copy.review}</p>}
    <footer>
      {!human && !closed && state?.phase !== 'resumed' && <Button label={copy.cancel} variant="secondary" size="sm" onClick={() => void answer('cancel')} isDisabled={busy} />}
      {disconnected && !closed && <Button label={copy.reconnect} variant="secondary" size="sm" onClick={() => setRevision((value) => value + 1)} isDisabled={busy} />}
      {human && <Button label={copy.resume} size="sm" onClick={() => void answer('resume')} isDisabled={busy || uncertain || !connected || !confirmed || Boolean(privateInput) || Boolean(hint) || !state?.display} />}
      {state?.phase === 'resumed' && <Button label={copy.share} size="sm" onClick={() => void share()} isDisabled={!connected} />}
    </footer>
  </section>;
}
