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

import { useCallback, useEffect, useRef, useState } from 'react';

interface SettingIntent<Value> {
  desired: Value;
  committed?: Value;
  committedAtCatalogRevision?: number;
  committedAtSessionRevision?: number;
  inFlight: boolean;
  completion: Promise<boolean>;
  resolveCompletion(succeeded: boolean): void;
}

export interface SessionSettingIntentRevisionWriteResult {
  readonly committed: boolean;
  readonly sessionRevision: number;
}

export type SessionSettingIntentWriteResult =
  | boolean
  | SessionSettingIntentRevisionWriteResult;

interface SessionSettingIntentChannelBase<Value> {
  isEqual?(left: Value, right: Value): boolean;
  onWriteError(sessionId: string, error: unknown, attempted: Value): void;
}

export type SessionSettingIntentChannel<Value> = SessionSettingIntentChannelBase<Value> & (
  | {
      write(sessionId: string, value: Value): Promise<boolean>;
      catalogSessionRevision?: never;
    }
  | {
      write(
        sessionId: string,
        value: Value,
      ): Promise<SessionSettingIntentRevisionWriteResult>;
      catalogSessionRevision(sessionId: string): number | undefined;
    }
);

export interface SessionSettingIntentOptions<Values extends object> {
  catalogRevision: number;
  refreshCatalog(): Promise<unknown>;
  channels: {
    [Channel in keyof Values]: SessionSettingIntentChannel<Values[Channel]>;
  };
}

export type SessionSettingIntentOverlays<Values extends object> = {
  [Channel in keyof Values]: Readonly<Record<string, Values[Channel]>>;
};

export interface SessionSettingIntentController<Values extends object> {
  overlayByChannel: SessionSettingIntentOverlays<Values>;
  request<Channel extends keyof Values>(
    channel: Channel,
    sessionId: string,
    value: Values[Channel],
  ): Promise<boolean>;
  clear(sessionId: string): void;
}

type AnyIntent = SettingIntent<unknown>;

function createIntent<Value>(
  desired: Value,
  previous?: SettingIntent<Value>,
): SettingIntent<Value> {
  let resolveCompletion!: (succeeded: boolean) => void;
  const completion = new Promise<boolean>((resolve) => {
    resolveCompletion = resolve;
  });
  return {
    desired,
    ...(previous?.committed !== undefined ? { committed: previous.committed } : {}),
    ...(previous?.committedAtCatalogRevision !== undefined
      ? { committedAtCatalogRevision: previous.committedAtCatalogRevision }
      : {}),
    ...(previous?.committedAtSessionRevision !== undefined
      ? { committedAtSessionRevision: previous.committedAtSessionRevision }
      : {}),
    inFlight: true,
    completion,
    resolveCompletion,
  };
}

/**
 * Owns optimistic setting overlays across independent channels. Each
 * channel/session pair has its own latest-intent worker, so unrelated setting
 * changes can converge concurrently without overwriting one another.
 */
export function useSessionSettingIntent<Values extends object>(
  options: SessionSettingIntentOptions<Values>,
): SessionSettingIntentController<Values> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const intentsRef = useRef(new Map<keyof Values, Map<string, AnyIntent>>());
  const mountedRef = useRef(false);
  const [overlayByChannel, setOverlayByChannel] = useState<
    SessionSettingIntentOverlays<Values>
  >(() => Object.fromEntries(
    Reflect.ownKeys(options.channels).map((channel) => [channel, {}]),
  ) as SessionSettingIntentOverlays<Values>);

  const isEqual = useCallback(<Channel extends keyof Values>(
    channel: Channel,
    left: Values[Channel],
    right: Values[Channel],
  ): boolean => {
    const compare = optionsRef.current.channels[channel].isEqual;
    return compare ? compare(left, right) : Object.is(left, right);
  }, []);

  const setOverlay = useCallback(<Channel extends keyof Values>(
    channel: Channel,
    sessionId: string,
    value: Values[Channel] | undefined,
  ): void => {
    setOverlayByChannel((current) => {
      const channelOverlay = current[channel] as Readonly<Record<string, Values[Channel]>>;
      if (value !== undefined) {
        if (sessionId in channelOverlay && isEqual(channel, channelOverlay[sessionId]!, value)) {
          return current;
        }
        return { ...current, [channel]: { ...channelOverlay, [sessionId]: value } };
      }
      if (!(sessionId in channelOverlay)) return current;
      const next = { ...channelOverlay };
      delete next[sessionId];
      return { ...current, [channel]: next };
    });
  }, [isEqual]);

  const reconcile = useCallback(<Channel extends keyof Values>(
    channel: Channel,
    sessionId: string,
  ): void => {
    const channelIntents = intentsRef.current.get(channel);
    const intent = channelIntents?.get(sessionId);
    if (!intent || intent.inFlight || intent.committedAtCatalogRevision === undefined) return;
    if (intent.committedAtSessionRevision !== undefined) {
      const observedRevision = optionsRef.current.channels[channel].catalogSessionRevision?.(
        sessionId,
      );
      if (
        observedRevision === undefined ||
        observedRevision < intent.committedAtSessionRevision
      ) {
        return;
      }
    } else if (optionsRef.current.catalogRevision <= intent.committedAtCatalogRevision) {
      return;
    }
    channelIntents?.delete(sessionId);
    setOverlay(channel, sessionId, undefined);
  }, [setOverlay]);

  useEffect(() => {
    for (const [channel, intents] of intentsRef.current) {
      for (const sessionId of intents.keys()) reconcile(channel, sessionId);
    }
  }, [options.catalogRevision, reconcile]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const channels = intentsRef.current;
      intentsRef.current = new Map();
      for (const intents of channels.values()) {
        for (const intent of intents.values()) intent.resolveCompletion(false);
      }
    };
  }, []);

  const request = useCallback(<Channel extends keyof Values>(
    channel: Channel,
    sessionId: string,
    value: Values[Channel],
  ): Promise<boolean> => {
    if (!mountedRef.current) return Promise.resolve(false);
    let channelIntents = intentsRef.current.get(channel);
    if (!channelIntents) {
      channelIntents = new Map();
      intentsRef.current.set(channel, channelIntents);
    }
    const typedIntents = channelIntents as Map<string, SettingIntent<Values[Channel]>>;
    const existing = typedIntents.get(sessionId);
    if (existing) {
      if (!existing.inFlight && existing.committed !== undefined &&
          isEqual(channel, existing.committed, value)) {
        return Promise.resolve(true);
      }
      existing.desired = value;
      setOverlay(channel, sessionId, value);
      if (existing.inFlight) return existing.completion;
    }

    const intent = createIntent(value, existing);
    typedIntents.set(sessionId, intent);
    setOverlay(channel, sessionId, value);

    void (async () => {
      let terminalSucceeded = false;
      while (mountedRef.current && typedIntents.get(sessionId) === intent) {
        const attempted = intent.desired;
        let committed = false;
        let committedSessionRevision: number | undefined;
        let writeError: unknown;
        try {
          const result = await optionsRef.current.channels[channel].write(sessionId, attempted);
          if (typeof result === 'boolean') {
            committed = result;
          } else {
            committed = result.committed;
            committedSessionRevision = result.sessionRevision;
          }
        } catch (error) {
          writeError = error;
        }

        if (!mountedRef.current || typedIntents.get(sessionId) !== intent) return;
        if (committed) {
          intent.committed = attempted;
          intent.committedAtCatalogRevision = optionsRef.current.catalogRevision;
          intent.committedAtSessionRevision = committedSessionRevision;
          if (isEqual(channel, intent.desired, attempted)) {
            setOverlay(channel, sessionId, attempted);
          }
          try {
            void optionsRef.current.refreshCatalog().catch(() => {});
          } catch {}
          if (isEqual(channel, intent.desired, attempted)) {
            terminalSucceeded = true;
            break;
          }
          continue;
        }
        if (isEqual(channel, intent.desired, attempted)) {
          try {
            optionsRef.current.channels[channel].onWriteError(
              sessionId,
              writeError,
              intent.desired,
            );
          } catch {}
          if (!mountedRef.current || typedIntents.get(sessionId) !== intent) return;
          if (!isEqual(channel, intent.desired, attempted)) continue;
          setOverlay(channel, sessionId, intent.committed);
          break;
        }
      }

      if (mountedRef.current && typedIntents.get(sessionId) === intent) {
        intent.inFlight = false;
        if (intent.committedAtCatalogRevision === undefined) {
          typedIntents.delete(sessionId);
          setOverlay(channel, sessionId, undefined);
        } else {
          reconcile(channel, sessionId);
        }
        intent.resolveCompletion(terminalSucceeded);
      }
    })();

    return intent.completion;
  }, [isEqual, reconcile, setOverlay]);

  const clear = useCallback((sessionId: string): void => {
    for (const [channel, intents] of intentsRef.current) {
      const intent = intents.get(sessionId);
      intents.delete(sessionId);
      intent?.resolveCompletion(false);
      setOverlay(channel, sessionId, undefined);
    }
  }, [setOverlay]);

  return { overlayByChannel, request, clear };
}
