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

import type { IPage } from '@jackwener/opencli/types';
import type { PreviewPreflightResult } from '../preview-preflight.js';
import type { BrowserOriginLease } from './browser-host.js';

export interface BrowserVerificationResult {
  readonly kind: 'browser_verification';
  readonly action: 'navigate' | 'snapshot' | 'click';
  readonly status: 'completed' | 'failed' | 'timeout' | 'unsupported' | 'unknown' | 'invalidated';
  readonly opened: boolean;
  /** Browser load only; target content and requested interactions still need observation. */
  readonly loaded: boolean;
  /** Observed URL, sanitized. Never populated from the requested URL. */
  readonly url: string | null;
  readonly title: string | null;
  readonly documentId?: string;
  readonly matchesRequestedUrl?: boolean;
  readonly snapshot?: string;
  readonly click?: {
    readonly matches: number;
    readonly confidence: string;
    readonly interaction: 'not_verified';
  };
  readonly evidence: readonly string[];
  readonly preflight?: PreviewPreflightResult;
  readonly error?: { readonly code: string; readonly message: string };
  readonly summary: string;
}

export class BrowserEvidenceError extends Error {
  constructor(
    readonly status: Exclude<BrowserVerificationResult['status'], 'completed'>,
    readonly code: string,
    message: string,
    readonly evidence: readonly string[] = [],
  ) {
    super(message);
  }
}

/** Managed preview paths are bearer capabilities, including when printed inside a snapshot. */
export function redactPreviewCapabilities(value: string): string {
  return value.replace(/\/[a-f0-9]{64}\/index\.html/gi, '/[preview-token]/index.html');
}

export function observedPageUrl(value: string): string {
  const url = new URL(value);
  return redactPreviewCapabilities(`${url.origin}${url.pathname}`);
}

/** One DOM read, fenced by the existing page-host lease and controller load facts. */
export async function observeDocument(page: IPage, lease: BrowserOriginLease, afterGoto = false) {
  const before = lease.snapshot();
  const document = before.document;
  if (!document)
    throw new BrowserEvidenceError(
      'unknown',
      'unobserved',
      'Controller load evidence is unavailable.',
    );
  if (!document.alive)
    throw new BrowserEvidenceError('invalidated', 'page_closed', 'The browser page was closed.');
  if (document.load?.state === 'stopped') {
    throw new BrowserEvidenceError(
      'invalidated',
      'load_stopped',
      'The document load was stopped before completion.',
      ['controller_load_stopped'],
    );
  }
  if (document.load?.state === 'failed') {
    throw new BrowserEvidenceError(
      'failed',
      'load_failed',
      `The target document failed to load (browser error ${document.load.errorCode}).`,
      ['controller_load_failure'],
    );
  }
  if (document.loadError) {
    throw new BrowserEvidenceError(
      'failed',
      'load_failed',
      `The target document failed to load (browser error ${document.loadError.code}).`,
      ['controller_load_error'],
    );
  }
  if (document.httpStatus !== null && document.httpStatus >= 400) {
    throw new BrowserEvidenceError(
      'failed',
      'load_failed',
      `The target document returned HTTP ${document.httpStatus}.`,
      ['controller_http_status'],
    );
  }
  if (document.loading)
    throw new BrowserEvidenceError(
      afterGoto ? 'timeout' : 'unknown',
      'document_loading',
      afterGoto
        ? 'The document has not finished loading within the browser action budget.'
        : 'The current document is still loading; no completed load was observed.',
      ['controller_load_state'],
    );
  if (document.load?.state !== 'completed') {
    throw new BrowserEvidenceError(
      'unknown',
      'load_unobserved',
      'No completed load was observed for the current document.',
      ['controller_load_state'],
    );
  }
  const observed = await page.evaluate<{ url: string; title: string }>(
    '({ url: window.location.href, title: document.title })',
  );
  const after = lease.snapshot();
  if (
    before.epoch !== after.epoch ||
    !after.document?.alive ||
    before.document?.viewId !== after.document.viewId ||
    document.load.navigationId !== after.document.load?.navigationId
  ) {
    throw new BrowserEvidenceError(
      'invalidated',
      'document_changed',
      'The document changed during observation.',
    );
  }
  if (
    !observed ||
    typeof observed.url !== 'string' ||
    typeof observed.title !== 'string' ||
    observed.url !== after.url ||
    !/^https?:\/\//.test(observed.url)
  ) {
    throw new BrowserEvidenceError(
      'unknown',
      'unobserved',
      'Could not confirm the current HTTP document location and title.',
    );
  }
  if (
    after.document.load?.state !== 'completed' ||
    after.document.loading ||
    after.document.loadError ||
    (after.document.httpStatus !== null && after.document.httpStatus >= 400)
  ) {
    throw new BrowserEvidenceError(
      'invalidated',
      'document_changed',
      'The document load state changed during observation.',
    );
  }
  return {
    url: observedPageUrl(observed.url),
    rawUrl: observed.url,
    title: redactPreviewCapabilities(observed.title),
    documentId: `${document.viewId}:${before.epoch}`,
  };
}

export function verificationFailure(
  action: BrowserVerificationResult['action'],
  error: unknown,
): BrowserVerificationResult {
  // Do not copy raw CDP error messages: they can contain the requested bearer URL.
  const timeout = error instanceof Error && /timed?\s*out/i.test(error.message);
  const status =
    error instanceof BrowserEvidenceError ? error.status : timeout ? 'timeout' : 'failed';
  const code =
    error instanceof BrowserEvidenceError
      ? error.code
      : timeout
        ? 'timeout'
        : 'browser_action_failed';
  const message =
    error instanceof BrowserEvidenceError
      ? error.message
      : timeout
        ? 'The browser action timed out.'
        : 'The browser action failed; no document or interaction was verified.';
  return {
    kind: 'browser_verification',
    action,
    status,
    opened: false,
    loaded: false,
    url: null,
    title: null,
    evidence: error instanceof BrowserEvidenceError ? error.evidence : [],
    error: { code, message },
    summary: message,
  };
}
