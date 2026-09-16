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

import { useMemo, type ReactNode } from 'react';
import { useOverlaysController } from '../controller/use-overlays-controller.js';
import type { OverlaysShellProjection } from '../model/overlays-projection.js';
import { OverlaysContext } from './overlays-context.js';

export interface OverlaysRootProps {
  /**
   * The shell frame, built once per overlays change. The frame reads the
   * overlays from the argument rather than a hook, so the shell body owns no
   * overlay state and the hook gate sees none.
   */
  readonly children: (overlays: OverlaysShellProjection) => ReactNode;
}

/** The only production owner of `useOverlaysController`. */
export function OverlaysRoot({ children }: OverlaysRootProps) {
  const overlays = useOverlaysController();
  const frame = useMemo(() => children(overlays), [children, overlays]);
  return <OverlaysContext.Provider value={overlays}>{frame}</OverlaysContext.Provider>;
}
