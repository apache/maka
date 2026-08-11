/**
 * PR-UI-RENDER-3a — Artifact preview registry (image-only first pass).
 *
 * Establishes the SHAPE that future PR-RENDER-3b/c/d/e expansions
 * will follow. Each future PR adds one more `PreviewResolution.kind`
 * variant and one more component implementation in the renderer. The
 * resolver is intentionally narrow today: it accepts only `image`,
 * and only the five universally-rendered raster MIMEs. SVG is
 * deferred to PR-RENDER-3b (sanitizer / script / foreignObject /
 * external href / SMIL animation / `<use href="javascript:...">`
 * surface area is non-trivial). HTML, Mermaid, PDF, Docx, Excel,
 * PPTX, Zip each get their own gated PR.
 *
 * Locked scope (PR-RENDER-3a review gate, @kenji msg 2aa3cfc3):
 *
 *   - Pure mapping. TextInput is a narrow `ArtifactPreviewInput`, never
 *     the full `ArtifactRecord` (so the registry can't see
 *     `relativePath` or anything path-like — registry decisions
 *     can't accidentally leak filesystem state).
 *   - Allowlist by MIME first, ext fallback second, both
 *     case-insensitive. Otherwise → unsupported with a reason that
 *     tells the renderer which Unsupported sub-copy to show and
 *     lets tests lock the path.
 *   - Size cap is part of resolution. `sizeBytes > IMAGE_PAYLOAD_
 *     MAX_BYTES` → `unsupported('oversize')` BEFORE the renderer
 *     attempts `readBinary`. The renderer also re-checks after
 *     load (cap can be hit even if `sizeBytes` was unknown).
 *   - No new internal protocol. The renderer keeps using the desktop preload's
 *     artifact reader → `data:<mime>;base64,...`,
 *     where main does path safety + MIME sniffing. We are NOT
 *     inventing `app-file://` / `maka-asset://` here; that's a
 *     trust-boundary PR, not a registry-shape PR.
 *
 * Adding a new preview kind in a future PR is a single edit here:
 *   1. Extend `PreviewResolution.kind` with the new variant
 *      (e.g. `'svg'`).
 *   2. Add MIME / ext allowlist entries.
 *   3. Add the renderer component + IPC plumbing.
 *   4. Add reason enum variants if new failure modes appear.
 *   5. Add deterministic fixture and journey coverage.
 */

import type { ArtifactBinaryReadResult, ArtifactKind } from '@maka/core/artifacts';

import type { UiLocale } from '@maka/core/ui-locale';
import { getSharedUiCopy } from './shared-ui-copy.js';

/**
 * Narrow input to the resolver. Deliberately excludes
 * `relativePath`, `id`, `sessionId`, `turnId` — none of those drive
 * preview classification, and the registry has no business seeing
 * them.
 */
export interface ArtifactPreviewInput {
  /** Display name (also the source for ext fallback). */
  name: string;
  /** Backend-classified kind. */
  kind: ArtifactKind;
  /** MIME if main process sniffed one. */
  mimeType?: string;
  /** Byte count if known. */
  sizeBytes?: number;
}

/**
 * Discriminated union telling the renderer which component to
 * mount AND why the classifier picked that outcome. Tests assert
 * on `reason`; Unsupported card sub-copy reads `reason` to pick a
 * specific localized message ("格式不受支持" vs "文件过大" vs
 * "无法识别类型" — all distinct user-facing failures).
 */
export type PreviewResolution =
  | {
      kind: 'image';
      /**
       * - `mime_match`: `input.mimeType` was in the allowlist.
       * - `ext_fallback`: no MIME (or MIME didn't match); filename
       *   extension was in the allowlist.
       */
      reason: 'mime_match' | 'ext_fallback';
    }
  | {
      kind: 'unsupported';
      /**
       * - `kind_disallowed`: `input.kind` is not one this registry
       *   version handles (currently only `'image'`).
       * - `mime_disallowed`: kind is `image` but MIME is outside the
       *   allowlist (e.g. `image/svg+xml`, `image/heic`).
       * - `no_mime_no_ext`: kind is `image` but neither MIME nor
       *   ext could classify it.
       * - `oversize`: `input.sizeBytes` exceeds `IMAGE_PAYLOAD_MAX_BYTES`.
       * - `read_failed`: the post-load IPC (`readBinary`) returned an
       *   error (`not_found` / `read_failed` / `not_allowed` /
       *   `deleted` / `unsupported_mime` / `too_large`). The L1
       *   resolver (`resolvePreviewKind`) NEVER returns this — it is
       *   emitted by the L2 layer (`decideImageReadOutcome`) and
       *   surfaced via the same `<UnsupportedArtifactPreview>` so the
       *   user sees a distinct "load failed" copy instead of
       *   misleading "格式不支持". @kenji review @msg 5fa6f6a5.
       */
      reason: 'kind_disallowed' | 'mime_disallowed' | 'no_mime_no_ext' | 'oversize' | 'read_failed';
    };

/**
 * Max decoded image payload allowed into React state. 2MB is well
 * past every e2e-fixture fixture and most user screenshots; a
 * real 10MB PNG should display via Finder open / future blob-URL
 * protocol rather than as a `data:` URL inside `setState`.
 *
 * @kenji review @msg 2aa3cfc3 — large payloads must NOT live as
 * base64 strings in React state.
 */
export const IMAGE_PAYLOAD_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Max base64 string length corresponding to `IMAGE_PAYLOAD_MAX_BYTES`.
 * `Math.ceil(bytes * 4 / 3)` — base64 expands 4:3 plus up to 2 chars
 * of padding. The renderer's post-load cap check is just
 * `base64.length > IMAGE_PAYLOAD_MAX_BASE64_LENGTH` (O(1) string
 * length comparison; NO `atob` / NO decode). This is the load-bearing
 * defense — @kenji review @msg adc10d66 explicitly: do not decode a
 * super-large payload just to check whether it should be rejected.
 *
 * Cap is a policy boundary, not exact byte accounting; the small
 * over-approximation from padding doesn't matter.
 */
export const IMAGE_PAYLOAD_MAX_BASE64_LENGTH = Math.ceil((IMAGE_PAYLOAD_MAX_BYTES * 4) / 3) + 2;

/**
 * MIME allowlist. Lower-cased exact match. SVG is intentionally
 * absent — it's deferred to PR-RENDER-3b.
 *
 * Exported so the renderer shell can use the SAME set for the
 * post-load L2 MIME re-validation (@kenji review @msg c9eb3b6f
 * point #2 / #3). Single source of truth; no parallel string
 * table on the renderer side.
 */
export const ALLOWED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

/**
 * Pure: returns the lower-cased MIME if it's in the allowlist;
 * `null` otherwise. Renderer uses this AFTER `readBinary` to
 * re-validate the MIME main sniffed, since the metadata MIME the
 * resolver consulted is user-controlled (could be `image/png`
 * metadata claim over actual SVG payload). The `<img src="data:
 * <mime>;base64,...">` attribute MUST be built from the result
 * of this function, never from the raw `mimeType` field.
 */
export function normalizeAllowedImageMime(mimeType: string | undefined): string | null {
  if (typeof mimeType !== 'string') return null;
  const mime = mimeType.trim().toLowerCase();
  if (mime === '') return null;
  return ALLOWED_IMAGE_MIMES.has(mime) ? mime : null;
}

/**
 * L2 outcome (post-`readBinary`). Pure decision that combines the
 * base64 cap check with the MIME re-validation, returning either
 * a `<img>`-renderable payload OR a typed Unsupported reason.
 *
 * Why this is its own function and not inlined in the component:
 * the cross-layer scenarios @kenji asked for in @msg f1ef0cc5 —
 *   - metadata `image/png` + sniffed `image/svg+xml` → Unsupported
 *   - metadata none + ext `.png` + sniffed `image/png` → image
 *   - metadata none + ext `.png` + sniffed `application/octet
 *     -stream` → Unsupported
 * are renderer-decision tests that don't need a DOM. The
 * component is then a thin shell over this function, exactly the
 * same shape as the L1 `resolvePreviewKind` / `<RegistryArtifact
 * Preview>` relationship.
 */
export type ImagePostLoadOutcome =
  | { kind: 'image'; safeMime: string; base64: string }
  | { kind: 'unsupported'; reason: 'oversize' | 'mime_disallowed' | 'read_failed' };

export function decideImagePostLoad(input: {
  base64: string;
  mimeType: string;
}): ImagePostLoadOutcome {
  if (exceedsImagePayloadCap(input.base64)) {
    return { kind: 'unsupported', reason: 'oversize' };
  }
  const safeMime = normalizeAllowedImageMime(input.mimeType);
  if (!safeMime) {
    return { kind: 'unsupported', reason: 'mime_disallowed' };
  }
  return { kind: 'image', safeMime, base64: input.base64 };
}

/**
 * PR-UI-RENDER-3a fixup (@kenji review @msg 5fa6f6a5) — single
 * chokepoint for the post-`readBinary` decision.
 *
 * The bug v1 had: `useBinaryRead` stored the raw
 * `ArtifactBinaryReadResult` (which carries the full base64 string)
 * in React state, and `decideImagePostLoad` only ran at render time.
 * That meant a 10MB base64 payload entered React state / DevTools
 * snapshot BEFORE the cap check ran. The cap blocked `<img src=...>`
 * rendering, but the load-bearing invariant ("large payloads must
 * NOT live as base64 strings in React state") was already violated.
 *
 * This helper is the new boundary. The renderer hook calls
 * `decideImageReadOutcome(rawReadResult)` INSIDE the async, BEFORE
 * `setState`. The hook state then only holds the post-decision
 * outcome, which is either an image branch (carrying the verified
 * base64) or an unsupported branch (NO base64 in state).
 *
 * Three failure paths feed `read_failed`:
 *   - `readResult.ok === false` (any IPC failure reason)
 *   - `readResult` missing required fields (defensive; would be a
 *     contract break by main, but we'd rather show a typed failure
 *     than crash)
 *
 * Image success calls into `decideImagePostLoad`, which is still
 * responsible for the L2 cap + MIME re-validation.
 */
export function decideImageReadOutcome(readResult: ArtifactBinaryReadResult): ImagePostLoadOutcome {
  if (!readResult.ok) {
    return { kind: 'unsupported', reason: 'read_failed' };
  }
  // Defensive shape check. `ArtifactBinaryReadResult`'s `ok: true`
  // branch is typed to carry `base64` and `mimeType`, but a future
  // main-process change that ever weakens that contract should
  // route to `read_failed` rather than crashing or — worse —
  // shoving an undefined into a `<img src="data:undefined;...">`.
  if (typeof readResult.base64 !== 'string' || typeof readResult.mimeType !== 'string') {
    return { kind: 'unsupported', reason: 'read_failed' };
  }
  return decideImagePostLoad({ base64: readResult.base64, mimeType: readResult.mimeType });
}

/**
 * Extension fallback. Lower-cased exact match including the dot.
 * Note `.jpg` and `.jpeg` both included; `.heic` / `.heif` / `.svg`
 * intentionally absent.
 */
const ALLOWED_IMAGE_EXTS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
]);

/**
 * Pure classifier. Maps `ArtifactPreviewInput` to a
 * `PreviewResolution`. Never throws, never reads `window`, never
 * touches `relativePath`. Future PRs extend the union but must
 * never broaden the input shape.
 */
export function resolvePreviewKind(input: ArtifactPreviewInput): PreviewResolution {
  // Kind gate first — keeps the rest of the function focused on
  // image classification only.
  if (input.kind !== 'image') {
    return { kind: 'unsupported', reason: 'kind_disallowed' };
  }
  // Size cap is a cheap reject before the renderer attempts
  // `readBinary` (which could materialize 50MB of base64 into
  // memory).
  if (input.sizeBytes !== undefined && input.sizeBytes > IMAGE_PAYLOAD_MAX_BYTES) {
    return { kind: 'unsupported', reason: 'oversize' };
  }
  // MIME is authoritative when present. If main sniffed
  // `image/svg+xml` on a file whose name happens to be `tricky.png`,
  // we trust the sniff and reject SVG (PR-RENDER-3b boundary) —
  // we do NOT then look at the extension and accept it as PNG.
  // The ext fallback only applies when MIME is missing entirely.
  if (input.mimeType) {
    const mime = input.mimeType.trim().toLowerCase();
    if (ALLOWED_IMAGE_MIMES.has(mime)) {
      return { kind: 'image', reason: 'mime_match' };
    }
    // MIME present and not allowed — surface as a distinct failure
    // so Unsupported can show "format unsupported" instead of "no
    // info".
    return { kind: 'unsupported', reason: 'mime_disallowed' };
  }
  // No MIME — ext fallback is the only hope for classification.
  const ext = lowercaseExt(input.name);
  if (ext && ALLOWED_IMAGE_EXTS.has(ext)) {
    return { kind: 'image', reason: 'ext_fallback' };
  }
  return { kind: 'unsupported', reason: 'no_mime_no_ext' };
}

/**
 * Pure: returns true iff `base64` is longer than the policy cap,
 * implying its decoded payload would exceed `IMAGE_PAYLOAD_MAX_BYTES`.
 *
 * Implementation is `base64.length > IMAGE_PAYLOAD_MAX_BASE64_LENGTH`
 * — a single O(1) string-length compare. The function does NOT call
 * `atob` and does NOT decode. The renderer component calls this
 * AFTER `readBinary` returns to enforce the cap even when the main
 * process didn't provide `sizeBytes` (resolver's L1 gate is best
 * effort; this is the L2 final defense).
 *
 * @kenji review @msg adc10d66 — never decode an oversize payload
 * just to check the cap. The L1 metadata gate in `resolvePreviewKind`
 * already covers the common case; this is the slim fallback.
 */
export function exceedsImagePayloadCap(base64: string): boolean {
  if (typeof base64 !== 'string') return true;
  return base64.length > IMAGE_PAYLOAD_MAX_BASE64_LENGTH;
}

/**
 * Pure: format a byte count as a short human-readable string for
 * Unsupported metadata display. KB / MB; no fractional precision
 * past 1 decimal. Returns `'未知大小'` for `undefined`.
 */
export function formatPreviewSize(sizeBytes: number | undefined, locale: UiLocale = 'zh'): string {
  if (sizeBytes === undefined || sizeBytes < 0 || !Number.isFinite(sizeBytes)) return getSharedUiCopy(locale).artifact.unknownSize;
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function lowercaseExt(name: string): string | null {
  if (typeof name !== 'string') return null;
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return null;
  return name.slice(idx).toLowerCase();
}
