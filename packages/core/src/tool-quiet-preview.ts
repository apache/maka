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
 * Quiet-panel formatting for tool args + generic JSON results.
 *
 * Pure formatting functions shared by the desktop quiet panel and the TUI
 * transcript. Neither depends on React or the DOM — only on `redactSecrets`
 * and `readWriteStdinInputPreview`, both already in `@maka/core`.
 *
 * Extracted from `packages/ui/src/tool-activity/builtin-preview.ts` (#1065)
 * so the CLI can consume the same path. Every caller passes its resolved
 * locale explicitly.
 */

import { redactSecrets } from './display-redaction.js';
import { projectToolActivityArgs, readWriteStdinInputPreview } from './tool-activity-args.js';
import type { UiLocale } from './ui-locale.js';

// ── Locale ───────────────────────────────────────────────────────────────

export type { UiLocale } from './ui-locale.js';

interface QuietPreviewStrings {
  backgroundTerminal: string;
  empty: string;
  done: string;
  notDone: string;
  /** Format a replacement count, e.g. `3 处` / `3 replacements`. */
  replacements: (n: number) => string;
  written: string;
  /** Format a byte count suffix, e.g. `共 7 字节` / `7 bytes`. */
  bytes: (n: number) => string;
  /** Suffix for a question list previewed by its first entry, e.g. `等 2 问` / `+1 more`. */
  moreQuestions: (total: number) => string;
}

const STRINGS_BY_LOCALE: Record<UiLocale, QuietPreviewStrings> = {
  'zh-CN': {
    backgroundTerminal: '后台终端交互',
    empty: '（空）',
    done: '已完成',
    notDone: '未完成',
    replacements: (n) => `${n} 处`,
    written: '已写入',
    bytes: (n) => `共 ${n} 字节`,
    moreQuestions: (total) => (total > 1 ? ` 等 ${total} 问` : ''),
  },
  'zh-TW': {
    backgroundTerminal: '後臺終端互動',
    empty: '（空）',
    done: '已完成',
    notDone: '未完成',
    replacements: (n) => `${n} 處`,
    written: '已寫入',
    bytes: (n) => `共 ${n} 位元組`,
    moreQuestions: (total) => (total > 1 ? ` 等 ${total} 問` : ''),
  },
  en: {
    backgroundTerminal: 'Background terminal interaction',
    empty: '(empty)',
    done: 'done',
    notDone: 'not done',
    replacements: (n) => (n === 1 ? '1 replacement' : `${n} replacements`),
    written: 'written',
    bytes: (n) => `${n} bytes`,
    moreQuestions: (total) => (total > 1 ? ` +${total - 1} more` : ''),
  },
};

function strings(locale: UiLocale): QuietPreviewStrings {
  return STRINGS_BY_LOCALE[locale] ?? STRINGS_BY_LOCALE['zh-CN'];
}

// ── Tool command extraction ──────────────────────────────────────────────

/**
 * Pull the shell command string out of a command-tool's args (bash / shell).
 * Returns undefined for a non-command shape so callers fall back to path /
 * pattern presentation or redacted JSON.
 */
export function extractToolCommand(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  const raw = record.command ?? record.cmd ?? record.script;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined;
}

// ── Key priority tables ──────────────────────────────────────────────────

const BODY_KEYS = [
  'content',
  'text',
  'message',
  'output',
  'stdout',
  'stderr',
  'diff',
  'summary',
  'body',
  'result',
] as const;

const LIST_KEYS = [
  'matches',
  'files',
  'results',
  'items',
  'lines',
  'rows',
  'loaded',
  'tools',
  'paths',
] as const;

const HEADLINE_KEYS = [
  'path',
  'file',
  'cmd',
  'command',
  'pattern',
  'query',
  'url',
  'name',
  'title',
  'id',
  'ref',
] as const;

/** Diagnostic / meta fields shown after the primary body when still present. */
const REMAINDER_PRIORITY = [
  'error',
  'reason',
  'ok',
  'truncated',
  'status',
  'code',
  'message',
] as const;

// ── Secret masking ───────────────────────────────────────────────────────

/**
 * Property names whose values must never be shown raw — structural redaction
 * beyond the string-pattern safety net in redactSecrets.
 */
// Multi-word forms use [\s_-]* so "api key" / "private key" / "access token" match.
const SENSITIVE_KEY_RE =
  /(password|passwd|secret|token|api[\s_-]*key|access[\s_-]*token|authorization|(?:^|[\s_-])auth(?:$|[\s_=:.-])|credential|private[\s_-]*key)/i;

/**
 * Secret embedded in a key itself, e.g. `password=x`, `password: x`,
 * `api key: …`, `auth=…`, `Authorization: Bearer tok`. Captures keyword +
 * separator; the remainder of the key (not just the first token) is replaced
 * with <redacted>.
 */
const SENSITIVE_KEY_PAYLOAD_RE =
  /((?:password|passwd|secret|token|api[\s_-]*key|access[\s_-]*token|authorization|\bauth\b|credential|private[\s_-]*key)[^\s=:]*)(\s*[=:]\s*|\s+)(.+)$/gi;

// ── Helpers ──────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const raw = record?.[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const raw = record?.[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

function maskSensitiveKeyPayload(key: string): string {
  SENSITIVE_KEY_PAYLOAD_RE.lastIndex = 0;
  return key.replace(SENSITIVE_KEY_PAYLOAD_RE, '$1$2<redacted>');
}

/**
 * Keys may themselves embed secrets (`password=x`, `password: x`). Mask the
 * assignment payload for = / : / whitespace separators — never rely on
 * redactSecrets alone for short passwords.
 */
function safeKeyLabel(key: string): string {
  const masked = maskSensitiveKeyPayload(key);
  if (masked !== key) return redactSecrets(masked);
  return redactSecrets(key);
}

function maskSensitiveValue(key: string, value: unknown): unknown {
  const keyHasEmbeddedSecret = maskSensitiveKeyPayload(key) !== key;
  if (!isSensitiveKey(key) && !keyHasEmbeddedSecret) {
    return value;
  }
  if (value === undefined) return undefined;
  return '<redacted>';
}

function formatRangeSuffix(args: Record<string, unknown>): string {
  const offset = numberField(args, 'offset');
  const limit = numberField(args, 'limit');
  if (offset === undefined && limit === undefined) return '';
  return ` · L${offset ?? 0}${limit !== undefined ? `+${limit}` : ''}`;
}

// ── Public API: invocation line ─────────────────────────────────────────

/** Minimal input for {@link formatToolInvocationLine}. */
export interface ToolInvocationInput {
  toolName: string;
  args: unknown;
}

/**
 * First-line invocation for the quiet panel from tool args — never a
 * pretty-printed args object.
 */
export function formatToolInvocationLine(
  item: ToolInvocationInput,
  locale: UiLocale,
): string | undefined {
  const s = strings(locale);
  const args = asRecord(item.args);
  if (!args) {
    if (typeof item.args === 'string' && item.args.trim()) return redactSecrets(item.args);
    return undefined;
  }

  const command = extractToolCommand(item.args);
  if (command) return redactSecrets(command);

  const path = stringField(args, 'path') ?? stringField(args, 'file');
  const pattern = stringField(args, 'pattern');
  const query = stringField(args, 'query');
  const name = item.toolName;

  if (name === 'WriteStdin') {
    const parts: string[] = [s.backgroundTerminal];
    const input = readWriteStdinInputPreview(args);
    if (input)
      parts.push(input.truncated ? `${input.text}… · ${s.bytes(input.bytes)}` : input.text);
    const size = asRecord(args.size);
    const cols = size ? numberField(size, 'cols') : undefined;
    const rows = size ? numberField(size, 'rows') : undefined;
    if (cols !== undefined && rows !== undefined) parts.push(`${cols}x${rows}`);
    return parts.join(' · ');
  }

  if (name === 'deep_research_start') {
    const objective = stringField(args, 'objective');
    if (objective) {
      const scopeLevel = stringField(args, 'scope_level');
      return redactSecrets(scopeLevel ? `${objective} (${scopeLevel})` : objective);
    }
  }

  if (name === 'GoalSet') {
    const condition = stringField(args, 'condition');
    if (condition) return redactSecrets(condition);
  }

  if (name === 'AskUserQuestion') {
    const questions = Array.isArray(args.questions) ? args.questions : undefined;
    const firstQuestion = questions
      ?.map((question) => stringField(asRecord(question), 'question'))
      .find((questionText) => questionText !== undefined);
    if (firstQuestion) {
      const total = numberField(args, 'questionsTotal') ?? questions!.length;
      return redactSecrets(`${firstQuestion}${s.moreQuestions(total)}`);
    }
  }

  if (name === 'Grep' || (pattern && (name === 'Glob' || path))) {
    if (pattern) {
      const scope = path ? ` in ${path}` : '';
      const glob = stringField(args, 'glob');
      const cwd = stringField(args, 'cwd');
      const where = scope || (cwd ? ` in ${cwd}` : '');
      const globSuffix = glob ? ` (${glob})` : '';
      return redactSecrets(`${pattern}${where}${globSuffix}`);
    }
  }

  if (path) {
    return redactSecrets(`${path}${formatRangeSuffix(args)}`);
  }

  if (pattern) {
    const cwd = stringField(args, 'cwd');
    return redactSecrets(cwd ? `${pattern} in ${cwd}` : pattern);
  }

  if (query) return redactSecrets(query);

  for (const key of HEADLINE_KEYS) {
    if (isSensitiveKey(key)) continue;
    const value = stringField(args, key);
    if (value) return redactSecrets(value);
  }

  // Last resort: short key:value lines (still not JSON braces).
  const lines = formatAsKeyValueLines(args, 0, locale);
  return lines.length > 0 ? lines : undefined;
}

// ── Public API: args preview (live wire) ────────────────────────────────

/**
 * Per-value cap for the wire preview. Long commands/paths still identify the
 * call; the full value arrives with the durable transcript at turn end.
 */
const ARGS_PREVIEW_STRING_MAX_CHARS = 240;
/** Whole-preview cap; lowest-priority fields drop until the preview fits. */
const ARGS_PREVIEW_MAX_CHARS = 2048;
/** Question lists keep only their leading entries. */
const ARGS_PREVIEW_LIST_MAX_ITEMS = 4;

const COMMIT_RESULT_ONLY_TOOL_NAMES = new Set(['todo_write']);

/**
 * Whitelist of scalar args keys {@link formatToolInvocationLine} can read, in
 * display-priority order. Anything not listed here (file contents, option
 * payloads, provider blobs) never enters the live wire preview.
 */
const ARGS_PREVIEW_SCALAR_KEYS = [
  'command',
  'cmd',
  'script',
  'path',
  'file',
  'pattern',
  'glob',
  'cwd',
  'query',
  'url',
  'name',
  'title',
  'subject',
  'condition',
  'status',
  'id',
  'ref',
] as const;

// This tool's objective is the compact row's durable headline. Keep it
// explicit rather than widening the generic wire allowlist with a broad key
// such as `input`: non-WriteStdin tools otherwise retain arbitrary payloads.
const DEEP_RESEARCH_START_PREVIEW_SCALAR_KEYS = ['objective', 'scope_level'] as const;

const ARGS_PREVIEW_NUMBER_KEYS = ['offset', 'limit'] as const;

function boundPreviewString(value: string): string {
  const redacted = redactSecrets(value);
  const chars = Array.from(redacted);
  return chars.length <= ARGS_PREVIEW_STRING_MAX_CHARS
    ? redacted
    : `${chars.slice(0, ARGS_PREVIEW_STRING_MAX_CHARS - 1).join('')}…`;
}

function previewStringField(record: Record<string, unknown>, key: string): string | undefined {
  const raw = record[key];
  return typeof raw === 'string' && raw.trim().length > 0 ? boundPreviewString(raw) : undefined;
}

function previewQuestions(
  record: Record<string, unknown>,
): { items: Record<string, unknown>[]; total: number } | undefined {
  const list = record.questions;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const items: Record<string, unknown>[] = [];
  for (const entry of list.slice(0, ARGS_PREVIEW_LIST_MAX_ITEMS)) {
    const text = previewStringField(asRecord(entry) ?? {}, 'question');
    if (text === undefined) continue;
    const redacted = redactSecrets(text);
    if (redacted.trim().length === 0) continue;
    items.push({ question: redacted });
  }
  return items.length > 0 ? { items, total: list.length } : undefined;
}

function previewInputPreview(value: unknown): Record<string, unknown> | undefined {
  const preview = asRecord(value);
  if (!preview) return undefined;
  const text = previewStringField(preview, 'text');
  if (text === undefined) return undefined;
  const bytes = numberField(preview, 'bytes');
  return {
    text,
    bytes: bytes ?? Array.from(text).length,
    truncated: preview.truncated === true,
  };
}

function previewSize(value: unknown): Record<string, unknown> | undefined {
  const size = asRecord(value);
  if (!size) return undefined;
  const cols = numberField(size, 'cols');
  const rows = numberField(size, 'rows');
  return cols !== undefined && rows !== undefined ? { cols, rows } : undefined;
}

/**
 * A bounded, redacted, wire-safe preview of a tool call's args, shaped like
 * the args themselves so `formatToolInvocationLine` renders the same line from
 * the preview as from the full args.
 *
 * Runtime Host live `tool_start` frames deliberately omit full args (the lean
 * subscription channel predates per-frame budgets; a Write can carry a whole
 * file). Without any args signal, compact/collapsed tool rows render name-only
 * for the whole live window — the only window a watching user sees. This
 * preview carries just the fields the invocation-line formatter reads, each
 * string redacted and capped, so live rows can say what the call does without
 * streaming file bodies or option payloads.
 *
 * Sensitive keys are dropped structurally (never redacted-in-place) and every
 * string still passes `redactSecrets`; the durable transcript remains the
 * authority for full args.
 */
export function projectToolArgsPreview(
  toolName: string,
  args: unknown,
): Record<string, unknown> | undefined {
  const record = asRecord(args);
  if (!record) return undefined;
  // A Todo write's args are only a proposal. Showing them while the call is
  // live would present uncommitted state as fact; the settled tool_result owns
  // the complete committed snapshot.
  if (COMMIT_RESULT_ONLY_TOOL_NAMES.has(toolName)) return undefined;

  // Apply the canonical activity projection first so WriteStdin's inputPreview
  // shape (bounded, display-safe) is what the whitelist picks up.
  const projected = asRecord(projectToolActivityArgs(toolName, args)) ?? record;
  const scalarKeys =
    toolName === 'deep_research_start'
      ? [...ARGS_PREVIEW_SCALAR_KEYS, ...DEEP_RESEARCH_START_PREVIEW_SCALAR_KEYS]
      : ARGS_PREVIEW_SCALAR_KEYS;

  const picked = new Map<string, unknown>();
  for (const key of scalarKeys) {
    if (isSensitiveKey(key)) continue;
    const value = previewStringField(projected, key);
    if (value !== undefined) picked.set(key, value);
  }
  for (const key of ARGS_PREVIEW_NUMBER_KEYS) {
    const value = numberField(projected, key);
    if (value !== undefined) picked.set(key, value);
  }
  // Only WriteStdin owns these shapes. Other tools retain arbitrary args, so
  // accepting a caller-supplied inputPreview here would reopen a generic free-
  // text payload path around its canonical safe-text projection.
  if (toolName === 'WriteStdin') {
    const inputPreview = previewInputPreview(projected.inputPreview);
    if (inputPreview) picked.set('inputPreview', inputPreview);
    const size = previewSize(projected.size);
    if (size) picked.set('size', size);
  }
  // Only the built-in interaction tool owns this free-text shape. Arbitrary
  // third-party tools may use the same field names for private payloads.
  if (toolName === 'AskUserQuestion') {
    const questions = previewQuestions(projected);
    if (questions) {
      picked.set('questions', questions.items);
      if (questions.total > questions.items.length) picked.set('questionsTotal', questions.total);
    }
  }

  if (picked.size === 0) return undefined;

  // Enforce the whole-preview budget by dropping lowest-priority fields; the
  // first picked (highest-priority) field always survives.
  const keysByPriority = [
    ...scalarKeys,
    ...ARGS_PREVIEW_NUMBER_KEYS,
    'inputPreview',
    'size',
    'questions',
    'questionsTotal',
  ];
  const result: Record<string, unknown> = {};
  for (const key of keysByPriority) {
    const value = picked.get(key);
    if (value !== undefined) result[key] = value;
  }
  const droppable = [...keysByPriority].reverse();
  while (JSON.stringify(result).length > ARGS_PREVIEW_MAX_CHARS && droppable.length > 1) {
    const key = droppable.shift()!;
    if (key === keysByPriority.find((candidate) => result[candidate] !== undefined)) continue;
    delete result[key];
  }
  return result;
}

// ── Public API: quiet JSON value ─────────────────────────────────────────

export interface QuietPreview {
  headline?: string;
  body: string;
}

/**
 * Format any tool JSON/result payload for the quiet panel.
 * Always returns a body — never `undefined` for object values so callers
 * cannot fall back to `JSON.stringify`.
 *
 * Primary list/text fields become the main body; remaining fields (error, ok,
 * truncated, …) are appended so diagnostics cannot vanish.
 */
export function formatQuietJsonValue(value: unknown, locale: UiLocale): QuietPreview {
  const s = strings(locale);
  if (value === null || value === undefined) {
    return { body: s.empty };
  }
  if (typeof value === 'string') {
    return { body: redactSecrets(value) || s.empty };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { body: String(value) };
  }
  if (Array.isArray(value)) {
    return { body: formatArrayAsBody(value, locale) };
  }

  const record = asRecord(value);
  if (!record) {
    return { body: redactSecrets(String(value)) };
  }

  // Known list payloads (Grep/Glob/tool_search/…).
  for (const key of LIST_KEYS) {
    if (!Array.isArray(record[key])) continue;
    const consumed = new Set<string>([key]);
    const primary = formatArrayAsBody(record[key] as unknown[], locale);
    const headline = pickHeadline(record, consumed);
    if (headline) consumed.add(headlineSourceKey(record, headline) ?? '');
    const rest = formatRemainder(record, consumed, locale);
    const body = rest ? `${primary}\n${rest}` : primary;
    return headline ? { headline, body } : { body };
  }

  // Dominant text payload (Read content, messages, …).
  for (const key of BODY_KEYS) {
    if (typeof record[key] !== 'string') continue;
    if (isSensitiveKey(key)) continue;
    const consumed = new Set<string>([key]);
    const primary = redactSecrets(record[key] as string);
    const headline = pickHeadline(record, consumed);
    if (headline) {
      const hk = headlineSourceKey(record, headline);
      if (hk) consumed.add(hk);
    }
    const rest = formatRemainder(record, consumed, locale);
    const body = rest ? `${primary}\n${rest}` : primary;
    return headline ? { headline, body } : { body };
  }

  // Write / Edit style { ok, path, bytes, … }.
  const path = stringField(record, 'path');
  if (
    path &&
    (record.ok === true ||
      record.ok === false ||
      numberField(record, 'bytes') !== undefined ||
      numberField(record, 'replacements') !== undefined)
  ) {
    const consumed = new Set<string>([
      'path',
      'ok',
      'bytes',
      'replacements',
      'startLine',
      'endLine',
      'matchedVia',
    ]);
    const bytes = numberField(record, 'bytes');
    const replacements = numberField(record, 'replacements');
    const startLine = numberField(record, 'startLine');
    const endLine = numberField(record, 'endLine');
    const parts: string[] = [];
    if (record.ok === true) parts.push(s.done);
    if (record.ok === false) parts.push(s.notDone);
    if (bytes !== undefined) parts.push(`${bytes} B`);
    if (replacements !== undefined) parts.push(s.replacements(replacements));
    if (startLine !== undefined && endLine !== undefined) parts.push(`L${startLine}–${endLine}`);
    const primary = parts.length > 0 ? parts.join(' · ') : s.written;
    const rest = formatRemainder(record, consumed, locale);
    return {
      headline: redactSecrets(path),
      body: rest ? `${primary}\n${rest}` : primary,
    };
  }

  return { body: formatAsKeyValueLines(record, 0, locale) || s.empty };
}

// ── Internal: headline / remainder ──────────────────────────────────────

function pickHeadline(
  record: Record<string, unknown>,
  skip: ReadonlySet<string>,
): string | undefined {
  for (const key of HEADLINE_KEYS) {
    if (skip.has(key) || isSensitiveKey(key)) continue;
    const value = stringField(record, key);
    if (value) return redactSecrets(value);
  }
  return undefined;
}

function headlineSourceKey(record: Record<string, unknown>, headline: string): string | undefined {
  for (const key of HEADLINE_KEYS) {
    const value = stringField(record, key);
    if (value && redactSecrets(value) === headline) return key;
  }
  return undefined;
}

/**
 * Remaining fields after a primary body was chosen — always keep diagnostics.
 * Order: REMAINDER_PRIORITY first, then the rest alphabetically stable via Object.entries.
 */
function formatRemainder(
  record: Record<string, unknown>,
  consumed: ReadonlySet<string>,
  locale: UiLocale,
): string {
  const rest: Record<string, unknown> = {};
  const prioritized: Record<string, unknown> = {};
  for (const key of REMAINDER_PRIORITY) {
    if (consumed.has(key) || record[key] === undefined) continue;
    prioritized[key] = record[key];
  }
  for (const [key, value] of Object.entries(record)) {
    if (consumed.has(key) || value === undefined) continue;
    if (key in prioritized) continue;
    rest[key] = value;
  }
  const ordered = { ...prioritized, ...rest };
  return formatAsKeyValueLines(ordered, 0, locale);
}

function formatArrayAsBody(values: unknown[], locale: UiLocale): string {
  const s = strings(locale);
  if (values.length === 0) return s.empty;
  if (values.every((item) => typeof item === 'string')) {
    return redactSecrets((values as string[]).join('\n'));
  }
  return values
    .map((item) => {
      if (typeof item === 'string') return redactSecrets(item);
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return formatAsKeyValueLines(item as Record<string, unknown>, 0, locale);
      }
      return redactSecrets(String(item));
    })
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Plain `key: value` lines — never JSON braces or escaped `\n` sequences.
 * Keys and whole lines pass through `redactSecrets`; sensitive key names force
 * value masking even when the value itself is a short non-token secret.
 */
export function formatAsKeyValueLines(
  record: Record<string, unknown>,
  depth: number,
  locale: UiLocale,
): string {
  const s = strings(locale);
  if (depth > 3) return redactSecrets(String(record));
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  const push = (line: string) => {
    lines.push(redactSecrets(line));
  };
  for (const [key, raw] of Object.entries(record)) {
    if (raw === undefined) continue;
    const safeKey = safeKeyLabel(key);
    const value = maskSensitiveValue(key, raw);
    if (value === null) {
      push(`${indent}${safeKey}: null`);
      continue;
    }
    if (typeof value === 'string') {
      if (value.includes('\n') && value !== '<redacted>') {
        push(`${indent}${safeKey}:`);
        for (const line of redactSecrets(value).split('\n')) {
          push(`${indent}  ${line}`);
        }
      } else {
        push(`${indent}${safeKey}: ${redactSecrets(value)}`);
      }
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      push(`${indent}${safeKey}: ${value}`);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        push(`${indent}${safeKey}: ${s.empty}`);
      } else if (
        value.every(
          (item) =>
            typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
        )
      ) {
        push(`${indent}${safeKey}:`);
        for (const item of value) {
          push(`${indent}  - ${typeof item === 'string' ? redactSecrets(item) : String(item)}`);
        }
      } else {
        push(`${indent}${safeKey}:`);
        for (const line of formatArrayAsBody(value, locale).split('\n')) {
          push(`${indent}  ${line}`);
        }
      }
      continue;
    }
    if (typeof value === 'object') {
      push(`${indent}${safeKey}:`);
      const nested = formatAsKeyValueLines(value as Record<string, unknown>, depth + 1, locale);
      if (nested) {
        for (const line of nested.split('\n')) push(line);
      }
      continue;
    }
    push(`${indent}${safeKey}: ${redactSecrets(String(value))}`);
  }
  return lines.join('\n');
}
