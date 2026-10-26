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

import { useLayoutEffect, useRef, useState } from 'react';
import { useUiLocale } from './locale-context.js';
import type { WorkspacePickerModel } from './workspace-picker.js';

/** Keep the footer on one line as its actual contents and available width change. */
export function useComposerWorkspaceOverflow(picker: WorkspacePickerModel | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const locale = useUiLocale();
  const [layout, setLayout] = useState<'measure' | 'compact' | 'expanded'>('measure');

  // Labels can change while icon-only buttons have the same width. Re-measure
  // when their semantic inputs change, including translated worktree labels.
  useLayoutEffect(() => {
    setLayout('measure');
  }, [picker, locale]);

  useLayoutEffect(() => {
    if (layout !== 'measure') return;
    const footer = ref.current;
    if (!footer || typeof ResizeObserver === 'undefined') return;
    const hasWorkspace = footer.querySelector(':scope > .maka-composer-workspace');
    setLayout(hasWorkspace && footer.scrollWidth > footer.clientWidth + 1 ? 'compact' : 'expanded');
  }, [layout]);

  useLayoutEffect(() => {
    const footer = ref.current;
    if (!footer || typeof ResizeObserver === 'undefined' || layout === 'measure') return;

    // Baseline the committed layout before observing. Initial observer delivery
    // and our own icon-only render must not start another expand/collapse loop.
    const widths = () => [footer.clientWidth, footer.scrollWidth,
      ...Array.from(footer.children, (child) => child.getBoundingClientRect().width)];
    const previous = widths();
    const measure = () => {
      const next = widths();
      if (next.length !== previous.length || next.some((width, index) => width !== previous[index]))
        setLayout('measure');
    };
    const resize = new ResizeObserver(measure);
    const observeControls = () => {
      resize.disconnect();
      resize.observe(footer);
      for (const child of footer.children) resize.observe(child);
      measure();
    };
    const content = new MutationObserver(observeControls);
    content.observe(footer, { childList: true, characterData: true, subtree: true });
    observeControls();
    return () => {
      resize.disconnect();
      content.disconnect();
    };
  }, [layout]);

  return { ref, layout, compact: layout === 'compact' };
}
