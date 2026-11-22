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

import { cleanup, effect, signal } from 'nsh';

/**
 * Follows `active`, but turns on only after it has stayed on for `ms`, so an
 * action that settles quickly does not flash its in-progress state. Turns off
 * at once.
 */
export function delayed(active: () => boolean, ms = 300) {
  const shown = signal(false);
  effect(() => {
    if (!active()) {
      shown.set(false);
      return;
    }
    const timer = setTimeout(() => shown.set(true), ms);
    cleanup(() => clearTimeout(timer));
  });
  return shown;
}
