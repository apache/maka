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

import { useCallback, useRef } from 'react';

export function useHistorySettingsFocus() {
  const openerRef = useRef<HTMLElement | null>(null);
  const capture = useCallback(() => {
    const active = document.activeElement;
    openerRef.current =
      active instanceof HTMLElement && active.closest('.computer-history-page') ? active : null;
  }, []);
  const restore = useCallback(() => {
    const opener = openerRef.current;
    openerRef.current = null;
    if (!opener) return;
    // Settings must release inert before focus returns to the mounted reader.
    requestAnimationFrame(() => {
      if (opener.isConnected && !opener.closest('[inert]')) {
        opener.focus({ preventScroll: true });
      }
    });
  }, []);
  return { capture, restore };
}
