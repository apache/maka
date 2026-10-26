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
import { decideImageReadOutcome } from './artifact-preview-registry.js';

/** Host capability for reading bytes from the Runtime Host attachment authority. */
export type ReadAttachmentBytes = (
  sessionId: string,
  artifactId: string,
) => Promise<ArtifactBinaryReadResult>;

type LoadedImage = { src?: string; limited?: boolean };
export type OpenSavedImage = (sessionId: string, artifactId: string) => Promise<{ ok: boolean }>;

type SessionAttachmentContextValue = {
  sessionId: string;
  openSavedImage?: OpenSavedImage;
  loadImage: (sessionId: string, artifactId: string, retry?: boolean) => Promise<LoadedImage>;
};

const SessionAttachmentContext = createContext<SessionAttachmentContextValue | undefined>(undefined);

/** Installs the one session-scoped attachment reader used by every transcript image. */
export function SessionAttachmentProvider(props: {
  sessionId: string;
  readBytes?: ReadAttachmentBytes;
  openSavedImage?: OpenSavedImage;
  children: ReactNode;
}) {
  const value = useMemo(
    () => {
      const readBytes = props.readBytes;
      if (!readBytes) return undefined;
      const pending = new Map<string, Promise<LoadedImage>>();
      return {
        sessionId: props.sessionId,
        openSavedImage: props.openSavedImage,
        loadImage(sessionId: string, artifactId: string, _retry = false) {
          const key = `${sessionId}\0${artifactId}`;
          const existing = pending.get(key);
          if (existing) return existing;
          const loaded = readBytes(sessionId, artifactId)
            .then((result) => {
              const outcome = decideImageReadOutcome(result);
              return outcome.kind === 'image'
                ? { src: `data:${outcome.safeMime};base64,${outcome.base64}` }
                : { limited: outcome.reason === 'oversize' };
            })
            .catch((): LoadedImage => ({}));
          pending.set(key, loaded);
          void loaded.finally(() => {
            if (pending.get(key) === loaded) pending.delete(key);
          });
          return loaded;
        },
      };
    },
    [props.readBytes, props.sessionId, props.openSavedImage],
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
    status: 'loading' | 'ready' | 'failed' | 'limited';
    src?: string;
  }>();

  useEffect(() => {
    if (!request) return;
    setResult({ request, status: 'loading' });
    let cancelled = false;
    request.loadImage(request.sessionId, request.artifactId, request.attempt > 0)
      .then((loaded) => {
        if (!cancelled) setResult({ request, status: loaded.src ? 'ready' : loaded.limited ? 'limited' : 'failed', src: loaded.src });
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  const openSaved = context?.openSavedImage && artifactId && sessionId
    ? () => context.openSavedImage!(sessionId, artifactId) : undefined;
  if (!request) return { status: 'unavailable' as const, src: undefined, retry, openSaved };
  if (result?.request !== request) return { status: 'loading' as const, src: undefined, retry, openSaved };
  return { status: result.status, src: result.src, retry, openSaved };
}
