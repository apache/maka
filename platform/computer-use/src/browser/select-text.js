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

function selectText(text, prefix, suffix, selectionType) {
  if (!this.isConnected || this.disabled || this.readOnly) throw Error('element is not editable');
  const value =
    typeof this.value === 'string' ? this.value : this.isContentEditable ? this.textContent : null;
  if (value === null || !text)
    throw Error('selectText requires an editable element and nonempty text');
  const matches = [];
  for (let from = 0; from <= value.length - text.length; ) {
    const at = value.indexOf(text, from);
    if (at < 0) break;
    if (
      (!prefix || value.slice(0, at).endsWith(prefix)) &&
      (!suffix || value.slice(at + text.length).startsWith(suffix))
    )
      matches.push(at);
    from = at + 1;
  }
  if (matches.length === 0)
    throw Error(
      'text_not_found: no match for text and prefix/suffix; read getAXState again because the content may have changed',
    );
  if (matches.length > 1) throw Error('ambiguous_text: multiple matches; provide prefix/suffix');
  let start = matches[0],
    end = start + text.length;
  if (selectionType === 'cursor_before') end = start;
  if (selectionType === 'cursor_after') start = end;
  this.focus();
  if (typeof this.setSelectionRange === 'function') {
    this.setSelectionRange(start, end);
    if (this.selectionStart !== start || this.selectionEnd !== end)
      throw Error('selection read-back failed');
  } else {
    const document = this.ownerDocument;
    const walker = document.createTreeWalker(this, 4);
    const range = document.createRange();
    let offset = 0,
      started = false,
      ended = false;
    while (walker.nextNode()) {
      const node = walker.currentNode,
        next = offset + node.textContent.length;
      if (!started && start <= next) {
        range.setStart(node, start - offset);
        started = true;
      }
      if (end <= next) {
        range.setEnd(node, end - offset);
        ended = true;
        break;
      }
      offset = next;
    }
    if (!started || !ended) throw Error('editable content changed during selection');
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    if (selection.toString() !== value.slice(start, end)) throw Error('selection read-back failed');
  }
}
