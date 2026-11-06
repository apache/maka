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


/** The settings pane spends this as `scroll-padding-block-end`, so a control
 *  the keyboard reaches is scrolled clear of the sticky Save bar instead of
 *  under it (`styles/settings/provider-editor.css`). */
const CLEARANCE_PROPERTY = '--provider-models-save-bar-space';
const PANE_SELECTOR = '.settingsMainPane';

/** Ref callback for the model Save bar: publishes the bar's height to the
 *  settings pane it is stuck to.
 *
 *  The bar hangs over the bottom of the pane, and the model rows scroll in a
 *  viewport of their own: tabbing from one row's control to the next scrolls
 *  that viewport, and no amount of scrolling inside it can move a row out from
 *  under a bar stuck to the pane. With the clearance published the pane itself
 *  scrolls the focused control above the bar. The height is measured rather
 *  than tokenized because the bar wraps at narrow widths, the way the
 *  composer dock's clearance is measured in `use-focused-preview.ts`.
 *
 *  A ref callback rather than a hook: the detail view that renders the bar is
 *  recorded renderer debt whose hook and capability budgets are frozen, so the
 *  measurement belongs to this feature instead. */
export function attachModelsSaveBarClearance(bar: HTMLElement | null) {
  const pane = bar?.closest<HTMLElement>(PANE_SELECTOR);
  if (!bar || !pane) return;
  const measure = () => {
    pane.style.setProperty(CLEARANCE_PROPERTY, `${Math.ceil(bar.getBoundingClientRect().height)}px`);
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(bar);
  return () => {
    observer.disconnect();
    pane.style.removeProperty(CLEARANCE_PROPERTY);
  };
}
