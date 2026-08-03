import { randomUUID } from 'node:crypto';
import type {
  BrowserWorkflowAction,
  BrowserWorkflowLocator,
  BrowserWorkflowWaitConditionInput,
} from '@maka/core/browser-workflow';
import { isBrowserWorkflowWaitConditionInput } from '@maka/core/browser-workflow';
import type { IPage } from '@jackwener/opencli/types';

type LocatorResult = { ok: true; matched: number; actual?: string | boolean } | { ok: false; reason: string };
type WaitConditionResult = { ok: true; matched: number } | { ok: false; reason: string; matched: number };
const WORKFLOW_CLICK_MARKER_ATTRIBUTE = 'data-maka-browser-workflow-target';
const WORKFLOW_NAVIGATION_MARKER_KEY = '__makaBrowserWorkflowNavigationMarkerV1';
const WORKFLOW_NAVIGATION_OBSERVER_KEY = '__makaBrowserWorkflowNavigationObserverV1';

export interface BrowserWorkflowRunContext {
  urlBeforeInteraction?: string | null;
  navigationMarker?: string;
}

export async function assertBrowserWorkflowWaitCondition(
  page: IPage,
  input: BrowserWorkflowWaitConditionInput,
): Promise<void> {
  if (!isBrowserWorkflowWaitConditionInput(input)) throw new Error('Invalid browser workflow wait condition.');
  const encoded = JSON.stringify(input);
  const result = await page.evaluate<WaitConditionResult>(`(() => {
    const input = ${encoded};
    if (input.kind === 'selector') {
      try {
        const matched = document.querySelectorAll(input.value).length;
        return matched > 0 ? { ok: true, matched } : { ok: false, reason: 'not_found', matched };
      } catch {
        return { ok: false, reason: 'invalid_selector', matched: 0 };
      }
    }
    const bodyText = document.body?.innerText ?? '';
    return bodyText.includes(input.value)
      ? { ok: true, matched: 1 }
      : { ok: false, reason: 'not_found', matched: 0 };
  })()`);
  if (!result.ok) {
    const reason = result.reason === 'invalid_selector' ? 'invalid CSS selector' : 'not currently observable';
    throw new Error(`Browser workflow wait condition is ${reason}. Observe it on the page before recording.`);
  }
}

function resolveLocatorScript(
  locator: BrowserWorkflowLocator,
  operation: 'click' | 'check' | 'type',
  value?: string | boolean,
  clickMarker?: { attribute: string; value: string },
): string {
  const encoded = JSON.stringify(locator);
  const encodedValue = JSON.stringify(value ?? '');
  const clickEffect = clickMarker
    ? `element.setAttribute(${JSON.stringify(clickMarker.attribute)}, ${JSON.stringify(clickMarker.value)});`
    : 'element.click();';
  return `(() => {
    const locator = ${encoded};
    const value = ${encodedValue};
    const clean = (input) => String(input || '').replace(/\\s+/g, ' ').trim();
    const all = (selector) => Array.from(document.querySelectorAll(selector));
    const roleFor = (el) => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a') return 'link';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'input') {
        const type = String(el.type || '').toLowerCase();
        return ['checkbox', 'radio', 'submit', 'button'].includes(type) ? type : 'textbox';
      }
      const contenteditable = el.getAttribute('contenteditable');
      if (el.isContentEditable === true || (contenteditable !== null && contenteditable.toLowerCase() !== 'false')) return 'textbox';
      return undefined;
    };
    const isContentEditableElement = (el) => {
      const contenteditable = el.getAttribute('contenteditable');
      return el.isContentEditable === true || (contenteditable !== null && contenteditable.toLowerCase() !== 'false');
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
    const candidates = (() => {
      switch (locator.kind) {
        case 'test_id': return all('[data-testid]') .filter((el) => el.getAttribute('data-testid') === locator.value);
        case 'aria_label': return all('[aria-label]') .filter((el) => el.getAttribute('aria-label') === locator.value);
        case 'name': return all('[name]') .filter((el) => el.getAttribute('name') === locator.value);
        case 'id': { const el = document.getElementById(locator.value); return el ? [el] : []; }
        case 'role': return all(locator.tag || '*').filter((el) =>
          roleFor(el) === locator.role && clean(inputValue(el)) === locator.value,
        );
        case 'text': return all(locator.tag || '*').filter((el) => clean(inputValue(el)) === locator.value);
        default: return [];
      }
    })();
    if (candidates.length !== 1) return { ok: false, reason: candidates.length === 0 ? 'not_found' : 'ambiguous', matched: candidates.length };
    const element = candidates[0];
    if (${JSON.stringify(operation)} === 'click') {
      ${clickEffect}
      return { ok: true, matched: 1 };
    }
    if (${JSON.stringify(operation)} === 'check') {
      const type = String(element.type || '').toLowerCase();
      if (String(element.tagName || '').toLowerCase() !== 'input' || (type !== 'checkbox' && type !== 'radio')) {
        return { ok: false, reason: 'not_checkable', matched: 1 };
      }
      ${clickEffect}
      return { ok: true, matched: 1, actual: element.checked === true };
    }
    if (isContentEditableElement(element)) {
      element.textContent = value;
    } else {
      const setter = element instanceof HTMLTextAreaElement
        ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        : element instanceof HTMLInputElement
          ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          : undefined;
      if (setter) setter.call(element, value);
      else element.value = value;
    }
    element.focus();
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, matched: 1, actual: inputValue(element) };
  })()`;
}

function clearClickMarkerScript(marker: { attribute: string; value: string }): string {
  const attribute = JSON.stringify(marker.attribute);
  const value = JSON.stringify(marker.value);
  return `(() => {
    for (const element of document.querySelectorAll('[' + ${attribute} + ']')) {
      if (element.getAttribute(${attribute}) === ${value}) element.removeAttribute(${attribute});
    }
  })()`;
}

export async function runBrowserWorkflowAction(
  page: IPage,
  action: BrowserWorkflowAction,
  sensitiveValues: Record<string, string>,
  context: BrowserWorkflowRunContext = {},
): Promise<void> {
  switch (action.kind) {
    case 'navigate':
      context.urlBeforeInteraction = undefined;
      await page.goto(action.url, { waitUntil: 'load' });
      return;
    case 'click': {
      const marker = { attribute: WORKFLOW_CLICK_MARKER_ATTRIBUTE, value: randomUUID() };
      const result = await page.evaluate<LocatorResult>(
        resolveLocatorScript(action.locator, 'click', undefined, marker),
      );
      assertLocatorResult(result, action.locator);
      const selector = `[${marker.attribute}=${JSON.stringify(marker.value)}]`;
      try {
        await captureWorkflowNavigationBoundary(page, context);
        // IPage.click uses the browser's native CDP input path when available,
        // preserving trusted user activation for replayed interactions.
        await page.click(selector);
      } finally {
        await page.evaluate(clearClickMarkerScript(marker)).catch(() => {});
      }
      return;
    }
    case 'check': {
      const marker = { attribute: WORKFLOW_CLICK_MARKER_ATTRIBUTE, value: randomUUID() };
      const result = await page.evaluate<LocatorResult>(
        resolveLocatorScript(action.locator, 'check', action.checked, marker),
      );
      assertLocatorResult(result, action.locator);
      const selector = `[${marker.attribute}=${JSON.stringify(marker.value)}]`;
      try {
        await captureWorkflowNavigationBoundary(page, context);
        if (result.actual !== action.checked) {
          await page.click(selector);
          const applied = await page.evaluate<LocatorResult>(
            resolveLocatorScript(action.locator, 'check', action.checked, marker),
          );
          assertLocatorResult(applied, action.locator);
          if (applied.actual !== action.checked) {
            throw new Error('Browser workflow action did not reach the recorded checked state.');
          }
        }
      } finally {
        await page.evaluate(clearClickMarkerScript(marker)).catch(() => {});
      }
      return;
    }
    case 'type': {
      const value = action.sensitive ? sensitiveValues[action.id] : action.value;
      if (typeof value !== 'string') throw new Error(`Sensitive value required for workflow action ${action.id}.`);
      const result = await page.evaluate<LocatorResult>(resolveLocatorScript(action.locator, 'type', value));
      assertLocatorResult(result, action.locator);
      if (action.submit) {
        await captureWorkflowNavigationBoundary(page, context);
        await page.pressKey('Enter');
      } else {
        clearWorkflowNavigationBoundary(context);
      }
      return;
    }
    case 'wait': {
      if (action.url) {
        await waitForWorkflowUrl(
          page,
          action.url,
          action.timeoutMs,
          context.urlBeforeInteraction,
          context.navigationMarker,
        );
      }
      else if (action.navigation) {
        const previousUrl = context.urlBeforeInteraction;
        const marker = context.navigationMarker;
        if (!previousUrl || !marker) {
          throw new Error('Browser workflow cannot wait for navigation because the pre-action URL is unknown.');
        }
        await waitForWorkflowNavigation(page, previousUrl, marker, action.timeoutMs);
      }
      else if (action.selector)
        await page.wait({ selector: action.selector, timeout: action.timeoutMs / 1000 });
      else if (action.text) await page.wait({ text: action.text, timeout: action.timeoutMs / 1000 });
      clearWorkflowNavigationBoundary(context);
      return;
    }
  }
}

async function waitForWorkflowUrl(
  page: IPage,
  expectedUrl: string,
  timeoutMs: number,
  previousUrl?: string | null,
  marker?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let currentUrl = '';
  while (true) {
    const state = await readWorkflowNavigationState(page, marker);
    currentUrl = state.url ?? '';
    const sameUrlDocumentNavigation = previousUrl === expectedUrl && marker !== undefined;
    if (currentUrl === expectedUrl && (!sameUrlDocumentNavigation || state.markerPresent === false)) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Browser workflow navigation did not reach ${expectedUrl}; current URL is ${currentUrl || 'unknown'}.`,
      );
    }
    await page.wait({ time: Math.min(100, remainingMs) / 1000 });
  }
}

async function waitForWorkflowNavigation(
  page: IPage,
  previousUrl: string,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let currentUrl = previousUrl;
  while (true) {
    const state = await readWorkflowNavigationState(page, marker);
    currentUrl = state.url ?? '';
    if ((currentUrl && currentUrl !== previousUrl) || state.markerPresent === false) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Browser workflow navigation did not leave ${previousUrl}; current URL is ${currentUrl || 'unknown'}.`,
      );
    }
    await page.wait({ time: Math.min(100, remainingMs) / 1000 });
  }
}

async function captureWorkflowNavigationBoundary(
  page: IPage,
  context: BrowserWorkflowRunContext,
): Promise<void> {
  const marker = randomUUID();
  const script = `(() => {
    const scope = globalThis;
    const markerKey = ${JSON.stringify(WORKFLOW_NAVIGATION_MARKER_KEY)};
    const observerKey = ${JSON.stringify(WORKFLOW_NAVIGATION_OBSERVER_KEY)};
    let observer = scope[observerKey];
    if (!observer || observer.version !== 1) {
      observer = { version: 1, activeMarker: null };
      scope[observerKey] = observer;
      const observeNavigation = () => {
        if (observer.activeMarker && scope[markerKey] === observer.activeMarker) {
          delete scope[markerKey];
        }
        observer.activeMarker = null;
      };
      if (typeof history !== 'undefined') {
        for (const method of ['pushState', 'replaceState']) {
          const original = history[method];
          if (typeof original !== 'function') continue;
          history[method] = function (...args) {
            const result = Reflect.apply(original, this, args);
            observeNavigation();
            return result;
          };
        }
      }
      if (typeof addEventListener === 'function') {
        addEventListener('popstate', observeNavigation);
        addEventListener('hashchange', observeNavigation);
      }
    }
    scope[markerKey] = ${JSON.stringify(marker)};
    observer.activeMarker = ${JSON.stringify(marker)};
    return typeof location === 'undefined' ? null : location.href;
  })()`;
  const evaluated = await page.evaluate<unknown>(script);
  const url = typeof evaluated === 'string' && evaluated ? evaluated : await readWorkflowUrl(page);
  context.urlBeforeInteraction = url;
  context.navigationMarker = typeof evaluated === 'string' && evaluated ? marker : undefined;
}

function clearWorkflowNavigationBoundary(context: BrowserWorkflowRunContext): void {
  context.urlBeforeInteraction = undefined;
  context.navigationMarker = undefined;
}

async function readWorkflowNavigationState(
  page: IPage,
  marker?: string,
): Promise<{ url: string | null; markerPresent: boolean | null }> {
  if (marker) {
    try {
      const result = await page.evaluate<unknown>(`(() => ({
        url: typeof location === 'undefined' ? null : location.href,
        markerPresent: globalThis[${JSON.stringify(WORKFLOW_NAVIGATION_MARKER_KEY)}] === ${JSON.stringify(marker)},
      }))()`);
      if (
        typeof result === 'object' &&
        result !== null &&
        typeof (result as { url?: unknown }).url === 'string' &&
        typeof (result as { markerPresent?: unknown }).markerPresent === 'boolean'
      ) {
        return result as { url: string; markerPresent: boolean };
      }
    } catch {
      // A navigation may temporarily destroy the execution context; poll again through the URL fallback.
    }
  }
  return { url: await readWorkflowUrl(page), markerPresent: null };
}

async function readWorkflowUrl(page: IPage): Promise<string | null> {
  try {
    const evaluated = await page.evaluate<string>('window.location.href');
    return typeof evaluated === 'string' && evaluated ? evaluated : null;
  } catch {
    return page.getCurrentUrl ? await page.getCurrentUrl().catch(() => null) : null;
  }
}

function assertLocatorResult(
  result: LocatorResult,
  locator: BrowserWorkflowLocator,
): asserts result is Extract<LocatorResult, { ok: true }> {
  if (result.ok) return;
  const detail = result.reason === 'ambiguous' ? 'matched multiple elements' : 'did not match an element';
  throw new Error(`Workflow locator ${JSON.stringify(locator)} ${detail}. Re-record this workflow.`);
}
