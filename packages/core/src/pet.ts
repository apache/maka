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

import { defineObjectShape, isRecord, type ExactObjectShape } from './record-schema.js';

export const PET_PACK_SCHEMA_V1 = 'maka.pet/v1' as const;

export const PET_REQUIRED_ACTIVITY_STATES = [
  'idle',
  'working',
  'needs-input',
  'ready',
  'blocked',
] as const;

export const PET_OPTIONAL_ACTIVITY_STATES = [
  'swarm',
  'cancelled',
  'poke',
  'wake',
  'sleep',
] as const;

export const PET_ACTIVITY_STATES = [
  ...PET_REQUIRED_ACTIVITY_STATES,
  ...PET_OPTIONAL_ACTIVITY_STATES,
] as const;

export type PetRequiredActivityState = (typeof PET_REQUIRED_ACTIVITY_STATES)[number];
export type PetOptionalActivityState = (typeof PET_OPTIONAL_ACTIVITY_STATES)[number];
export type PetActivityState = (typeof PET_ACTIVITY_STATES)[number];

export const PET_ACTIVITY_STATE_FALLBACKS = {
  idle: 'idle',
  working: 'working',
  'needs-input': 'needs-input',
  ready: 'ready',
  blocked: 'blocked',
  swarm: 'working',
  cancelled: 'idle',
  poke: 'idle',
  wake: 'idle',
  sleep: 'idle',
} as const satisfies Record<PetActivityState, PetRequiredActivityState>;

export const PET_PACK_ID_MAX_CHARS = 64;
export const PET_PACK_DISPLAY_NAME_MAX_CHARS = 80;
export const PET_PACK_DESCRIPTION_MAX_CHARS = 500;
export const PET_ASSET_PATH_MAX_CHARS = 256;
export const PET_SPRITE_FRAME_MAX_DIMENSION = 2_048;
export const PET_SPRITE_SHEET_MAX_DIMENSION = 8_192;
export const PET_SPRITE_GRID_MAX_AXIS = 64;
export const PET_SPRITE_FRAME_COUNT_MAX = 256;
export const PET_ANIMATION_FPS_MAX = 60;

export const PET_SPRITE_FORMATS = ['png', 'webp'] as const;
export type PetSpriteFormat = (typeof PET_SPRITE_FORMATS)[number];

export interface PetSpriteSheetV1 {
  readonly path: string;
  readonly format: PetSpriteFormat;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly columns: number;
  readonly rows: number;
  readonly frameCount: number;
}

export interface PetAnimationV1 {
  readonly frames: readonly number[];
  readonly fps: number;
  readonly loop: boolean;
  /** State selected after a non-looping animation finishes. Defaults to idle. */
  readonly fallback?: PetActivityState;
}

export type PetAnimationsV1 = Readonly<Record<PetRequiredActivityState, PetAnimationV1>> &
  Readonly<Partial<Record<PetOptionalActivityState, PetAnimationV1>>>;

/**
 * Declarative, code-free custom pet manifest. Assets live beside the manifest
 * and are addressed only by safe package-relative paths.
 */
export interface PetPackManifestV1 {
  readonly schema: typeof PET_PACK_SCHEMA_V1;
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly spriteSheet: PetSpriteSheetV1;
  readonly animations: PetAnimationsV1;
}

export type PetManifestValidationIssueCode =
  | 'invalid_type'
  | 'missing_field'
  | 'unknown_field'
  | 'invalid_value'
  | 'out_of_range'
  | 'unsafe_path'
  | 'missing_animation'
  | 'invalid_reference';

export interface PetManifestValidationIssue {
  readonly code: PetManifestValidationIssueCode;
  readonly path: string;
  readonly message: string;
}

export type PetManifestValidationResult =
  | { readonly ok: true; readonly value: PetPackManifestV1 }
  | { readonly ok: false; readonly issues: readonly PetManifestValidationIssue[] };

export class PetManifestValidationError extends Error {
  readonly issues: readonly PetManifestValidationIssue[];

  constructor(issues: readonly PetManifestValidationIssue[]) {
    super(`Invalid ${PET_PACK_SCHEMA_V1} manifest: ${issues[0]?.message ?? 'unknown error'}`);
    this.name = 'PetManifestValidationError';
    this.issues = issues;
  }
}

const MANIFEST_SHAPE = defineObjectShape<PetPackManifestV1>()(
  ['schema', 'id', 'displayName', 'spriteSheet', 'animations'],
  ['description'],
);
const SPRITE_SHEET_SHAPE = defineObjectShape<PetSpriteSheetV1>()(
  ['path', 'format', 'frameWidth', 'frameHeight', 'columns', 'rows', 'frameCount'],
  [],
);
const ANIMATION_SHAPE = defineObjectShape<PetAnimationV1>()(
  ['frames', 'fps', 'loop'],
  ['fallback'],
);

const PET_ACTIVITY_STATE_SET = new Set<string>(PET_ACTIVITY_STATES);
const PET_SPRITE_FORMAT_SET = new Set<string>(PET_SPRITE_FORMATS);
const PET_PACK_ID_PATTERN = new RegExp(
  `^[a-z0-9](?:[a-z0-9._-]{0,${PET_PACK_ID_MAX_CHARS - 2}}[a-z0-9])?$`,
);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

export function isPetPackId(value: unknown): value is string {
  return typeof value === 'string' && PET_PACK_ID_PATTERN.test(value);
}

function addIssue(
  issues: PetManifestValidationIssue[],
  code: PetManifestValidationIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function validateExactShape(
  value: Record<string, unknown>,
  shape: ExactObjectShape,
  path: string,
  issues: PetManifestValidationIssue[],
): void {
  for (const field of shape.required) {
    if (!Object.hasOwn(value, field)) {
      addIssue(issues, 'missing_field', `${path}.${field}`, `missing required field ${field}`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!shape.allowed.has(field)) {
      addIssue(issues, 'unknown_field', `${path}.${field}`, `unknown field ${field}`);
    }
  }
}

function validateBoundedText(
  value: unknown,
  path: string,
  maxChars: number,
  issues: PetManifestValidationIssue[],
): value is string {
  if (typeof value !== 'string') {
    addIssue(issues, 'invalid_type', path, 'must be a string');
    return false;
  }
  if (value.length === 0 || value.trim() !== value || CONTROL_CHARACTER_PATTERN.test(value)) {
    addIssue(
      issues,
      'invalid_value',
      path,
      'must be non-empty, trimmed, and free of control characters',
    );
    return false;
  }
  if (value.length > maxChars) {
    addIssue(issues, 'out_of_range', path, `must be at most ${maxChars} characters`);
    return false;
  }
  return true;
}

function validateBoundedInteger(
  value: unknown,
  path: string,
  min: number,
  max: number,
  issues: PetManifestValidationIssue[],
): value is number {
  if (!Number.isInteger(value)) {
    addIssue(issues, 'invalid_type', path, 'must be an integer');
    return false;
  }
  const integer = value as number;
  if (integer < min || integer > max) {
    addIssue(issues, 'out_of_range', path, `must be between ${min} and ${max}`);
    return false;
  }
  return true;
}

export function isSafePetAssetPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PET_ASSET_PATH_MAX_CHARS ||
    value.trim() !== value ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    WINDOWS_DRIVE_PATH_PATTERN.test(value) ||
    value.includes('\\') ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function validateSpriteSheet(
  value: unknown,
  issues: PetManifestValidationIssue[],
): value is PetSpriteSheetV1 {
  const path = '$.spriteSheet';
  if (!isRecord(value)) {
    addIssue(issues, 'invalid_type', path, 'must be an object');
    return false;
  }
  validateExactShape(value, SPRITE_SHEET_SHAPE, path, issues);

  const spritePath = value.path;
  const spriteFormat = value.format;
  const frameWidth = value.frameWidth;
  const frameHeight = value.frameHeight;
  const columns = value.columns;
  const rows = value.rows;
  const frameCount = value.frameCount;

  const safePath = isSafePetAssetPath(spritePath);
  if (!safePath)
    addIssue(issues, 'unsafe_path', `${path}.path`, 'must be a safe package-relative path');

  const validFormat = typeof spriteFormat === 'string' && PET_SPRITE_FORMAT_SET.has(spriteFormat);
  if (!validFormat) {
    addIssue(issues, 'invalid_value', `${path}.format`, 'must be png or webp');
  } else if (safePath && !spritePath.toLowerCase().endsWith(`.${spriteFormat}`)) {
    addIssue(issues, 'invalid_value', `${path}.path`, `must end in .${spriteFormat}`);
  }

  const validFrameWidth = validateBoundedInteger(
    frameWidth,
    `${path}.frameWidth`,
    1,
    PET_SPRITE_FRAME_MAX_DIMENSION,
    issues,
  );
  const validFrameHeight = validateBoundedInteger(
    frameHeight,
    `${path}.frameHeight`,
    1,
    PET_SPRITE_FRAME_MAX_DIMENSION,
    issues,
  );
  const validColumns = validateBoundedInteger(
    columns,
    `${path}.columns`,
    1,
    PET_SPRITE_GRID_MAX_AXIS,
    issues,
  );
  const validRows = validateBoundedInteger(
    rows,
    `${path}.rows`,
    1,
    PET_SPRITE_GRID_MAX_AXIS,
    issues,
  );
  const validFrameCount = validateBoundedInteger(
    frameCount,
    `${path}.frameCount`,
    1,
    PET_SPRITE_FRAME_COUNT_MAX,
    issues,
  );

  if (validFrameWidth && validColumns && frameWidth * columns > PET_SPRITE_SHEET_MAX_DIMENSION) {
    addIssue(
      issues,
      'out_of_range',
      path,
      `sprite sheet width must be at most ${PET_SPRITE_SHEET_MAX_DIMENSION} pixels`,
    );
  }
  if (validFrameHeight && validRows && frameHeight * rows > PET_SPRITE_SHEET_MAX_DIMENSION) {
    addIssue(
      issues,
      'out_of_range',
      path,
      `sprite sheet height must be at most ${PET_SPRITE_SHEET_MAX_DIMENSION} pixels`,
    );
  }
  if (validFrameCount && validColumns && validRows && frameCount > columns * rows) {
    addIssue(
      issues,
      'out_of_range',
      `${path}.frameCount`,
      'cannot exceed the sprite grid capacity',
    );
  }

  return (
    safePath &&
    validFormat &&
    validFrameWidth &&
    validFrameHeight &&
    validColumns &&
    validRows &&
    validFrameCount
  );
}

function validateAnimation(
  value: unknown,
  state: PetActivityState,
  frameCount: number | undefined,
  issues: PetManifestValidationIssue[],
): value is PetAnimationV1 {
  const path = `$.animations.${state}`;
  if (!isRecord(value)) {
    addIssue(issues, 'invalid_type', path, 'must be an object');
    return false;
  }
  validateExactShape(value, ANIMATION_SHAPE, path, issues);

  let validFrames = true;
  if (!Array.isArray(value.frames) || value.frames.length === 0) {
    addIssue(issues, 'invalid_value', `${path}.frames`, 'must be a non-empty array');
    validFrames = false;
  } else if (value.frames.length > PET_SPRITE_FRAME_COUNT_MAX) {
    addIssue(
      issues,
      'out_of_range',
      `${path}.frames`,
      `must contain at most ${PET_SPRITE_FRAME_COUNT_MAX} frames`,
    );
    validFrames = false;
  } else {
    for (const [index, frame] of value.frames.entries()) {
      if (
        !Number.isInteger(frame) ||
        frame < 0 ||
        (frameCount !== undefined && frame >= frameCount)
      ) {
        addIssue(
          issues,
          'out_of_range',
          `${path}.frames[${index}]`,
          frameCount === undefined
            ? 'must be a non-negative integer'
            : `must be an integer between 0 and ${frameCount - 1}`,
        );
        validFrames = false;
      }
    }
  }

  const validFps = validateBoundedInteger(
    value.fps,
    `${path}.fps`,
    1,
    PET_ANIMATION_FPS_MAX,
    issues,
  );
  const validLoop = typeof value.loop === 'boolean';
  if (!validLoop) addIssue(issues, 'invalid_type', `${path}.loop`, 'must be a boolean');

  let validFallback = true;
  if (value.fallback !== undefined) {
    if (typeof value.fallback !== 'string' || !PET_ACTIVITY_STATE_SET.has(value.fallback)) {
      addIssue(issues, 'invalid_value', `${path}.fallback`, 'must name a supported activity state');
      validFallback = false;
    } else if (value.loop === true) {
      addIssue(
        issues,
        'invalid_value',
        `${path}.fallback`,
        'is only valid for non-looping animations',
      );
      validFallback = false;
    }
  }

  return validFrames && validFps && validLoop && validFallback;
}

function validateAnimations(
  value: unknown,
  frameCount: number | undefined,
  issues: PetManifestValidationIssue[],
): value is PetAnimationsV1 {
  const path = '$.animations';
  if (!isRecord(value)) {
    addIssue(issues, 'invalid_type', path, 'must be an object');
    return false;
  }

  let valid = true;
  for (const state of PET_REQUIRED_ACTIVITY_STATES) {
    if (!Object.hasOwn(value, state)) {
      addIssue(
        issues,
        'missing_animation',
        `${path}.${state}`,
        `missing required ${state} animation`,
      );
      valid = false;
    }
  }
  for (const state of Object.keys(value)) {
    if (!PET_ACTIVITY_STATE_SET.has(state)) {
      addIssue(issues, 'unknown_field', `${path}.${state}`, `unknown activity state ${state}`);
      valid = false;
      continue;
    }
    if (!validateAnimation(value[state], state as PetActivityState, frameCount, issues))
      valid = false;
  }

  for (const [state, animation] of Object.entries(value)) {
    if (
      PET_ACTIVITY_STATE_SET.has(state) &&
      isRecord(animation) &&
      typeof animation.fallback === 'string' &&
      PET_ACTIVITY_STATE_SET.has(animation.fallback) &&
      !Object.hasOwn(value, animation.fallback)
    ) {
      addIssue(
        issues,
        'invalid_reference',
        `${path}.${state}.fallback`,
        `references missing ${animation.fallback} animation`,
      );
      valid = false;
    }
  }

  return valid;
}

export function validatePetPackManifest(value: unknown): PetManifestValidationResult {
  const issues: PetManifestValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [{ code: 'invalid_type', path: '$', message: 'manifest must be an object' }],
    };
  }
  validateExactShape(value, MANIFEST_SHAPE, '$', issues);

  if (value.schema !== PET_PACK_SCHEMA_V1) {
    addIssue(issues, 'invalid_value', '$.schema', `must equal ${PET_PACK_SCHEMA_V1}`);
  }

  if (validateBoundedText(value.id, '$.id', PET_PACK_ID_MAX_CHARS, issues)) {
    if (!isPetPackId(value.id)) {
      addIssue(
        issues,
        'invalid_value',
        '$.id',
        'must use lowercase ASCII letters, digits, dots, underscores, or hyphens and start and end with a letter or digit',
      );
    }
  }
  validateBoundedText(value.displayName, '$.displayName', PET_PACK_DISPLAY_NAME_MAX_CHARS, issues);
  if (value.description !== undefined) {
    validateBoundedText(value.description, '$.description', PET_PACK_DESCRIPTION_MAX_CHARS, issues);
  }

  validateSpriteSheet(value.spriteSheet, issues);
  const rawFrameCount = isRecord(value.spriteSheet) ? value.spriteSheet.frameCount : undefined;
  const frameCount =
    Number.isInteger(rawFrameCount) &&
    (rawFrameCount as number) >= 1 &&
    (rawFrameCount as number) <= PET_SPRITE_FRAME_COUNT_MAX
      ? (rawFrameCount as number)
      : undefined;
  validateAnimations(
    value.animations,
    typeof frameCount === 'number' ? frameCount : undefined,
    issues,
  );

  return issues.length === 0
    ? { ok: true, value: value as unknown as PetPackManifestV1 }
    : { ok: false, issues };
}

export function isPetPackManifestV1(value: unknown): value is PetPackManifestV1 {
  return validatePetPackManifest(value).ok;
}

export function decodePetPackManifest(value: unknown): PetPackManifestV1 {
  const result = validatePetPackManifest(value);
  if (!result.ok) throw new PetManifestValidationError(result.issues);
  return result.value;
}

export function resolvePetAnimationState(
  manifest: Pick<PetPackManifestV1, 'animations'>,
  requested: PetActivityState,
): PetActivityState {
  return Object.hasOwn(manifest.animations, requested)
    ? requested
    : PET_ACTIVITY_STATE_FALLBACKS[requested];
}

export function resolvePetAnimationFallback(
  manifest: Pick<PetPackManifestV1, 'animations'>,
  state: PetActivityState,
): PetActivityState {
  const resolvedState = resolvePetAnimationState(manifest, state);
  const animation = manifest.animations[resolvedState] ?? manifest.animations.idle;
  if (animation.loop) return resolvedState;
  return resolvePetAnimationState(manifest, animation.fallback ?? 'idle');
}
