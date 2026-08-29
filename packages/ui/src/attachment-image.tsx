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

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/** Host capability for reading bytes from the Runtime Host attachment authority. */
export type ReadAttachmentBytes = (
  sessionId: string,
  artifactId: string,
) => Promise<{ ok: true; base64: string; mimeType: string } | { ok: false }>;

type SessionAttachmentContextValue = {
  sessionId: string;
  readBytes: ReadAttachmentBytes;
};

const SessionAttachmentContext = createContext<SessionAttachmentContextValue | undefined>(undefined);

/** Installs the one session-scoped attachment reader used by every transcript image. */
export function SessionAttachmentProvider(props: {
  sessionId: string;
  readBytes?: ReadAttachmentBytes;
  children: ReactNode;
}) {
  const value = useMemo(
    () => props.readBytes
      ? { sessionId: props.sessionId, readBytes: props.readBytes }
      : undefined,
    [props.readBytes, props.sessionId],
  );
  return (
    <SessionAttachmentContext.Provider value={value}>
      {props.children}
    </SessionAttachmentContext.Provider>
  );
}

/** Resolve a session attachment to an internal data URL without exposing host globals. */
export function useAttachmentImageSource(ref: {
  artifactId: string;
  sessionId?: string;
} | undefined): string | undefined {
  const context = useContext(SessionAttachmentContext);
  const artifactId = ref?.artifactId;
  const sessionId = ref?.sessionId ?? context?.sessionId;
  const readBytes = context?.readBytes;
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    setSrc(undefined);
    if (!artifactId || !sessionId || !readBytes) return;
    let cancelled = false;
    readBytes(sessionId, artifactId)
      .then((result) => {
        if (cancelled || !result.ok) return;
        setSrc(`data:${result.mimeType};base64,${result.base64}`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [artifactId, readBytes, sessionId]);

  return src;
}
