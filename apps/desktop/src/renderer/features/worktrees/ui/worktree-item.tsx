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

import { Button, getWorktreeCopy, useUiLocale } from '@maka/ui';
import type { WorktreeInfo } from '@maka/core/worktree';
import { ChevronRight, GitBranch } from '@maka/ui/icons';

/** Checkout summary and recovery share one row, independent of project settings. */
export function WorktreeItem(props: {
  item: WorktreeInfo;
  busy: boolean;
  removing: boolean;
  initializing?: 'retry' | 'skip';
  onRemove(): void;
  onInitialize(skip: boolean): void;
}) {
  const copy = getWorktreeCopy(useUiLocale());
  const { item } = props;
  const failed = item.initialization === 'failed';
  return (
    <div className="worktreeItem">
      <div className="worktreeItemHeader">
        <GitBranch className="worktreeItemIcon" size={16} aria-hidden="true" />
        <strong className="worktreeItemName" title={item.name}>{item.name}</strong>
        <span className="worktreeTaskCount">{item.sessionCount} {copy.tasks}</span>
        <Button label={copy.remove} isLoading={props.removing}
          variant="ghost" size="sm" isDisabled={props.busy || item.locked} onClick={props.onRemove} />
      </div>
      <div className="worktreeItemPath" title={item.path}>{item.path}</div>
      <div className="worktreeItemMetadata">
        <span>{item.branch ?? copy.detached}</span>
        {item.initialization ? <span data-state={item.initialization}>
          {copy.initialization[item.initialization]}
        </span> : null}
      </div>
      {item.log ? <details className="worktreeLog" open={failed}>
        <summary>
          <ChevronRight className="worktreeDisclosureIcon" size={14} aria-hidden="true" />
          {copy.log}
        </summary>
        <pre>{item.log}</pre>
      </details> : null}
      {failed ? <div className="worktreeActions">
        <Button label={copy.retry} variant="secondary" size="sm"
          isLoading={props.initializing === 'retry'}
          isDisabled={props.busy || item.locked} onClick={() => props.onInitialize(false)} />
        <Button label={copy.skip} variant="ghost" size="sm"
          isLoading={props.initializing === 'skip'}
          isDisabled={props.busy || item.locked} onClick={() => props.onInitialize(true)} />
      </div> : null}
    </div>
  );
}
