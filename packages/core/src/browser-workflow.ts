/**
 * Versioned contract for reusable browser workflows.
 *
 * The contract deliberately stores locator evidence instead of snapshot
 * references. Snapshot refs are short-lived and are never valid workflow
 * identifiers.
 */

export const BROWSER_WORKFLOW_SCHEMA_VERSION = 1 as const;
export const BROWSER_WORKFLOW_REDACTED_VALUE = '__MAKA_REDACTED__' as const;
export const BROWSER_WORKFLOW_MAX_ACTIONS = 500 as const;

export type BrowserWorkflowLocatorKind = 'test_id' | 'aria_label' | 'name' | 'id' | 'role' | 'text';

export interface BrowserWorkflowLocator {
  kind: BrowserWorkflowLocatorKind;
  value: string;
  /** Tag/role evidence used to disambiguate text and role locators. */
  tag?: string;
  role?: string;
}

export interface BrowserWorkflowNavigateAction {
  id: string;
  kind: 'navigate';
  url: string;
}

export interface BrowserWorkflowClickAction {
  id: string;
  kind: 'click';
  locator: BrowserWorkflowLocator;
}

export interface BrowserWorkflowCheckAction {
  id: string;
  kind: 'check';
  locator: BrowserWorkflowLocator;
  checked: boolean;
}

export interface BrowserWorkflowTypeAction {
  id: string;
  kind: 'type';
  locator: BrowserWorkflowLocator;
  /** Omitted for sensitive inputs; supplied only transiently at replay time. */
  value?: string;
  sensitive: boolean;
  submit: boolean;
}

export interface BrowserWorkflowWaitAction {
  id: string;
  kind: 'wait';
  /** One stable condition observed after the preceding action. */
  selector?: string;
  text?: string;
  /** Final main-frame URL reached by a recorded interaction; replay waits without navigating again. */
  url?: string;
  /** A main-frame navigation whose dynamic destination must not be persisted as a strict URL. */
  navigation?: true;
  timeoutMs: number;
}

/** User-supplied condition captured while a workflow is being recorded. */
export interface BrowserWorkflowWaitConditionInput {
  kind: 'selector' | 'text';
  value: string;
  timeoutMs: number;
}

export type BrowserWorkflowAction =
  | BrowserWorkflowNavigateAction
  | BrowserWorkflowClickAction
  | BrowserWorkflowCheckAction
  | BrowserWorkflowTypeAction
  | BrowserWorkflowWaitAction;

export interface BrowserWorkflow {
  schemaVersion: typeof BROWSER_WORKFLOW_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  actions: BrowserWorkflowAction[];
}

export interface BrowserWorkflowDraft {
  actions: BrowserWorkflowAction[];
  startedAt: number;
  endedAt: number;
}

export type BrowserWorkflowRunStatus = 'running' | 'completed' | 'failed' | 'canceled';

export interface BrowserWorkflowProgress {
  runId: string;
  workflowId: string;
  sessionId: string;
  status: BrowserWorkflowRunStatus;
  current: number;
  total: number;
  message?: string;
}

export const BROWSER_WORKFLOW_SENSITIVE_FIELD_PATTERN =
  '(?:(?:^|[-_ ])code$|pass(?:word|code)?|pin|secret|token|api[-_ ]?key|credential|authorization|cookie|card[-_ ]?(?:number|cvv|cvc)|cc-(?:name|given-name|additional-name|family-name|number|exp|exp-month|exp-year|csc|type)|ssn|one[-_ ]?time|otp|verification[-_ ]?code)';

const SENSITIVE_NAME = new RegExp(BROWSER_WORKFLOW_SENSITIVE_FIELD_PATTERN, 'i');
const SENSITIVE_URL_PATH_MARKER =
  /^(?:activate|activation|auth|invite|invitation|invitations|magic|reset|token|verify|verification)$/i;

function hasSensitiveBrowserWorkflowPath(url: URL): boolean {
  let sawSensitiveMarker = false;
  for (const rawSegment of url.pathname.split('/')) {
    if (!rawSegment) continue;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return true;
    }
    if (sawSensitiveMarker) return true;
    if (SENSITIVE_URL_PATH_MARKER.test(segment)) sawSensitiveMarker = true;
  }
  return false;
}

export function isSafeBrowserWorkflowUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || value.length > 4000) {
    return false;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (hasSensitiveBrowserWorkflowPath(url)) return false;
    return [...url.searchParams.entries()].every(
      ([key, queryValue]) => !SENSITIVE_NAME.test(key) && queryValue === '',
    );
  } catch {
    return false;
  }
}

export function isSensitiveBrowserInput(input: {
  type?: string | null;
  name?: string | null;
  id?: string | null;
  autocomplete?: string | null;
  ariaLabel?: string | null;
  placeholder?: string | null;
  testId?: string | null;
  labelText?: string | null;
}): boolean {
  const type = String(input.type ?? '').toLowerCase();
  if (type === 'password') return true;
  return [
    input.name,
    input.id,
    input.autocomplete,
    input.ariaLabel,
    input.placeholder,
    input.testId,
    input.labelText,
  ].some((value) => typeof value === 'string' && SENSITIVE_NAME.test(value));
}

export function isStableBrowserWorkflowLocator(
  locator: unknown,
): locator is BrowserWorkflowLocator {
  if (typeof locator !== 'object' || locator === null) return false;
  const value = locator as Record<string, unknown>;
  if (!['test_id', 'aria_label', 'name', 'id', 'role', 'text'].includes(String(value.kind)))
    return false;
  if (
    typeof value.value !== 'string' ||
    value.value.trim().length === 0 ||
    value.value.length > 1000 ||
    /^\[\d+\]$/.test(value.value.trim())
  )
    return false;
  if (value.tag !== undefined && (typeof value.tag !== 'string' || value.tag.length > 80))
    return false;
  if (value.role !== undefined && (typeof value.role !== 'string' || value.role.length > 80))
    return false;
  return true;
}

export function isBrowserWorkflowAction(value: unknown): value is BrowserWorkflowAction {
  if (typeof value !== 'object' || value === null) return false;
  const action = value as Record<string, unknown>;
  if (typeof action.id !== 'string' || action.id.length === 0 || action.id.length > 100)
    return false;
  switch (action.kind) {
    case 'navigate':
      return isSafeBrowserWorkflowUrl(action.url);
    case 'click':
      return isStableBrowserWorkflowLocator(action.locator);
    case 'check':
      return isStableBrowserWorkflowLocator(action.locator) && typeof action.checked === 'boolean';
    case 'type':
      return (
        isStableBrowserWorkflowLocator(action.locator) &&
        typeof action.sensitive === 'boolean' &&
        typeof action.submit === 'boolean' &&
        (action.sensitive
          ? action.value === undefined || action.value === BROWSER_WORKFLOW_REDACTED_VALUE
          : typeof action.value === 'string' && action.value.length <= 100_000)
      );
    case 'wait':
      return (
        [
          typeof action.selector === 'string' &&
            action.selector.trim().length > 0 &&
            action.selector.length <= 2000,
          typeof action.text === 'string' &&
            action.text.trim().length > 0 &&
            action.text.length <= 2000,
          typeof action.url === 'string' && isSafeBrowserWorkflowUrl(action.url),
          action.navigation === true,
        ].filter(Boolean).length === 1 &&
        [action.selector, action.text, action.url, action.navigation].filter(
          (item) => item !== undefined,
        ).length === 1 &&
        Number.isInteger(action.timeoutMs) &&
        Number(action.timeoutMs) > 0 &&
        Number(action.timeoutMs) <= 120_000
      );
    default:
      return false;
  }
}

export function isBrowserWorkflowWaitConditionInput(
  value: unknown,
): value is BrowserWorkflowWaitConditionInput {
  if (typeof value !== 'object' || value === null) return false;
  const input = value as Record<string, unknown>;
  return (
    (input.kind === 'selector' || input.kind === 'text') &&
    typeof input.value === 'string' &&
    input.value.trim().length > 0 &&
    input.value.length <= 2000 &&
    typeof input.timeoutMs === 'number' &&
    Number.isInteger(input.timeoutMs) &&
    input.timeoutMs > 0 &&
    input.timeoutMs <= 120_000
  );
}

export function isBrowserWorkflow(value: unknown): value is BrowserWorkflow {
  if (typeof value !== 'object' || value === null) return false;
  const workflow = value as Record<string, unknown>;
  return (
    workflow.schemaVersion === BROWSER_WORKFLOW_SCHEMA_VERSION &&
    typeof workflow.id === 'string' &&
    workflow.id.length > 0 &&
    workflow.id.length <= 200 &&
    typeof workflow.name === 'string' &&
    workflow.name.trim().length > 0 &&
    workflow.name.length <= 200 &&
    Number.isFinite(workflow.createdAt) &&
    Number.isFinite(workflow.updatedAt) &&
    Array.isArray(workflow.actions) &&
    workflow.actions.length > 0 &&
    workflow.actions.length <= BROWSER_WORKFLOW_MAX_ACTIONS &&
    workflow.actions.every(isBrowserWorkflowAction)
  );
}

export function validateBrowserWorkflow(value: unknown): BrowserWorkflow {
  if (!isBrowserWorkflow(value)) throw new Error('Invalid browser workflow contract');
  return value;
}
