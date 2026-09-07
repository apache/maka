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

import { useMemo } from 'react';
import { SearchModal } from '@maka/ui';
import { useOverlays } from './overlays-context.js';

/**
 * The Search modal, wired to the overlays: open state and the thread search
 * come from the controller, and only the navigation into a Session stays a
 * shell action. Astryx restores the opener for ordinary closes.
 *
 * `deps` keeps one identity for the life of the controller. The modal's
 * debounce effect lists `searchThread` in its dependencies, and a fresh
 * identity per render tore the timer down before it fired while a turn was
 * streaming, which made search dead exactly then.
 */
export function SearchModalHost(props: {
  readonly onNavigateToSession: (sessionId: string, turnId?: string, sequence?: number) => void;
}) {
  const { commands, selectors } = useOverlays();
  const deps = useMemo(() => ({ searchThread: commands.searchThread }), [commands]);
  return (
    <SearchModal
      isOpen={selectors.searchOpen}
      onOpenChange={(open) => {
        if (!open) commands.closeSearch();
      }}
      deps={deps}
      onNavigateToSession={props.onNavigateToSession}
    />
  );
}
