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

/** Bounded, structured observations without depending on OpenCLI's DOM pruning. */
export const BROWSER_OBSERVATION_MAX_CHARS = 16_000;
export const BROWSER_OBSERVATION_SCAN_LIMIT = 5_000;

export interface BrowserObservationOptions {
  selector?: string;
  scope?: string;
  visibleOnly?: boolean;
  maxElements?: number;
  context?: boolean;
}

export interface BrowserCandidate {
  /** Document-local CSS reference accepted by browser_click / browser_type. */
  ref: string;
  tag: string;
  name: string;
  attributes: Record<string, string>;
  visible: boolean;
  enabled: boolean;
}

export interface BrowserObservation {
  selector: string;
  scope: string;
  scopeMatchCount: number;
  matchCount: number;
  visibleMatchCount: number | null;
  scannedCount: number;
  scanTruncated: boolean;
  truncated: boolean;
  candidates: BrowserCandidate[];
  context: string[];
  error?: string;
}

/**
 * Inputs are JSON literals, never executable selector fragments. References use
 * a per-document nonce and a WeakMap: another inspection preserves them, while
 * reload/navigation cannot silently reuse them for unrelated elements.
 * Only reference attributes are written; no page controls or values are changed.
 */
export function browserObservationJs(options: BrowserObservationOptions = {}): string {
  return `(() => {
  const options = ${JSON.stringify(options)};
  const interactive = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="tab"],[role="textbox"],[role="combobox"],[contenteditable="true"]';
  const selector = options.selector || interactive;
  const scope = options.scope || 'body';
  const maxElements = Math.max(1, Math.min(100, options.maxElements || 20));
  const result = { selector, scope, scopeMatchCount: 0, matchCount: 0, visibleMatchCount: 0, scannedCount: 0, scanTruncated: false, truncated: false, candidates: [], context: [] };
  let roots;
  try { roots = document.querySelectorAll(scope); }
  catch { result.error = 'Invalid scope selector.'; return result; }
  result.scopeMatchCount = roots.length;
  if (roots.length !== 1) {
    result.error = 'Scope must match exactly one element; use a narrower scope.';
    return result;
  }
  const root = roots[0];
  let nodes;
  try {
    nodes = Array.from(root.querySelectorAll(selector));
    if (root.matches(selector)) nodes.unshift(root);
  } catch { result.error = 'Invalid element selector.'; return result; }
  result.matchCount = nodes.length;
  result.scannedCount = Math.min(nodes.length, ${BROWSER_OBSERVATION_SCAN_LIMIT});
  result.scanTruncated = nodes.length > result.scannedCount;
  const visibility = new WeakMap();
  function allowedByAncestors(el) {
    if (!el) return true;
    if (visibility.has(el)) return visibility.get(el);
    const style = window.getComputedStyle(el);
    const allowed = !el.hidden && !el.hasAttribute('inert') &&
      style.display !== 'none' &&
      Number(style.opacity) !== 0 && allowedByAncestors(el.parentElement);
    visibility.set(el, allowed);
    return allowed;
  }
  function visible(el) {
    if (el.matches('input[type="hidden"]') || !allowedByAncestors(el)) return false;
    const ownVisibility = window.getComputedStyle(el).visibility;
    if (ownVisibility === 'hidden' || ownVisibility === 'collapse') return false;
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS' && !parent.open) {
        const summary = Array.from(parent.children).find(child => child.tagName === 'SUMMARY');
        if (!summary || !summary.contains(el)) return false;
      }
    }
    return Array.from(el.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
  }
  const clean = (text) => String(text || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  function name(el) {
    const explicit = el.getAttribute('aria-label');
    if (explicit) return clean(explicit);
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const text = labelled.split(/\\s+/).map(id => {
        const label = document.getElementById(id);
        return label && visible(label) ? label.innerText : '';
      }).join(' ');
      if (text.trim()) return clean(text);
    }
    if (el.labels && el.labels.length) {
      const text = Array.from(el.labels).filter(visible).map(label => label.innerText).join(' ');
      if (text.trim()) return clean(text);
    }
    return clean(el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') ||
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ? '' : el.innerText));
  }
  const stateKey = '__makaBrowserObservationRefs';
  if (!window[stateKey]) {
    window[stateKey] = { nonce: Array.from(window.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''), next: 0, refs: new WeakMap() };
  }
  const state = window[stateKey];
  let eligibleCount = 0;
  let visibleCount = 0;
  for (const el of nodes.slice(0, result.scannedCount)) {
    const isVisible = visible(el);
    if (isVisible) visibleCount++;
    // Never expose hidden controls, their identifiers, or their values even
    // when inspecting invisible candidates. Values are omitted for all inputs.
    if (el.matches('input[type="hidden"]')) continue;
    if (options.visibleOnly !== false && !isVisible) continue;
    eligibleCount++;
    if (result.candidates.length >= maxElements) continue;
    let id = state.refs.get(el);
    if (!id) { id = 'maka-' + state.nonce + '-' + (++state.next); state.refs.set(el, id); }
    el.setAttribute('data-maka-browser-ref', id);
    const attributes = {};
    for (const key of ['id', 'name', 'role', 'type', 'aria-label', 'aria-checked', 'aria-expanded']) {
      const value = el.getAttribute(key);
      if (value) attributes[key] = clean(value);
    }
    const enabled = !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true';
    result.candidates.push({ ref: '[data-maka-browser-ref="' + id + '"]', tag: el.tagName.toLowerCase(), name: name(el), attributes, visible: isVisible, enabled });
  }
  result.visibleMatchCount = result.scanTruncated ? null : visibleCount;
  if (options.context) {
    for (const el of root.querySelectorAll('h1,h2,h3,[role="heading"]')) {
      if (visible(el)) result.context.push(clean(el.innerText));
      if (result.context.length >= 12) break;
    }
  }
  result.truncated = result.scanTruncated || eligibleCount > result.candidates.length;
  while (JSON.stringify(result).length > ${BROWSER_OBSERVATION_MAX_CHARS} && result.candidates.length) {
    result.candidates.pop(); result.truncated = true;
  }
  return result;
})()`;
}
