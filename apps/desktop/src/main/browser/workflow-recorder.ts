import {
  BROWSER_WORKFLOW_SENSITIVE_FIELD_PATTERN,
  isStableBrowserWorkflowLocator,
  type BrowserWorkflowLocator,
} from '@maka/core/browser-workflow';

export interface BrowserRecorderEvent {
  eventId?: string;
  kind: 'click' | 'check' | 'type';
  locator: BrowserWorkflowLocator;
  value?: string;
  checked?: boolean;
  sensitive?: boolean;
  submit?: boolean;
  timestamp: number;
}

export const WORKFLOW_RECORDER_EVENT_PREFIX = '__MAKA_BROWSER_WORKFLOW_EVENT_V1__:';
export const WORKFLOW_RECORDER_ISOLATED_WORLD_ID = 1001;

/**
 * The embedded page has no Maka preload by design. A tiny page-local queue is
 * therefore installed and drained by the main process. It records only DOM
 * interactions that produced an event, never model/tool calls.
 */
export function createBrowserWorkflowRecorderInstallScript(credential: string): string {
  if (!credential) throw new Error('Browser workflow recorder credential is required.');
  const authenticatedPrefix = `${WORKFLOW_RECORDER_EVENT_PREFIX}${credential}:`;
  return `(() => {
  const key = '__makaBrowserWorkflowRecorderV1';
  if (window[key]?.credential === ${JSON.stringify(credential)}) return true;
  if (window[key]) window[key].dispose();
  const events = [];
  const recorderId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  let sequence = 0;
  const now = () => performance.timeOrigin + performance.now();
  const sensitive = new RegExp(${JSON.stringify(BROWSER_WORKFLOW_SENSITIVE_FIELD_PATTERN)}, 'i');
  const emit = (event) => {
    const value = { eventId: recorderId + ':' + (++sequence), ...event };
    events.push(value);
    console.debug(${JSON.stringify(authenticatedPrefix)} + JSON.stringify(value));
  };
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 1000);
  const all = (selector) => Array.from(document.querySelectorAll(selector));
  const isContentEditableElement = (el) => {
    const attribute = el && el.getAttribute ? el.getAttribute('contenteditable') : null;
    return el?.isContentEditable === true || (attribute !== null && String(attribute).toLowerCase() !== 'false');
  };
  const inputValue = (el) => {
    if (isContentEditableElement(el)) return String(el.innerText ?? el.textContent ?? '');
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return String(el.value || '');
    const role = String(el.getAttribute?.('role') || '').toLowerCase();
    if (
      tag === 'button' ||
      tag === 'a' ||
      ['button', 'checkbox', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'submit', 'switch', 'tab'].includes(role)
    ) {
      return String(el.innerText ?? el.textContent ?? '');
    }
    if ('value' in el && el.value !== undefined && el.value !== null) return String(el.value || '');
    return String(el.innerText ?? el.textContent ?? '');
  };
  const roleFor = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') return ['checkbox', 'radio', 'submit', 'button'].includes(el.type) ? el.type : 'textbox';
    if (isContentEditableElement(el)) return 'textbox';
    return undefined;
  };
  const hasMutableLocatorText = (el) => {
    if (isContentEditableElement(el)) return true;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') {
      return !['button', 'submit', 'reset'].includes(String(el.type || '').toLowerCase());
    }
    const role = String(el.getAttribute?.('role') || '').toLowerCase();
    return ['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'].includes(role) && 'value' in el;
  };
  const isSensitiveElement = (el) => {
    const type = String(el.type || '').toLowerCase();
    const labelText = Array.from(el.labels || [])
      .map((label) => String(label.innerText ?? label.textContent ?? ''))
      .join(' ');
    return type === 'password' || [
      el.getAttribute('name'),
      el.id,
      el.getAttribute('autocomplete'),
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('data-testid'),
      labelText,
    ].some((item) => item && sensitive.test(item));
  };
  const elementFor = (source) => {
    let el = source && source.closest ? source.closest('button,a,input,textarea,select,label,[role],[data-testid],[contenteditable]') : null;
    if (el && String(el.tagName || '').toLowerCase() === 'label') {
      const controlId = clean(el.getAttribute('for'));
      const associated = controlId ? document.getElementById(controlId) : el.querySelector('input,textarea,select,[role]');
      el = associated || null;
    }
    return el;
  };
  const locatorFor = (source) => {
    const el = elementFor(source);
    if (!el) return null;
    if (String(el.tagName || '').toLowerCase() === 'input' && String(el.type || '').toLowerCase() === 'file') return null;
    const testId = clean(el.getAttribute('data-testid'));
    const unique = (nodes) => nodes.length === 1 ? nodes[0] : null;
    const exact = (attribute, value) => unique(all('[' + attribute + ']')
      .filter((node) => node.getAttribute(attribute) === value));
    if (testId && exact('data-testid', testId) === el) return { kind: 'test_id', value: testId };
    const aria = clean(el.getAttribute('aria-label'));
    if (aria && exact('aria-label', aria) === el) return { kind: 'aria_label', value: aria, tag: el.tagName.toLowerCase(), role: roleFor(el) };
    const name = clean(el.getAttribute('name'));
    if (name && exact('name', name) === el) return { kind: 'name', value: name, tag: el.tagName.toLowerCase() };
    const id = clean(el.id);
    if (id && exact('id', id) === el) return { kind: 'id', value: id, tag: el.tagName.toLowerCase() };
    const role = roleFor(el);
    // Editable values and secrets are action payloads, never locator evidence.
    // Without a stable attribute above, skip the event instead of persisting a
    // locator that cannot match the control again on a fresh page.
    const label = isSensitiveElement(el) || hasMutableLocatorText(el) ? '' : clean(inputValue(el));
    if (role && label) {
      const roleMatches = all(el.tagName.toLowerCase()).filter((node) => {
        const nodeRole = roleFor(node);
        return nodeRole === role && clean(inputValue(node)) === label;
      });
      if (unique(roleMatches) === el) return { kind: 'role', value: label, tag: el.tagName.toLowerCase(), role };
    }
    if (label) {
      const textMatches = all(el.tagName.toLowerCase()).filter((node) => clean(inputValue(node)) === label);
      if (unique(textMatches) === el) return { kind: 'text', value: label, tag: el.tagName.toLowerCase() };
    }
    return null;
  };
  const onClick = (event) => {
    const target = elementFor(event.target);
    const type = String(target?.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return;
    const locator = locatorFor(target);
    if (locator) emit({ kind: 'click', locator, timestamp: now() });
  };
  const recordType = (el, submit) => {
    const locator = locatorFor(el);
    if (!locator) return;
    const isSensitive = isSensitiveElement(el);
    emit({
      kind: 'type',
      locator,
      ...(isSensitive ? {} : { value: inputValue(el).slice(0, 100000) }),
      sensitive: isSensitive,
      submit,
      timestamp: now(),
    });
  };
  const onInput = (event) => {
    const el = event.target;
    const type = String(el?.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      const locator = locatorFor(el);
      if (locator) emit({ kind: 'check', locator, checked: el.checked === true, timestamp: now() });
      return;
    }
    recordType(el, false);
  };
  const onKeyDown = (event) => {
    const el = event.target;
    if (
      event.key !== 'Enter' ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !el ||
      String(el.tagName || '').toLowerCase() !== 'input' ||
      !el.form ||
      ['button', 'submit', 'reset', 'checkbox', 'radio', 'file'].includes(String(el.type || '').toLowerCase())
    ) return;
    recordType(el, true);
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('keydown', onKeyDown, true);
  window[key] = {
    credential: ${JSON.stringify(credential)},
    drain() {
      const next = events.splice(0, events.length);
      return next;
    },
    dispose() {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('keydown', onKeyDown, true);
      delete window[key];
    },
  };
  return true;
})()`;
}

export const WORKFLOW_RECORDER_DRAIN_SCRIPT = `(() => {
  const recorder = window.__makaBrowserWorkflowRecorderV1;
  return recorder ? recorder.drain() : [];
})()`;

export const WORKFLOW_RECORDER_DISPOSE_SCRIPT = `(() => {
  const recorder = window.__makaBrowserWorkflowRecorderV1;
  if (!recorder) return [];
  const events = recorder.drain();
  recorder.dispose();
  return events;
})()`;

export type BrowserWorkflowNavigationSource = 'explicit' | 'interaction';

let navigationRecorder:
  | ((sessionId: string, url: string, source: BrowserWorkflowNavigationSource) => void | Promise<void>)
  | null = null;
let navigationDrain: ((sessionId: string) => Promise<void>) | null = null;
let recorderEvent: ((sessionId: string, value: unknown) => void) | null = null;

export function setBrowserWorkflowNavigationRecorder(
  recorder:
    | ((sessionId: string, url: string, source: BrowserWorkflowNavigationSource) => void | Promise<void>)
    | null,
  drain: ((sessionId: string) => Promise<void>) | null = null,
  event: ((sessionId: string, value: unknown) => void) | null = null,
): void {
  navigationRecorder = recorder;
  navigationDrain = drain;
  recorderEvent = event;
}

export function flushBrowserWorkflowNavigation(sessionId: string): Promise<void> {
  return navigationDrain?.(sessionId) ?? Promise.resolve();
}

export function notifyBrowserWorkflowNavigation(
  sessionId: string,
  url: string,
  source: BrowserWorkflowNavigationSource = 'interaction',
): Promise<void> {
  return Promise.resolve(navigationRecorder?.(sessionId, url, source));
}

export function notifyBrowserWorkflowRecorderEvent(sessionId: string, value: unknown): void {
  recorderEvent?.(sessionId, value);
}

export function parseBrowserWorkflowRecorderConsoleMessage(message: string, credential: string): unknown | null {
  if (!credential) return null;
  const authenticatedPrefix = `${WORKFLOW_RECORDER_EVENT_PREFIX}${credential}:`;
  if (!message.startsWith(authenticatedPrefix)) return null;
  try {
    return JSON.parse(message.slice(authenticatedPrefix.length));
  } catch {
    return null;
  }
}

export function normalizeBrowserRecorderEvent(value: unknown): BrowserRecorderEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const event = value as Record<string, unknown>;
  if (event.kind !== 'click' && event.kind !== 'check' && event.kind !== 'type') return null;
  if (event.kind === 'check' && typeof event.checked !== 'boolean') return null;
  const locator = event.locator;
  if (typeof locator !== 'object' || locator === null) return null;
  const candidate = locator as Record<string, unknown>;
  if (typeof candidate.kind !== 'string' || typeof candidate.value !== 'string') return null;
  const normalized: BrowserWorkflowLocator = {
    kind: candidate.kind as BrowserWorkflowLocator['kind'],
    value: candidate.value.trim(),
    ...(typeof candidate.tag === 'string' && candidate.tag ? { tag: candidate.tag } : {}),
    ...(typeof candidate.role === 'string' && candidate.role ? { role: candidate.role } : {}),
  };
  if (!isStableBrowserWorkflowLocator(normalized)) return null;
  const sensitive = event.kind === 'type' && event.sensitive === true;
  return {
    ...(typeof event.eventId === 'string' && event.eventId.length > 0 && event.eventId.length <= 200
      ? { eventId: event.eventId }
      : {}),
    kind: event.kind,
    locator: normalized,
    ...(event.kind === 'check' && typeof event.checked === 'boolean' ? { checked: event.checked } : {}),
    ...(event.kind === 'type' && !sensitive && typeof event.value === 'string'
      ? { value: event.value.slice(0, 100_000) }
      : {}),
    ...(event.kind === 'type' ? { sensitive, submit: event.submit === true } : {}),
    timestamp: typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? event.timestamp : Date.now(),
  };
}
