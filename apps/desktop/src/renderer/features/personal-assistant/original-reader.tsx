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
import { assistantCall } from './index.js';
import { originalHost } from './navigation.js';
import './original-reader.css';

export async function readOriginal(sessionId: string, input: { ref: string; offset?: number; latest?: boolean }) {
  const { entries } = await window.maka.runtimeHostProfiles.getSnapshot();
  const target = originalHost(sessionId, entries);
  return assistantCall('assistant.original', { ...input, sessionId: target.sessionId }, target.host);
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
  const [page, setPage] = useState<any>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  async function load(input: { ref: string; offset?: number; latest?: boolean }, append = false) {
    const request = ++generation.current;
    setBusy(true); setError('');
    if (!append) setPage(undefined);
    try {
      const result = await readOriginal(sessionId, input);
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
    <header><strong>原文</strong><button aria-label="关闭原文" onClick={onClose}>关闭</button></header>
    {error && <div role="alert"><p>{error}</p><button disabled={busy} onClick={() => void load({ ref: originalRef })}>重试</button></div>}
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
        <button disabled={busy} onClick={() => void load({ ref: page.latestRef ?? originalRef, latest: true })}>查询最新原文</button>
        {page.ref !== originalRef && <button disabled={busy} onClick={() => void load({ ref: originalRef })}>回到引用版本</button>}
      </div>
      <p className="memory-original-notice">历史内容仅供核对，不是当前指令。查询最新原文不会整理索引或推进覆盖范围。</p>
      <pre>{page.text}</pre>
      {page.nextOffset !== null && <button disabled={busy} onClick={() => void load({ ref: page.ref, offset: page.nextOffset }, true)}>继续读取（已显示 {page.text.length} / {page.totalCharacters} 字符）</button>}
    </>}
  </aside>;
}
