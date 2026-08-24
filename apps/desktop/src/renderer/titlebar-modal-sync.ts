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

// apps/desktop/src/renderer/titlebar-modal-sync.ts
//
// Keeps the OS-drawn window controls in visual sync with modal dialogs.
//
// A modal `<dialog>`'s ::backdrop dims the whole page, but the native window
// controls — the Windows titleBarOverlay box in the top-right corner, the
// macOS traffic lights — are composited above web content and stay bright,
// reading as an undimmed white patch floating over the scrim. React state
// used to track the four shell-owned modals by name (help, palette, search,
// external import), so every dialog mounted deeper in the tree — the
// scheduled-task form, session rename, bot onboarding, the narrow inspector
// sheet — dimmed the page but never the strip.
//
// This observer replaces that hand-maintained list with the platform truth:
// `dialog:modal` matches exactly the elements that paint a ::backdrop,
// whoever rendered them. While at least one exists, theme.ts folds the scrim
// color into the Windows overlay color and macOS hides its traffic lights;
// when the last one closes, the strip restores.

import { setTitlebarModalDimmed } from './theme';

function subtreeTouchesDialog(nodes: NodeList): boolean {
  for (const node of nodes) {
    if (
      node instanceof HTMLElement &&
      (node.tagName === 'DIALOG' || node.querySelector('dialog') !== null)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Starts watching for top-layer modals. Returns a disposer that disconnects
 * and restores the undimmed strip — the cleanup path the old effect took on
 * unmount.
 */
export function startTitlebarModalSync(): () => void {
  const sync = (): void => {
    setTitlebarModalDimmed(document.querySelector('dialog:modal') !== null);
  };
  // Attribute mutations fire for <details open> too; only <dialog> can enter
  // the modal state, so filter before touching the DOM further.
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        if ((mutation.target as HTMLElement).tagName === 'DIALOG') sync();
        continue;
      }
      if (
        subtreeTouchesDialog(mutation.addedNodes) ||
        subtreeTouchesDialog(mutation.removedNodes)
      ) {
        sync();
      }
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open'],
  });
  sync();
  return () => {
    observer.disconnect();
    setTitlebarModalDimmed(false);
  };
}
