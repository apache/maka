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

import { useEffect, useRef, useState } from 'react';
import { createDelayedFlag, type DelayedFlag } from './model-wait-state.js';

/**
 * React binding for `createDelayedFlag` (#646): a boolean that turns true only
 * after `condition` has held true for `delayMs`, and false immediately when it
 * drops. The timing/arm/cancel logic lives in the pure `createDelayedFlag` (unit
 * tested with fake timers); this hook only wires it to `window` timers + a
 * re-render. `delayMs` is read once at mount — it is a constant in practice.
 */
export function useDelayedFlag(condition: boolean, delayMs: number): boolean {
  const [visible, setVisible] = useState(false);
  const flagRef = useRef<DelayedFlag | null>(null);
  if (flagRef.current === null) {
    flagRef.current = createDelayedFlag({
      delayMs,
      scheduler: {
        setTimeout: (handler, ms) => window.setTimeout(handler, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
      },
      onChange: setVisible,
    });
  }
  useEffect(() => {
    flagRef.current?.setCondition(condition);
  }, [condition]);
  useEffect(() => () => flagRef.current?.dispose(), []);
  return visible;
}
