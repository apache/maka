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

import type { DirectoryReference } from '@maka/core/events';
import { Token, Tooltip } from '@astryxdesign/core';
import { FolderOpen, ICON_SIZE } from './icons.js';

/** The same reference chip before and after send; a path is not a saved attachment. */
export function DirectoryReferenceChip(props: {
  reference: DirectoryReference;
  onRemove?(): void;
}) {
  const path = props.reference.path;
  const label = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  return (
    <Tooltip content={path} focusTrigger="always">
      <Token
        size="sm"
        className="maka-composer-attachment-token"
        icon={<FolderOpen size={ICON_SIZE.meta} aria-hidden="true" />}
        label={label}
        onRemove={props.onRemove}
      />
    </Tooltip>
  );
}
