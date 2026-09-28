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
import { Button, IconButton, InputGroup, InputGroupText, useUiLocale } from '@maka/ui';
import { Eye, EyeOff, ICON_SIZE } from '@maka/ui/icons';
import type { UiCatalog } from '@maka/core/ui-locale';
import { Banner, ChatComposer, TextInput, isImeKeyEvent } from '@astryxdesign/core';
import type { RuntimeResourceHandoffResult } from '@maka/runtime-host/protocol';
import { useWorkbarServices } from '../../services-context.js';
import { parseDesktopSessionKey } from '../../../../../shared/runtime-host-identity.js';
import { isValidPrivateTerminalInput, terminalFeedback } from './terminal-handoff-feedback.js';

const COPY = {
  en: {
    waiting: 'The agent is waiting for your private input.', details: 'Connection details',
    input: 'Private terminal input', submit: 'Submit', resume: 'Done, continue task', cancel: 'Cancel and stop',
    show: 'Show input', hide: 'Hide input',
    sent: 'Submitted. Check the terminal response.',
    unknown: 'Delivery is uncertain. Stop this terminal to avoid duplicate input.',
    disconnected: 'Connection lost. Reconnect to the original terminal; input will not be resent.',
    reconnect: 'Reconnect to original terminal', invalid: 'Not sent. Enter one line without control characters, up to 32 KB.',
    target: 'Execution host',
    password: 'Enter the SSH password below.', authentication_retry: 'SSH rejected authentication. Check the password and try again.',
    exited: 'The original terminal process exited.',
    cancelled: 'Terminal stopped.', unavailable: 'The original terminal is unavailable.',
  },
  'zh-CN': {
    waiting: 'Agent 正在等待你的私密输入。', details: '连接详情',
    input: '私密终端输入', submit: '提交', resume: '已完成，继续任务', cancel: '取消并停止',
    show: '显示输入', hide: '隐藏输入',
    sent: '已提交，请查看终端回应。',
    unknown: '无法确认是否送达，请停止此终端，避免重复输入。',
    disconnected: '连接已中断，请重新连接原终端。输入不会重发。',
    reconnect: '重新连接原终端', invalid: '尚未发送。请输入不含控制字符的单行内容，最多 32 KB。',
    target: '执行主机',
    password: '请在下方输入 SSH 密码。', authentication_retry: 'SSH 验证未通过，请核对密码后重试。',
    exited: '原终端进程已退出。', cancelled: '已停止终端。', unavailable: '原终端已不可用。',
  },
  'zh-TW': {
    waiting: 'Agent 正在等待你的私密輸入。', details: '連線詳情',
    input: '私密終端輸入', submit: '提交', resume: '已完成，繼續任務', cancel: '取消並停止',
    show: '顯示輸入', hide: '隱藏輸入',
    sent: '已提交，請查看終端回應。',
    unknown: '無法確認是否送達，請停止此終端，避免重複輸入。',
    disconnected: '連線已中斷，請重新連線原終端。輸入不會重送。',
    reconnect: '重新連線原終端', invalid: '尚未傳送。請輸入不含控制字元的單行內容，最多 32 KB。',
    target: '執行主機',
    password: '請在下方輸入 SSH 密碼。', authentication_retry: 'SSH 驗證未通過，請核對密碼後重試。',
    exited: '原終端行程已結束。', cancelled: '已停止終端。', unavailable: '原終端已無法使用。',
  },
} satisfies UiCatalog<Record<string, string>>;
type Notice = '' | 'sent' | 'unknown' | 'invalid';

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
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [revision, setRevision] = useState(0);
  // Component-local only: never reuse chat drafts or generic form responses.
  const [privateInput, setPrivateInput] = useState('');
  const [visible, setVisible] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const displayEpoch = useRef(0);
  const identity = { sessionId: props.sessionId, requestId: props.request.requestId, controllerId };
  const connected = connection === 'connected';
  const disconnected = connection === 'disconnected';
  // An ambiguous local send stays latched even if a later poll looks healthy.
  const uncertain = notice === 'unknown' || state?.status === 'outcome_unknown';

  function accept(result: RuntimeResourceHandoffResult) {
    setState(result);
    if (result.status === 'outcome_unknown') setNotice('unknown');
    if (result.status === 'closed') { setNotice(''); setVisible(false); }
    if (result.rejection === 'controller_expired') { setConnection('disconnected'); setVisible(false); }
    if (result.rejection === 'invalid_input') setNotice((previous) => previous === 'unknown' ? previous : 'invalid');
  }

  useEffect(() => {
    if (!terminal.handoff || !props.active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const failed = () => {
      if (disposed) return;
      setConnection('disconnected'); setVisible(false);
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
        setConnection('connected'); accept(result);
        if (result.phase !== 'closed') void poll();
      }).catch(failed);
    return () => {
      disposed = true; displayEpoch.current++; clearTimeout(timer);
      if (input.current) input.current.value = '';
      setPrivateInput(''); setVisible(false); setState((previous) => previous ? { ...previous, display: undefined } : previous); setConnection('connecting');
      void terminal.handoff!({ ...identity, action: 'release' }).catch(() => {});
    };
  }, [terminal, props.sessionId, props.request.requestId, props.active, controllerId, revision]);

  async function submit() {
    const value = input.current?.value ?? '';
    if (sending.current || !state || state.phase !== 'human' || uncertain || !connected) return;
    if (!isValidPrivateTerminalInput(value)) { setNotice('invalid'); return; }
    sending.current = true; setBusy(true);
    input.current!.value = ''; setPrivateInput(''); setVisible(false);
    const epoch = ++displayEpoch.current;
    try {
      const result = await terminal.handoff!({ ...identity, action: 'input', sequence: state.nextSequence, input: value });
      if (epoch !== displayEpoch.current) return;
      accept(result);
      if (result.status === 'written') setNotice((previous) => previous === 'unknown' ? previous : 'sent');
    } catch {
      if (epoch !== displayEpoch.current) return;
      setNotice('unknown'); setConnection('disconnected');
    } finally { sending.current = false; setBusy(false); }
  }

  async function answer(action: 'resume' | 'cancel') {
    if (sending.current || (action === 'resume' && (!connected || uncertain || privateInput || !state?.display || terminalFeedback(props.request.command, state.display.text)))) return;
    sending.current = true; setBusy(true);
    if (input.current) input.current.value = '';
    setPrivateInput(''); setVisible(false);
    const epoch = ++displayEpoch.current;
    setState((previous) => previous ? { ...previous, display: undefined } : previous);
    try {
      await terminal.answerHandoff!({ ...identity, action });
      const result = await terminal.handoff!({ ...identity, action: 'observe' });
      if (epoch !== displayEpoch.current) return;
      displayEpoch.current++; accept(result); setNotice('');
    } catch {
      if (epoch === displayEpoch.current) setConnection('disconnected');
    } finally { sending.current = false; setBusy(false); }
  }

  const human = state?.phase === 'human';
  const closed = state?.phase === 'closed';
  const host = parseDesktopSessionKey(props.sessionId)?.hostId ?? props.sessionId;
  const hint = human && connected && state?.display ? terminalFeedback(props.request.command, state.display.text) : undefined;
  const problem = uncertain ? 'unknown' : disconnected ? 'disconnected' : notice === 'invalid' ? 'invalid' : hint === 'authentication_retry' ? hint : undefined;
  const response = <pre className="maka-terminal-handoff-screen" aria-hidden="true" data-private-terminal="true">{props.active ? state?.display?.text : ''}</pre>;
  const reconnect = disconnected && !closed && <Button label={copy.reconnect} variant="secondary" size="sm" onClick={() => setRevision((value) => value + 1)} isDisabled={busy} />;
  // Keep the private transport/capture fence, but the completed input UI has no
  // reason to occupy the terminal. A later handoff mounts a fresh input card.
  if (state?.phase === 'resumed' || closed) return <section className="maka-session-terminal-panel" data-testid="private-terminal">
    {closed ? <Banner status={state.closure === 'cancelled' ? 'info' : 'warning'} title={copy[state.closure ?? 'unavailable']} /> :
      problem && <Banner status="warning" title={copy[problem]} />}
    {response}
    {reconnect}
  </section>;
  return <section className="maka-terminal-handoff" data-testid="terminal-handoff">
    <header><strong>{copy.input}</strong><code>{props.request.command}</code></header>
    <details><summary>{copy.details}</summary><p>{props.request.message}</p><small>{copy.target}: {host}</small><code>{props.request.ref}</code></details>
    {response}
    {problem ? <Banner status={problem === 'disconnected' ? 'warning' : 'error'} title={copy[problem]} /> :
      human && <p role="status">{hint ? copy[hint] : notice === 'sent' ? copy.sent : copy.waiting}</p>}
    {human && <ChatComposer className="maka-composer-astryx" onSubmit={() => {}}
      input={<InputGroup label={copy.input} data-maka-assistant-exclude isDisabled={busy || uncertain || !connected}>
        <TextInput ref={input} label={copy.input} isLabelHidden type={visible ? 'text' : 'password'} autoComplete="off"
          value={privateInput} onChange={(value) => { setPrivateInput(value); if (!value) setVisible(false); if (notice === 'invalid') setNotice(''); }} isDisabled={busy || uncertain || !connected} width="100%"
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (!isImeKeyEvent(event.nativeEvent)) void submit(); } }} />
        <InputGroupText><IconButton label={visible ? copy.hide : copy.show} variant="ghost" size="sm" aria-pressed={visible}
          icon={visible ? <EyeOff size={ICON_SIZE.chrome} aria-hidden="true" /> : <Eye size={ICON_SIZE.chrome} aria-hidden="true" />}
          isDisabled={busy || uncertain || !connected} onClick={() => setVisible((value) => !value)} /></InputGroupText>
      </InputGroup>}
      footerActions={<Button label={copy.cancel} variant="ghost" size="sm" onClick={() => void answer('cancel')} isDisabled={busy} />}
      sendButton={<Button label={copy.submit} size="sm" onClick={() => void submit()} isDisabled={busy || uncertain || !connected || !privateInput} />}
    />}
    <footer>
      {!human && <Button label={copy.cancel} variant="secondary" size="sm" onClick={() => void answer('cancel')} isDisabled={busy} />}
      {reconnect}
      {human && <Button label={copy.resume} size="sm" onClick={() => void answer('resume')} isDisabled={busy || uncertain || !connected || Boolean(privateInput) || Boolean(hint) || !state?.display} />}
    </footer>
  </section>;
}
