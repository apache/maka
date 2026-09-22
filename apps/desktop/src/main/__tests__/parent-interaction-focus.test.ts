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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseHTML } from 'linkedom';
import { focusParentConversation } from '../../renderer/features/workbar/model/parent-interaction-focus.js';

/**
 * The action resolves its workspace from the element the user acted on, so the
 * fixture is the real markup shape: a marked frame, a marked parent region
 * inside it, and the Workbar column as a sibling of that region.
 */
function frame(id: string, hidden = false): string {
  return `
    <div data-maka-interaction-container ${hidden ? 'hidden' : ''} id="frame-${id}">
      <div class="mainColumn" data-maka-parent-interaction>
        <div class="maka-composer-interaction-slot">
          <button hidden id="${id}-hidden">隐藏</button>
          <button disabled id="${id}-disabled">拒绝</button>
          <button id="${id}-allow">本任务允许</button>
        </div>
        <div class="maka-composer"><div contenteditable="true" id="${id}-composer"></div></div>
      </div>
      <div class="maka-session-workbar">
        <div class="maka-quote-companion">
          <button id="${id}-open">前往主对话</button>
          <div class="maka-composer"><div contenteditable="true" id="${id}-side-composer"></div></div>
        </div>
      </div>
    </div>`;
}

/**
 * linkedom is neither a style engine nor a layout engine, so this fixture states
 * the two facts production reads from those engines: every element reports one
 * client rect, and the inline `style` attribute is resolved the way a browser
 * resolves `visibility` (inherited) and `display` (not inherited).
 *
 * That makes this a unit test of the selection rules only. Whether a real
 * Chromium computes those styles, and where focus lands after a real click, is
 * asserted by the browser story play.
 */
function setup(html: string) {
  const parsed = parseHTML(`<body>${html}</body>`);
  const document = parsed.document as unknown as Document;
  const focusTargets = parsed.window.HTMLElement.prototype as unknown as {
    focus(this: { id: string }): void;
  };
  const focused: string[] = [];
  for (const element of document.querySelectorAll('*')) {
    Object.defineProperty(element, 'getClientRects', {
      configurable: true,
      value: () => [{ width: 10, height: 10 }],
    });
  }
  const declared = (element: Element, property: string) =>
    new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([a-z-]+)`).exec(
      element.getAttribute('style') ?? '',
    )?.[1];
  (parsed.window as unknown as { getComputedStyle: (element: Element) => unknown }).getComputedStyle =
    (element: Element) => {
      let visibility = 'visible';
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const own = declared(ancestor, 'visibility');
        if (own) {
          visibility = own;
          break;
        }
      }
      return { display: declared(element, 'display') ?? 'block', visibility };
    };
  focusTargets.focus = function focus(this: { id: string }) {
    focused.push(this.id);
  };
  const element = (id: string) => {
    const found = document.querySelector<HTMLElement>(`#${id}`);
    assert.ok(found, `fixture element ${id} is missing`);
    return found;
  };
  return { document, element, focused };
}

/** The parent region of one frame, with whatever the case needs inside its interaction slot. */
function frameWithSlot(id: string, slot: string): string {
  return `
    <div data-maka-interaction-container id="frame-${id}">
      <div data-maka-parent-interaction>
        <div class="maka-composer-interaction-slot">${slot}</div>
        <div class="maka-composer"><div contenteditable="true" id="${id}-composer"></div></div>
      </div>
      <div class="maka-session-workbar">
        <div class="maka-quote-companion">
          <button id="${id}-open">前往主对话</button>
          <div class="maka-composer"><div contenteditable="true" id="${id}-side-composer"></div></div>
        </div>
      </div>
    </div>`;
}

describe('focusParentConversation', () => {
  it('focuses the originating workspace parent control and never the side chat', () => {
    const { element, focused } = setup(frame('a'));
    focusParentConversation(element('a-open'));
    assert.deepEqual(focused, ['a-allow']);
  });

  it('prefers the parent composer when the interaction slot has no usable control', () => {
    const { element, focused } = setup(`
      <div data-maka-interaction-container id="frame-a">
        <div class="mainColumn" data-maka-parent-interaction>
          <div class="maka-composer-interaction-slot">
            <button disabled id="a-disabled">拒绝</button>
          </div>
          <div class="maka-composer"><div contenteditable="true" id="a-composer"></div></div>
        </div>
        <div class="maka-session-workbar">
          <div class="maka-quote-companion">
            <button id="a-open">前往主对话</button>
            <div class="maka-composer"><div contenteditable="true" id="a-side-composer"></div></div>
          </div>
        </div>
      </div>`);
    focusParentConversation(element('a-open'));
    assert.deepEqual(focused, ['a-composer']);
  });

  it('never crosses into an adjacent workspace, even for the same action', () => {
    const { element, focused } = setup(`${frame('a')}${frame('b')}`);
    focusParentConversation(element('b-open'));
    assert.deepEqual(focused, ['b-allow']);
  });

  it('focuses nothing when the originating workspace is hidden', () => {
    const { element, focused } = setup(frame('a', true));
    focusParentConversation(element('a-open'));
    assert.deepEqual(focused, []);
  });

  it('focuses nothing for an origin outside any marked workspace', () => {
    const { document, focused } = setup(frame('a'));
    const detached = document.createElement('button');
    focusParentConversation(detached);
    focusParentConversation();
    assert.deepEqual(focused, []);
  });

  it('skips a control a disabled fieldset disables', () => {
    const { element, focused } = setup(
      frameWithSlot(
        'a',
        `<fieldset disabled>
           <legend>审批</legend>
           <button id="a-blocked">拒绝</button>
         </fieldset>
         <button id="a-allow">允许</button>`,
      ),
    );
    focusParentConversation(element('a-open'));
    assert.deepEqual(focused, ['a-allow']);
  });

  it('keeps a control the disabled fieldset exempts through its first legend', () => {
    const { element, focused } = setup(
      frameWithSlot(
        'a',
        `<fieldset disabled>
           <legend><button id="a-exempt">本任务允许</button></legend>
           <button id="a-blocked">拒绝</button>
         </fieldset>`,
      ),
    );
    focusParentConversation(element('a-open'));
    assert.deepEqual(focused, ['a-exempt']);
  });

  it('skips a control whose only eligible sibling sits under an inert ancestor', () => {
    const { element, focused } = setup(
      frameWithSlot(
        'a',
        `<div inert><button id="a-inert">本任务允许</button>
           <div><input id="a-inert-input" /></div>
         </div>
         <button id="a-allow">允许</button>`,
      ),
    );
    focusParentConversation(element('a-open'));
    assert.deepEqual(focused, ['a-allow']);
  });

  it('falls back to a composer outside the inert subtree', () => {
    const { element, focused } = setup(
      frameWithSlot('b', `<div inert><button id="b-inert">本任务允许</button></div>`),
    );
    focusParentConversation(element('b-open'));
    assert.deepEqual(focused, ['b-composer']);
  });

  it('skips computed-invisible targets before the composer fallback', () => {
    const { element, focused } = setup(
      frameWithSlot(
        'a',
        `<div style="display: none"><button id="a-display">本任务允许</button></div>
         <div style="visibility: hidden"><button id="a-visibility">拒绝</button></div>
         <div style="visibility: collapse"><button id="a-collapse">拒绝</button></div>
         <button id="a-allow">允许</button>`,
      ),
    );
    focusParentConversation(element('a-open'));
    assert.deepEqual(focused, ['a-allow']);
  });

  it('skips a composer that is computed-invisible in the parent region', () => {
    const { element, focused } = setup(`
      <div data-maka-interaction-container id="frame-a">
        <div data-maka-parent-interaction>
          <div class="maka-composer-interaction-slot"></div>
          <div class="maka-composer" style="visibility: hidden">
            <div contenteditable="true" id="a-composer"></div>
          </div>
        </div>
        <div class="maka-session-workbar">
          <div class="maka-quote-companion"><button id="a-open">前往主对话</button></div>
        </div>
      </div>`);
    focusParentConversation(element('a-open'));
    assert.deepEqual(focused, []);
  });
});
