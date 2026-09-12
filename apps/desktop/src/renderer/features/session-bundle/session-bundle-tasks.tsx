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
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { useMountedRef, useToast, useUiLocale } from '@maka/ui';
import type { DesktopSessionSummary } from '../../../shared/desktop-session-projection.js';
import { getExternalSessionImportCopy } from '../../locales/external-session-import-copy.js';
import { getSettingsSharedCopy } from '../../locales/settings-shared-copy.js';
import { ExportTree } from './export-tree.js';
import { useSessionBundleServices } from './services-context.js';

/**
 * Settings › Import/export tasks — moving a Session between installations.
 *
 * The catalog of other agents' conversations stays where it was; this wraps it
 * with the second half of the subject and owns everything the bundle needs, so
 * the legacy page keeps its shape and gains no state, no bridge call and no
 * component of its own.
 */
export function SessionBundleTasks(props: {
  /**
   * Whether the Settings target is the Local Host.
   *
   * A bundle names a path the native picker chose, which is a path on this
   * machine, and the protocol reads it on the Host's filesystem. Those are the
   * same filesystem only for the Local Host, so beside any other target this
   * feature has nothing coherent to offer and is not shown.
   */
  isLocalTarget: boolean;
  /** The adapter catalog, rendered when the import half is showing. */
  children: ReactNode;
  /** Local tasks for the export half. Archived ones are left out here. */
  sessions?: readonly DesktopSessionSummary[];
  /** The settings surface's own section chrome, supplied rather than imported. */
  renderSection: (input: {
    title?: string;
    description?: string;
    variant?: 'bare';
    children: ReactNode;
  }) => ReactElement;
}): ReactElement {
  const locale = useUiLocale();
  const copy = getExternalSessionImportCopy(locale);
  const [mode, setMode] = useState<'import' | 'export'>('import');
  const services = useSessionBundleServices();
  const bundle = useSessionBundleActions();
  // Local-owner Sessions only. A bundle names a path the Electron picker chose,
  // which is a path on this machine; a remote Host would read it on its own
  // filesystem. A Guest projection is not ours to carry at all -- a Guest's
  // Desktop does not even register these channels, and a remote owner is not
  // granted the operations.
  const exportable = (props.sessions ?? []).filter(
    (session) => session.profileKind === 'local' && session.shared !== true,
  );

  // Its own label, and segment names no row action shares. `来源` is what an
  // adapter is; this switch is not that. And a row's action is called 导出 too,
  // so two controls answering to one name is a person tabbing to the wrong one.
  const modeSwitch = (
    <SegmentedControl
      label={copy.modeLabel}
      value={mode}
      layout="fill"
      size="sm"
      onChange={(next) => {
        // The note reports what the other half just did. Carrying it across
        // makes it read as this half's result.
        bundle.clearNote();
        setMode(next as 'import' | 'export');
      }}
    >
      <SegmentedControlItem value="import" label={copy.modeImport} />
      <SegmentedControlItem value="export" label={copy.modeExport} />
    </SegmentedControl>
  );

  // The section chrome belongs to the settings surface, not here: a feature
  // that reached into the legacy page for it would be a feature that only
  // renders inside that page.
  // Not Local: the adapter catalog stands on its own -- but still inside the
  // provider. Whether the catalog offers the bundle source and whether this
  // feature is mounted are two decisions, and a panel that throws when they
  // disagree turns a wiring slip into a blank page. Providing it always makes
  // that disagreement impossible to crash on.
  if (!props.isLocalTarget) {
    return (
      <SessionBundleActionsContext.Provider value={bundle}>
        {props.children}
      </SessionBundleActionsContext.Provider>
    );
  }

  return (
    <>
      {props.renderSection({ variant: 'bare', children: modeSwitch })}
      {mode === 'export'
        ? props.renderSection({
            title: copy.exportTitle,
            description: copy.exportDescription,
            children: (
              <VStack gap={3}>
                {bundle.banner}
                <ExportTree
                  sessions={exportable}
                  isBusy={bundle.isBusy}
                  onExport={bundle.exportTask}
                />
              </VStack>
            ),
          })
        : (
            <SessionBundleActionsContext.Provider value={bundle}>
              {props.children}
            </SessionBundleActionsContext.Provider>
          )}
    </>
  );
}

function messageOf(error: unknown): string | undefined {
  return error instanceof Error && error.message ? error.message : undefined;
}

/** The Maka source's panel, rendered by the catalog page when it is selected. */
export function SessionBundleImportPanel(): ReactElement {
  const locale = useUiLocale();
  const copy = getExternalSessionImportCopy(locale);
  const bundle = useSessionBundleActionsContext();
  return (
    <VStack gap={3}>
      {bundle.banner}
      <p>{copy.makaImportDescription}</p>
      <HStack>
        <Button
          variant="secondary"
          size="sm"
          label={copy.makaImportAction}
          isDisabled={bundle.isBusy}
          onClick={() => void bundle.importBundle()}
        />
      </HStack>
    </VStack>
  );
}

interface SessionBundleActions {
  readonly isBusy: boolean;
  readonly banner: ReactElement | null;
  readonly clearNote: () => void;
  readonly importBundle: () => Promise<void>;
  readonly exportTask: (
    session: DesktopSessionSummary,
    subtree: readonly string[],
  ) => Promise<void>;
}

const SessionBundleActionsContext = createContext<SessionBundleActions | undefined>(undefined);

function useSessionBundleActionsContext(): SessionBundleActions {
  const actions = useContext(SessionBundleActionsContext);
  if (!actions) throw new Error('SessionBundleImportPanel must render inside SessionBundleTasks');
  return actions;
}

function useSessionBundleActions(): SessionBundleActions {
  const locale = useUiLocale();
  const services = useSessionBundleServices();
  const copy = getExternalSessionImportCopy(locale);
  const toast = useToast();
  const mountedRef = useMountedRef();
  const [isBusy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string; detail?: string }>();

  const failureText = (reason: string): string => {
    switch (reason) {
      case 'session_busy':
        return copy.bundleBusy;
      // The one failure the user can act on by simply trying again, so it says
      // that rather than falling through to "that did not work".
      case 'candidate_set_stale':
        return copy.bundleSubtreeChanged;
      case 'operation_conflict':
        return copy.bundleConflict;
      case 'source_unreadable':
        return copy.bundleUnreadable;
      default:
        return copy.bundleFailed;
    }
  };

  const settle = (
    result:
      | { ok: true; text: string }
      | { ok: false; reason: string; detail?: string },
  ): void => {
    if (!mountedRef.current) return;
    // Closing the file dialog is the user deciding not to, which is not an
    // outcome worth a banner -- and a red one says something went wrong.
    if (!result.ok && result.reason === 'canceled') return;
    setNote(
      result.ok
        ? { tone: 'ok', text: result.text }
        : {
            tone: 'error',
            text: failureText(result.reason),
            ...(result.detail ? { detail: result.detail } : {}),
          },
    );
  };

  return {
    isBusy,
    banner: note ? (
      <Banner
        status={note.tone === 'ok' ? 'success' : 'error'}
        title={note.text}
        {...(note.detail ? { description: note.detail } : {})}
      />
    ) : null,
    clearNote: () => setNote(undefined),
    importBundle: async () => {
      setBusy(true);
      setNote(undefined);
      try {
        const result = await services.importBundle();
        settle(result.ok ? { ok: true, text: copy.makaImported(result.sessionCount) } : result);
      } catch (error) {
        // Routing, a dropped Host connection and an unsupported channel all
        // reject rather than answer. Without this they are unhandled promises
        // and the page simply never says anything.
        settle({ ok: false, reason: 'failed', detail: messageOf(error) });
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    exportTask: async (session, subtree) => {
      const carried = subtree.length - 1;
      if (carried > 0) {
        // The row names one task and the file holds several. Saying so before
        // the save dialog is the last point where that is still a decision.
        const confirmed = await toast.confirm({
          title: copy.exportSubtreeConfirmTitle(carried),
          description: copy.exportSubtreeConfirmBody,
          confirmLabel: copy.exportAction,
          cancelLabel: getSettingsSharedCopy(locale).cancel,
        });
        if (!confirmed) return;
      }
      setBusy(true);
      setNote(undefined);
      try {
        const result = await services.exportBundle({
          sessionId: session.id,
          suggestedName: session.name ?? session.id,
          confirmedSubtree: subtree,
        });
        settle(result.ok ? { ok: true, text: copy.exported(result.sessionCount) } : result);
      } catch (error) {
        settle({ ok: false, reason: 'failed', detail: messageOf(error) });
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
  };
}
