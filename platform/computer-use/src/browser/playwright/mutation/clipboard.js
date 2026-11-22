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

async function clipboardOperation(element, request, prepared) {
  const htmlNamespace = 'http://www.w3.org/1999/xhtml';
  const html = (node, tag) => node?.namespaceURI === htmlNamespace && node.localName === tag;
  const requireElement = (node) => {
    if (!node || node.nodeType !== 1) throw new Error('Clipboard target is not an element');
    if (!node.isConnected || !node.ownerDocument.defaultView)
      throw new Error('Clipboard target is not connected');
    return node;
  };
  const activePasteTarget = () => {
    const localName = Object.getOwnPropertyDescriptor(window.Element.prototype, 'localName')?.get;
    const namespace = Object.getOwnPropertyDescriptor(
      window.Element.prototype,
      'namespaceURI',
    )?.get;
    if (!localName || !namespace) throw new Error('Virtual clipboard requires native DOM getters');
    const elementNode = (node) => {
      if (node == null) return null;
      try {
        localName.call(node);
      } catch {
        return null;
      }
      return node.ownerDocument.defaultView ? node : null;
    };
    const descend = (root) => {
      const node = elementNode(root.activeElement);
      if (!node) return null;
      if (namespace.call(node) === htmlNamespace) {
        if (node.shadowRoot) return descend(node.shadowRoot) ?? node;
        if (['iframe', 'frame'].includes(localName.call(node))) {
          try {
            const document = node.contentDocument ?? node.contentWindow?.document;
            if (document) return descend(document) ?? node;
          } catch {
            return node;
          }
        }
      }
      return node;
    };
    return descend(document) ?? document.body;
  };
  const protectedInput = (node) => {
    if (node?.tagName?.toLowerCase() !== 'input') return false;
    if ((node.getAttribute('type') ?? '').toLowerCase() === 'hidden') return true;
    const attributes = ['type', 'autocomplete', 'id', 'name', 'placeholder', 'aria-label', 'title'];
    const value = attributes
      .map((attribute) => node.getAttribute(attribute) ?? '')
      .join(' ')
      .toLowerCase();
    const words = ['password', 'passcode', 'passwd', 'phone', 'mobile'];
    for (const separator of ['', '-', '_', ' ']) {
      words.push('user' + separator + 'name', 'e' + separator + 'mail');
      for (const next of ['', '-', '_', ' '])
        words.push('one' + separator + 'time' + next + 'code');
    }
    return (
      words.some((word) => value.includes(word)) ||
      value.split(/\W+/).some((word) => ['otp', '2fa', 'mfa', 'tel'].includes(word))
    );
  };
  const sanitize = (root) => {
    let changed = false;
    for (const input of root.querySelectorAll('input[value]')) {
      if (!protectedInput(input)) continue;
      input.removeAttribute('value');
      changed = true;
    }
    return changed;
  };
  const textItems = (text, markup = '') => {
    const entries = [];
    if (text) entries.push({ mimeType: 'text/plain', text });
    if (markup) entries.push({ mimeType: 'text/html', text: markup });
    return entries.length ? [{ entries, presentationStyle: 'unspecified' }] : [];
  };
  const selection = (node) => {
    if (html(node, 'input') || html(node, 'textarea')) {
      const start = node.selectionStart;
      const end = node.selectionEnd;
      if (start === null || end === null || start === end) return null;
      const text = node.value.slice(start, end);
      return { items: textItems(text), cut: { node, start, end, text } };
    }
    const selected = node.ownerDocument.defaultView.getSelection();
    if (!selected || selected.isCollapsed || !selected.rangeCount) return null;
    const ranges = Array.from({ length: selected.rangeCount }, (_, index) =>
      selected.getRangeAt(index).cloneRange(),
    );
    const container = node.ownerDocument.createElement('div');
    for (const range of ranges) container.append(range.cloneContents());
    sanitize(container);
    let editable = node.isContentEditable ? node : null;
    while (editable?.parentElement?.isContentEditable) editable = editable.parentElement;
    const text = selected.toString();
    return { items: textItems(text, container.innerHTML), cut: { node, editable, ranges, text } };
  };
  const decode = (value, view) => {
    const binary = view.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  const encode = (buffer) => {
    const bytes = new Uint8Array(buffer);
    const pieces = [];
    for (let offset = 0; offset < bytes.length; offset += 8192)
      pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
    return btoa(pieces.join(''));
  };
  const transferItems = async (transfer, document) => {
    const entries = [];
    for (const type of Array.from(transfer.types)) {
      if (type === 'Files') continue;
      let text = transfer.getData(type);
      if (type === 'text/html' && /<input[\s/>]/i.test(text)) {
        const template = document.createElement('template');
        template.innerHTML = text;
        if (sanitize(template.content)) text = template.innerHTML;
      }
      entries.push({ mimeType: type, text });
    }
    for (const file of Array.from(transfer.files))
      if (file.type)
        entries.push({ mimeType: file.type, base64: encode(await file.arrayBuffer()) });
    return entries.length ? [{ entries, presentationStyle: 'unspecified' }] : [];
  };
  const populateTransfer = (transfer, items, view) => {
    transfer.clearData();
    for (const item of items) {
      for (const entry of item.entries) {
        if (typeof entry.text === 'string') transfer.setData(entry.mimeType, entry.text);
        else {
          const extension = entry.mimeType.split('/')[1] ?? 'bin';
          transfer.items.add(
            new view.File([decode(entry.base64 ?? '', view)], 'clipboard.' + extension, {
              type: entry.mimeType,
            }),
          );
        }
      }
    }
  };
  const plain = (items, type) =>
    items.flatMap((item) => item.entries).find((entry) => entry.mimeType === type)?.text ?? '';
  const deleteEvent = (view, kind) =>
    new view.InputEvent(kind, {
      bubbles: true,
      cancelable: kind === 'beforeinput',
      composed: true,
      inputType: 'deleteByCut',
    });
  const commitCut = () => {
    const cut = prepared?.cut;
    if (!cut) throw new Error('Browser Use virtual cut is no longer pending');
    delete prepared.cut;
    if (cut.node !== element) throw new Error('Virtual cut target changed');
    const node = requireElement(cut.node);
    const view = node.ownerDocument.defaultView;
    if (cut.ranges) {
      if (
        !cut.editable?.isConnected ||
        !cut.editable.isContentEditable ||
        !cut.ranges.every((range) => cut.editable.contains(range.commonAncestorContainer)) ||
        cut.ranges.map((range) => range.toString()).join('') !== cut.text
      )
        return {};
      if (!node.dispatchEvent(deleteEvent(view, 'beforeinput'))) return {};
      for (const range of cut.ranges.slice().reverse()) range.deleteContents();
    } else {
      if (node.disabled || node.readOnly || node.value.slice(cut.start, cut.end) !== cut.text)
        return {};
      if (!node.dispatchEvent(deleteEvent(view, 'beforeinput'))) return {};
      node.setRangeText('', cut.start, cut.end, 'end');
    }
    node.dispatchEvent(deleteEvent(view, 'input'));
    return {};
  };
  const defaultPaste = (node, items, markup) => {
    const text = plain(items, 'text/plain');
    const view = node.ownerDocument.defaultView;
    if (html(node, 'input') || html(node, 'textarea')) {
      if (node.disabled || node.readOnly || !text) return;
      const setValue = () => {
        const prototype = Object.getPrototypeOf(node);
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        const ownSetter = Object.getOwnPropertyDescriptor(node, 'value')?.set;
        const value = request.replaceInputValue ? text : node.value + text;
        if (setter && setter !== ownSetter) setter.call(node, value);
        else node.value = value;
      };
      if (node.selectionStart === null || node.selectionEnd === null) setValue();
      else {
        try {
          node.setRangeText(text, node.selectionStart, node.selectionEnd, 'end');
        } catch {
          setValue();
        }
      }
      node.dispatchEvent(new view.InputEvent('input', { bubbles: true }));
      return;
    }
    if (
      node.namespaceURI !== htmlNamespace ||
      (!node.isContentEditable && !node.closest('[contenteditable=true]'))
    )
      return;
    node.focus();
    // These insertions edit this document; clipboard acquisition stays in Rust.
    if (markup) node.ownerDocument.execCommand('insertHTML', false, markup);
    else if (text) node.ownerDocument.execCommand('insertText', false, text);
  };

  if (request.kind === 'commitCut') return commitCut();
  const node = request.currentActiveElement ? activePasteTarget() : requireElement(element);
  if (!node) throw new Error('Active clipboard target is unavailable');
  const view = node.ownerDocument.defaultView;
  if (request.kind === 'paste') {
    const items = (request.items ?? [])
      .map((item) => ({
        ...item,
        entries: item.entries.filter(
          (entry) => !request.plainTextOnly || entry.mimeType === 'text/plain',
        ),
      }))
      .filter((item) => item.entries.length);
    if (!items.length) throw new Error('Browser Use virtual clipboard has no data to paste');
    const markup =
      request.richTextFallback && !request.plainTextOnly ? plain(items, 'text/html') : '';
    if (typeof view.DataTransfer !== 'function' || typeof view.ClipboardEvent !== 'function') {
      defaultPaste(node, items, markup);
      return {};
    }
    const transfer = new view.DataTransfer();
    populateTransfer(transfer, items, view);
    const event = new view.ClipboardEvent('paste', {
      clipboardData: transfer,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    if (node.dispatchEvent(event)) defaultPaste(node, items, markup);
    return {};
  }
  if (request.kind !== 'copy' && request.kind !== 'cut')
    throw new Error('Unsupported virtual clipboard operation');
  if (protectedInput(node)) return {};
  const selected = selection(node);
  const transfer = new view.DataTransfer();
  const event = new view.ClipboardEvent(request.kind, {
    clipboardData: transfer,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  if (!node.dispatchEvent(event)) {
    const items = await transferItems(transfer, node.ownerDocument);
    return items.length ? { items } : {};
  }
  if (!selected?.items.length) return {};
  return request.kind === 'cut' ? selected : { items: selected.items };
}
