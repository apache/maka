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

import { Selector } from '@astryxdesign/core/Selector';

/**
 * Picks the branch the review panel diffs against. Pure props: the panel owns
 * the selection, its persistence, and the reload.
 *
 * The trigger and every option read a real branch name — never an "auto"
 * pseudo-entry — so the panel always says what it is comparing to. The search
 * box comes from `Selector` itself; its placeholder and empty copy are already
 * localized by the Astryx catalog at the renderer root.
 */
export function SessionReviewBaseBranchPicker(props: {
  baseBranch: string | null;
  baseBranchOptions: readonly string[];
  label: string;
  onSelect: (branch: string) => void;
}) {
  return (
    // The wrapper is what lets review.css cap the panel: Selector portals its
    // listbox next to the field, not inside the trigger it styles.
    <div className="maka-session-review-base-branch">
      <Selector
        label={props.label}
        isLabelHidden
        variant="ghost"
        size="sm"
        hasSearch
        options={[...props.baseBranchOptions]}
        value={props.baseBranch ?? undefined}
        onChange={props.onSelect}
        placeholder={props.label}
        // The trigger names a branch, it is not a call to action: read like
        // the current branch it sits beside, not like a primary button.
        style={{
          color: 'var(--color-text-secondary)',
          fontWeight: 'var(--font-weight-normal)',
        }}
      />
    </div>
  );
}
