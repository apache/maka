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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppUpdateServices } from '../services-context.js';
import type {
  AppUpdateInstallRequest,
  AppUpdateInstallResult,
  AppUpdateStatus,
} from '../ports.js';

export interface AppUpdateController {
  readonly status: AppUpdateStatus | null;
  readonly checking: boolean;
  readonly commands: {
    checkForUpdates(): Promise<AppUpdateStatus>;
    retryUpdateDownload(): Promise<AppUpdateStatus>;
    installUpdate(input: AppUpdateInstallRequest): Promise<AppUpdateInstallResult>;
  };
}

/**
 * Owns the renderer's sole App Update subscription.
 *
 * Each command captures the observation revision before its round trip. A
 * returned snapshot is accepted only when no newer push arrived meanwhile,
 * so a slow read can never overwrite a fresher status event.
 */
export function useAppUpdateController(): AppUpdateController {
  const { appUpdate } = useAppUpdateServices();
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const observationRevisionRef = useRef(0);
  const checkInFlightRef = useRef<Promise<AppUpdateStatus> | null>(null);
  const mountedRef = useRef(false);

  const observe = useCallback((next: AppUpdateStatus) => {
    observationRevisionRef.current += 1;
    setStatus(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    const revisionBeforeRead = observationRevisionRef.current;
    const unsubscribe = appUpdate.subscribeUpdateStatus((next) => {
      if (!cancelled) observe(next);
    });
    void appUpdate
      .updateStatus()
      .then((next) => {
        if (
          !cancelled &&
          observationRevisionRef.current === revisionBeforeRead
        ) {
          observe(next);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      mountedRef.current = false;
      unsubscribe();
    };
  }, [appUpdate, observe]);

  const acceptCommandSnapshotWhenCurrent = useCallback(
    async (command: () => Promise<AppUpdateStatus>): Promise<AppUpdateStatus> => {
      const revisionBeforeCommand = observationRevisionRef.current;
      const next = await command();
      if (
        mountedRef.current &&
        observationRevisionRef.current === revisionBeforeCommand
      ) {
        observe(next);
      }
      return next;
    },
    [observe],
  );

  const checkForUpdates = useCallback(() => {
    if (checkInFlightRef.current) return checkInFlightRef.current;
    setChecking(true);
    const operation = acceptCommandSnapshotWhenCurrent(
      () => appUpdate.checkForUpdates(),
    ).finally(() => {
      if (checkInFlightRef.current === operation) {
        checkInFlightRef.current = null;
        if (mountedRef.current) setChecking(false);
      }
    });
    checkInFlightRef.current = operation;
    return operation;
  }, [acceptCommandSnapshotWhenCurrent, appUpdate]);
  const retryUpdateDownload = useCallback(
    () => acceptCommandSnapshotWhenCurrent(() => appUpdate.retryUpdateDownload()),
    [acceptCommandSnapshotWhenCurrent, appUpdate],
  );
  const installUpdate = useCallback(
    (input: AppUpdateInstallRequest) => appUpdate.installUpdate(input),
    [appUpdate],
  );

  const commands = useMemo(
    () => ({ checkForUpdates, retryUpdateDownload, installUpdate }),
    [checkForUpdates, installUpdate, retryUpdateDownload],
  );
  return useMemo(
    () => ({ status, checking, commands }),
    [checking, commands, status],
  );
}
