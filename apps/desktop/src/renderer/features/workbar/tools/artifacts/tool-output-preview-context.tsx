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

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { ToolResultHostProvider, type ToolOutputOpenRequest } from '@maka/ui';

const ToolOutputPreviewContext = createContext<{
  previewFor(sessionId: string): { request: ToolOutputOpenRequest; id: number } | undefined;
  open(request: ToolOutputOpenRequest): void;
  close(sessionId: string): void;
  hide(sessionId: string): void;
} | undefined>(undefined);

export const useToolOutputPreview = () => useContext(ToolOutputPreviewContext);

/** Retained tool output is a transient selection in the existing Files viewer. */
export function ToolOutputPreviewProvider(props: { children?: ReactNode }) {
  const [previews, setPreviews] = useState<ReadonlyMap<string, { request: ToolOutputOpenRequest; id: number }>>(
    () => new Map(),
  );
  const nextId = useRef(0);
  const openers = useRef(new Map<string, HTMLElement>());
  const close = useCallback((sessionId: string) => {
    setPreviews((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
    openers.current.delete(sessionId);
  }, []);
  const hide = useCallback((sessionId: string) => {
    setPreviews((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
    const opener = openers.current.get(sessionId);
    if (opener?.isConnected) opener.focus();
    openers.current.delete(sessionId);
  }, []);
  const open = useCallback((request: ToolOutputOpenRequest) => {
    if (document.activeElement instanceof HTMLElement) {
      openers.current.set(request.sessionId, document.activeElement);
    } else {
      openers.current.delete(request.sessionId);
    }
    setPreviews((current) => new Map(current).set(
      request.sessionId,
      { request, id: ++nextId.current },
    ));
  }, []);
  const previewFor = useCallback((sessionId: string) => previews.get(sessionId), [previews]);
  const value = useMemo(() => ({ previewFor, open, close, hide }), [previewFor, open, close, hide]);
  return <ToolOutputPreviewContext.Provider value={value}>
    <ToolResultHostProvider value={open}>{props.children}</ToolResultHostProvider>
  </ToolOutputPreviewContext.Provider>;
}
