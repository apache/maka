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

/**
 * Local preview capability preflight — what this client can actually show,
 * asked before anything is attempted.
 *
 * Showing a page locally depends on independent things that each fail
 * differently: the client may have no GUI surface at all, the embedded browser
 * refuses `file://` by policy, and the conversation's own view may not be the
 * one on screen. Attempting the preview and reading the first error conflates
 * them. A refused loopback connection is the worst case: "nothing listening
 * yet", "server still starting", and "separate network namespace" are
 * indistinguishable at the socket, yet the refusal reads like proof of the
 * last one.
 *
 * So every capability below answers with one of three statuses and names the
 * observation behind it. `verified` requires a positive observation.
 * `unsupported` is a settled product boundary this code can state without
 * probing. Everything else is `unknown` — explicitly NOT a claim that a
 * sandbox, an isolated localhost, or a missing capability caused it.
 *
 * No result here claims that a page is ready. The loopback probe observes the
 * origin, not the page, and whether a page loads is #5235's question; a
 * readiness flag built from a listener's answer would claim more than the
 * evidence holds.
 *
 * Pure by construction: every observation arrives through
 * PreviewPreflightAuthority, so each status — including the ones that need a
 * refused socket — is reachable from a plain unit test. The probes that touch
 * the OS live in preview-preflight-probes.ts.
 */

import type { MakaTool } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import { parseNavigable } from './browser/logic.js';

export type PreviewCapabilityStatus = 'verified' | 'unsupported' | 'unknown';

export type PreviewCapabilityId = 'gui_surface' | 'url_schemes' | 'browser_view' | 'loopback_endpoint';

export interface PreviewCapability {
  readonly id: PreviewCapabilityId;
  readonly status: PreviewCapabilityStatus;
  /** The observation this status rests on. Every status names one. */
  readonly evidence: string;
  /** What the status does not prove, or why the boundary exists. */
  readonly boundary?: string;
}

/** An endpoint nobody named was not found wanting; it was never asked about. */
export type PreviewEndpointStatus = PreviewCapabilityStatus | 'not_checked';

export interface PreviewPreflightResult {
  readonly kind: 'preview_preflight';
  /**
   * Whether this client can display a page at all, independent of any
   * particular endpoint: a GUI surface plus a view that accepts actions.
   */
  readonly surface: PreviewCapabilityStatus;
  /**
   * Whether something listens at the named origin. `verified` proves a
   * listener, not that any page exists there or that it loads.
   */
  readonly endpoint: PreviewEndpointStatus;
  readonly capabilities: readonly PreviewCapability[];
  readonly summary: string;
  /** Present unless the caller already has a verified surface and listener. */
  readonly alternative?: string;
}

/** An observation that may not have been obtainable, kept distinct from a negative one. */
export type Observed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly cause: string };

export type LoopbackProbe =
  // Any HTTP status answers the question: a 404 still proves something listened.
  | { readonly kind: 'answered'; readonly status: number }
  | { readonly kind: 'no_answer'; readonly cause: string };

export interface PreviewPreflightAuthority {
  /** Whether a Desktop browser view host is registered for this client. */
  guiSurfaceAvailable(): boolean | Promise<boolean>;
  /** Whether this conversation's embedded view accepts an observe action right now. */
  browserDrivable(input: {
    readonly sessionId: string;
    readonly signal: AbortSignal;
  }): boolean | Promise<boolean>;
  /** Bounded `HEAD /` against an origin. A connection outcome is a result, never a throw. */
  probeLoopback(input: {
    readonly origin: string;
    readonly signal: AbortSignal;
  }): LoopbackProbe | Promise<LoopbackProbe>;
}

/**
 * Names the supported route and defers to it for what that route promises.
 * Restating ArtifactPreview's guarantees here would give two answers to the
 * same question, and the copy would drift from the tool it describes.
 */
export const ARTIFACT_PREVIEW_HANDOFF =
  'To show an HTML Artifact without a shell server or file:// navigation, use the ArtifactPreview tool in this same offer. Its description states what the URL it returns does and does not guarantee; read that before reporting that a preview opened.';

/** Addresses the embedded browser is asked about, one per scheme worth reporting. */
const SCHEME_PROBES = [
  'https://example.invalid/preview.html',
  'http://127.0.0.1:8765/preview.html',
  'file:///tmp/preview.html',
  'data:text/html,<h1>preview</h1>',
] as const;

/**
 * Stricter than `isLoopbackHost` in @maka/core/mcp on purpose, so do not widen
 * it to match. That predicate decides whether traffic may be trusted as local;
 * this one names the exact address a probe dials, because the evidence it
 * returns says which address answered or refused. `localhost` can resolve to
 * either 127.0.0.1 or [::1] depending on the resolver's order, so a refusal
 * there would not say which address was tried — a server bound to one family
 * reads as down. The rest of 127/8 is excluded for the same precision.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

export interface SchemeProbeResult {
  readonly sample: string;
  readonly scheme: string;
  readonly navigable: boolean;
}

/**
 * Ask the real address policy rather than restating it. A hardcoded list would
 * keep reporting `file:` as rejected long after someone changed the rule.
 */
export function probeNavigableSchemes(): readonly SchemeProbeResult[] {
  return SCHEME_PROBES.map((sample) => ({
    sample,
    scheme: sample.slice(0, sample.indexOf(':') + 1),
    navigable: parseNavigable(sample) !== null,
  }));
}

export function classifyGuiSurface(observed: Observed<boolean>): PreviewCapability {
  if (!observed.ok) {
    return {
      id: 'gui_surface',
      status: 'unknown',
      evidence: `Could not determine whether a browser view host is registered: ${observed.cause}.`,
      boundary: 'This does not mean the client is headless; the check itself did not complete.',
    };
  }
  if (observed.value) {
    return {
      id: 'gui_surface',
      status: 'verified',
      evidence: 'A Desktop browser view host is registered for this client.',
    };
  }
  return {
    id: 'gui_surface',
    status: 'unsupported',
    evidence: 'No Desktop browser view host is registered.',
    boundary:
      'Browser automation exists only inside the desktop app, so this runtime has no embedded view to preview into. Nothing this runtime does will make one appear.',
  };
}

export function classifyUrlSchemes(probes: readonly SchemeProbeResult[]): PreviewCapability {
  const navigable = probes.filter((probe) => probe.navigable).map((probe) => probe.scheme);
  const rejected = probes.filter((probe) => !probe.navigable).map((probe) => probe.scheme);
  const evidence = `The embedded browser's address policy accepted ${describeSchemes(navigable)} and rejected ${describeSchemes(rejected)}.`;
  if (probes.some((probe) => probe.scheme === 'file:' && probe.navigable)) {
    return { id: 'url_schemes', status: 'verified', evidence };
  }
  return {
    id: 'url_schemes',
    status: 'unsupported',
    evidence,
    boundary:
      'Admission requires an HTTP origin. file:// is rejected so that a typed address or an in-page link can never reach the local filesystem, so a generated file cannot be previewed by pointing the embedded browser at its path. This is a deliberate boundary, not a missing feature: use ArtifactPreview to serve the same content over http:// instead of working around it.',
  };
}

/**
 * Reached only when a view host exists, so this answers `verified` or
 * `unknown` and never `unsupported`: a refused observe is a visibility
 * condition of the moment, not a boundary.
 */
export function classifyBrowserView(drivable: Observed<boolean>): PreviewCapability {
  if (!drivable.ok) {
    return {
      id: 'browser_view',
      status: 'unknown',
      evidence: `Could not determine whether this conversation's view accepts actions: ${drivable.cause}.`,
    };
  }
  if (drivable.value) {
    return {
      id: 'browser_view',
      status: 'verified',
      evidence: "This conversation's embedded view accepts an observe action, so a page can be driven into it now.",
    };
  }
  return {
    id: 'browser_view',
    status: 'unknown',
    evidence: "This conversation's embedded view refused an observe action right now.",
    boundary:
      'Every browser action must run in the conversation the user is looking at. A refusal usually means this conversation is not the one on screen, which is transient and visibility-scoped — it does not prove the browser is unreachable or that a sandbox separates it.',
  };
}

/** The view half when there is demonstrably no view host to ask. */
export const BROWSER_VIEW_WITHOUT_HOST: PreviewCapability = {
  id: 'browser_view',
  status: 'unsupported',
  evidence: 'There is no registered browser view host, so this client has no embedded view to drive.',
};

export function classifyLoopbackEndpoint(input: {
  readonly origin: string;
  readonly observed: Observed<LoopbackProbe>;
}): PreviewCapability {
  if (!input.observed.ok) {
    return {
      id: 'loopback_endpoint',
      status: 'unknown',
      evidence: `Could not probe ${input.origin}: ${input.observed.cause}.`,
    };
  }
  const probe = input.observed.value;
  if (probe.kind === 'answered') {
    return {
      id: 'loopback_endpoint',
      status: 'verified',
      evidence: `HEAD / at ${input.origin} answered with HTTP ${probe.status} to the Desktop main process.`,
      boundary:
        'An answer proves a listener at this origin and nothing more: not that any particular page exists there, not that it loads, and not that the embedded browser shares this loopback namespace.',
    };
  }
  // The rule this whole tool exists for: a connection outcome can produce
  // `verified` or `unknown`, never `unsupported`. Nothing observable at a
  // refused socket distinguishes a slow start from an isolated namespace.
  return {
    id: 'loopback_endpoint',
    status: 'unknown',
    // "No usable response", not "nothing answered": a TLS handshake failure,
    // garbage bytes, or a reset after accept all mean something did listen.
    evidence: `No usable HTTP response from ${input.origin}: ${probe.cause}.`,
    boundary:
      'This does not prove sandbox isolation, a separate localhost namespace, or that the endpoint is unusable. It shows only that no usable HTTP response reached this process from that address at this moment. Retry once the server reports that it is listening, or read the server\'s own startup output.',
  };
}

/**
 * Reject anything that would turn a capability check into an arbitrary
 * outbound request, and say what is accepted instead. Returns the origin only:
 * the probe never requests the caller's path, so a dev-server route with side
 * effects on GET cannot be tripped by a capability check.
 */
export function assertLoopbackOrigin(raw: string): string {
  const guidance = 'Pass a loopback origin such as http://127.0.0.1:8765.';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a URL: ${JSON.stringify(raw)}. ${guidance}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http:// and https:// origins can be probed, not ${url.protocol}. ${guidance}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`Credentials are not accepted in a probe URL. ${guidance}`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`A probe URL carries no query or fragment. ${guidance}`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `Only 127.0.0.1 and [::1] can be probed, not ${JSON.stringify(url.hostname)}. "localhost" is excluded because it can resolve to either address, so a refusal would not say which one was tried. ${guidance}`,
    );
  }
  return url.origin;
}

/**
 * Whether this client can display a page at all. Deliberately independent of
 * any endpoint, so "nothing was named to check" cannot read as "this client
 * cannot preview". A settled boundary on either half settles the whole.
 */
export function derivePreviewSurface(input: {
  readonly guiSurface: PreviewCapability;
  readonly browserView: PreviewCapability;
}): PreviewCapabilityStatus {
  const statuses = [input.guiSurface.status, input.browserView.status];
  if (statuses.includes('unsupported')) return 'unsupported';
  return statuses.every((status) => status === 'verified') ? 'verified' : 'unknown';
}

export function summarizePreviewPreflight(input: {
  readonly capabilities: readonly PreviewCapability[];
  readonly surface: PreviewCapabilityStatus;
  readonly endpoint: PreviewEndpointStatus;
}): string {
  if (input.surface === 'unsupported') {
    return 'This client cannot display a page locally. The unsupported entries below say why, and that will not change at runtime — take the alternative rather than retrying.';
  }
  if (input.surface === 'verified' && input.endpoint === 'verified') {
    return 'This client can display a page, and something is listening at the named origin. That does not prove the page you want exists there or loads — navigate to it and observe the result before reporting it shown.';
  }
  if (input.endpoint === 'not_checked') {
    return input.surface === 'verified'
      ? 'This client has a usable preview surface. No endpoint was named, so none was checked — an absent question, not a negative result.'
      : 'No endpoint was named, so none was checked, and the surface itself is unproven. The entries below report what was observed, not a cause.';
  }
  const counts = { verified: 0, unsupported: 0, unknown: 0 };
  for (const capability of input.capabilities) counts[capability.status] += 1;
  return (
    `Some of what a preview needs is unproven — ${counts.verified} verified, ${counts.unsupported} unsupported, ${counts.unknown} unknown. ` +
    'Only the unsupported entries are settled boundaries; an unknown entry reports what was observed and not a cause.'
  );
}

function describeSchemes(schemes: readonly string[]): string {
  return schemes.length === 0 ? 'nothing' : schemes.join(', ');
}

/**
 * Cancellation is not an observation. Without this the abort that ends a turn
 * would be reported as an `unknown` capability, which reads like a finding.
 */
async function observe<T>(signal: AbortSignal, run: () => T | Promise<T>): Promise<Observed<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (signal.aborted) throw error;
    return { ok: false, cause: error instanceof Error ? error.message : String(error) };
  }
}

/** The local-preview capability preflight, published beside ArtifactPreview. */
export function buildPreviewPreflightTools(
  authority: PreviewPreflightAuthority,
): readonly MakaTool[] {
  const preflight: MakaTool<{ origin?: string }, PreviewPreflightResult> = {
    name: 'preview_preflight',
    displayName: 'Check local preview capabilities',
    description:
      'Report what this Maka client can actually preview locally BEFORE attempting it: GUI availability, which URL schemes the embedded browser accepts, and whether this conversation\'s view accepts actions. ' +
      'file:// is never navigable in the embedded browser; that is a settled boundary, not a failure to retry. ' +
      'Pass `origin` to also check whether something listens at a loopback origin you started; only `HEAD /` is sent, so the path you pass is not requested. ' +
      'Each capability answers verified, unsupported, or unknown, with the observation behind it — an unknown reports what was seen and never asserts a sandbox or isolation cause. ' +
      '`surface` says whether this client can display a page at all; `endpoint` is reported separately and is `not_checked` when no origin was passed. Neither claims that a page loads. ' +
      'Call this instead of inferring a boundary from a failed navigation or a refused connection.',
    parameters: z
      .object({
        origin: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe(
            'Optional loopback origin to probe, such as http://127.0.0.1:8765. Only 127.0.0.1 and [::1] are accepted; no credentials, query, or fragment. Any path is ignored: the probe sends HEAD / to the origin.',
          ),
      })
      .strict(),
    categoryHint: 'read',
    recoveryMode: 'replay_safe',
    impl: async ({ origin: rawOrigin }, { sessionId, abortSignal }) => {
      abortSignal.throwIfAborted();
      // Validate before probing so a malformed origin is an argument error the
      // caller can fix, not an `unknown` capability that reads like a finding.
      const origin = rawOrigin === undefined ? undefined : assertLoopbackOrigin(rawOrigin);

      const guiSurface = classifyGuiSurface(
        await observe(abortSignal, () => authority.guiSurfaceAvailable()),
      );
      const urlSchemes = classifyUrlSchemes(probeNavigableSchemes());
      // Skip the drive check when there is demonstrably no view host: asking
      // would throw, and an exception dressed as `unknown` would hide the
      // settled `unsupported` answer the caller needs.
      const browserView =
        guiSurface.status === 'unsupported'
          ? BROWSER_VIEW_WITHOUT_HOST
          : classifyBrowserView(
              await observe(abortSignal, () =>
                authority.browserDrivable({ sessionId, signal: abortSignal }),
              ),
            );
      const loopbackEndpoint =
        origin === undefined
          ? undefined
          : classifyLoopbackEndpoint({
              origin,
              observed: await observe(abortSignal, () =>
                authority.probeLoopback({ origin, signal: abortSignal }),
              ),
            });

      const capabilities = [
        guiSurface,
        urlSchemes,
        browserView,
        ...(loopbackEndpoint ? [loopbackEndpoint] : []),
      ];
      const surface = derivePreviewSurface({ guiSurface, browserView });
      const endpoint: PreviewEndpointStatus = loopbackEndpoint?.status ?? 'not_checked';
      const covered = surface === 'verified' && endpoint === 'verified';
      return {
        kind: 'preview_preflight',
        surface,
        endpoint,
        capabilities,
        summary: summarizePreviewPreflight({ capabilities, surface, endpoint }),
        ...(covered ? {} : { alternative: ARTIFACT_PREVIEW_HANDOFF }),
      };
    },
  };
  return [preflight as MakaTool];
}
