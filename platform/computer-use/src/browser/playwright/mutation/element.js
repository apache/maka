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

async function elementOperation(element, request) {
  const requireElement = (node) => {
    if (!node || node.nodeType !== 1) throw new Error('Node is not an element');
    if (!node.isConnected) throw new Error('Element is not connected');
    return node;
  };
  const inputTarget = () => {
    requireElement(element);
    return requireElement(
      request.requireEditable === false ? element : this.retarget(element, 'follow-label'),
    );
  };
  const stateFailure = (states) => {
    requireElement(element);
    for (const state of states) {
      const result = this.elementState(element, state);
      if (result.received === 'error:notconnected') throw new Error('Element is not connected');
      if (!result.matches) return 'Element is not ' + state;
    }
    return null;
  };
  const requireStates = (states) => {
    const message = stateFailure(states);
    if (message) throw new Error(message);
  };
  const prepare = (states) => {
    const message = stateFailure(states);
    return message ? { status: 'retry', message } : { status: 'ready' };
  };
  const textStates =
    request.requireEditable === false ? ['visible', 'enabled'] : ['visible', 'enabled', 'editable'];
  const focused = (node) => {
    if (!node?.isConnected || !node.ownerDocument.hasFocus()) return false;
    let current = node;
    while (current) {
      const root = current.getRootNode();
      if (root.activeElement !== current) return false;
      if (!root.host) return true;
      current = root.host;
    }
    return false;
  };
  const requireVisibleAncestors = () => {
    requireElement(element);
    let frame = element.ownerDocument.defaultView?.frameElement;
    while (frame) {
      const state = this.elementState(frame, 'visible');
      if (state.received === 'error:notconnected') throw new Error('Frame is not connected');
      if (!state.matches) throw new Error('Ancestor frame is not visible');
      frame = frame.ownerDocument.defaultView?.frameElement;
    }
  };
  const scroll = (alignment = { block: 'center', inline: 'nearest' }, instant = false) => {
    element.scrollIntoView(instant ? { ...alignment, behavior: 'instant' } : alignment);
  };
  const complete = (result) => {
    if (typeof result === 'string' && result.startsWith('error:'))
      throw new Error(result === 'error:notconnected' ? 'Element is not connected' : result);
    return result;
  };

  switch (request.kind) {
    case 'preparePointer':
      return prepare(request.force ? [] : ['visible', 'enabled']);
    case 'prepareText':
      return prepare(textStates);
    case 'prepareSelect': {
      const prepared = prepare(['enabled']);
      if (prepared.status !== 'ready') return prepared;
      const target = requireElement(this.retarget(element, 'follow-label'));
      if (target.localName !== 'select') throw new Error('Element is not a <select> element');
      return prepared;
    }
    case 'pointer': {
      const states = request.force ? [] : ['visible', 'enabled'];
      requireStates(states);
      scroll(request.scrollAlignment, true);
      let bounds = element.getBoundingClientRect();
      let stableFrames = 0;
      for (let frame = 0; frame < 10 && stableFrames < 2; frame++) {
        await new Promise((resolve) => {
          const view = element.ownerDocument.defaultView;
          if (typeof view?.requestAnimationFrame === 'function')
            view.requestAnimationFrame(resolve);
          else setTimeout(resolve, 0);
        });
        requireElement(element);
        const next = element.getBoundingClientRect();
        stableFrames = ['left', 'top', 'width', 'height'].every(
          (field) => bounds[field] === next[field],
        )
          ? stableFrames + 1
          : 0;
        bounds = next;
      }
      requireStates(states);
      if (!(bounds.width > 0 && bounds.height > 0))
        throw new Error('Element does not have a clickable bounding box');
      const view = element.ownerDocument.defaultView;
      if (!view) throw new Error('Element viewport is not available');
      return {
        point: {
          x: Math.max(0, bounds.left + bounds.width / 2),
          y: Math.max(0, bounds.top + bounds.height / 2),
        },
        width: bounds.width,
        height: bounds.height,
        viewportWidth: view.innerWidth,
        viewportHeight: view.innerHeight,
      };
    }
    case 'readChecked': {
      requireElement(element);
      const state = this.elementState(element, 'checked');
      if (state.received === 'error:notconnected') throw new Error('Element is not connected');
      return { checked: !!state.matches, isRadio: !!state.isRadio };
    }
    case 'verify': {
      if (!element?.isConnected) return { connected: false, focused: false };
      const target =
        request.exactTarget || request.requireEditable === false
          ? element
          : this.retarget(element, 'follow-label');
      return { connected: !!target?.isConnected, focused: focused(target) };
    }
    case 'focus':
    case 'type': {
      requireElement(element);
      requireVisibleAncestors();
      requireStates(textStates);
      const target = inputTarget();
      scroll();
      if (!focused(target)) complete(this.focusNode(target, false));
      if (!focused(target)) throw new Error('Element is not focused');
      return { status: 'needsinput' };
    }
    case 'fill': {
      if (typeof request.value !== 'string')
        throw new Error('locator.fill requires a string value');
      requireStates(['visible', 'enabled', 'editable']);
      scroll();
      const target = inputTarget();
      if (
        target.isContentEditable &&
        target.localName !== 'input' &&
        target.localName !== 'textarea'
      ) {
        target.focus();
        // Focus handlers may replace children or detach the held node. Select
        // its current contents without looking up the selector again.
        const contents = target.ownerDocument.createRange();
        contents.selectNodeContents(target);
        const selection = target.ownerDocument.defaultView?.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(contents);
        }
        return { status: 'needsinput' };
      }
      const result = complete(this.fill(element, request.value));
      if (result !== 'done' && result !== 'needsinput') throw new Error(String(result));
      return { status: result };
    }
    case 'selectOption': {
      requireStates(['enabled']);
      if (!Array.isArray(request.selections) || request.selections.length === 0)
        throw new Error('locator.selectOption requires at least one value');
      complete(this.selectOptions(element, request.selections));
      return { status: 'done' };
    }
    default:
      throw new Error('Unsupported browser mutation operation');
  }
}
