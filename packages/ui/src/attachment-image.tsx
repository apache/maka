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
import type { ArtifactBinaryReadResult } from '@maka/core/artifacts';
import { decideImageReadOutcome } from './artifact-preview-registry.js';

/** Host capability for reading bytes from the Runtime Host attachment authority. */
export type ReadAttachmentBytes = (
  sessionId: string,
  artifactId: string,
) => Promise<ArtifactBinaryReadResult>;

type SessionAttachmentContextValue = {
  sessionId: string;
  loadImage: (sessionId: string, artifactId: string) => Promise<string | undefined>;
};

const SessionAttachmentContext = createContext<SessionAttachmentContextValue | undefined>(undefined);

/** Installs the one session-scoped attachment reader used by every transcript image. */
export function SessionAttachmentProvider(props: {
  sessionId: string;
  readBytes?: ReadAttachmentBytes;
  children: ReactNode;
}) {
  const value = useMemo(
    () => {
      const readBytes = props.readBytes;
      if (!readBytes) return undefined;
      const pending = new Map<string, Promise<string | undefined>>();
      return {
        sessionId: props.sessionId,
        loadImage(sessionId: string, artifactId: string) {
          const key = `${sessionId}\0${artifactId}`;
          const existing = pending.get(key);
          if (existing) return existing;
          const loaded = readBytes(sessionId, artifactId)
            .then((result) => {
              const outcome = decideImageReadOutcome(result);
              return outcome.kind === 'image'
                ? `data:${outcome.safeMime};base64,${outcome.base64}`
                : undefined;
            })
            .catch(() => undefined);
          pending.set(key, loaded);
          void loaded.finally(() => {
            if (pending.get(key) === loaded) pending.delete(key);
          });
          return loaded;
        },
      };
    },
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
  const loadImage = context?.loadImage;
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    setSrc(undefined);
    if (!artifactId || !sessionId || !loadImage) return;
    let cancelled = false;
    loadImage(sessionId, artifactId)
      .then((loaded) => {
        if (!cancelled) setSrc(loaded);
      })
    return () => {
      cancelled = true;
    };
  }, [artifactId, loadImage, sessionId]);

  return src;
}
