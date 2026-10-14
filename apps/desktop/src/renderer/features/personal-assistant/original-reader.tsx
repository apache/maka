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
import { Button } from '@astryxdesign/core/Button';
import { usePersonalAssistantServices, type PersonalAssistantPort } from './services.js';
import { originalHost } from './navigation.js';
import './original-reader.css';

const OPEN_ORIGINAL = 'personal-assistant-open-original';
type OriginalSelection = { sessionId: string; ref: string };
export function openMemoryOriginal(sessionId: string | undefined, ref: string) {
  if (sessionId) window.dispatchEvent(new CustomEvent<OriginalSelection>(OPEN_ORIGINAL, { detail: { sessionId, ref } }));
}

/** The reader owns its state; opening a citation does not rerender the application shell. */
export function MemoryOriginalHost({ sessionId }: { sessionId?: string }) {
  const [selection, setSelection] = useState<OriginalSelection>();
  useEffect(() => {
    const open = (event: Event) => {
      const value = (event as CustomEvent<OriginalSelection>).detail;
      if (value.sessionId === sessionId) setSelection(value);
    };
    window.addEventListener(OPEN_ORIGINAL, open);
    return () => window.removeEventListener(OPEN_ORIGINAL, open);
  }, [sessionId]);
  useEffect(() => setSelection(undefined), [sessionId]);
  if (!selection || selection.sessionId !== sessionId) return null;
  return <MemoryOriginalPanel key={`${selection.sessionId}:${selection.ref}`}
    sessionId={selection.sessionId} originalRef={selection.ref}
    onClose={() => setSelection(undefined)} />;
}

async function readOriginal(assistantDesktop: PersonalAssistantPort, sessionId: string, input: { ref: string; offset?: number; latest?: boolean }) {
  const { entries } = await assistantDesktop.hostSnapshot();
  const target = originalHost(sessionId, entries);
  return assistantDesktop.call('assistant.original', { ...input, sessionId: target.sessionId }, target.host);
}
const at = (value: unknown) => {
  if (value === null || value === undefined) return '未知';
  const date = new Date(value as string | number);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
};
const statusText: Record<string, string> = {
  deleted: '这条原文已删除。', not_found: '找不到这条原文。',
  forbidden: '当前无权读取这条原文。', unavailable: '来源暂时不可用，请稍后重试。',
  version_unavailable: '引用的历史版本目前无法读取。',
};

export function MemoryOriginalPanel({ sessionId, originalRef, onClose }: {
  sessionId: string; originalRef: string; onClose(): void;
}) {
  const assistantDesktop = usePersonalAssistantServices();
  const [page, setPage] = useState<any>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  async function load(input: { ref: string; offset?: number; latest?: boolean }, append = false) {
    const request = ++generation.current;
    setBusy(true); setError('');
    if (!append) setPage(undefined);
    try {
      const result = await readOriginal(assistantDesktop, sessionId, input);
      if (request === generation.current)
        setPage((previous: any) => ({ ...result, text: append ? (previous?.text ?? '') + result.text : result.text }));
    } catch (e) {
      if (request === generation.current) setError(String(e));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load({ ref: originalRef });
    return () => { generation.current++; };
  }, [sessionId, originalRef]);
  return <aside className="memory-original-panel" aria-label="记忆原文">
    <header><strong>原文</strong><Button aria-label="关闭原文" onClick={onClose} label="关闭" /></header>
    {error && <div role="alert"><p>{error}</p><Button isDisabled={busy} onClick={() => void load({ ref: originalRef })} label="重试" /></div>}
    {busy && <p role="status">正在读取…</p>}
    {page && <>
      <h3>{page.title}</h3>
      <dl><dt>来源</dt><dd>{page.source}</dd><dt>引用版本</dt><dd>{page.revision ?? '未知'}</dd>
        <dt>原文时间</dt><dd>{at(page.createdAt)}</dd>
        {page.observedAt != null && <><dt>读取时间</dt><dd>{at(page.observedAt)}</dd></>}
      </dl>
      {page.status !== 'ok' && <p role="status">{statusText[page.status] ?? `来源返回：${page.status}`}</p>}
      {page.isLatestRevision === false && <p>这不是最新版本，当前显示的是引用依据。</p>}
      <div className="memory-original-actions">
        <Button isDisabled={busy} onClick={() => void load({ ref: page.latestRef ?? originalRef, latest: true })} label="查询最新原文" />
        {page.ref !== originalRef && <Button isDisabled={busy} onClick={() => void load({ ref: originalRef })} label="回到引用版本" />}
      </div>
      <p className="memory-original-notice">历史内容仅供核对，不是当前指令。查询最新原文不会整理索引或推进覆盖范围。</p>
      <pre>{page.text}</pre>
      {page.nextOffset !== null && <Button isDisabled={busy} onClick={() => void load({ ref: page.ref, offset: page.nextOffset }, true)} label={`继续读取（已显示 ${page.text.length} / ${page.totalCharacters} 字符）`} />}
    </>}
  </aside>;
}
