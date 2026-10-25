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
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import { ChevronRight, Settings } from '@maka/ui/icons';
import {
  Banner,
  Button,
  getWorktreeCopy,
  IconButton,
  Spinner,
  TextArea,
  TextInput,
  useToast,
  useUiLocale,
} from '@maka/ui';
import type {
  WorktreeInfo,
  WorktreeMutation,
  WorktreeProject,
  WorktreeProjectConfig,
  WorktreeSnapshot,
} from '@maka/core/worktree';
import { useWorktreeServices } from '../services-context.js';
import type { WorktreeHostRef, WorktreeServices } from '../ports.js';
import {
  SettingsField,
  SettingsPage,
  SettingsSection,
} from '../../../application/contracts/settings-presentation/settings-section.js';
import {
  useRuntimeHostSettingsTarget,
  useRuntimeHostSettingsGenerationKey,
  useOptionalRuntimeHostSettingsLabel,
} from '../../../application/contracts/settings-presentation/runtime-host-settings-target.js';
import { WorktreeItem } from './worktree-item.js';

export function WorktreeSettingsPage(props: { onOpenSession?(id: string): void }) {
  const services = useWorktreeServices();
  const host = useRuntimeHostSettingsTarget();
  const generationKey = useRuntimeHostSettingsGenerationKey();
  const label = useOptionalRuntimeHostSettingsLabel();
  return (
    <SettingsPage>
      <HostWorktrees
        key={generationKey}
        host={host}
        label={label}
        services={services}
        onOpenSession={props.onOpenSession}
      />
    </SettingsPage>
  );
}

function HostWorktrees(props: {
  host: WorktreeHostRef;
  label?: string;
  services: WorktreeServices;
  onOpenSession?(id: string): void;
}) {
  const copy = getWorktreeCopy(useUiLocale());
  const toast = useToast();
  const hostRef = { profileId: props.host.profileId, hostId: props.host.hostId };
  const [snapshot, setSnapshot] = useState<WorktreeSnapshot>();
  const [root, setRoot] = useState('');
  const [error, setError] = useState<string>();
  const [operation, setOperation] = useState<WorktreeMutation>();
  const busy = !!operation;
  const shouldPoll = useRef(false);
  shouldPoll.current = busy || !!snapshot?.projects.some((project) =>
    project.worktrees.some((item) => item.initialization === 'running' || item.initialization === 'pending'));
  const sequence = useRef(0);
  const live = useRef(true);
  const actionPending = useRef(false);
  const queryPending = useRef(false);
  const savedRoot = useRef<string | undefined>(undefined);
  const acceptSnapshot = useCallback((next: WorktreeSnapshot) => {
    const previousRoot = savedRoot.current;
    savedRoot.current = next.config.rootDirectory;
    setRoot((draft) => previousRoot === undefined || draft === previousRoot ? next.config.rootDirectory : draft);
    setSnapshot({
      ...next,
      projects: next.projects.map((project) => ({
        ...project,
        worktrees: project.worktrees.filter((item) => item.managed && item.available && !item.isMain),
      })),
    });
  }, []);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await props.services.query({
        profileId: props.host.profileId,
        hostId: props.host.hostId,
      });
      if (live.current && sequence.current === request) {
        acceptSnapshot(next);
        setError(undefined);
      }
    } catch (error) {
      if (live.current && sequence.current === request) setError(String(error));
    }
  }, [props.host.profileId, props.host.hostId, props.services, acceptSnapshot]);
  useEffect(() => {
    live.current = true;
    void reload();
    // Discovery stays current during long scripts without resetting edited fields.
    const refresh = async () => {
      if (queryPending.current || !live.current) return;
      queryPending.current = true;
      const request = ++sequence.current;
      try {
        const next = await props.services.query({ profileId: props.host.profileId, hostId: props.host.hostId });
        if (live.current && request === sequence.current) acceptSnapshot(next);
      } catch { /* Explicit refresh owns error presentation. */ }
      finally { queryPending.current = false; }
    };
    const unsubscribe = props.services.subscribeChanges(() => void refresh());
    const timer = setInterval(() => { if (shouldPoll.current) void refresh(); }, 2000);
    return () => {
      clearInterval(timer);
      unsubscribe();
      live.current = false;
      sequence.current++;
    };
  }, [reload, acceptSnapshot]);
  const mutate = async (input: WorktreeMutation) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setOperation(input);
    try {
      const result = await props.services.mutate(hostRef, input);
      // Recovery belongs to the accepted operation on its original Host,
      // even when the user leaves this page before initialization finishes.
      const resumedSessionId = input.kind === 'initialize' &&
        result.kind === 'worktree' &&
        (result.worktree.initialization === 'ready' ||
          result.worktree.initialization === 'skipped')
        ? await props.services.resumeTask(hostRef, input.path)
        : undefined;
      if (!live.current) return;
      if (result.kind === 'cleanup_failed') {
        const accepted = await toast.confirm({
          title: copy.scriptFailed,
          description: result.log,
          confirmLabel: copy.deleteAnyway,
          cancelLabel: copy.keep,
          destructive: true,
        });
        if (accepted && live.current)
          await props.services.mutate(hostRef, {
            kind: 'remove',
            projectId: (input as Extract<WorktreeMutation, { kind: 'remove' }>).projectId,
            path: result.path,
            confirmation: result.confirmation,
          });
      } else if (result.kind === 'configured') toast.success(copy.saved);
      else if (input.kind === 'initialize' && input.skip) toast.success(copy.skipped);
      await reload();
      if (resumedSessionId && live.current) props.onOpenSession?.(resumedSessionId);
    } catch (error) {
      if (live.current)
        toast.error(copy.operationFailed, String(error), undefined, {
          profileId: hostRef.profileId,
        });
    } finally {
      actionPending.current = false;
      if (live.current) setOperation(undefined);
    }
  };
  return (
    <SettingsSection
      title={props.label}
      description={copy.rootHelp}
      variant="bare"
      action={
        <Button
          label={copy.refresh}
          variant="secondary"
          size="sm"
          isDisabled={busy}
          onClick={() => void reload()}
        />
      }
    >
      {error ? <Banner status="error" title={copy.error} description={error} /> : null}
      {busy ? <WorktreeActivity
        key={JSON.stringify(operation)}
        label={operation.kind === 'configure' ? copy.saving : operation.kind === 'remove' ? copy.removing : copy.initializing}
        description={copy.operationHelp}
        timed
      /> : null}
      <div className="worktreeHostRoot">
        <TextInput
          label={copy.root}
          value={root}
          onChange={setRoot}
          width="100%"
          isDisabled={busy || !snapshot}
        />
        <Button
          label={copy.save}
          variant="secondary"
          isLoading={operation?.kind === 'configure' && !operation.projectId}
          isDisabled={busy || !snapshot || root === snapshot.config.rootDirectory}
          onClick={() => void mutate({ kind: 'configure', config: { rootDirectory: root } })}
        />
      </div>
      <div className="worktreeProjects" aria-busy={!snapshot && !error}>
        {!snapshot && !error ? (
          <div role="status">
            <VisuallyHidden>{copy.loading}</VisuallyHidden>
            {[0, 1, 2].map((index) => (
              <div className="worktreeProjectPlaceholder" key={index}>
                <Skeleton width="40%" height={12} radius="rounded" index={index} />
                <Skeleton width={16} height={10} radius="rounded" index={index} />
              </div>
            ))}
          </div>
        ) : snapshot?.projects.length === 0 ? (
          <EmptyState title={copy.empty} isCompact />
        ) : (
          snapshot?.projects.map((project) => (
            <ProjectWorktrees
              key={project.id}
              project={project}
              busy={busy}
              operation={operation}
              mutate={mutate}
            />
          ))
        )}
      </div>
    </SettingsSection>
  );
}

function ProjectWorktrees(props: {
  project: WorktreeProject;
  busy: boolean;
  operation?: WorktreeMutation;
  mutate(input: WorktreeMutation): Promise<void>;
}) {
  const copy = getWorktreeCopy(useUiLocale());
  const toast = useToast();
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const configurationBody = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<WorktreeProjectConfig>(props.project.config);
  const savedConfig = useRef(props.project.config);
  const saved = JSON.stringify(props.project.config);
  useEffect(() => {
    const previous = savedConfig.current;
    const next = props.project.config;
    savedConfig.current = next;
    // Refresh untouched fields without replacing scripts being edited locally.
    // A save acknowledgement becomes the baseline for subsequent refreshes.
    setDraft((current) => ({
      ...next,
      setupScript: current.setupScript === previous.setupScript ? next.setupScript : current.setupScript,
      cleanupScript: current.cleanupScript === previous.cleanupScript ? next.cleanupScript : current.cleanupScript,
    }));
  }, [saved]);
  const set = (patch: Partial<WorktreeProjectConfig>) =>
    setDraft((value) => ({ ...value, ...patch }));
  const remove = async (item: WorktreeInfo) => {
    if (
      await toast.confirm({
        title: copy.removeTitle,
        description: `${item.path}\n${item.sessionCount} ${copy.tasks}. ${copy.removeHelp}`,
        confirmLabel: copy.remove,
        destructive: true,
      })
    )
      await props.mutate({ kind: 'remove', projectId: props.project.id, path: item.path });
  };
  return (
    <div className="worktreeProject">
      <details className="worktreeProjectDisclosure">
        <summary>
          <ChevronRight className="worktreeDisclosureIcon" size={16} aria-hidden="true" />
          <span className="worktreeProjectName" title={props.project.mainPath}>{props.project.name}</span>
          <span className="worktreeProjectCount">{props.project.worktrees.length}</span>
        </summary>
        <div className="worktreeProjectBody">
          {props.project.worktrees.length === 0 ? <EmptyState title={copy.noWorktrees} isCompact /> : null}
          <div className="worktreeList">
            {props.project.worktrees.map((item) => (
              <WorktreeItem
                key={item.path}
                item={item}
                busy={props.busy}
                removing={props.operation?.kind === 'remove' && props.operation.path === item.path}
                initializing={props.operation?.kind === 'initialize' && props.operation.path === item.path
                  ? props.operation.skip ? 'skip' : 'retry' : undefined}
                onRemove={() => void remove(item)}
                onInitialize={(skip) => void props.mutate({
                  kind: 'initialize', projectId: props.project.id, path: item.path, skip,
                })}
              />
            ))}
          </div>
        </div>
      </details>
      <IconButton
        className="worktreeProjectSettings"
        icon={<Settings size={16} />}
        label={`${props.project.name} · ${copy.projectSettings}`}
        variant="ghost"
        size="sm"
        onClick={() => setConfigurationOpen(true)}
      />
      <Dialog
        isOpen={configurationOpen}
        onOpenChange={setConfigurationOpen}
        purpose="form"
        width={560}
        maxHeight="calc(100dvh - 64px)"
      >
        <Layout
          header={<DialogHeader
            title={copy.projectSettings}
            subtitle={copy.projectSettingsHelp}
            onOpenChange={setConfigurationOpen}
          />}
          content={<LayoutContent padding={4}>
            <div className="worktreeConfigurationBody" ref={configurationBody} tabIndex={-1}>
              <section className="worktreeConfigurationGroup">
                <SettingsField>
                  <TextArea
                    label={copy.setup}
                    description={copy.setupHelp}
                    placeholder={copy.scriptPlaceholder}
                    value={draft.setupScript ?? ''}
                    onChange={(setupScript) => set({ setupScript })}
                    rows={3}
                    hasSpellCheck={false}
                    width="100%"
                    isDisabled={props.busy}
                  />
                </SettingsField>
                <SettingsField>
                  <TextArea
                    label={copy.cleanup}
                    description={copy.cleanupHelp}
                    placeholder={copy.scriptPlaceholder}
                    value={draft.cleanupScript ?? ''}
                    onChange={(cleanupScript) => set({ cleanupScript })}
                    rows={3}
                    hasSpellCheck={false}
                    width="100%"
                    isDisabled={props.busy}
                  />
                </SettingsField>
              </section>
              <div className="worktreeConfigurationActions">
                <Button
                  label={copy.save}
                  variant="secondary"
                  isLoading={props.operation?.kind === 'configure' && props.operation.projectId === props.project.id}
                  isDisabled={props.busy || JSON.stringify(draft) === saved}
                  onClick={() => {
                    // Saving disables the edited controls. Keep focus inside
                    // the dialog while their new values are being committed.
                    configurationBody.current?.focus();
                    void props.mutate({ kind: 'configure', projectId: props.project.id, config: draft });
                  }}
                />
              </div>
            </div>
          </LayoutContent>}
        />
      </Dialog>
    </div>
  );
}

function WorktreeActivity(props: { label: string; description?: string; timed?: boolean }) {
  const copy = getWorktreeCopy(useUiLocale());
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!props.timed) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [props.timed]);
  return (
    <div className="worktreeActivity" role="status">
      <Spinner size="sm" aria-hidden="true" />
      <div>
        <strong>{props.label}</strong>
        {props.description ? <p className="worktreeHelp">{props.description}</p> : null}
      </div>
      {props.timed ? <span className="worktreeElapsed" aria-hidden="true">{copy.elapsed(seconds)}</span> : null}
    </div>
  );
}
