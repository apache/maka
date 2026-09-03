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

import {
  MAX_ADDITIONAL_FILESYSTEM_ENTRIES,
  validateAdditionalPermissionProfile,
  type AdditionalPermissionAccess,
  type AdditionalPermissionRiskSummary,
  type AdditionalPermissionScope,
} from './additional-permissions.js';
import {
  categorizeBash,
  isToolCategory,
  permissionReasonForCategory,
  type PermissionRequest,
  type PermissionRequestPayload,
  type SandboxEscalationRiskSummary,
  type ToolCategory,
} from './permission.js';
import { defineObjectShape, hasExactShape, type ExactObjectShape } from './record-schema.js';
import { redactSecrets } from './redaction.js';
import { projectWriteStdinPermissionSummary } from './tool-activity-args.js';

export const INTERACTION_TOOL_NAME_MAX_BYTES = 256;
export const INTERACTION_PERMISSION_COMMAND_MAX_BYTES = 8 * 1024;
export const INTERACTION_PERMISSION_PATH_MAX_BYTES = 4 * 1024;
export const INTERACTION_PERMISSION_TEXT_MAX_BYTES = 4 * 1024;
export const INTERACTION_GENERIC_TOOL_ARGUMENTS_MAX_BYTES = 4 * 1024;
export const INTERACTION_BROWSER_TEXT_PREVIEW_MAX_BYTES = 2 * 1024;
export const INTERACTION_BROWSER_WAIT_MAX_SECONDS = 120;

const UTF8 = new TextEncoder();
const GENERIC_TOOL_ARGUMENTS_MAX_DEPTH = 32;
const GENERIC_TOOL_ARGUMENT_LONG_STRING_BYTES = 512;
const GENERIC_TOOL_ARGUMENT_STRING_BUDGETS = [512, 256, 128, 64, 32, 16, 8] as const;
const UNSAFE_REVIEW_CHARACTER =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

export type InteractionPermissionReason = PermissionRequest['reason'];

export interface InteractionCommandReview {
  readonly kind: 'command';
  readonly command: string;
  readonly cwd?: string;
}

export interface InteractionPathReview {
  readonly kind: 'path';
  readonly operation: 'read' | 'write' | 'edit';
  readonly path: string;
}

export interface InteractionSearchReview {
  readonly kind: 'search';
  readonly operation: 'glob' | 'grep';
  readonly pattern: string;
  readonly root: string;
  readonly glob?: string;
}

export interface InteractionWebReview {
  readonly kind: 'web';
  readonly targetKind: 'url' | 'query';
  readonly target: string;
}

export interface InteractionGenericToolReview {
  readonly kind: 'tool';
  readonly arguments: {
    readonly text: string;
    readonly bytes: number;
    readonly truncated: boolean;
  };
}

export interface InteractionStdinReview {
  readonly kind: 'stdin';
  readonly ref?: string;
  readonly input?: {
    readonly text: string;
    readonly bytes: number;
    readonly truncated: boolean;
  };
  readonly size?: { readonly cols: number; readonly rows: number };
}

export interface InteractionBrowserTextPreview {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

interface InteractionBrowserReviewBase {
  readonly kind: 'browser';
}

export type InteractionBrowserReview =
  | (InteractionBrowserReviewBase & {
      readonly action: 'navigate';
      readonly url: string;
    })
  | (InteractionBrowserReviewBase & {
      readonly action: 'snapshot';
    })
  | (InteractionBrowserReviewBase & {
      readonly action: 'click';
      readonly ref: string;
    })
  | (InteractionBrowserReviewBase & {
      readonly action: 'type';
      readonly ref: string;
      readonly input: InteractionBrowserTextPreview;
      readonly submit: boolean;
    })
  | (InteractionBrowserReviewBase & {
      readonly action: 'wait';
      readonly condition: 'text' | 'selector';
      readonly value: string;
      readonly timeoutSeconds: number;
    })
  | (InteractionBrowserReviewBase & {
      readonly action: 'wait';
      readonly condition: 'duration';
      readonly seconds: number;
    })
  | (InteractionBrowserReviewBase & {
      readonly action: 'extract';
      readonly selector?: string;
      readonly start: number;
    });

export type InteractionToolPermissionReview =
  | InteractionCommandReview
  | InteractionPathReview
  | InteractionSearchReview
  | InteractionWebReview
  | InteractionGenericToolReview
  | InteractionStdinReview
  | InteractionBrowserReview;

export interface InteractionAdditionalPermissionPathReview {
  readonly path: string;
  readonly access: AdditionalPermissionAccess;
  readonly scope: AdditionalPermissionScope;
}

export interface InteractionPermissionAdditionalPermissionsReview {
  readonly kind: 'additional_permissions';
  readonly cwd: string;
  readonly paths: readonly InteractionAdditionalPermissionPathReview[];
  readonly networkEnabled: boolean;
}

export type InteractionPermissionReview =
  | InteractionToolPermissionReview
  | InteractionPermissionAdditionalPermissionsReview;

export interface InteractionToolPermissionPrompt {
  readonly kind: 'tool_permission';
  readonly toolName: string;
  readonly category: ToolCategory;
  readonly reason: InteractionPermissionReason;
  readonly review: InteractionToolPermissionReview;
  readonly rememberForTurnAllowed: boolean;
}

export interface InteractionAdditionalPermissionsPrompt {
  readonly kind: 'additional_permissions';
  readonly toolName: string;
  readonly category: ToolCategory;
  readonly reason: 'additional_permissions';
  readonly review: InteractionPermissionAdditionalPermissionsReview;
  readonly risk: AdditionalPermissionRiskSummary;
  readonly alsoApprovesToolExecution: boolean;
  readonly availableDecisions: readonly ['allow_once', 'deny'];
}

export interface InteractionSandboxEscalationPrompt {
  readonly kind: 'sandbox_escalation';
  readonly toolName: 'Bash';
  readonly category: ToolCategory;
  readonly reason: 'sandbox_escalation';
  readonly review: InteractionCommandReview & { readonly cwd: string };
  readonly trigger: 'proactive' | 'sandbox_denial';
  readonly risk: SandboxEscalationRiskSummary;
  readonly alsoApprovesToolExecution: boolean;
  readonly availableDecisions: readonly ['allow_once', 'deny'];
}

export type InteractionPermissionPrompt =
  | InteractionToolPermissionPrompt
  | InteractionAdditionalPermissionsPrompt
  | InteractionSandboxEscalationPrompt;

export type InteractionPermissionProjectionInput = PermissionRequestPayload;
export type InteractionPermissionProjectionErrorReason = 'unrepresentable_review';

export class InteractionPermissionProjectionError extends Error {
  readonly reason: InteractionPermissionProjectionErrorReason = 'unrepresentable_review';

  constructor(message = 'Permission review cannot be safely represented') {
    super(message);
    this.name = 'InteractionPermissionProjectionError';
  }
}

const TOOL_PROMPT_SHAPE = defineObjectShape<InteractionToolPermissionPrompt>()(
  ['kind', 'toolName', 'category', 'reason', 'review', 'rememberForTurnAllowed'],
  [],
);
const ADDITIONAL_PROMPT_SHAPE = defineObjectShape<InteractionAdditionalPermissionsPrompt>()(
  [
    'kind',
    'toolName',
    'category',
    'reason',
    'review',
    'risk',
    'alsoApprovesToolExecution',
    'availableDecisions',
  ],
  [],
);
const SANDBOX_PROMPT_SHAPE = defineObjectShape<InteractionSandboxEscalationPrompt>()(
  [
    'kind',
    'toolName',
    'category',
    'reason',
    'review',
    'trigger',
    'risk',
    'alsoApprovesToolExecution',
    'availableDecisions',
  ],
  [],
);
const COMMAND_SHAPE = defineObjectShape<InteractionCommandReview>()(['kind', 'command'], ['cwd']);
const PATH_SHAPE = defineObjectShape<InteractionPathReview>()(['kind', 'operation', 'path'], []);
const SEARCH_SHAPE = defineObjectShape<InteractionSearchReview>()(
  ['kind', 'operation', 'pattern', 'root'],
  ['glob'],
);
const WEB_SHAPE = defineObjectShape<InteractionWebReview>()(['kind', 'targetKind', 'target'], []);
const GENERIC_TOOL_SHAPE = defineObjectShape<InteractionGenericToolReview>()(
  ['kind', 'arguments'],
  [],
);
const GENERIC_TOOL_ARGUMENTS_SHAPE = defineObjectShape<InteractionGenericToolReview['arguments']>()(
  ['text', 'bytes', 'truncated'],
  [],
);
const STDIN_SHAPE = defineObjectShape<InteractionStdinReview>()(['kind'], ['ref', 'input', 'size']);
const STDIN_INPUT_SHAPE = defineObjectShape<NonNullable<InteractionStdinReview['input']>>()(
  ['text', 'bytes', 'truncated'],
  [],
);
const STDIN_SIZE_SHAPE = defineObjectShape<NonNullable<InteractionStdinReview['size']>>()(
  ['cols', 'rows'],
  [],
);
const BROWSER_NAVIGATE_SHAPE = defineObjectShape<
  Extract<InteractionBrowserReview, { action: 'navigate' }>
>()(['kind', 'action', 'url'], []);
const BROWSER_SNAPSHOT_SHAPE = defineObjectShape<
  Extract<InteractionBrowserReview, { action: 'snapshot' }>
>()(['kind', 'action'], []);
const BROWSER_CLICK_SHAPE = defineObjectShape<
  Extract<InteractionBrowserReview, { action: 'click' }>
>()(['kind', 'action', 'ref'], []);
const BROWSER_TYPE_SHAPE = defineObjectShape<
  Extract<InteractionBrowserReview, { action: 'type' }>
>()(['kind', 'action', 'ref', 'input', 'submit'], []);
const BROWSER_TEXT_PREVIEW_SHAPE = defineObjectShape<InteractionBrowserTextPreview>()(
  ['text', 'bytes', 'truncated'],
  [],
);
const BROWSER_WAIT_VALUE_SHAPE = defineObjectShape<
  Extract<InteractionBrowserReview, { action: 'wait'; condition: 'text' | 'selector' }>
>()(['kind', 'action', 'condition', 'value', 'timeoutSeconds'], []);
const BROWSER_WAIT_DURATION_SHAPE = defineObjectShape<
  Extract<InteractionBrowserReview, { action: 'wait'; condition: 'duration' }>
>()(['kind', 'action', 'condition', 'seconds'], []);
const BROWSER_EXTRACT_SHAPE = defineObjectShape<
  Extract<InteractionBrowserReview, { action: 'extract' }>
>()(['kind', 'action', 'start'], ['selector']);
const ADDITIONAL_REVIEW_SHAPE =
  defineObjectShape<InteractionPermissionAdditionalPermissionsReview>()(
    ['kind', 'cwd', 'paths', 'networkEnabled'],
    [],
  );
const ADDITIONAL_PATH_SHAPE = defineObjectShape<InteractionAdditionalPermissionPathReview>()(
  ['path', 'access', 'scope'],
  [],
);
const ADDITIONAL_RISK_SHAPE = defineObjectShape<AdditionalPermissionRiskSummary>()(
  ['outsideWorkspace', 'protectedMetadata', 'networkEnabled'],
  [],
);
const SANDBOX_RISK_SHAPE = defineObjectShape<SandboxEscalationRiskSummary>()(
  [
    'unsandboxedExecution',
    'unrestrictedFileSystem',
    'unrestrictedNetwork',
    'protectedMetadataExposed',
  ],
  [],
);

export function projectInteractionPermissionPrompt(
  request: InteractionPermissionProjectionInput,
): InteractionPermissionPrompt {
  if (request.kind === 'tool_permission') {
    const toolName = boundedString(request.toolName, 'toolName', INTERACTION_TOOL_NAME_MAX_BYTES);
    const category = categoryValue(request.category);
    const review = projectToolReview(toolName, category, request.args);
    const remember = boolean(request.rememberForTurnAllowed, 'rememberForTurnAllowed');
    assertToolSemantics(toolName, category, request.reason, review, remember);
    return deepFreeze({
      kind: 'tool_permission',
      toolName,
      category,
      reason: request.reason,
      review,
      rememberForTurnAllowed: remember,
    });
  }
  if (request.kind === 'additional_permissions') return projectAdditionalPrompt(request);
  return projectSandboxPrompt(request);
}

export function decodeInteractionPermissionPrompt(value: unknown): InteractionPermissionPrompt {
  const record = plainRecord(value, 'Interaction permission prompt');
  if (record.kind === 'tool_permission') {
    exact(record, TOOL_PROMPT_SHAPE, 'tool permission prompt');
    const toolName = boundedString(record.toolName, 'toolName', INTERACTION_TOOL_NAME_MAX_BYTES);
    const category = categoryValue(record.category);
    const reason = reasonValue(record.reason);
    const review = decodeToolReview(record.review);
    const remember = boolean(record.rememberForTurnAllowed, 'rememberForTurnAllowed');
    assertToolSemantics(toolName, category, reason, review, remember);
    return deepFreeze({
      kind: 'tool_permission',
      toolName,
      category,
      reason,
      review,
      rememberForTurnAllowed: remember,
    });
  }
  if (record.kind === 'additional_permissions') {
    exact(record, ADDITIONAL_PROMPT_SHAPE, 'additional permission prompt');
    if (record.reason !== 'additional_permissions' || !allowOnceDeny(record.availableDecisions))
      throw new Error('Invalid additional permission prompt');
    const review = decodeAdditionalReview(record.review);
    const risk = decodeAdditionalRisk(record.risk);
    if (review.networkEnabled !== risk.networkEnabled)
      throw new Error('Permission review does not match risk');
    return deepFreeze({
      kind: 'additional_permissions',
      toolName: boundedString(record.toolName, 'toolName', INTERACTION_TOOL_NAME_MAX_BYTES),
      category: categoryValue(record.category),
      reason: 'additional_permissions',
      review,
      risk,
      alsoApprovesToolExecution: boolean(
        record.alsoApprovesToolExecution,
        'alsoApprovesToolExecution',
      ),
      availableDecisions: ['allow_once', 'deny'],
    });
  }
  if (record.kind === 'sandbox_escalation') return decodeSandboxPrompt(record);
  throw new Error('Invalid Interaction permission prompt kind');
}

function projectAdditionalPrompt(
  request: Extract<PermissionRequestPayload, { kind: 'additional_permissions' }>,
): InteractionAdditionalPermissionsPrompt {
  if (!allowOnceDeny(request.availableDecisions)) throw new Error('Invalid available decisions');
  const validated = validateAdditionalPermissionProfile(request.additionalPermissions);
  if (!validated.ok) throw new InteractionPermissionProjectionError(validated.message);
  const paths = (validated.profile.fileSystem?.entries ?? []).map((entry) => ({
    ...entry,
    path: safeText(entry.path, INTERACTION_PERMISSION_PATH_MAX_BYTES),
  }));
  const networkEnabled = validated.profile.network?.enabled === true;
  const risk = decodeAdditionalRisk(request.risk);
  if (networkEnabled !== risk.networkEnabled)
    throw new Error('Permission review does not match risk');
  return deepFreeze({
    kind: 'additional_permissions',
    toolName: boundedString(request.toolName, 'toolName', INTERACTION_TOOL_NAME_MAX_BYTES),
    category: categoryValue(request.category),
    reason: 'additional_permissions',
    review: {
      kind: 'additional_permissions',
      cwd: safeText(request.cwd, INTERACTION_PERMISSION_PATH_MAX_BYTES),
      paths,
      networkEnabled,
    },
    risk,
    alsoApprovesToolExecution: boolean(
      request.alsoApprovesToolExecution,
      'alsoApprovesToolExecution',
    ),
    availableDecisions: ['allow_once', 'deny'],
  });
}

function projectSandboxPrompt(
  request: Extract<PermissionRequestPayload, { kind: 'sandbox_escalation' }>,
): InteractionSandboxEscalationPrompt {
  if (
    request.toolName !== 'Bash' ||
    request.reason !== 'sandbox_escalation' ||
    !allowOnceDeny(request.availableDecisions)
  )
    throw new Error('Invalid sandbox escalation request');
  const category = categoryValue(request.category);
  if (category !== categorizeBash(request.command))
    throw new Error('Sandbox category does not match command');
  const command = safeText(request.command, INTERACTION_PERMISSION_COMMAND_MAX_BYTES);
  if (category !== categorizeBash(command)) throw new InteractionPermissionProjectionError();
  const prompt: InteractionSandboxEscalationPrompt = {
    kind: 'sandbox_escalation',
    toolName: 'Bash',
    category,
    reason: 'sandbox_escalation',
    review: {
      kind: 'command',
      command,
      cwd: safeText(request.cwd, INTERACTION_PERMISSION_PATH_MAX_BYTES),
    },
    trigger: oneOf(request.trigger, ['proactive', 'sandbox_denial'] as const, 'trigger'),
    risk: decodeSandboxRisk(request.risk),
    alsoApprovesToolExecution: boolean(
      request.alsoApprovesToolExecution,
      'alsoApprovesToolExecution',
    ),
    availableDecisions: ['allow_once', 'deny'],
  };
  return decodeInteractionPermissionPrompt(prompt) as InteractionSandboxEscalationPrompt;
}

function decodeSandboxPrompt(record: Record<string, unknown>): InteractionSandboxEscalationPrompt {
  exact(record, SANDBOX_PROMPT_SHAPE, 'sandbox escalation prompt');
  if (
    record.toolName !== 'Bash' ||
    record.reason !== 'sandbox_escalation' ||
    !allowOnceDeny(record.availableDecisions)
  )
    throw new Error('Invalid sandbox escalation prompt');
  const review = decodeToolReview(record.review);
  if (review.kind !== 'command' || review.cwd === undefined)
    throw new Error('Invalid sandbox command review');
  const category = categoryValue(record.category);
  if (category !== categorizeBash(review.command))
    throw new Error('Sandbox category does not match command review');
  return deepFreeze({
    kind: 'sandbox_escalation',
    toolName: 'Bash',
    category,
    reason: 'sandbox_escalation',
    review: { ...review, cwd: review.cwd },
    trigger: oneOf(record.trigger, ['proactive', 'sandbox_denial'] as const, 'trigger'),
    risk: decodeSandboxRisk(record.risk),
    alsoApprovesToolExecution: boolean(
      record.alsoApprovesToolExecution,
      'alsoApprovesToolExecution',
    ),
    availableDecisions: ['allow_once', 'deny'],
  });
}

function projectToolReview(
  toolName: string,
  category: ToolCategory,
  args: unknown,
): InteractionToolPermissionReview {
  const record = projectionRecord(args);
  switch (toolName) {
    case 'Bash': {
      const command = projectionString(record.command, INTERACTION_PERMISSION_COMMAND_MAX_BYTES);
      const cwd = optionalProjectionString(record, 'cwd', INTERACTION_PERMISSION_PATH_MAX_BYTES);
      if (category !== categorizeBash(command))
        throw new Error('Bash category does not match command');
      return {
        kind: 'command',
        command: safeText(command, INTERACTION_PERMISSION_COMMAND_MAX_BYTES),
        ...(cwd === undefined ? {} : { cwd: safeText(cwd, INTERACTION_PERMISSION_PATH_MAX_BYTES) }),
      };
    }
    case 'Read':
    case 'Write':
    case 'Edit': {
      const path = projectionStringFrom(
        record,
        'path',
        'file_path',
        INTERACTION_PERMISSION_PATH_MAX_BYTES,
      );
      return {
        kind: 'path',
        operation: toolName === 'Read' ? 'read' : toolName === 'Write' ? 'write' : 'edit',
        path: safeText(path, INTERACTION_PERMISSION_PATH_MAX_BYTES),
      };
    }
    case 'Glob':
      return projectSearch(record, 'glob');
    case 'Grep':
      return projectSearch(record, 'grep');
    case 'WebFetch':
      return {
        kind: 'web',
        targetKind: 'url',
        target: safeText(
          projectionString(record.url, INTERACTION_PERMISSION_TEXT_MAX_BYTES),
          INTERACTION_PERMISSION_TEXT_MAX_BYTES,
        ),
      };
    case 'WebSearch':
      return {
        kind: 'web',
        targetKind: 'query',
        target: safeText(
          projectionString(record.query, INTERACTION_PERMISSION_TEXT_MAX_BYTES),
          INTERACTION_PERMISSION_TEXT_MAX_BYTES,
        ),
      };
    case 'WriteStdin':
      return projectStdin(args);
    case 'browser_navigate':
    case 'browser_snapshot':
    case 'browser_click':
    case 'browser_type':
    case 'browser_wait':
    case 'browser_extract':
      return projectBrowser(toolName, record);
    default:
      return projectGenericToolReview(record);
  }
}

function projectGenericToolReview(record: Record<string, unknown>): InteractionGenericToolReview {
  let serialized: string;
  let redacted: unknown;
  try {
    serialized = JSON.stringify(canonicalizeGenericToolArguments(record, new WeakSet<object>(), 0));
    redacted = JSON.parse(redactSecrets(serialized));
  } catch {
    throw new InteractionPermissionProjectionError();
  }
  const bytes = UTF8.encode(serialized).byteLength;
  for (const stringBudget of GENERIC_TOOL_ARGUMENT_STRING_BUDGETS) {
    const summary = summarizeGenericToolArguments(redacted, stringBudget);
    const text = sanitizeText(JSON.stringify(summary.value), true);
    if (UTF8.encode(text).byteLength <= INTERACTION_GENERIC_TOOL_ARGUMENTS_MAX_BYTES) {
      return deepFreeze({
        kind: 'tool',
        arguments: { text, bytes, truncated: summary.truncated },
      });
    }
  }
  throw new InteractionPermissionProjectionError();
}

function projectBrowser(
  toolName:
    | 'browser_navigate'
    | 'browser_snapshot'
    | 'browser_click'
    | 'browser_type'
    | 'browser_wait'
    | 'browser_extract',
  record: Record<string, unknown>,
): InteractionBrowserReview {
  switch (toolName) {
    case 'browser_navigate':
      return {
        kind: 'browser',
        action: 'navigate',
        url: safeText(
          projectionString(record.url, INTERACTION_PERMISSION_TEXT_MAX_BYTES),
          INTERACTION_PERMISSION_TEXT_MAX_BYTES,
        ),
      };
    case 'browser_snapshot':
      return { kind: 'browser', action: 'snapshot' };
    case 'browser_click':
      return {
        kind: 'browser',
        action: 'click',
        ref: safeText(
          projectionString(record.ref, INTERACTION_PERMISSION_PATH_MAX_BYTES),
          INTERACTION_PERMISSION_PATH_MAX_BYTES,
        ),
      };
    case 'browser_type': {
      const submit = optionalProjectionBoolean(record, 'submit') ?? false;
      return {
        kind: 'browser',
        action: 'type',
        ref: safeText(
          projectionString(record.ref, INTERACTION_PERMISSION_PATH_MAX_BYTES),
          INTERACTION_PERMISSION_PATH_MAX_BYTES,
        ),
        input: projectBrowserTextPreview(record.text),
        submit,
      };
    }
    case 'browser_wait':
      return projectBrowserWait(record);
    case 'browser_extract': {
      const selector = optionalProjectionText(
        record,
        'selector',
        INTERACTION_PERMISSION_TEXT_MAX_BYTES,
        true,
      );
      const start = Object.hasOwn(record, 'start') ? normalizeBrowserStart(record.start) : 0;
      return {
        kind: 'browser',
        action: 'extract',
        ...(selector === undefined ? {} : { selector }),
        start,
      };
    }
  }
}

function projectBrowserWait(record: Record<string, unknown>): InteractionBrowserReview {
  const present = (['text', 'selector', 'time'] as const).filter((key) =>
    Object.hasOwn(record, key),
  );
  if (present.length !== 1) throw new InteractionPermissionProjectionError();
  const timeout = Object.hasOwn(record, 'timeout')
    ? positiveFiniteNumberForProjection(record.timeout, 'browser timeout')
    : undefined;
  if (present[0] === 'time') {
    const seconds = Math.min(
      positiveFiniteNumberForProjection(record.time, 'browser wait'),
      INTERACTION_BROWSER_WAIT_MAX_SECONDS,
    );
    return { kind: 'browser', action: 'wait', condition: 'duration', seconds };
  }
  const condition = present[0];
  const value = safeText(
    projectionString(record[condition], INTERACTION_PERMISSION_TEXT_MAX_BYTES),
    INTERACTION_PERMISSION_TEXT_MAX_BYTES,
  );
  if (value.trim().length === 0) throw new InteractionPermissionProjectionError();
  return {
    kind: 'browser',
    action: 'wait',
    condition,
    value,
    timeoutSeconds: Math.min(
      timeout ?? (condition === 'selector' ? 10 : 30),
      INTERACTION_BROWSER_WAIT_MAX_SECONDS,
    ),
  };
}

function projectBrowserTextPreview(value: unknown): InteractionBrowserTextPreview {
  if (typeof value !== 'string') throw new InteractionPermissionProjectionError();
  const bytes = UTF8.encode(value).byteLength;
  const safe = sanitizeText(value, true);
  let text = '';
  let previewBytes = 0;
  for (const char of safe) {
    const charBytes = UTF8.encode(char).byteLength;
    if (previewBytes + charBytes > INTERACTION_BROWSER_TEXT_PREVIEW_MAX_BYTES) break;
    text += char;
    previewBytes += charBytes;
  }
  return Object.freeze({ text, bytes, truncated: text.length < safe.length });
}

function projectSearch(
  record: Record<string, unknown>,
  operation: 'glob' | 'grep',
): InteractionSearchReview {
  const pattern = safeText(
    projectionString(record.pattern, INTERACTION_PERMISSION_TEXT_MAX_BYTES),
    INTERACTION_PERMISSION_TEXT_MAX_BYTES,
  );
  const root = safeText(
    projectionStringFrom(record, 'path', 'cwd', INTERACTION_PERMISSION_PATH_MAX_BYTES),
    INTERACTION_PERMISSION_PATH_MAX_BYTES,
  );
  const glob =
    operation === 'grep'
      ? optionalProjectionString(record, 'glob', INTERACTION_PERMISSION_TEXT_MAX_BYTES)
      : undefined;
  return {
    kind: 'search',
    operation,
    pattern,
    root,
    ...(glob === undefined ? {} : { glob: safeText(glob, INTERACTION_PERMISSION_TEXT_MAX_BYTES) }),
  };
}

function projectStdin(args: unknown): InteractionStdinReview {
  const raw = projectionRecord(args);
  for (const key of ['ref', 'input'] as const) {
    if (Object.hasOwn(raw, key) && typeof raw[key] !== 'string')
      throw new InteractionPermissionProjectionError();
  }
  if (Object.hasOwn(raw, 'size')) {
    let size: Record<string, unknown>;
    try {
      size = plainRecord(raw.size, 'stdin size');
      exact(size, STDIN_SIZE_SHAPE, 'stdin size');
      positiveInteger(size.cols, 'cols');
      positiveInteger(size.rows, 'rows');
    } catch {
      throw new InteractionPermissionProjectionError();
    }
  }
  const summary = projectWriteStdinPermissionSummary(args);
  if (Object.keys(summary).length === 0) throw new InteractionPermissionProjectionError();
  if (summary.size && (summary.size.cols <= 0 || summary.size.rows <= 0))
    throw new InteractionPermissionProjectionError();
  return deepFreeze({
    kind: 'stdin',
    ...(summary.ref
      ? {
          ref: safeText(summary.ref.text, INTERACTION_PERMISSION_TEXT_MAX_BYTES),
        }
      : {}),
    ...(summary.input ? { input: summary.input } : {}),
    ...(summary.size ? { size: summary.size } : {}),
  });
}

function decodeToolReview(value: unknown): InteractionToolPermissionReview {
  const record = plainRecord(value, 'Permission review');
  switch (record.kind) {
    case 'command':
      exact(record, COMMAND_SHAPE, 'command review');
      return Object.freeze({
        kind: 'command',
        command: safeCanonicalString(
          record.command,
          'command',
          INTERACTION_PERMISSION_COMMAND_MAX_BYTES,
        ),
        ...(record.cwd === undefined
          ? {}
          : {
              cwd: safeCanonicalString(record.cwd, 'cwd', INTERACTION_PERMISSION_PATH_MAX_BYTES),
            }),
      });
    case 'path':
      exact(record, PATH_SHAPE, 'path review');
      return Object.freeze({
        kind: 'path',
        operation: oneOf(record.operation, ['read', 'write', 'edit'] as const, 'operation'),
        path: safeCanonicalString(record.path, 'path', INTERACTION_PERMISSION_PATH_MAX_BYTES),
      });
    case 'search':
      exact(record, SEARCH_SHAPE, 'search review');
      return Object.freeze({
        kind: 'search',
        operation: oneOf(record.operation, ['glob', 'grep'] as const, 'operation'),
        pattern: safeCanonicalString(
          record.pattern,
          'pattern',
          INTERACTION_PERMISSION_TEXT_MAX_BYTES,
        ),
        root: safeCanonicalString(record.root, 'root', INTERACTION_PERMISSION_PATH_MAX_BYTES),
        ...(record.glob === undefined
          ? {}
          : {
              glob: safeCanonicalString(record.glob, 'glob', INTERACTION_PERMISSION_TEXT_MAX_BYTES),
            }),
      });
    case 'web':
      exact(record, WEB_SHAPE, 'web review');
      return Object.freeze({
        kind: 'web',
        targetKind: oneOf(record.targetKind, ['url', 'query'] as const, 'targetKind'),
        target: safeCanonicalString(record.target, 'target', INTERACTION_PERMISSION_TEXT_MAX_BYTES),
      });
    case 'tool': {
      exact(record, GENERIC_TOOL_SHAPE, 'generic tool review');
      const args = plainRecord(record.arguments, 'generic tool arguments');
      exact(args, GENERIC_TOOL_ARGUMENTS_SHAPE, 'generic tool arguments');
      return deepFreeze({
        kind: 'tool',
        arguments: {
          text: safeCanonicalText(
            args.text,
            'generic tool arguments text',
            INTERACTION_GENERIC_TOOL_ARGUMENTS_MAX_BYTES,
            true,
          ),
          bytes: nonNegativeInteger(args.bytes, 'generic tool arguments bytes'),
          truncated: boolean(args.truncated, 'generic tool arguments truncated'),
        },
      });
    }
    case 'stdin':
      return decodeStdin(record);
    case 'browser':
      return decodeBrowser(record);
    default:
      throw new Error('Invalid permission review kind');
  }
}

function decodeBrowser(record: Record<string, unknown>): InteractionBrowserReview {
  switch (record.action) {
    case 'navigate':
      exact(record, BROWSER_NAVIGATE_SHAPE, 'browser navigate review');
      return Object.freeze({
        kind: 'browser',
        action: 'navigate',
        url: safeCanonicalString(record.url, 'browser URL', INTERACTION_PERMISSION_TEXT_MAX_BYTES),
      });
    case 'snapshot':
      exact(record, BROWSER_SNAPSHOT_SHAPE, 'browser snapshot review');
      return Object.freeze({ kind: 'browser', action: 'snapshot' });
    case 'click':
      exact(record, BROWSER_CLICK_SHAPE, 'browser click review');
      return Object.freeze({
        kind: 'browser',
        action: 'click',
        ref: safeCanonicalString(record.ref, 'browser ref', INTERACTION_PERMISSION_PATH_MAX_BYTES),
      });
    case 'type': {
      exact(record, BROWSER_TYPE_SHAPE, 'browser type review');
      const input = plainRecord(record.input, 'browser input preview');
      exact(input, BROWSER_TEXT_PREVIEW_SHAPE, 'browser input preview');
      return deepFreeze({
        kind: 'browser',
        action: 'type',
        ref: safeCanonicalString(record.ref, 'browser ref', INTERACTION_PERMISSION_PATH_MAX_BYTES),
        input: {
          text: safeCanonicalText(
            input.text,
            'browser input text',
            INTERACTION_BROWSER_TEXT_PREVIEW_MAX_BYTES,
            true,
          ),
          bytes: nonNegativeInteger(input.bytes, 'browser input bytes'),
          truncated: boolean(input.truncated, 'browser input truncated'),
        },
        submit: boolean(record.submit, 'browser submit'),
      });
    }
    case 'wait':
      return decodeBrowserWait(record);
    case 'extract':
      exact(record, BROWSER_EXTRACT_SHAPE, 'browser extract review');
      return Object.freeze({
        kind: 'browser',
        action: 'extract',
        ...(record.selector === undefined
          ? {}
          : {
              selector: safeCanonicalText(
                record.selector,
                'browser selector',
                INTERACTION_PERMISSION_TEXT_MAX_BYTES,
                true,
              ),
            }),
        start: nonNegativeInteger(record.start, 'browser start'),
      });
    default:
      throw new Error('Invalid browser review action');
  }
}

function decodeBrowserWait(record: Record<string, unknown>): InteractionBrowserReview {
  if (record.condition === 'duration') {
    exact(record, BROWSER_WAIT_DURATION_SHAPE, 'browser duration wait review');
    return Object.freeze({
      kind: 'browser',
      action: 'wait',
      condition: 'duration',
      seconds: boundedPositiveNumber(record.seconds, 'browser wait'),
    });
  }
  exact(record, BROWSER_WAIT_VALUE_SHAPE, 'browser value wait review');
  const condition = oneOf(record.condition, ['text', 'selector'] as const, 'condition');
  const value = safeCanonicalString(
    record.value,
    `browser ${condition}`,
    INTERACTION_PERMISSION_TEXT_MAX_BYTES,
  );
  if (value.trim().length === 0) throw new Error('Invalid browser wait value');
  return Object.freeze({
    kind: 'browser',
    action: 'wait',
    condition,
    value,
    timeoutSeconds: boundedPositiveNumber(record.timeoutSeconds, 'browser timeout'),
  });
}

function decodeStdin(record: Record<string, unknown>): InteractionStdinReview {
  exact(record, STDIN_SHAPE, 'stdin review');
  let input: NonNullable<InteractionStdinReview['input']> | undefined;
  if (record.input !== undefined) {
    const value = plainRecord(record.input, 'stdin input');
    exact(value, STDIN_INPUT_SHAPE, 'stdin input');
    input = {
      text: safeCanonicalString(value.text, 'stdin text', INTERACTION_PERMISSION_TEXT_MAX_BYTES),
      bytes: nonNegativeInteger(value.bytes, 'stdin bytes'),
      truncated: boolean(value.truncated, 'truncated'),
    };
  }
  let size: NonNullable<InteractionStdinReview['size']> | undefined;
  if (record.size !== undefined) {
    const value = plainRecord(record.size, 'stdin size');
    exact(value, STDIN_SIZE_SHAPE, 'stdin size');
    size = {
      cols: positiveInteger(value.cols, 'cols'),
      rows: positiveInteger(value.rows, 'rows'),
    };
  }
  if (record.ref === undefined && !input && !size) throw new Error('Empty stdin review');
  return deepFreeze({
    kind: 'stdin',
    ...(record.ref === undefined
      ? {}
      : {
          ref: safeCanonicalString(record.ref, 'stdin ref', INTERACTION_PERMISSION_TEXT_MAX_BYTES),
        }),
    ...(input ? { input } : {}),
    ...(size ? { size } : {}),
  });
}

function decodeAdditionalReview(value: unknown): InteractionPermissionAdditionalPermissionsReview {
  const record = plainRecord(value, 'Additional permission review');
  exact(record, ADDITIONAL_REVIEW_SHAPE, 'additional permission review');
  if (record.kind !== 'additional_permissions') throw new Error('Invalid additional review kind');
  const paths = plainArray(
    record.paths,
    'additional paths',
    0,
    MAX_ADDITIONAL_FILESYSTEM_ENTRIES,
  ).map((item) => {
    const path = plainRecord(item, 'additional path');
    exact(path, ADDITIONAL_PATH_SHAPE, 'additional path');
    return {
      path: safeCanonicalString(path.path, 'path', INTERACTION_PERMISSION_PATH_MAX_BYTES),
      access: oneOf(path.access, ['read', 'write'] as const, 'access'),
      scope: oneOf(path.scope, ['exact', 'subtree'] as const, 'scope'),
    };
  });
  const networkEnabled = boolean(record.networkEnabled, 'networkEnabled');
  if (paths.length === 0 && !networkEnabled) throw new Error('Empty additional permission review');
  return deepFreeze({
    kind: 'additional_permissions',
    cwd: safeCanonicalString(record.cwd, 'cwd', INTERACTION_PERMISSION_PATH_MAX_BYTES),
    paths,
    networkEnabled,
  });
}

function decodeAdditionalRisk(value: unknown): AdditionalPermissionRiskSummary {
  const record = plainRecord(value, 'additional risk');
  exact(record, ADDITIONAL_RISK_SHAPE, 'additional risk');
  return Object.freeze({
    outsideWorkspace: boolean(record.outsideWorkspace, 'outsideWorkspace'),
    protectedMetadata: boolean(record.protectedMetadata, 'protectedMetadata'),
    networkEnabled: boolean(record.networkEnabled, 'networkEnabled'),
  });
}

function decodeSandboxRisk(value: unknown): SandboxEscalationRiskSummary {
  const record = plainRecord(value, 'sandbox risk');
  exact(record, SANDBOX_RISK_SHAPE, 'sandbox risk');
  if (
    record.unsandboxedExecution !== true ||
    record.unrestrictedFileSystem !== true ||
    record.unrestrictedNetwork !== true ||
    record.protectedMetadataExposed !== true
  )
    throw new Error('Invalid sandbox risk');
  return Object.freeze({
    unsandboxedExecution: true,
    unrestrictedFileSystem: true,
    unrestrictedNetwork: true,
    protectedMetadataExposed: true,
  });
}

function assertToolSemantics(
  toolName: string,
  category: ToolCategory,
  reason: InteractionPermissionReason,
  review: InteractionToolPermissionReview,
  remember: boolean,
): void {
  if (permissionReasonForCategory(category) !== reason)
    throw new Error('Permission category does not match reason');
  const identity: Record<string, readonly [ToolCategory, InteractionToolPermissionReview['kind']]> =
    {
      Read: ['read', 'path'],
      Write: ['file_write', 'path'],
      Edit: ['file_write', 'path'],
      Glob: ['read', 'search'],
      Grep: ['read', 'search'],
      WebFetch: ['web_read', 'web'],
      WebSearch: ['web_read', 'web'],
      WriteStdin: ['shell_unsafe', 'stdin'],
      browser_navigate: ['browser', 'browser'],
      browser_snapshot: ['browser', 'browser'],
      browser_click: ['browser', 'browser'],
      browser_type: ['browser', 'browser'],
      browser_wait: ['browser', 'browser'],
      browser_extract: ['browser', 'browser'],
    };
  const expected =
    toolName === 'Bash'
      ? ([category, 'command'] as const)
      : (identity[toolName] ?? ([category, 'tool'] as const));
  if (category !== expected[0] || review.kind !== expected[1])
    throw new Error('Permission review does not match tool identity');
  if (review.kind === 'browser') {
    const actionByTool = {
      browser_navigate: 'navigate',
      browser_snapshot: 'snapshot',
      browser_click: 'click',
      browser_type: 'type',
      browser_wait: 'wait',
      browser_extract: 'extract',
    } as const;
    if (actionByTool[toolName as keyof typeof actionByTool] !== review.action)
      throw new Error('Browser review does not match tool identity');
  }
  if (toolName === 'WriteStdin' && remember) throw new Error('WriteStdin cannot be remembered');
  if (
    toolName === 'Bash' &&
    review.kind === 'command' &&
    category !== categorizeBash(review.command)
  )
    throw new Error('Bash category does not match command');
}

function reasonValue(value: unknown): InteractionPermissionReason {
  return oneOf(
    value,
    [
      'shell_dangerous',
      'file_write',
      'fs_destructive',
      'network',
      'git_destructive',
      'privileged',
      'browser',
      'computer_use',
      'custom',
    ] as const,
    'reason',
  );
}

function categoryValue(value: unknown): ToolCategory {
  if (!isToolCategory(value)) throw new Error('Invalid permission category');
  return value;
}

function optionalProjectionString(
  record: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  return projectionString(record[key], maxBytes);
}

function optionalProjectionText(
  record: Record<string, unknown>,
  key: string,
  maxBytes: number,
  allowEmpty: boolean,
): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  if (typeof record[key] !== 'string') throw new InteractionPermissionProjectionError();
  return safeText(record[key], maxBytes, allowEmpty);
}

function optionalProjectionBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  if (typeof record[key] !== 'boolean') throw new InteractionPermissionProjectionError();
  return record[key];
}

function projectionStringFrom(
  record: Record<string, unknown>,
  primary: string,
  fallback: string,
  maxBytes: number,
): string {
  return projectionString(
    Object.hasOwn(record, primary) ? record[primary] : record[fallback],
    maxBytes,
  );
}

function projectionString(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || UTF8.encode(value).byteLength > maxBytes)
    throw new InteractionPermissionProjectionError();
  return value;
}

export function projectInteractionReviewText(
  value: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  if (!allowEmpty && value.length === 0) throw new InteractionPermissionProjectionError();
  const safe = sanitizeText(value, allowEmpty);
  if (UTF8.encode(safe).byteLength > maxBytes) throw new InteractionPermissionProjectionError();
  return safe;
}

const safeText = projectInteractionReviewText;

function sanitizeText(value: string, allowEmpty: boolean): string {
  if (!allowEmpty && value.length === 0) throw new InteractionPermissionProjectionError();
  return redactSecrets(value).replace(
    UNSAFE_REVIEW_CHARACTER,
    (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`,
  );
}

function safeCanonicalString(value: unknown, label: string, maxBytes: number): string {
  const text = boundedString(value, label, maxBytes);
  if (safeText(text, maxBytes) !== text) throw new Error(`Unsafe ${label}`);
  return text;
}

function safeCanonicalText(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    UTF8.encode(value).byteLength > maxBytes ||
    sanitizeText(value, allowEmpty) !== value
  )
    throw new Error(`Invalid ${label}`);
  return value;
}

function projectionRecord(value: unknown): Record<string, unknown> {
  try {
    return plainRecord(value, 'tool args');
  } catch {
    throw new InteractionPermissionProjectionError();
  }
}

function canonicalizeGenericToolArguments(
  value: unknown,
  stack: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > GENERIC_TOOL_ARGUMENTS_MAX_DEPTH) throw new Error('Tool arguments are too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Tool arguments contain a non-finite number');
    return value;
  }
  if (typeof value !== 'object') throw new Error('Tool arguments must contain JSON data');
  if (stack.has(value)) throw new Error('Tool arguments are cyclic');
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const items = plainArray(value, 'tool arguments array', 0, Number.MAX_SAFE_INTEGER);
      return items.map((item) => canonicalizeGenericToolArguments(item, stack, depth + 1));
    }
    const record = plainRecord(value, 'tool arguments object');
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalizeGenericToolArguments(record[key], stack, depth + 1)]),
    );
  } finally {
    stack.delete(value);
  }
}

function summarizeGenericToolArguments(
  value: unknown,
  stringBudget: number,
): { readonly value: unknown; readonly truncated: boolean } {
  if (typeof value === 'string') {
    if (
      UTF8.encode(value).byteLength <= GENERIC_TOOL_ARGUMENT_LONG_STRING_BYTES ||
      value === '[redacted]'
    ) {
      return { value, truncated: false };
    }
    return {
      value: `${truncateUtf8(value, Math.max(0, stringBudget - 3))}...`,
      truncated: true,
    };
  }
  if (Array.isArray(value)) {
    let truncated = false;
    const items = value.map((item) => {
      const summary = summarizeGenericToolArguments(item, stringBudget);
      truncated ||= summary.truncated;
      return summary.value;
    });
    return { value: items, truncated };
  }
  if (value && typeof value === 'object') {
    let truncated = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const summary = summarizeGenericToolArguments(item, stringBudget);
      truncated ||= summary.truncated;
      return [key, summary.value] as const;
    });
    return { value: Object.fromEntries(entries), truncated };
  }
  return { value, truncated: false };
}

function truncateUtf8(value: string, maxBytes: number): string {
  let text = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = UTF8.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    text += character;
    bytes += characterBytes;
  }
  return text;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be a plain record`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${label} must be a plain record`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !descriptor ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    )
      throw new Error(`${label} must contain plain data properties`);
  }
  return value as Record<string, unknown>;
}

function exact(record: Record<string, unknown>, shape: ExactObjectShape, label: string): void {
  if (!hasExactShape(record, shape)) throw new Error(`Invalid ${label} fields`);
}

function plainArray(value: unknown, label: string, min: number, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < min ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw new Error(`Invalid ${label}`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      throw new Error(`Invalid ${label}`);
  }
  return value;
}

function allowOnceDeny(value: unknown): value is readonly ['allow_once', 'deny'] {
  try {
    const array = plainArray(value, 'available decisions', 2, 2);
    return array[0] === 'allow_once' && array[1] === 'deny';
  } catch {
    return false;
  }
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || UTF8.encode(value).byteLength > maxBytes)
    throw new Error(`Invalid ${label}`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Invalid ${label}`);
  return value;
}

function positiveFiniteNumberForProjection(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new InteractionPermissionProjectionError(`Invalid ${label}`);
  return value;
}

function boundedPositiveNumber(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > INTERACTION_BROWSER_WAIT_MAX_SECONDS
  )
    throw new Error(`Invalid ${label}`);
  return value;
}

function normalizeBrowserStart(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new InteractionPermissionProjectionError();
  return Math.max(0, Math.floor(value));
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid ${label}`);
  return value;
}

function nonNegativeIntegerForProjection(value: unknown, label: string): number {
  try {
    return nonNegativeInteger(value, label);
  } catch {
    throw new InteractionPermissionProjectionError();
  }
}

function oneOf<const T extends readonly unknown[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (!values.includes(value)) throw new Error(`Invalid ${label}`);
  return value as T[number];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
