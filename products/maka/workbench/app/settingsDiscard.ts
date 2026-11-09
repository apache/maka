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

import { signal } from 'nsh';

/** Holds a settings page's exit while the user decides about its unsaved changes. */
export function createSettingsDiscard(unsaved: () => boolean, discard: () => void) {
  const asking = signal(false);
  let next: (() => void) | null = null;
  const ask = (exit: (() => void) | null) => {
    next = exit;
    asking.set(true);
  };
  const clear = () => {
    next = null;
    asking.set(false);
  };
  return {
    asking,
    /** Leaving again while asking replaces the held exit; the user is still asked once. */
    leave(exit: () => void) {
      if (unsaved()) ask(exit);
      else exit();
    },
    /** Back or Escape. True when the prompt took it: it keeps editing or starts asking. */
    back() {
      if (asking()) clear();
      else if (unsaved()) ask(null);
      else return false;
      return true;
    },
    keep: clear,
    discard() {
      if (!asking()) return;
      const exit = next;
      clear();
      discard();
      exit?.();
    },
    clear,
  };
}
