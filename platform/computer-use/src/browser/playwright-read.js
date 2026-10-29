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

function read(request) {
  if (request.operation.kind === 'selectorSegments')
    return { status: 'value', value: this.makaSegments(request.selector) };
  const parsed =
    request.parsedSelector ?? (request.selector ? this.parseSelector(request.selector) : undefined);
  const elements = parsed ? this.querySelectorAll(parsed, document) : [];
  const value = (value) => ({ status: 'value', value });
  const choose = () => {
    if (elements.length === 0) return { status: 'missing' };
    if (elements.length === 1) return value(elements[0]);
    const visible = elements.filter((element) => this.elementState(element, 'visible').matches);
    return visible.length === 1 ? value(visible[0]) : { status: 'strict', count: elements.length };
  };
  const protectedInput = this.makaProtectedInput;
  switch (request.operation.kind) {
    case 'domSnapshot': {
      const root = document.body ?? document.documentElement;
      if (!root) return value({ full: '', iframes: [] });
      const snapshot = this.makaSnapshot(root, protectedInput);
      const iframes = [];
      for (const reference of snapshot.iframeRefs) {
        const marker = '[ref=' + reference + ']';
        if (
          !snapshot.full
            .split('\n')
            .some((line) => line.trimStart().startsWith('- iframe') && line.includes(marker))
        )
          continue;
        const owner = this.querySelectorAll(this.parseSelector('aria-ref=' + reference), root)[0];
        if (!owner) continue;
        iframes.push({
          reference,
          id: owner.getAttribute('id'),
          name: owner.getAttribute('name'),
          visible:
            owner.getAttribute('aria-hidden') !== 'true' &&
            this.elementState(owner, 'visible').matches,
        });
      }
      return value({ full: snapshot.full, iframes });
    }
    case 'waitFor': {
      const element = elements[0];
      const state = request.operation.state;
      if (state === 'attached')
        return value({ ready: !!element, reason: 'Element is not attached' });
      if (state === 'detached')
        return value({ ready: !element, reason: 'Element is still attached' });
      if (!element) return value({ ready: state === 'hidden', reason: 'Element is not attached' });
      const result = this.elementState(element, state);
      if (result.received === 'error:notconnected')
        return value({ ready: false, reason: 'Element is not connected' });
      return value({ ready: !!result.matches, reason: 'Element is not ' + state });
    }
    case 'waitDiagnostics': {
      const report = { matchCount: elements.length, visibleCount: 0, matches: [] };
      for (const element of elements) {
        const visible = element.getClientRects().length > 0;
        report.visibleCount += Number(visible);
        if (report.matches.length < 5)
          report.matches.push({
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute('role'),
            type: element.getAttribute('type'),
            ariaLabel: element.getAttribute('aria-label'),
            text: (element.textContent ?? '').trim().slice(0, 120),
            visible,
            disabled: 'disabled' in element && Boolean(element.disabled),
          });
      }
      return value(report);
    }
    case 'count':
      return value(elements.length);
    case 'allTextContents':
      return value(
        elements.map((element) =>
          typeof element.textContent === 'string' ? element.textContent : '',
        ),
      );
    case 'isEnabled':
      return value(elements[0] ? !!this.elementState(elements[0], 'enabled').matches : false);
    case 'isVisible':
      return value(elements[0] ? !!this.elementState(elements[0], 'visible').matches : false);
    case 'rows': {
      const relative = request.relative ? this.parseSelector(request.relative) : undefined;
      return value(
        elements.map((root) => {
          const element = relative ? this.querySelectorAll(relative, root)[0] : root;
          if (!element) return null;
          const attributes = Array.from(element.attributes)
            .filter(
              (attribute) => attribute.name.toLowerCase() !== 'value' || !protectedInput(element),
            )
            .map((attribute) => [attribute.name, attribute.value]);
          return {
            attributes: Object.fromEntries(attributes),
            innerText: 'innerText' in element ? String(element.innerText) : '',
            textContent: element.textContent,
          };
        }),
      );
    }
    default: {
      const selected = choose();
      if (selected.status !== 'value') return selected;
      const element = selected.value;
      switch (request.operation.kind) {
        case 'frame':
          return value(element);
        case 'innerText':
          return value('innerText' in element ? String(element.innerText) : '');
        case 'textContent':
          return value(element.textContent);
        case 'getAttribute':
          return value(
            request.operation.name.toLowerCase() === 'value' && protectedInput(element)
              ? null
              : element.getAttribute(request.operation.name),
          );
        default:
          throw new Error('Unsupported browser read operation');
      }
    }
  }
}
