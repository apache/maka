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

import { useEffect, useReducer, useRef } from "react";
import {
  createProxyPasswordDraft,
  type ProxyPasswordDraft,
} from "../model/proxy-password-draft.js";

export function useProxyPasswordDraft(
  save: (secret: string) => Promise<void>,
): ProxyPasswordDraft {
  const saveRef = useRef(save);
  saveRef.current = save;
  const draftRef = useRef<ProxyPasswordDraft | null>(null);
  draftRef.current ??= createProxyPasswordDraft((secret) =>
    saveRef.current(secret),
  );
  const draft = draftRef.current;
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  useEffect(() => draft.subscribe(rerender), [draft]);
  return draft;
}
