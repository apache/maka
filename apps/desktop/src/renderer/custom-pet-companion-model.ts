import type { PetActivityState, PetAnimationV1, PetPackManifestV1, PetSpriteSheetV1 } from '@maka/core/pet';

import type { SessionStatus } from '@maka/core/session';

export interface PetCompanionSource {
  getSelection(): Promise<string | null>;
  list(): Promise<PetPackManifestV1[]>;
  readSpriteSheet(petId: string): Promise<
    | { ok: true; mimeType: 'image/png' | 'image/webp'; bytes: Uint8Array }
    | {
        ok: false;
        reason: 'invalid_id' | 'not_found' | 'corrupt_pack' | 'read_failed';
      }
  >;
}

export type SelectedPetCompanion =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'ready';
      readonly manifest: PetPackManifestV1;
      readonly mimeType: 'image/png' | 'image/webp';
      readonly bytes: Uint8Array;
    };

export interface PetRuntimeActivityInput {
  readonly hasActiveSession: boolean;
  readonly hasActiveInteraction: boolean;
  readonly turnActive: boolean;
  readonly sessionStatus: SessionStatus | undefined;
}

/**
 * Project authoritative shell signals onto the pack contract. Completion is a
 * separate edge-triggered pulse: normal turns return their session to `active`,
 * so a durable status cannot distinguish "ready just now" from ordinary idle.
 */
export function derivePetActivityState(
  input: PetRuntimeActivityInput,
): PetActivityState {
  if (!input.hasActiveSession) return 'idle';
  if (input.hasActiveInteraction || input.sessionStatus === 'waiting_for_user') {
    return 'needs-input';
  }
  if (input.sessionStatus === 'blocked') return 'blocked';
  if (input.turnActive) return 'working';
  return 'idle';
}

export function syncPetPlaybackState(input: {
  readonly currentState: PetActivityState;
  readonly activityState: PetActivityState;
  readonly completionArrived: boolean;
  readonly contextChanged: boolean;
}): PetActivityState {
  if (input.completionArrived) return 'ready';
  if (input.contextChanged || input.activityState !== 'idle') return input.activityState;
  // A completed turn can retire its running witness before its one-shot
  // `ready` animation ends. Its manifest fallback owns that transition.
  return input.currentState === 'ready' ? 'ready' : 'idle';
}

/**
 * Resolve the selection through the same public bridge available to Settings.
 * Every mismatch fails closed: a stale id, a removed manifest, or an unreadable
 * sprite sheet means no decorative layer instead of a broken-image surface.
 */
export async function loadSelectedPetCompanion(
  source: PetCompanionSource,
): Promise<SelectedPetCompanion> {
  const selectedPetId = await source.getSelection();
  if (selectedPetId === null) return { kind: 'none' };

  const manifests = await source.list();
  const manifest = manifests.find((candidate) => candidate.id === selectedPetId);
  if (!manifest) return { kind: 'none' };

  const spriteSheet = await source.readSpriteSheet(selectedPetId);
  if (!spriteSheet.ok) return { kind: 'none' };
  return {
    kind: 'ready',
    manifest,
    mimeType: spriteSheet.mimeType,
    bytes: spriteSheet.bytes,
  };
}

export interface PetAnimationSample {
  readonly frame: number;
  readonly sequenceIndex: number;
  readonly complete: boolean;
}

/** Pure elapsed-time sampler so delayed frames do not slow the animation. */
export function samplePetAnimation(
  animation: PetAnimationV1,
  elapsedMs: number,
): PetAnimationSample {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const unboundedIndex = Math.floor((elapsed * animation.fps) / 1_000);
  const complete = !animation.loop && unboundedIndex >= animation.frames.length;
  const sequenceIndex = animation.loop
    ? unboundedIndex % animation.frames.length
    : Math.min(unboundedIndex, animation.frames.length - 1);
  return {
    frame: animation.frames[sequenceIndex],
    sequenceIndex,
    complete,
  };
}

export interface PetFrameSourceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function petFrameSourceRect(
  frame: number,
  sheet: PetSpriteSheetV1,
): PetFrameSourceRect {
  return {
    x: (frame % sheet.columns) * sheet.frameWidth,
    y: Math.floor(frame / sheet.columns) * sheet.frameHeight,
    width: sheet.frameWidth,
    height: sheet.frameHeight,
  };
}

export function shouldReducePetMotion(input: {
  readonly reducedMotionAttribute: boolean;
  readonly e2eFixtureAttribute: boolean;
  readonly systemPreference: boolean;
}): boolean {
  return input.reducedMotionAttribute
    || input.e2eFixtureAttribute
    || input.systemPreference;
}
