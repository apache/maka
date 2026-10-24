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
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ArtifactBinaryReadResult } from '@maka/core/artifacts';
import { mediaImageSource } from './media-image-source.js';

/** Host capability for reading bytes from the Runtime Host attachment authority. */
export type ReadAttachmentBytes = (
  sessionId: string,
  artifactId: string,
) => Promise<ArtifactBinaryReadResult>;

type SessionAttachmentContextValue = {
  sessionId: string;
  loadImage: (sessionId: string, artifactId: string, retry?: boolean) => Promise<string | undefined>;
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
      const ready = new Map<string, string>();
      let readyChars = 0;
      return {
        sessionId: props.sessionId,
        loadImage(sessionId: string, artifactId: string, retry = false) {
          const key = `${sessionId}\0${artifactId}`;
          if (retry) { const previous = ready.get(key); if (previous) readyChars -= previous.length; ready.delete(key); }
          const cached = ready.get(key);
          if (cached) { ready.delete(key); ready.set(key, cached); return Promise.resolve(cached); }
          const existing = pending.get(key);
          if (existing) return existing;
          const loaded = readBytes(sessionId, artifactId)
            .then(mediaImageSource)
            .then(source => {
              if (source) {
                ready.set(key, source); readyChars += source.length;
                while (ready.size > 32 || readyChars > 8 * 1024 * 1024) {
                  const oldest = ready.keys().next().value!;
                  readyChars -= ready.get(oldest)!.length; ready.delete(oldest);
                }
              }
              return source;
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
  return useAttachmentImage(ref).src;
}

export function useAttachmentImage(ref: {
  artifactId: string;
  sessionId?: string;
} | undefined) {
  const context = useContext(SessionAttachmentContext);
  const artifactId = ref?.artifactId;
  const sessionId = ref?.sessionId ?? context?.sessionId;
  const loadImage = context?.loadImage;
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);
  const request = useMemo(
    () => artifactId && sessionId && loadImage
      ? { artifactId, sessionId, loadImage, attempt }
      : undefined,
    [artifactId, sessionId, loadImage, attempt],
  );
  const [result, setResult] = useState<{
    request: typeof request;
    status: 'loading' | 'ready' | 'failed';
    src?: string;
  }>();

  useEffect(() => {
    if (!request) return;
    setResult({ request, status: 'loading' });
    let cancelled = false;
    request.loadImage(request.sessionId, request.artifactId, request.attempt > 0)
      .then((loaded) => {
        if (!cancelled) setResult({ request, status: loaded ? 'ready' : 'failed', src: loaded });
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  if (!request) return { status: 'unavailable' as const, src: undefined, retry };
  if (result?.request !== request) return { status: 'loading' as const, src: undefined, retry };
  return { status: result.status, src: result.src, retry };
}
