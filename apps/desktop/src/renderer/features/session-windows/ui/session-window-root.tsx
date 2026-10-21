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

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useToast, useUiLocale } from '@maka/ui';
import type { SessionSummary } from '@maka/core/session';
import type { SettingsSection } from '@maka/core/settings';
import type { SessionWindowContext, SessionWindowNavigation, SessionWindowOwnership } from '../ports.js';
import { useSessionWindowServices } from '../services-context.js';
import { bootstrapSessionWindow, createSessionWindowNavigator } from '../controller/session-window-navigation.js';
import { sessionWindowCopy } from '../copy.js';

interface MainWindowActions {
  openHelp(): void;
  openSettings(): void;
  openSettingsSection(section?: SettingsSection): void;
  openExternalAgentSettings(): void;
}

export interface SessionWindowProjection {
  readonly frameProps: { 'data-window-kind': SessionWindowContext['kind']; inert: boolean | undefined };
  readonly titlebarProps: { standalone: boolean; returningToMain: boolean; onOpenInMainWindow(): void };
  readonly standalone: boolean;
  setFrozen(frozen: boolean): void;
  bootstrap(refresh: () => Promise<SessionSummary[]>, revision: () => number, open: (id: string) => void): Promise<void>;
  openSession(navigation: SessionWindowNavigation, activate: () => void): boolean;
  openInNewWindow(sessionId: string): Promise<void>;
  mainActions(local: MainWindowActions): MainWindowActions;
  requestNewTask(local: () => void): void;
}

/** Resolves the sender's role before any conversation or navigation controller mounts. */
export function SessionWindowRoot(props: { children(window: SessionWindowProjection): ReactNode }) {
  const services = useSessionWindowServices();
  const locale = useUiLocale();
  const toast = useToast();
  const ownership = useRef<SessionWindowOwnership>({ version: -1, sessionIds: [] });
  const owned = useRef(new Set<string>());
  const blocked = useRef(false);
  const [context, setContext] = useState<SessionWindowContext>();
  const [failure, setFailure] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [returning, setReturning] = useState(false);
  const copy = sessionWindowCopy(locale);
  useEffect(() => {
    let disposed = false;
    const update = (next: SessionWindowOwnership) => {
      if (disposed || next.version < ownership.current.version) return;
      ownership.current = next;
      owned.current = new Set(next.sessionIds);
    };
    const unsubscribe = services.subscribeSessionWindowOwnership(update);
    void Promise.all([services.context(), services.ownership()]).then(
      ([next, snapshot]) => { if (!disposed) { update(snapshot); setContext(next); } },
      () => { if (!disposed) setFailure(true); },
    );
    return () => { disposed = true; unsubscribe(); };
  }, [services]);
  const commands = useMemo(() => {
    const report = (error: unknown) => toast.error(copy.failed, error instanceof Error ? error.message : String(error));
    return {
      setFrozen(value: boolean) {
        blocked.current = value;
        setFrozen(value);
      },
      bootstrap(refresh: () => Promise<SessionSummary[]>, revision: () => number, open: (id: string) => void) {
        return bootstrapSessionWindow({ kind: context?.kind, refresh, revision, open });
      },
      openSession: createSessionWindowNavigator({
        owns: (id) => owned.current.has(id),
        blocked: () => blocked.current,
        route: (navigation) => { void services.routeSession(navigation).catch(report); },
      }),
      async openInNewWindow(sessionId: string) {
        try { await services.openSessionWindow(sessionId); } catch (error) { report(error); }
      },
      openInMainWindow() {
        setReturning(true);
        void services.openInMainWindow().catch(report).finally(() => setReturning(false));
      },
      mainActions(local: MainWindowActions): MainWindowActions {
        if (context?.kind !== 'session') return local;
        const openSettings = () => { void services.commandMain('openSettings').catch(report); };
        return { openHelp: () => { void services.commandMain('openHelp').catch(report); },
          openSettings, openSettingsSection: openSettings, openExternalAgentSettings: openSettings };
      },
      requestNewTask(local: () => void) {
        if (context?.kind === 'session') void services.commandMain('newTask').catch(report);
        else local();
      },
    };
  }, [services, toast, copy.failed, context?.kind]);
  if (failure) return <div role="alert">{copy.failed}</div>;
  if (!context) return null;
  const standalone = context.kind === 'session';
  return props.children({
    standalone,
    frameProps: { 'data-window-kind': context.kind, inert: frozen || undefined },
    titlebarProps: { standalone, returningToMain: returning, onOpenInMainWindow: commands.openInMainWindow },
    ...commands,
  });
}
