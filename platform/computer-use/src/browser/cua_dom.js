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

// Fixed projection called on the existing injected utility object. DOM handles
// live only in the caller's CDP object group; stable references belong to Tab.
function visibleDom(request) {
  const view = window.visualViewport;
  const viewport = view
    ? [view.offsetLeft, view.offsetTop, view.offsetLeft + view.width, view.offsetTop + view.height]
    : [0, 0, window.innerWidth, window.innerHeight];
  const clip = request.clip
    ? [
        Math.max(viewport[0], request.clip[0]),
        Math.max(viewport[1], request.clip[1]),
        Math.min(viewport[2], request.clip[2]),
        Math.min(viewport[3], request.clip[3]),
      ]
    : viewport;
  const items = [];
  const frames = [];
  const tags = new Set([
    'a',
    'button',
    'details',
    'input',
    'option',
    'select',
    'summary',
    'textarea',
  ]);
  const roles = new Set([
    'button',
    'checkbox',
    'combobox',
    'link',
    'menuitem',
    'option',
    'radio',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
  ]);
  const attributes = [
    'aria-disabled',
    'aria-label',
    'contenteditable',
    'href',
    'name',
    'placeholder',
    'role',
    'title',
    'type',
    'value',
  ];
  const booleans = ['checked', 'disabled', 'multiple', 'readonly', 'required', 'selected'];
  const omitted = new Set(['noscript', 'script', 'style', 'template']);
  const name = (element) => (element.localName || element.nodeName || '').toLowerCase();
  const space = (text) => text.replace(/\s+/g, ' ').trim();
  const escape = (text) =>
    text
      .replace(/[\t\n\f\r]+/g, ' ')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const rectangle = (element) => {
    const style = window.getComputedStyle(element);
    if (
      style.visibility !== 'visible' ||
      style.display === 'none' ||
      style.pointerEvents === 'none' ||
      Number(style.opacity) <= 0.01
    )
      return;
    for (const rect of element.getClientRects())
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > clip[0] &&
        rect.left < clip[2] &&
        rect.bottom > clip[1] &&
        rect.top < clip[3]
      )
        return [rect.left, rect.top, rect.right, rect.bottom];
  };
  const text = (root) => {
    const words = [];
    const pending = [root];
    let count = 0;
    while (pending.length && count < 160) {
      const node = pending.pop();
      if (node.nodeType === 3) {
        const word = space(node.nodeValue || '');
        if (word) {
          words.push(word);
          count += word.length + 1;
        }
      } else if (node.nodeType !== 1 || !omitted.has(name(node))) {
        const children = [...(node.childNodes || []), ...(node.shadowRoot?.childNodes || [])];
        pending.push(...children.reverse());
      }
    }
    return space(words.join(' ')).slice(0, 160);
  };
  const interactive = (element) => {
    const tag = name(element);
    if (
      element.getAttribute('aria-hidden') === 'true' ||
      element.hasAttribute('hidden') ||
      (tag === 'input' && element.getAttribute('type') === 'hidden')
    )
      return false;
    const editable = element.getAttribute('contenteditable');
    return (
      tags.has(tag) ||
      (editable !== null && editable.toLowerCase() !== 'false') ||
      element.hasAttribute('href') ||
      element.hasAttribute('onclick') ||
      roles.has((element.getAttribute('role') || '').trim().toLowerCase()) ||
      Number(element.getAttribute('tabindex') ?? -1) >= 0
    );
  };
  let characters = 0;
  let order = 0;
  let full = false;
  const pending = document.documentElement ? [document.documentElement] : [];
  while (pending.length && !full && items.length < request.maxElements) {
    const element = pending.pop();
    const ordinal = order++;
    if (element.nodeType !== 1) continue;
    // The provider's UI is outside page content; its exact roots are passed by
    // the admitted host rather than a page-controlled broad selector.
    if (request.overlayRootIds?.includes(element.id)) continue;
    const tag = name(element);
    if (tag === 'iframe' || tag === 'frame') {
      const bounds = rectangle(element);
      if (bounds && frames.length < request.maxElements)
        frames.push({
          order: ordinal,
          element,
          rect: bounds,
          size: [
            element.clientWidth > 0 ? element.clientWidth : bounds[2] - bounds[0],
            element.clientHeight > 0 ? element.clientHeight : bounds[3] - bounds[1],
          ],
        });
    }
    if (interactive(element) && rectangle(element)) {
      const values = [];
      for (const attribute of attributes) {
        if (attribute === 'value' && this.makaProtectedInput(element)) continue;
        const value = element.getAttribute(attribute);
        if (value !== null && value !== '') values.push(attribute + '="' + escape(value) + '"');
      }
      for (const attribute of booleans)
        if (element.hasAttribute(attribute)) values.push(attribute + '="true"');
      const label = text(element);
      const prefix =
        '<' + tag + ' node_id=__maka_dom_ref__' + (values.length ? ' ' + values.join(' ') : '');
      const line = label ? prefix + '>' + escape(label) + '</' + tag + '>' : prefix + ' />';
      const length = line.length + (items.length ? 1 : 0);
      if (characters + length > request.maxChars) full = true;
      else {
        items.push({ element, line, order: ordinal });
        characters += length;
      }
    }
    // Open shadow content precedes light children, matching the visible walk.
    const children = [...(element.shadowRoot?.children || []), ...(element.children || [])];
    pending.push(...children.reverse());
  }
  return { viewport, clip, items, frames };
}
