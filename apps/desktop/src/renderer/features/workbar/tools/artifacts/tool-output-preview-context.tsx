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
  preview?: { request: ToolOutputOpenRequest; id: number; visible: boolean };
  close(): void;
  hide(): void;
} | undefined>(undefined);

export const useToolOutputPreview = () => useContext(ToolOutputPreviewContext);

/** Retained tool output is a transient selection in the existing Files viewer. */
export function ToolOutputPreviewProvider(props: { children?: ReactNode }) {
  const [preview, setPreview] = useState<{ request: ToolOutputOpenRequest; id: number; visible: boolean }>();
  const opener = useRef<HTMLElement | null>(null);
  const close = useCallback(() => { setPreview(undefined); opener.current = null; }, []);
  const hide = useCallback(() => {
    setPreview(current => current ? { ...current, visible: false } : current);
    if (opener.current?.isConnected) opener.current.focus();
  }, []);
  const openOutput = useCallback((request: ToolOutputOpenRequest) => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPreview(current => ({ request, id: (current?.id ?? 0) + 1, visible: true }));
  }, []);
  const value = useMemo(() => ({ preview, close, hide }), [preview, close, hide]);
  return <ToolOutputPreviewContext.Provider value={value}>
    <ToolResultHostProvider value={openOutput}>{props.children}</ToolResultHostProvider>
  </ToolOutputPreviewContext.Provider>;
}
