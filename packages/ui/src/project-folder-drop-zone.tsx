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

import { useState, type DragEvent, type ReactNode } from 'react';
import { getConversationCopy } from './conversation-copy.js';
import { useUiLocale } from './locale-context.js';
import { useSessionRailData } from './session-rail-context.js';

export function ProjectFolderDropZone({ children }: { children: ReactNode }) {
  const rail = useSessionRailData();
  const copy = getConversationCopy(useUiLocale()).sessions;
  const enabled = rail.groupVariant === 'project' && rail.onDropProjectFolders !== undefined;
  const [dragging, setDragging] = useState(false);
  const active = enabled && dragging;

  function captureFileDrag(event: DragEvent<HTMLDivElement>) {
    const types = Array.from(event.dataTransfer.types);
    if (!enabled || types.includes('application/x-maka-session')) return false;
    // Keep the window drop guard's non-file blocking inside this file target.
    event.preventDefault();
    event.stopPropagation();
    return types.includes('Files');
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!captureFileDrag(event)) return;
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  }

  return (
    <div
      className="maka-project-folder-drop-zone"
      data-maka-file-drop-target={enabled ? 'true' : undefined}
      data-folder-drop-active={active ? 'true' : undefined}
      onDragEnterCapture={handleDragOver}
      onDragOverCapture={handleDragOver}
      onDragLeave={(event) => {
        if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) {
          setDragging(false);
        }
      }}
      onDropCapture={(event) => {
        if (!captureFileDrag(event)) return;
        setDragging(false);
        void rail.onDropProjectFolders?.(Array.from(event.dataTransfer.files));
      }}
    >
      {children}
      {active && (
        <div className="maka-project-folder-drop-hint" role="status">{copy.dropProjectFolders}</div>
      )}
    </div>
  );
}
