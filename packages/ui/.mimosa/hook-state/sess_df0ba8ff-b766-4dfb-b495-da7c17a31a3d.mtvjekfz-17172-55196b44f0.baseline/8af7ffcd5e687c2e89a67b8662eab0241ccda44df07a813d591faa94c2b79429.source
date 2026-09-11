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

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/* PR-SIMPLIFY-ROUND-D-0: the fail-soft settings surfaces each hand-rolled
   the same mounted guard (a ref set true on mount, false on unmount, read
   before every post-await setState/toast). One shared hook replaces the
   boilerplate; components that must also reset their own refs on unmount
   keep a separate cleanup effect for those.

   Starts true (not false) so reads during the first render — before
   effects run — already report "mounted"; the effect re-arms it for
   StrictMode's mount → unmount → remount double-invoke. */
export function useMountedRef(): RefObject<boolean> {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}
