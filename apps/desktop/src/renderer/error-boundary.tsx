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

// apps/desktop/src/renderer/error-boundary.tsx
//
// Top-level React error boundary. If anything in the renderer throws during
// render or in a lifecycle method, the boundary catches it and shows a
// friendly fallback with stack details and a "Try again" button instead of a
// blank white window (the old behavior — a Vite/Electron renderer that
// crashed early just left the user staring at an empty viewport).

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import type { UiLocale } from '@maka/core/ui-locale';
import { ICON_SIZE, AlertTriangle, Check, Clipboard, RotateCw } from '@maka/ui/icons';
import { Button as UiButton, Card, redactSecrets } from '@maka/ui';
import { getShellCopy } from './locales/shell-copy.js';

type State = {
  error: Error | null;
  errorInfo: ErrorInfo | null;
  copyState: 'idle' | 'pending' | 'copied' | 'failed';
};

const RENDERER_ERROR_DETAILS_MAX_BYTES = 24 * 1024;
const RENDERER_USER_AGENT_MAX_BYTES = 2 * 1024;
const RENDERER_LOCATION_MAX_BYTES = 8 * 1024;
export const RENDERER_ERROR_REPORT_MAX_BYTES = 32 * 1024;
const RENDERER_FIELD_TRUNCATION_MARKER = '\n<renderer diagnostic field truncated>';
const RENDERER_REPORT_TRUNCATION_MARKER = '\n<renderer diagnostic report truncated>';

export function formatRendererErrorReport(error: Error, info?: ErrorInfo | null): string {
  const lines = [
    'Maka renderer error report',
    `Captured at: ${new Date().toISOString()}`,
    '',
    boundedRendererField(formatRendererErrorDetails(error, info), RENDERER_ERROR_DETAILS_MAX_BYTES),
  ];
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    lines.push(
      '',
      `User agent: ${boundedRendererField(navigator.userAgent, RENDERER_USER_AGENT_MAX_BYTES)}`,
    );
  }
  if (typeof window !== 'undefined' && window.location?.href) {
    lines.push(
      `Location: ${boundedRendererField(window.location.href, RENDERER_LOCATION_MAX_BYTES)}`,
    );
  }
  return truncateUtf8(
    redactSecrets(lines.join('\n')),
    RENDERER_ERROR_REPORT_MAX_BYTES,
    RENDERER_REPORT_TRUNCATION_MARKER,
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode; locale: UiLocale }, State> {
  state: State = { error: null, errorInfo: null, copyState: 'idle' };
  private mounted = false;
  private copyRequestSeq = 0;

  static getDerivedStateFromError(error: Error): State {
    return { error, errorInfo: null, copyState: 'idle' };
  }

  componentDidMount(): void {
    this.mounted = true;
  }

  componentWillUnmount(): void {
    this.mounted = false;
    this.copyRequestSeq += 1;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // In Electron's renderer this lands in DevTools console + main-process
    // stderr via the contextBridge logging path.
    console.error('Maka renderer error boundary caught:', error, info);
    this.copyRequestSeq += 1;
    this.setState({ errorInfo: info });
  }

  private handleReset = () => {
    this.copyRequestSeq += 1;
    this.setState({ error: null, errorInfo: null, copyState: 'idle' });
  };

  private handleReload = () => {
    this.copyRequestSeq += 1;
    window.location.reload();
  };

  private isCurrentCopyRequest(copyRequestId: number, error: Error): boolean {
    return this.mounted && this.copyRequestSeq === copyRequestId && this.state.error === error;
  }

  private handleCopyReport = async () => {
    const { error, errorInfo } = this.state;
    if (!error || this.state.copyState === 'pending') return;
    const copyRequestId = ++this.copyRequestSeq;
    this.setState({ copyState: 'pending' });
    try {
      const diagnostics = window.maka?.diagnostics;
      if (diagnostics) {
        await diagnostics.copyReport({
          surface: 'renderer_crash',
          title: `${error.name}: ${error.message}`,
          details: formatRendererErrorDetails(error, errorInfo),
        });
      } else {
        await navigator.clipboard.writeText(formatRendererErrorReport(error, errorInfo));
      }
      if (this.isCurrentCopyRequest(copyRequestId, error)) this.setState({ copyState: 'copied' });
    } catch {
      if (this.isCurrentCopyRequest(copyRequestId, error)) this.setState({ copyState: 'failed' });
    }
  };

  render(): ReactNode {
    const { error, errorInfo, copyState } = this.state;
    if (!error) return this.props.children;
    const safeStack = redactSecrets(`${error.name}: ${error.message}${error.stack ? `\n\n${error.stack}` : ''}`);
    const copyPending = copyState === 'pending';
    const copy = getShellCopy(this.props.locale).errorBoundary;
    const copyLabel = copyPending
      ? copy.copyPending
      : copyState === 'copied'
        ? copy.copied
        : copyState === 'failed'
          ? copy.copyFailed
          : copy.copyReport;
    const CopyIcon = copyState === 'copied' ? Check : Clipboard;

    return (
      <div className="maka-error-surface" role="alert" aria-live="assertive">
        {/* Astryx Card owns the card face: red tint for the destructive
            surface, high elevation for the former shadow-modal. The class
            keeps only the icon/copy grid geometry. */}
        <Card variant="red" elevation="high" padding={0} className="maka-error-card">
          <span className="maka-error-icon" aria-hidden="true">
            <AlertTriangle size={ICON_SIZE.empty} /> {/* 20 in the 32px plate — the ladder's fill convention */}
          </span>
          <div className="maka-error-copy">
            <h2>{copy.title}</h2>
            <p>
              {copy.descriptionBeforeRetry} <strong>{copy.retry}</strong> {copy.descriptionBeforeReload}{' '}
              <strong>{copy.reload}</strong> {copy.descriptionAfterReload}
            </p>
            <pre className="maka-error-stack" role="group" aria-label={copy.errorDetails}>
              {safeStack}
            </pre>
            {errorInfo?.componentStack && (
              <pre className="maka-error-stack" role="group" aria-label={copy.componentStack}>
                {redactSecrets(errorInfo.componentStack.trim())}
              </pre>
            )}
            <div className="maka-error-actions">
              <UiButton
                variant="secondary"
                className="maka-error-copy-action"
                data-copy-state={copyState}
                isDisabled={copyPending}
                aria-busy={copyPending ? 'true' : undefined}
                onClick={this.handleCopyReport}
                icon={<CopyIcon size={ICON_SIZE.control} aria-hidden="true" />}
                label={copyLabel}
              />
              <UiButton
                variant="secondary"
                onClick={this.handleReset}
                icon={<RotateCw size={ICON_SIZE.control} aria-hidden="true" />}
                label={copy.retry}
              />
              <UiButton variant="primary" onClick={this.handleReload} label={copy.reload} />
            </div>
            {copyState === 'failed' && <p className="maka-error-copy-status">{copy.clipboardFailure}</p>}
          </div>
        </Card>
      </div>
    );
  }
}

function formatRendererErrorDetails(error: Error, info?: ErrorInfo | null): string {
  const lines = [`${error.name}: ${error.message}`];
  if (error.stack) lines.push('', 'Stack:', error.stack);
  if (info?.componentStack) {
    lines.push('', 'React component stack:', info.componentStack.trim());
  }
  return redactSecrets(lines.join('\n'));
}

function boundedRendererField(value: string, maximumBytes: number): string {
  return truncateUtf8(redactSecrets(value), maximumBytes, RENDERER_FIELD_TRUNCATION_MARKER);
}
