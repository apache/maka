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
 * Showing generated HTML locally depends on four independent things, and each
 * one fails differently: the client may have no GUI surface at all, the
 * embedded browser refuses `file://` by policy, the process that writes the
 * file may not share a filesystem with the surface that would render it, and
 * the conversation's own view may not be the one on screen. Attempting the
 * preview and reading the first error conflates all four. A refused loopback
 * connection is the worst of them: "nothing listening yet", "server still
 * starting", and "separate network namespace" are indistinguishable at the
 * socket, yet the refusal reads like proof of the last one.
 *
 * So every capability below answers with one of three statuses and names the
 * observation behind it. `verified` requires a positive observation.
 * `unsupported` is a settled product boundary this code can state without
 * probing. Everything else is `unknown` — explicitly NOT a claim that a
 * sandbox, an isolated localhost, or a missing capability caused it. A caller
 * may describe a preview as ready only on `verified`, which is why `ready`
 * below is derived from positive evidence alone and never from the absence of
 * an error.
 *
 * Pure by construction: every observation arrives through
 * PreviewPreflightAuthority, so each status — including the ones that need a
 * refused socket or an unreadable directory — is reachable from a plain unit
 * test. The probes that touch the OS live in preview-preflight-probes.ts.
 */

import type { MakaTool } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import { parseNavigable } from './browser/logic.js';

export type PreviewCapabilityStatus = 'verified' | 'unsupported' | 'unknown';

export type PreviewCapabilityId =
  | 'gui_surface'
  | 'url_schemes'
  | 'filesystem_visibility'
  | 'browser_reachability'
  | 'loopback_endpoint';

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
  /** The health of the named endpoint, kept separate from the surface above. */
  readonly endpoint: PreviewEndpointStatus;
  /**
   * True only when a page can be shown on positive evidence right now: a
   * verified surface AND an endpoint that answered. An absent error is never
   * enough. Read `surface` and `endpoint` to see which half is missing — a
   * false `ready` with no endpoint named is not a capability finding.
   */
  readonly ready: boolean;
  readonly capabilities: readonly PreviewCapability[];
  readonly summary: string;
  /** The supported handoff to use instead. Always present when `ready` is false. */
  readonly alternative?: string;
}

/** An observation that may not have been obtainable, kept distinct from a negative one. */
export type Observed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly cause: string };

export type StagingRootProbe =
  | { readonly kind: 'round_tripped'; readonly root: string }
  | { readonly kind: 'unavailable'; readonly root: string; readonly cause: string }
  | { readonly kind: 'not_configured' };

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
  /** Round-trip a probe file under the Artifact staging root. */
  probeStagingRoot(input: { readonly signal: AbortSignal }): StagingRootProbe | Promise<StagingRootProbe>;
  /** Bounded loopback request. A connection outcome is a result, never a throw. */
  probeLoopback(input: {
    readonly origin: string;
    readonly signal: AbortSignal;
  }): LoopbackProbe | Promise<LoopbackProbe>;
}

/**
 * The supported handoff: it needs neither `file://` navigation in the embedded
 * browser nor an ad-hoc localhost server, so it stays available even when every
 * capability below is unknown. Its own honesty caveat is repeated here, because
 * a caller reading this line is exactly the one about to overclaim.
 */
export const ARTIFACT_PREVIEW_HANDOFF =
  'Use the ArtifactPreview tool: it turns an HTML Artifact in this session into a Desktop-managed, temporary HTTP URL the browser can open, with no shell server and no file:// navigation. Its `reachable` flag reports a Desktop-side HTTP check and not a browser load, so confirm rendering by navigating and observing the page. If it fails, fall back to Generated Files → Save As or Show in Folder rather than reporting that the preview opened.';

/** Addresses the embedded browser is asked about, one per scheme worth reporting. */
const SCHEME_PROBES = [
  'https://example.invalid/preview.html',
  'http://127.0.0.1:8765/preview.html',
  'file:///tmp/preview.html',
  'data:text/html,<h1>preview</h1>',
] as const;

/**
 * `localhost` is deliberately not accepted: it resolves through the host's
 * name resolution and can point somewhere other than the loopback interface,
 * which would turn a capability check into an arbitrary outbound request.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

export interface SchemeProbeResult {
  readonly scheme: string;
  readonly navigable: boolean;
}

/**
 * Ask the real address policy rather than restating it. A hardcoded list would
 * keep reporting `file:` as rejected long after someone changed the rule.
 */
export function probeNavigableSchemes(): readonly SchemeProbeResult[] {
  return SCHEME_PROBES.map((sample) => ({
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

export function classifyFilesystemVisibility(observed: Observed<StagingRootProbe>): PreviewCapability {
  if (!observed.ok) {
    return {
      id: 'filesystem_visibility',
      status: 'unknown',
      evidence: `Could not probe the Artifact staging root: ${observed.cause}.`,
      boundary: 'The probe did not complete, so nothing was learned about the path.',
    };
  }
  const probe = observed.value;
  if (probe.kind === 'not_configured') {
    return {
      id: 'filesystem_visibility',
      status: 'unsupported',
      evidence: 'This client has no Artifact staging root configured.',
      boundary: 'Without a staging root there is no local path for a preview to be materialized into.',
    };
  }
  if (probe.kind === 'round_tripped') {
    return {
      id: 'filesystem_visibility',
      status: 'verified',
      evidence: `Created, read back, and removed a probe file under ${probe.root}.`,
      boundary:
        'This proves only that the Desktop main process reaches that directory. It does not prove that the shell or sandboxed runtime which generates a file writes into the same filesystem.',
    };
  }
  return {
    id: 'filesystem_visibility',
    status: 'unknown',
    evidence: `A probe file under ${probe.root} could not be round-tripped: ${probe.cause}.`,
    boundary:
      'A failed access does not distinguish a missing directory, a permission denial, and a sandbox that hides the path. Read the reported cause rather than assuming isolation.',
  };
}

export function classifyBrowserReachability(input: {
  readonly guiSurface: PreviewCapability;
  /** Omitted when the view was never asked, which only a settled `unsupported` justifies. */
  readonly drivable?: Observed<boolean>;
}): PreviewCapability {
  if (input.guiSurface.status === 'unsupported') {
    return {
      id: 'browser_reachability',
      status: 'unsupported',
      evidence: 'There is no registered browser view host, so this client has no embedded view to reach.',
    };
  }
  if (!input.drivable) {
    return {
      id: 'browser_reachability',
      status: 'unknown',
      evidence: "This conversation's view was not asked whether it accepts actions.",
    };
  }
  if (!input.drivable.ok) {
    return {
      id: 'browser_reachability',
      status: 'unknown',
      evidence: `Could not determine whether this conversation's view accepts actions: ${input.drivable.cause}.`,
    };
  }
  if (input.drivable.value) {
    return {
      id: 'browser_reachability',
      status: 'verified',
      evidence: "This conversation's embedded view accepts an observe action, so a page can be driven into it now.",
    };
  }
  return {
    id: 'browser_reachability',
    status: 'unknown',
    evidence: "This conversation's embedded view refused an observe action right now.",
    boundary:
      'Every browser action must run in the conversation the user is looking at. A refusal usually means this conversation is not the one on screen, which is transient and visibility-scoped — it does not prove the browser is unreachable or that a sandbox separates it.',
  };
}

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
      evidence: `${input.origin} answered with HTTP ${probe.status} to the Desktop main process.`,
      boundary:
        'The answer proves something is listening for this process. It does not prove the embedded browser shares that loopback namespace.',
    };
  }
  // The rule this whole tool exists for: a connection outcome can produce
  // `verified` or `unknown`, never `unsupported`. Nothing observable at a
  // refused socket distinguishes a slow start from an isolated namespace.
  return {
    id: 'loopback_endpoint',
    status: 'unknown',
    evidence: `Nothing answered at ${input.origin}: ${probe.cause}.`,
    boundary:
      'A refused or timed-out connection does not prove sandbox isolation, a separate localhost namespace, or that the endpoint is unusable. It shows only that nothing answered this process at that address at this moment. Retry once the server reports that it is listening, or read the server\'s own startup output.',
  };
}

/**
 * Reject anything that would turn a capability check into an arbitrary
 * outbound request, and say what is accepted instead. Mirrors the bounded
 * loopback contract the background-task health check uses (#5237).
 */
export function assertLoopbackOrigin(raw: string): string {
  const guidance = 'Pass a loopback URL such as http://127.0.0.1:8765/preview.html.';
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
      `Only the loopback interface can be probed, not ${JSON.stringify(url.hostname)}. "localhost" is excluded because it resolves through the host and can point elsewhere. ${guidance}`,
    );
  }
  return url.toString();
}

/**
 * Whether this client can display a page at all. Deliberately independent of
 * any endpoint, so "nothing was named to check" cannot read as "this client
 * cannot preview". A settled boundary on either half settles the whole.
 */
export function derivePreviewSurface(input: {
  readonly guiSurface: PreviewCapability;
  readonly browserReachability: PreviewCapability;
}): PreviewCapabilityStatus {
  const statuses = [input.guiSurface.status, input.browserReachability.status];
  if (statuses.includes('unsupported')) return 'unsupported';
  return statuses.every((status) => status === 'verified') ? 'verified' : 'unknown';
}

export function summarizePreviewPreflight(input: {
  readonly capabilities: readonly PreviewCapability[];
  readonly surface: PreviewCapabilityStatus;
  readonly endpoint: PreviewEndpointStatus;
  readonly ready: boolean;
}): string {
  if (input.ready) {
    return 'A page can be shown now: this client has a usable preview surface and the endpoint answered.';
  }
  if (input.surface === 'unsupported') {
    return 'This client cannot display a page locally. The unsupported entries below say why, and that will not change at runtime — take the alternative rather than retrying.';
  }
  if (input.endpoint === 'not_checked') {
    return input.surface === 'verified'
      ? 'This client has a usable preview surface. No endpoint was named, so none was checked — an absent question, not a negative result.'
      : 'No endpoint was named, so none was checked, and the surface itself is unproven. The entries below report what was observed, not a cause.';
  }
  const counts = { verified: 0, unsupported: 0, unknown: 0 };
  for (const capability of input.capabilities) counts[capability.status] += 1;
  return (
    `No verified way to show a page right now — ${counts.verified} verified, ${counts.unsupported} unsupported, ${counts.unknown} unknown. ` +
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

/** The local-preview capability preflight, published as its own capability offer. */
export function buildPreviewPreflightTools(
  authority: PreviewPreflightAuthority,
): readonly MakaTool[] {
  const preflight: MakaTool<{ origin?: string }, PreviewPreflightResult> = {
    name: 'preview_preflight',
    displayName: 'Check local preview capabilities',
    description:
      'Report what this Maka client can actually preview locally BEFORE attempting it: GUI availability, which URL schemes the embedded browser accepts, whether the Artifact staging path round-trips, and whether this conversation\'s view accepts actions. ' +
      'Pass `origin` to also check a loopback endpoint you started. Each capability answers verified, unsupported, or unknown, with the observation behind it — an unknown reports what was seen and never asserts a sandbox or isolation cause. ' +
      '`surface` says whether this client can display a page at all and is reported separately from `endpoint`, which is `not_checked` when no origin was passed; `ready` needs both. ' +
      'Call this instead of inferring a boundary from a failed navigation or a refused connection.',
    parameters: z
      .object({
        origin: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe(
            'Optional loopback URL to probe, such as http://127.0.0.1:8765/preview.html. Only 127.0.0.1 and [::1] are accepted; no credentials, query, or fragment.',
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
      const filesystemVisibility = classifyFilesystemVisibility(
        await observe(abortSignal, () => authority.probeStagingRoot({ signal: abortSignal })),
      );
      // Skip the drive check when there is demonstrably no view host: asking
      // would throw, and an exception dressed as `unknown` would hide the
      // settled `unsupported` answer the caller needs.
      const browserReachability = classifyBrowserReachability({
        guiSurface,
        ...(guiSurface.status === 'unsupported'
          ? {}
          : {
              drivable: await observe(abortSignal, () =>
                authority.browserDrivable({ sessionId, signal: abortSignal }),
              ),
            }),
      });
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
        filesystemVisibility,
        browserReachability,
        ...(loopbackEndpoint ? [loopbackEndpoint] : []),
      ];
      const surface = derivePreviewSurface({ guiSurface, browserReachability });
      const endpoint: PreviewEndpointStatus = loopbackEndpoint?.status ?? 'not_checked';
      const ready = surface === 'verified' && endpoint === 'verified';
      return {
        kind: 'preview_preflight',
        surface,
        endpoint,
        ready,
        capabilities,
        summary: summarizePreviewPreflight({ capabilities, surface, endpoint, ready }),
        ...(ready ? {} : { alternative: ARTIFACT_PREVIEW_HANDOFF }),
      };
    },
  };
  return [preflight as MakaTool];
}
