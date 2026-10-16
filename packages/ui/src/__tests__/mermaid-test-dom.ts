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

import { act } from 'react';
import { parseHTML } from 'linkedom';

const GLOBAL_KEYS = [
  'CSS',
  'CSSStyleSheet',
  'DOMParser',
  'Element',
  'HTMLElement',
  'IS_REACT_ACT_ENVIRONMENT',
  'MutationObserver',
  'Node',
  'ResizeObserver',
  'SVGElement',
  'XMLSerializer',
  'cancelAnimationFrame',
  'document',
  'getComputedStyle',
  'navigator',
  'requestAnimationFrame',
  'scrollTo',
  'window',
] as const;

export function installDom() {
  const originals = new Map<PropertyKey, PropertyDescriptor | undefined>(
    GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new URL('http://localhost/'),
  });

  class InertResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  class TestXmlSerializer {
    serializeToString(node: Node): string {
      return String(node);
    }
  }
  Object.defineProperties(window.SVGElement.prototype, {
    getBBox: {
      configurable: true,
      value() {
        return { x: 0, y: 0, width: Math.max(1, (this.textContent ?? '').length * 8), height: 16 };
      },
    },
    getComputedTextLength: {
      configurable: true,
      value() {
        return Math.max(1, (this.textContent ?? '').length * 8);
      },
    },
  });
  const CSSStyleSheet = document.createElement('style').sheet!.constructor;
  const globals = {
    CSS: { escape: String, supports: () => false },
    CSSStyleSheet,
    DOMParser: window.DOMParser,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: window.MutationObserver,
    Node: window.Node,
    ResizeObserver: InertResizeObserver,
    SVGElement: window.SVGElement,
    XMLSerializer: TestXmlSerializer,
    cancelAnimationFrame: () => {},
    document,
    getComputedStyle: () => ({
      paddingBottom: '0',
      paddingLeft: '0',
      paddingRight: '0',
      paddingTop: '0',
    }),
    navigator: window.navigator ?? { userAgent: 'node' },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    },
    scrollTo: () => {},
    window,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  Object.assign(window, {
    CSS: globals.CSS,
    CSSStyleSheet,
    cancelAnimationFrame: globals.cancelAnimationFrame,
    getComputedStyle: globals.getComputedStyle,
    innerHeight: 800,
    requestAnimationFrame: globals.requestAnimationFrame,
    scrollTo: globals.scrollTo,
  });

  return {
    document,
    restore() {
      for (const key of GLOBAL_KEYS) {
        const descriptor = originals.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

export async function settleEffects(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => Promise.resolve());
  }
}
