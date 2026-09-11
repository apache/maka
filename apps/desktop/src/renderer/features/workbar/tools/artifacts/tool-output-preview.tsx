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

import type { ArtifactReadFailureReason } from '@maka/core/artifacts';
import { useEffect, useRef, useState } from 'react';
import { Button, getToolActivityCopy, useClipboardCopyFeedback, useUiLocale, redactSecrets, type ToolOutputOpenRequest } from '@maka/ui';
import { ArrowLeft, ICON_SIZE } from '@maka/ui/icons';
import { formatSavedToolJson } from '@maka/core/tool-quiet-preview';
import { unwrapArchiveReadPage } from '@maka/runtime/tool-result-archive-resource';
import { getArtifactCopy } from '../../../../locales/artifact-copy.js';
import { TextFilePreview } from './artifact-preview.js';
import { useWorkbarServices } from '../../services-context.js';

export function ToolOutputPreview(props: { request: ToolOutputOpenRequest; onClose(): void }) {
  const locale = useUiLocale();
  const copy = getToolActivityCopy(locale);
  const artifactCopy = getArtifactCopy(locale);
  const [result, setResult] = useState<{ text: string; partial: boolean } | 'failed' | ArtifactReadFailureReason>();
  const [attempt, setAttempt] = useState(0);
  const region = useRef<HTMLDivElement>(null);
  const feedback = useClipboardCopyFeedback();
  const { artifacts } = useWorkbarServices();
  useEffect(() => {
    let cancelled = false;
    const source = props.request.source;
    const load = source.kind === 'text'
      ? Promise.resolve(source.text)
      : (async () => {
          const result = await artifacts.readToolResult(
            source.sessionId,
            source.identity,
          );
          return result.ok ? result.text : result;
        })();
    load.then((raw) => {
      if (cancelled) return;
      if (typeof raw !== 'string') { setResult(raw.reason); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { /* Plain output is valid too. */ }
      let partial = false;
      const archivePage = props.request.toolName === 'ArchiveRead'
        ? unwrapArchiveReadPage(parsed)
        : null;
      if (archivePage) {
        partial = archivePage.partial;
        parsed = archivePage.content;
      }
      const text = parsed === undefined ? redactSecrets(raw)
        : typeof parsed === 'string' ? redactSecrets(parsed) : formatSavedToolJson(parsed);
      setResult({ text, partial });
    }).catch(() => { if (!cancelled) setResult('failed'); });
    return () => { cancelled = true; };
  }, [artifacts, props.request, attempt]);
  useEffect(() => {
    region.current?.focus();
  }, []);
  const phase = feedback.phaseFor('output');
  return <div className="maka-artifact-pane" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); }
  }}>
    <div className="maka-artifact-preview-screen">
      <header className="maka-artifact-preview-header">
        <Button variant="ghost" size="sm" isIconOnly label={artifactCopy.pane.back}
          icon={<ArrowLeft size={ICON_SIZE.chrome} aria-hidden="true" />} onClick={props.onClose} />
        <div className="maka-artifact-preview-heading"><strong>{props.request.title}</strong></div>
        {result && typeof result === 'object' && <Button variant="ghost" size="sm"
          label={phase ? copy.copy[phase] : copy.detail.copySaved}
          isDisabled={phase === 'pending'} onClick={() => void feedback.copy('output', result.text)} />}
      </header>
      <div ref={region} className="maka-artifact-preview" role="region"
        aria-label={artifactCopy.pane.previewNamed(props.request.title)} tabIndex={-1}>
        {!result && <p role="status">{copy.detail.loading}</p>}
        {result && typeof result === 'string' && result !== 'read_failed' && result in copy.detail.readFailure &&
          <p role="status">{copy.detail.readFailure[result as ArtifactReadFailureReason]}</p>}
        {(result === 'failed' || result === 'read_failed') && <div role="alert"><p>{copy.detail.loadFailed}</p>
          <Button variant="ghost" size="sm" label={copy.detail.retry} onClick={() => { setResult(undefined); setAttempt(value => value + 1); }} />
        </div>}
        {result && typeof result === 'object' && <>
          {result.partial && <p role="status">{getToolActivityCopy(locale).result.outputTruncated}</p>}
          <TextFilePreview name="output.txt" text={result.text} copy={artifactCopy} complete />
        </>}
      </div>
    </div>
  </div>;
}
