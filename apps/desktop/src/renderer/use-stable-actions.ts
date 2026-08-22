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
import { createDelegatingActions } from './stable-actions';

/**
 * Runs an app-shell action factory in the render body but returns a stable
 * identity (issue #1043).
 *
 * The factory still runs every render, so its closures always capture the
 * latest deps — identical to calling it bare. What consumers receive is a
 * once-created delegating facade whose method identities never change, and it
 * delegates only to the latest COMMITTED render's actions: publication happens
 * in useLayoutEffect, so an interrupted or discarded concurrent render never
 * leaks its closures to event handlers, timers, or subscriptions. This
 * supersedes hand-rolled `handlersRef.current = handlers` mirrors, which
 * published during render.
 *
 * `createAppShellStopAction` is deliberately NOT wrapped: it returns a bare
 * function (no object to facade) and only feeds JSX props, never effect deps.
 */
export function useStableActions<D, A extends object>(factory: (deps: D) => A, deps: D): A {
  const actions = factory(deps);
  const latestRef = useRef<A | null>(null);
  // Lazy initialization is the one render-phase ref write React permits; on
  // updates the ref is already populated and only the layout effect publishes.
  if (latestRef.current === null) latestRef.current = actions;
  useLayoutEffect(() => {
    latestRef.current = actions;
  });
  const [facade] = useState(() => createDelegatingActions(latestRef as { current: A }));
  return facade;
}
