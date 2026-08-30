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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { Switch } from '@astryxdesign/core/Switch';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import {
  Badge,
  Banner,
  Button,
  IconButton,
  MoreMenu,
  Selector,
  Spinner,
  TextInput,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { HelpCircle, ICON_SIZE } from '@maka/ui/icons';
import { uiLocaleToIntlLocale, type UiLocale } from '@maka/core/ui-locale';
import type {
  DesktopRuntimeHostManagementAction,
  DesktopRuntimeHostDirectPeerSnapshot,
  DesktopRuntimeHostManagementResult,
  DesktopRuntimeHostManagementProgress,
  DesktopRuntimeHostAccessCredential,
  DesktopRuntimeHostAccessSnapshot,
  DesktopRuntimeHostUpdatePolicySnapshot,
  DesktopRuntimeHostUpdateReconciliationOutcome,
  DesktopRuntimeHostUpdateReconciliationResponse,
} from '../../preload/bridge-contract.js';
import { getSettingsProjectsCopy } from '../locales/settings-projects-copy.js';
import {
  canonicalProjectDirectoryRoots,
  projectDirectoryRootsValid,
} from '../../shared/runtime-host-project-directory-policy.js';
import { settingsActionErrorMessage } from './settings-error-copy.js';
import {
  RuntimeHostProjectDirectoryEditor,
  type ProjectDirectoryRootDraft,
} from './runtime-host-project-directory-editor.js';

type RuntimeHostManagementConfirmation =
  | { readonly kind: 'uninstall'; readonly allowInterruptActiveTasks: boolean }
  | { readonly kind: 'restart' }
  | { readonly kind: 'update' }
  | { readonly kind: 'configureDirectories' }
  | { readonly kind: 'rotate' }
  | {
      readonly kind: 'revoke';
      readonly credential: DesktopRuntimeHostAccessCredential;
    };

type UpdatePolicyChoice = 'manual' | 'fixed' | 'latest' | 'next';
type DirectoryPolicySnapshot = {
  readonly roots: readonly { readonly label: string; readonly path: string }[];
  readonly configurationFingerprint: string;
};
type DirectoryPolicyEdit = {
  readonly baseline: DirectoryPolicySnapshot;
  readonly draft: readonly ProjectDirectoryRootDraft[];
  readonly conflict?: DirectoryPolicySnapshot;
};
export interface RuntimeHostManagementTarget {
  readonly id: string;
  readonly name: string;
  readonly subtitle?: string;
  readonly directPeerManagement: boolean;
}

export function RuntimeHostManagementDialog(props: {
  readonly target: RuntimeHostManagementTarget | undefined;
  readonly onClose: () => void;
}) {
  const locale = useUiLocale();
  const copy = getSettingsProjectsCopy(locale).runtimeHost;
  const toast = useToast();
  const [result, setResult] = useState<DesktopRuntimeHostManagementResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [reconnectWarning, setReconnectWarning] = useState<string>();
  const [uninstalledRoot, setUninstalledRoot] = useState<string>();
  const [access, setAccess] = useState<DesktopRuntimeHostAccessSnapshot>();
  const [confirmation, setConfirmation] = useState<RuntimeHostManagementConfirmation>();
  const [updatePhase, setUpdatePhase] = useState<DesktopRuntimeHostManagementProgress['phase']>();
  const [updatePolicy, setUpdatePolicy] = useState<DesktopRuntimeHostUpdatePolicySnapshot>();
  const [updatePolicyChoice, setUpdatePolicyChoice] = useState<UpdatePolicyChoice>('manual');
  const [fixedVersion, setFixedVersion] = useState('');
  const [updatePolicyError, setUpdatePolicyError] = useState<string>();
  const [lastUpdateOutcome, setLastUpdateOutcome] =
    useState<DesktopRuntimeHostUpdateReconciliationOutcome>();
  const [directoryPolicyEdit, setDirectoryPolicyEdit] = useState<DirectoryPolicyEdit>();
  const [directPeer, setDirectPeer] = useState<DesktopRuntimeHostDirectPeerSnapshot>();
  const [directPeerError, setDirectPeerError] = useState<string>();
  const [coordinationRelays, setCoordinationRelays] = useState('');
  const [automaticRelayDiscovery, setAutomaticRelayDiscovery] = useState(true);
  const nextDirectoryRootId = useRef(1);
  const logsRef = useRef<HTMLPreElement>(null);

  const target = props.target;
  useEffect(() => {
    if (!target) return;
    let disposed = false;
    setResult(undefined);
    setError(undefined);
    setReconnectWarning(undefined);
    setUninstalledRoot(undefined);
    setAccess(undefined);
    setConfirmation(undefined);
    setUpdatePhase(undefined);
    setUpdatePolicy(undefined);
    setUpdatePolicyChoice('manual');
    setFixedVersion('');
    setUpdatePolicyError(undefined);
    setLastUpdateOutcome(undefined);
    setDirectoryPolicyEdit(undefined);
    setDirectPeer(undefined);
    setDirectPeerError(undefined);
    setCoordinationRelays('');
    setLoading(true);
    void (async () => {
      let shouldLoadUpdatePolicy = false;
      try {
        const response = await window.maka.runtimeHostManagement.run(target.id, 'status');
        if (disposed) return;
        if (response.kind === 'result') {
          setResult(response);
          reconcileDirectoryPolicy(response.service);
          shouldLoadUpdatePolicy = response.service.state !== 'not_installed';
        }
        else if (response.kind === 'error') setError(response.error.message);
        else setUninstalledRoot(response.retainedStateRoot);
      } catch (failure) {
        if (!disposed) setError(settingsActionErrorMessage(failure, locale));
      }
      if (shouldLoadUpdatePolicy) {
        try {
          const policy = await window.maka.runtimeHostManagement.getUpdatePolicy(target.id);
          if (!disposed) applyUpdatePolicy(policy);
        } catch (failure) {
          if (!disposed) {
            setUpdatePolicy(undefined);
            setUpdatePolicyError(settingsActionErrorMessage(failure, locale));
          }
        }
      }
      if (shouldLoadUpdatePolicy && target.directPeerManagement) {
        try {
          const peer = await window.maka.runtimeHostManagement.getDirectPeer(target.id);
          if (!disposed) applyDirectPeer(peer);
        } catch (failure) {
          if (!disposed) setDirectPeerError(settingsActionErrorMessage(failure, locale));
        }
      }
      if (!disposed) setLoading(false);
    })();
    return () => {
      disposed = true;
    };
  }, [locale, target]);

  useEffect(() => window.maka.runtimeHostManagement.subscribeProgress((progress) => {
    if (progress.profileId === target?.id) setUpdatePhase(progress.phase);
  }), [target?.id]);

  useLayoutEffect(() => {
    if (result?.action !== 'logs') return;
    const logs = logsRef.current;
    if (logs) logs.scrollTop = logs.scrollHeight;
  }, [result]);

  async function run(
    action: DesktopRuntimeHostManagementAction,
    allowInterruptActiveTasks = false,
  ): Promise<void> {
    if (!target) return;
    setLoading(true);
    setError(undefined);
    setReconnectWarning(undefined);
    setLastUpdateOutcome(undefined);
    try {
      const response = await window.maka.runtimeHostManagement.run(
        target.id,
        action,
        allowInterruptActiveTasks,
      );
      if (response.kind === 'error') {
        if (action === 'uninstall' && response.error.code === 'active_tasks') {
          setError(undefined);
          setConfirmation({ kind: 'uninstall', allowInterruptActiveTasks: true });
          return;
        }
        if (action === 'restart' && response.error.code === 'active_tasks') {
          setError(undefined);
          setConfirmation({ kind: 'restart' });
          return;
        }
        setUpdatePolicy(undefined);
        setError(response.error.message);
        toast.error(copy.managementActionFailed, response.error.message);
        return;
      }
      if (response.kind === 'uninstalled') {
        setResult(undefined);
        setUpdatePolicy(undefined);
        setUninstalledRoot(response.retainedStateRoot);
        setConfirmation(undefined);
        return;
      }
      setConfirmation(undefined);
      setResult(response);
      reconcileDirectoryPolicy(response.service);
      if (response.service.state === 'not_installed') setUpdatePolicy(undefined);
      else if (action !== 'logs') await reloadUpdatePolicy(target.id);
    } catch (failure) {
      const message = settingsActionErrorMessage(failure, locale);
      setUpdatePolicy(undefined);
      setError(message);
      toast.error(copy.managementActionFailed, message);
    } finally {
      setLoading(false);
    }
  }

  function applyDirectPeer(snapshot: DesktopRuntimeHostDirectPeerSnapshot): void {
    setDirectPeer(snapshot);
    setCoordinationRelays(snapshot.coordinationRelays.join(', '));
    setAutomaticRelayDiscovery(snapshot.automaticRelayDiscovery);
    setDirectPeerError(undefined);
  }

  async function reloadDirectPeer(): Promise<void> {
    if (!target) return;
    setLoading(true);
    setDirectPeerError(undefined);
    try {
      applyDirectPeer(await window.maka.runtimeHostManagement.getDirectPeer(target.id));
    } catch (failure) {
      setDirectPeerError(settingsActionErrorMessage(failure, locale));
    } finally {
      setLoading(false);
    }
  }

  async function configureDirectPeer(enabled: boolean): Promise<void> {
    if (!target) return;
    setLoading(true);
    setDirectPeerError(undefined);
    try {
      const relays = coordinationRelays
        .split(',')
        .map((relay) => relay.trim())
        .filter(Boolean);
      applyDirectPeer(
        await window.maka.runtimeHostManagement.configureDirectPeer(
          target.id,
          enabled,
          relays,
          automaticRelayDiscovery,
        ),
      );
    } catch (failure) {
      const message = settingsActionErrorMessage(failure, locale);
      try {
        applyDirectPeer(await window.maka.runtimeHostManagement.getDirectPeer(target.id));
      } catch {
        // Preserve the last authoritative snapshot when recovery cannot be read.
      }
      setDirectPeerError(message);
      toast.error(copy.directPeerActionFailed, message);
    } finally {
      setLoading(false);
    }
  }

  async function loadAccess(): Promise<void> {
    if (!target) return;
    setLoading(true);
    setError(undefined);
    try {
      setAccess(await window.maka.runtimeHostManagement.listCredentials(target.id));
    } catch (failure) {
      const message = settingsActionErrorMessage(failure, locale);
      setError(message);
      toast.error(copy.accessActionFailed, message);
    } finally {
      setLoading(false);
    }
  }

  async function update(allowInterruptActiveTasks: boolean): Promise<void> {
    if (!target) return;
    setLoading(true);
    setError(undefined);
    setReconnectWarning(undefined);
    setUpdatePhase('checking');
    setLastUpdateOutcome(undefined);
    try {
      const response = await window.maka.runtimeHostManagement.update(
        target.id,
        allowInterruptActiveTasks,
      );
      if (response.kind === 'error') {
        setUpdatePolicy(undefined);
        setError(response.error.message);
        toast.error(copy.managementActionFailed, response.error.message);
        return;
      }
      if (response.kind === 'uninstalled') {
        throw new Error('Runtime Host update returned an uninstall result');
      }
      setResult(response);
      reconcileDirectoryPolicy(response.service);
      applyReconnectWarning(response.reconnectError);
      if (response.action === 'update') setLastUpdateOutcome(response.update);
      setConfirmation(
        response.action === 'update' && response.update.kind === 'active_tasks'
          ? { kind: 'update' }
          : undefined,
      );
      if (response.action === 'update' && response.update.kind !== 'active_tasks') {
        await reloadUpdatePolicy(target.id);
      }
    } catch (failure) {
      const message = settingsActionErrorMessage(failure, locale);
      setUpdatePolicy(undefined);
      setError(message);
      toast.error(copy.managementActionFailed, message);
    } finally {
      setLoading(false);
      setUpdatePhase(undefined);
    }
  }

  function draftDirectoryRoots(
    roots: readonly { readonly label: string; readonly path: string }[],
  ): readonly ProjectDirectoryRootDraft[] {
    return roots.map((root) => ({ id: nextDirectoryRootId.current++, ...root }));
  }

  function directoryPolicySnapshot(
    service: DesktopRuntimeHostManagementResult['service'],
  ): DirectoryPolicySnapshot | undefined {
    const configurationFingerprint = service.configurationFingerprint;
    if (!configurationFingerprint) return undefined;
    return {
      roots: service.projectDirectoryRoots.map((root) => ({ ...root })),
      configurationFingerprint,
    };
  }

  function resetDirectoryPolicy(
    service: DesktopRuntimeHostManagementResult['service'],
  ): void {
    const baseline = directoryPolicySnapshot(service);
    setDirectoryPolicyEdit(
      baseline ? { baseline, draft: draftDirectoryRoots(baseline.roots) } : undefined,
    );
  }

  function reconcileDirectoryPolicy(
    service: DesktopRuntimeHostManagementResult['service'],
  ): void {
    const observed = directoryPolicySnapshot(service);
    setDirectoryPolicyEdit((current) => {
      if (!observed) return undefined;
      if (!current) return { baseline: observed, draft: draftDirectoryRoots(observed.roots) };
      const draft = canonicalProjectDirectoryRoots(current.draft);
      const dirty = JSON.stringify(draft) !== JSON.stringify(current.baseline.roots);
      if (!dirty) return { baseline: observed, draft: draftDirectoryRoots(observed.roots) };
      if (JSON.stringify(observed.roots) === JSON.stringify(current.baseline.roots)) {
        return { baseline: observed, draft: current.draft };
      }
      return { ...current, conflict: observed };
    });
  }

  async function configureDirectories(allowInterruptActiveTasks: boolean): Promise<void> {
    if (!target || !directoryPolicyEdit || directoryPolicyEdit.conflict) return;
    setLoading(true);
    setError(undefined);
    setReconnectWarning(undefined);
    try {
      const response = await window.maka.runtimeHostManagement.configureProjectDirectories(
        target.id,
        canonicalProjectDirectoryRoots(directoryPolicyEdit.draft),
        directoryPolicyEdit.baseline.configurationFingerprint,
        allowInterruptActiveTasks,
      );
      if (response.kind === 'error') {
        setError(response.error.message);
        toast.error(copy.managementActionFailed, response.error.message);
        return;
      }
      if (response.kind === 'uninstalled' || response.action !== 'configure') {
        throw new Error('Runtime Host configuration returned an unrelated result');
      }
      setResult(response);
      applyReconnectWarning(response.reconnectError);
      if (response.configuration.kind === 'active_tasks') {
        setConfirmation({ kind: 'configureDirectories' });
      } else {
        setConfirmation(undefined);
        resetDirectoryPolicy(response.service);
      }
    } catch (failure) {
      const message = settingsActionErrorMessage(failure, locale);
      setError(message);
      toast.error(copy.managementActionFailed, message);
    } finally {
      setLoading(false);
    }
  }

  function applyUpdatePolicy(snapshot: DesktopRuntimeHostUpdatePolicySnapshot): void {
    setUpdatePolicy(snapshot);
    const policy = snapshot.policy;
    if (policy.kind === 'manual') {
      setUpdatePolicyChoice('manual');
    } else if (policy.kind === 'fixed') {
      setUpdatePolicyChoice('fixed');
      setFixedVersion(policy.version);
    } else {
      setUpdatePolicyChoice(policy.channel);
    }
    setUpdatePolicyError(undefined);
  }

  async function reloadUpdatePolicy(profileId: string): Promise<void> {
    try {
      applyUpdatePolicy(await window.maka.runtimeHostManagement.getUpdatePolicy(profileId));
    } catch (failure) {
      setUpdatePolicy(undefined);
      setUpdatePolicyError(settingsActionErrorMessage(failure, locale));
    }
  }

  async function saveUpdatePolicy(): Promise<void> {
    if (!target) return;
    setLoading(true);
    setError(undefined);
    setUpdatePolicyError(undefined);
    setLastUpdateOutcome(undefined);
    try {
      const policy = updatePolicyChoice === 'manual'
        ? { kind: 'manual' as const }
        : updatePolicyChoice === 'fixed'
          ? { kind: 'fixed' as const, version: fixedVersion.trim() }
          : { kind: 'channel' as const, channel: updatePolicyChoice };
      applyUpdatePolicy(
        await window.maka.runtimeHostManagement.setUpdatePolicy(target.id, policy),
      );
    } catch (failure) {
      const message = settingsActionErrorMessage(failure, locale);
      setUpdatePolicy(undefined);
      setUpdatePolicyError(message);
      toast.error(copy.managementActionFailed, message);
    } finally {
      setLoading(false);
    }
  }

  async function reconcileUpdate(): Promise<void> {
    if (!target) return;
    setLoading(true);
    setError(undefined);
    setReconnectWarning(undefined);
    setUpdatePolicyError(undefined);
    setUpdatePhase('checking');
    setLastUpdateOutcome(undefined);
    try {
      const response = await window.maka.runtimeHostManagement.reconcileUpdate(target.id);
      if (response.kind === 'error') {
        setUpdatePolicy(undefined);
        setUpdatePolicyError(response.error.message);
        toast.error(copy.managementActionFailed, response.error.message);
        return;
      }
      setLastUpdateOutcome(response.reconciliation);
      applyUpdatePolicy(response.updatePolicy);
      applyReconnectWarning(response.reconnectError);
      const reconciledService = response.service;
      if (reconciledService) {
        reconcileDirectoryPolicy(reconciledService);
        setResult((current) => current ? { ...current, service: reconciledService } : current);
      }
    } catch (failure) {
      const message = settingsActionErrorMessage(failure, locale);
      setUpdatePolicy(undefined);
      setUpdatePolicyError(message);
      toast.error(copy.managementActionFailed, message);
    } finally {
      setLoading(false);
      setUpdatePhase(undefined);
    }
  }

  async function rotateCredential(): Promise<void> {
    if (!target) return;
    setLoading(true);
    setError(undefined);
    try {
      setAccess(await window.maka.runtimeHostManagement.rotateCredential(target.id));
    } catch (failure) {
      const message = settingsActionErrorMessage(failure, locale);
      setError(message);
      toast.error(copy.accessActionFailed, message);
    } finally {
      setLoading(false);
    }
  }

  function applyReconnectWarning(
    reconnectError: { readonly message: string } | undefined,
  ): void {
    setReconnectWarning(reconnectError?.message);
    if (reconnectError) {
      toast.warning(copy.managementReconnectFailed, reconnectError.message);
    }
  }

  async function revokeCredential(): Promise<void> {
    const revokeTarget = confirmation?.kind === 'revoke'
      ? confirmation.credential
      : undefined;
    if (!target || !revokeTarget) return;
    setLoading(true);
    setError(undefined);
    try {
      setAccess(
        await window.maka.runtimeHostManagement.revokeCredential(
          target.id,
          revokeTarget.credentialId,
        ),
      );
      setConfirmation(undefined);
    } catch (failure) {
      const message = settingsActionErrorMessage(failure, locale);
      setError(message);
      toast.error(copy.accessActionFailed, message);
    } finally {
      setLoading(false);
    }
  }

  const service = result?.service;
  const uninstalled = uninstalledRoot !== undefined;
  const serviceInstalled = service !== undefined && service.state !== 'not_installed';
  const serviceActive = service?.state === 'running';
  const supervised = service?.lifecycle?.mode === 'supervised';
  const savedPolicyChoice = updatePolicy ? updatePolicyChoiceOf(updatePolicy) : undefined;
  const updatePolicyDirty = savedPolicyChoice !== updatePolicyChoice ||
    (updatePolicyChoice === 'fixed' &&
      updatePolicy?.policy.kind === 'fixed' &&
      updatePolicy.policy.version !== fixedVersion.trim());
  const automaticPolicySelected = updatePolicyChoice !== 'manual';
  const automaticUpdatesAvailable = updatePolicy?.schedulingState === 'ready';
  const directoryRoots = directoryPolicyEdit?.draft ?? [];
  const normalizedDirectoryRoots = canonicalProjectDirectoryRoots(directoryRoots);
  const directoryRootsAreValid = projectDirectoryRootsValid(directoryRoots);
  const directoryRootsDirty =
    directoryPolicyEdit !== undefined &&
    JSON.stringify(normalizedDirectoryRoots) !== JSON.stringify(directoryPolicyEdit.baseline.roots);
  const updateOutcome = lastUpdateOutcome;
  return (
    <Dialog
      isOpen={target !== undefined}
      onOpenChange={(open) => {
        if (!open && !loading) props.onClose();
      }}
      purpose="form"
      width={640}
      maxHeight="calc(100dvh - 64px)"
    >
      <Layout
        header={(
          <DialogHeader
            title={target ? copy.managementTitle(target.name) : copy.title}
            subtitle={target?.subtitle}
            onOpenChange={(open) => {
              if (!open && !loading) props.onClose();
            }}
          />
        )}
        content={(
          <LayoutContent padding={4}>
            <div className="settingsRuntimeHostManagement">
              {loading ? (
                <div className="settingsRuntimeHostSetupProgress" role="status">
                  <Spinner size="sm" />
                  {updatePhase ? <Text type="supporting">{copy.updatePhase[updatePhase]}</Text> : null}
                </div>
              ) : null}
              {error ? <Banner status="error" title={error} /> : null}
              {reconnectWarning ? (
                <Banner
                  status="warning"
                  title={copy.managementReconnectFailed}
                  description={reconnectWarning}
                />
              ) : null}
              {confirmation?.kind === 'configureDirectories' ? (
                <Banner
                  status="warning"
                  title={copy.directoryRootsActiveTasks}
                  description={copy.directoryRootsActiveTasksDescription}
                />
              ) : null}
              {confirmation?.kind === 'uninstall' ? (
                <Banner
                  status="warning"
                  title={copy.uninstallConfirmTitle}
                  description={confirmation.allowInterruptActiveTasks
                    ? copy.uninstallActiveTasksDescription
                    : copy.uninstallConfirmBody}
                />
              ) : null}
              {confirmation?.kind === 'update' ? (
                <Banner
                  status="warning"
                  title={copy.updateBlockedTitle}
                  description={copy.updateBlockedBody}
                />
              ) : null}
              {confirmation?.kind === 'restart' ? (
                <Banner
                  status="warning"
                  title={copy.directoryRootsActiveTasks}
                  description={copy.restartActiveTasksDescription}
                />
              ) : null}
              {confirmation?.kind === 'rotate' ? (
                <Banner
                  status="warning"
                  title={copy.rotateCredentialConfirmTitle}
                  description={copy.rotateCredentialConfirmBody}
                />
              ) : null}
              {uninstalledRoot ? (
                <Banner
                  status="success"
                  title={copy.uninstallRetained(uninstalledRoot)}
                />
              ) : null}
              {updateOutcome?.kind === 'updated' ? (
                <Banner
                  status="success"
                  title={copy.updateComplete(
                    updateOutcome.previousVersion,
                    updateOutcome.targetVersion,
                  )}
                />
              ) : null}
              {updateOutcome?.kind === 'already_current' ? (
                <Banner
                  status="info"
                  title={copy.updateAlreadyCurrent(updateOutcome.version)}
                />
              ) : null}
              {updateOutcome?.kind === 'repaired' ? (
                <Banner status="success" title={copy.updateRepaired(updateOutcome.version)} />
              ) : null}
              {updateOutcome?.kind === 'disabled' ? (
                <Banner status="info" title={copy.updatePolicyDisabled} />
              ) : null}
              {updateOutcome?.kind === 'manual_action' ? (
                <Banner
                  status="warning"
                  title={(updateOutcome.reason === 'target_not_newer'
                    ? copy.updatePolicyNotNewer
                    : copy.updatePolicyManualAction)(updateOutcome.candidate.version)}
                  description={updateOutcome.reason === 'target_not_newer'
                    ? undefined
                    : copy.updatePolicyManualReason[updateOutcome.reason]}
                />
              ) : null}
              {updateOutcome?.kind === 'active_tasks' && confirmation?.kind !== 'update' ? (
                <Banner status="warning" title={copy.updatePolicyActiveTasks} />
              ) : null}
              {!access && service ? (
                <>
                  <dl className="settingsRuntimeHostManagementFacts">
                    <Fact label={copy.serviceStatus} value={copy.serviceState[service.state]} />
                    <Fact label={copy.installedVersion} value={service.installedVersion ?? '—'} />
                    <Fact
                      label={copy.operatingSystem}
                      value={`${service.platform} ${service.arch} · ${service.osRelease}`}
                    />
                    <Fact label={copy.processId} value={service.pid?.toString() ?? '—'} />
                    <Fact
                      label={copy.lastExitCode}
                      value={service.lastExitCode?.toString() ?? '—'}
                    />
                    {service.stateRoot ? (
                      <Fact label={copy.stateRoot} value={service.stateRoot} wide />
                    ) : null}
                  </dl>
                  {serviceInstalled && target?.directPeerManagement ? (
                    <section className="settingsRuntimeHostDirectPeer">
                      <div className="settingsRuntimeHostUpdatePolicyHeading">
                        <div>
                          <Text type="body" weight="semibold">{copy.directPeer}</Text>
                          <Text type="supporting" color="secondary">
                            {copy.directPeerDescription}
                          </Text>
                        </div>
                        <Badge
                          variant={directPeer?.state === 'enabled' ? 'success' : 'neutral'}
                          label={directPeer
                            ? copy.directPeerState[directPeer.state]
                            : copy.directPeerState.unavailable}
                        />
                      </div>
                      {directPeerError ? (
                        <Banner
                          status="warning"
                          title={copy.directPeerUnavailable}
                          description={directPeerError}
                        />
                      ) : null}
                      {directPeer && !directPeer.managementAvailable ? (
                        <Banner
                          status="warning"
                          title={copy.directPeerUpgradeRequired}
                        />
                      ) : null}
                      {!directPeer ? (
                        <div className="settingsRuntimeHostUpdatePolicyActions">
                          <Button
                            variant="secondary"
                            size="sm"
                            label={copy.refresh}
                            isDisabled={loading}
                            onClick={() => void reloadDirectPeer()}
                          />
                        </div>
                      ) : null}
                      {directPeer && !directPeer.clientAvailable ? (
                        <Banner status="warning" title={copy.directPeerClientUnavailable} />
                      ) : null}
                      {directPeer?.profileEnabled ? (
                        <Banner status="info" title={copy.directPeerDisableProfileFirst} />
                      ) : null}
                      {directPeer?.managementAvailable ? (
                        <>
                          {directPeer.peerId ? (
                            <dl className="settingsRuntimeHostManagementFacts">
                              <Fact label={copy.directPeerId} value={directPeer.peerId} wide />
                              <Fact
                                label={copy.directPeerRoutes}
                                value={directPeer.routeHints.join(', ') || '—'}
                                wide
                              />
                            </dl>
                          ) : null}
                          <div className="settingsRuntimeHostDirectPeerDiscovery">
                            <div className="settingsRuntimeHostDirectPeerDiscoveryLabel">
                              <Text type="body" weight="semibold">
                                {copy.directPeerAutomaticRelayDiscovery}
                              </Text>
                              <Tooltip content={copy.directPeerAutomaticRelayDiscoveryHelp}>
                                <IconButton
                                  label={copy.directPeerAutomaticRelayDiscoveryHelp}
                                  icon={<HelpCircle size={ICON_SIZE.control} aria-hidden="true" />}
                                  variant="ghost"
                                  size="sm"
                                />
                              </Tooltip>
                            </div>
                            <Switch
                              label={copy.directPeerAutomaticRelayDiscovery}
                              isLabelHidden
                              value={automaticRelayDiscovery}
                              isDisabled={
                                loading ||
                                directPeer.profileEnabled ||
                                directPeer.state === 'enabled'
                              }
                              onChange={setAutomaticRelayDiscovery}
                            />
                          </div>
                          <details className="settingsRuntimeHostDirectPeerAdvanced">
                            <summary>{copy.directPeerAdvancedCoordination}</summary>
                            <TextInput
                              label={copy.directPeerCoordinationRelays}
                              value={coordinationRelays}
                              placeholder={copy.directPeerCoordinationRelaysPlaceholder}
                              isDisabled={
                                loading ||
                                directPeer.profileEnabled ||
                                directPeer.state === 'enabled'
                              }
                              onChange={setCoordinationRelays}
                            />
                          </details>
                          <div className="settingsRuntimeHostUpdatePolicyActions">
                            <Button
                              variant="secondary"
                              size="sm"
                              label={copy.refresh}
                              isDisabled={loading}
                              onClick={() => void reloadDirectPeer()}
                            />
                            {directPeer.state === 'enabled' && !directPeer.profilePresent ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                label={copy.directPeerAddProfile}
                                isDisabled={
                                  loading ||
                                  directPeer.profileEnabled ||
                                  !directPeer.clientAvailable
                                }
                                onClick={() => void configureDirectPeer(true)}
                              />
                            ) : null}
                            <Button
                              variant={directPeer.state === 'enabled' ? 'secondary' : 'primary'}
                              size="sm"
                              label={directPeer.state === 'enabled'
                                ? copy.directPeerDisable
                                : copy.directPeerEnable}
                              isDisabled={
                                loading ||
                                directPeer.profileEnabled ||
                                (
                                  !directPeer.clientAvailable &&
                                  directPeer.state !== 'enabled'
                                )
                              }
                              onClick={() => void configureDirectPeer(
                                directPeer.state !== 'enabled',
                              )}
                            />
                          </div>
                        </>
                      ) : null}
                    </section>
                  ) : null}
                  {serviceInstalled ? (
                    <section className="settingsRuntimeHostUpdatePolicy">
                      <div className="settingsRuntimeHostUpdatePolicyHeading">
                        <div>
                          <Text type="body" weight="semibold">{copy.updatePolicy}</Text>
                          <Text type="supporting" color="secondary">
                            {copy.updatePolicyDescription}
                          </Text>
                        </div>
                        {updatePolicy ? (
                          <Badge
                            variant={updatePolicy.policy.kind === 'manual'
                              ? 'neutral'
                              : automaticUpdatesAvailable
                                ? 'success'
                                : 'warning'}
                            label={updatePolicy.policy.kind === 'manual'
                              ? copy.updatePolicyManual
                              : updatePolicy.schedulingState === 'ready'
                                ? copy.updatePolicyAutomatic
                              : updatePolicy.schedulingState === 'needs_repair'
                                ? copy.updateSchedulerNeedsRepair
                                : updatePolicy.schedulingState === 'inactive'
                                  ? copy.updateSchedulerInactive
                                  : copy.updateSchedulerUnsupported}
                          />
                        ) : null}
                      </div>
                      {updatePolicyError ? (
                        <Banner
                          status="warning"
                          title={copy.updatePolicyUnavailable}
                          description={updatePolicyError}
                        />
                      ) : null}
                      {updatePolicy?.schedulingState === 'unsupported' ? (
                        <Banner
                          status="warning"
                          title={copy.updateSchedulerUnavailable}
                          description={copy.updateSchedulerUnavailableBody}
                        />
                      ) : null}
                      {updatePolicy?.schedulingState === 'needs_repair' ? (
                        <Banner
                          status="warning"
                          title={copy.updateSchedulerNeedsRepair}
                          description={copy.updateSchedulerNeedsRepairBody}
                        />
                      ) : null}
                      {updatePolicy?.schedulingState === 'inactive' ? (
                        <Banner
                          status="warning"
                          title={copy.updateSchedulerInactive}
                          description={copy.updateSchedulerInactiveBody}
                        />
                      ) : null}
                      {updatePolicy ? (
                        <div className="settingsRuntimeHostUpdatePolicyControls">
                          <Selector
                            label={copy.updatePolicy}
                            isLabelHidden
                            value={updatePolicyChoice}
                            isDisabled={loading}
                            options={[
                              { value: 'manual', label: copy.updatePolicyOptions.manual },
                              { value: 'fixed', label: copy.updatePolicyOptions.fixed },
                              { value: 'latest', label: copy.updatePolicyOptions.latest },
                              { value: 'next', label: copy.updatePolicyOptions.next },
                            ]}
                            onChange={(value) => setUpdatePolicyChoice(value as UpdatePolicyChoice)}
                          />
                          {updatePolicyChoice === 'fixed' ? (
                            <TextInput
                              label={copy.updatePolicyFixedVersion}
                              value={fixedVersion}
                              isDisabled={loading}
                              onChange={setFixedVersion}
                            />
                          ) : null}
                          <div className="settingsRuntimeHostUpdatePolicyActions">
                            <Button
                              variant="secondary"
                              size="sm"
                              label={copy.updatePolicySave}
                              isDisabled={
                                loading ||
                                !updatePolicyDirty ||
                                (automaticPolicySelected && !automaticUpdatesAvailable) ||
                                (updatePolicyChoice === 'fixed' && fixedVersion.trim().length === 0)
                              }
                              onClick={() => void saveUpdatePolicy()}
                            />
                            {updatePolicy.policy.kind !== 'manual' &&
                            automaticUpdatesAvailable &&
                            !updatePolicyDirty ? (
                              <Button
                                variant="primary"
                                size="sm"
                                label={copy.updatePolicyCheckNow}
                                isDisabled={loading}
                                onClick={() => void reconcileUpdate()}
                              />
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </section>
                  ) : null}
                  <div className="settingsRuntimeHostManagementDirectoryRoots">
                    <Text type="body" weight="semibold">{copy.directoryRoots}</Text>
                    <Text type="supporting" color="secondary">
                      {copy.directoryRootsDescription}
                    </Text>
                    {directoryPolicyEdit ? (
                      <>
                        {directoryPolicyEdit.conflict ? (
                          <Banner
                            status="warning"
                            title={copy.directoryRootsChanged}
                            description={copy.directoryRootsChangedDescription}
                            endContent={
                              <Button
                                variant="secondary"
                                size="sm"
                                label={copy.reloadDirectoryRoots}
                                onClick={() => {
                                  const baseline = directoryPolicyEdit.conflict;
                                  if (!baseline) return;
                                  setDirectoryPolicyEdit({
                                    baseline,
                                    draft: draftDirectoryRoots(baseline.roots),
                                  });
                                }}
                              />
                            }
                          />
                        ) : null}
                        {directoryRoots.length === 0 ? (
                          <Text type="supporting" color="secondary">{copy.noDirectoryRoots}</Text>
                        ) : null}
                        <RuntimeHostProjectDirectoryEditor
                          roots={directoryRoots}
                          isDisabled={loading}
                          nextId={() => nextDirectoryRootId.current++}
                          copy={copy}
                          onChange={(draft) => setDirectoryPolicyEdit((current) =>
                            current ? { ...current, draft } : current
                          )}
                        />
                        <div className="settingsRuntimeHostManagementDirectoryRootActions">
                          <Button
                            variant="primary"
                            size="sm"
                            label={copy.saveDirectoryRoots}
                            isDisabled={
                              loading ||
                              directoryPolicyEdit.conflict !== undefined ||
                              !directoryRootsDirty ||
                              !directoryRootsAreValid
                            }
                            onClick={() => void configureDirectories(false)}
                          />
                        </div>
                      </>
                    ) : (
                      <Text type="supporting" color="secondary">
                        {copy.directoryRootsUnavailable}
                      </Text>
                    )}
                  </div>
                  {result.action === 'logs' ? (
                    <pre ref={logsRef} className="settingsRuntimeHostManagementLogs">
                      {result.logs || copy.noLogs}
                    </pre>
                  ) : null}
                </>
              ) : null}
              {access ? (
                <div className="settingsRuntimeHostAccess">
                  <Text type="body" weight="semibold">{copy.accessTitle}</Text>
                  {!access.canRotate ? (
                    <Text type="supporting" color="secondary">
                      {copy.enableBeforeRotate}
                    </Text>
                  ) : null}
                  {!serviceActive ? (
                    <Text type="supporting" color="secondary">
                      {copy.startBeforeChangingAccess}
                    </Text>
                  ) : null}
                  {confirmation?.kind === 'revoke' ? (
                    <Banner
                      status="warning"
                      title={copy.revokeCredentialConfirm(
                        confirmation.credential.principalId,
                      )}
                      description={copy.revokeCredentialConfirmBody}
                    />
                  ) : null}
                  {access.credentials.length === 0 ? (
                    <Text type="supporting" color="secondary">
                      {copy.noAccessCredentials}
                    </Text>
                  ) : (
                    <ul className="settingsRuntimeHostAccessList">
                      {access.credentials.map((credential) => (
                        <li key={credential.credentialId}>
                          <div className="settingsRuntimeHostAccessIdentity">
                            <div>
                              <strong>{credential.principalId}</strong>
                              <span>
                                {credential.principalKind === 'capability_provider'
                                  ? copy.accessKind.capabilityProvider
                                  : copy.accessKind.owner}
                              </span>
                            </div>
                            <div className="settingsRuntimeHostAccessBadges">
                              {credential.isCurrentDesktop ? (
                                <Badge variant="neutral" label={copy.currentDesktop} />
                              ) : null}
                              {credential.status === 'pending' ? (
                                <Badge variant="warning" label={copy.accessPending} />
                              ) : null}
                            </div>
                          </div>
                          <div className="settingsRuntimeHostAccessMeta">
                            <span>{copy.accessCreated(formatCredentialDate(credential.createdAt, locale))}</span>
                            {credential.isCurrentDesktop ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                label={copy.rotateCredential}
                                isDisabled={
                                  loading ||
                                  confirmation !== undefined ||
                                  credential.status === 'pending' ||
                                  !access.canRotate ||
                                  !serviceActive
                                }
                                onClick={() => setConfirmation({ kind: 'rotate' })}
                              />
                            ) : (
                              <Button
                                variant="secondary"
                                size="sm"
                                label={copy.revokeCredential}
                                isDisabled={
                                  loading || confirmation !== undefined || !serviceActive
                                }
                                onClick={() => setConfirmation({ kind: 'revoke', credential })}
                              />
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <div className="settingsRuntimeHostManagementActions">
              {confirmation?.kind === 'revoke' ? (
                <>
                  <Button
                    variant="secondary"
                    label={copy.cancel}
                    isDisabled={loading}
                    onClick={() => setConfirmation(undefined)}
                  />
                  <Button
                    variant="destructive"
                    label={copy.revokeCredential}
                    isDisabled={loading}
                    onClick={() => void revokeCredential()}
                  />
                </>
              ) : confirmation?.kind === 'update' ? (
                <>
                  <Button
                    variant="secondary"
                    label={copy.cancel}
                    isDisabled={loading}
                    onClick={() => setConfirmation(undefined)}
                  />
                  <Button
                    variant="destructive"
                    label={copy.updateInterrupt}
                    isDisabled={loading}
                    onClick={() => void update(true)}
                  />
                </>
              ) : confirmation?.kind === 'restart' ? (
                <>
                  <Button
                    variant="secondary"
                    label={copy.cancel}
                    isDisabled={loading}
                    onClick={() => setConfirmation(undefined)}
                  />
                  <Button
                    variant="destructive"
                    label={copy.restartInterrupt}
                    isDisabled={loading}
                    onClick={() => void run('restart', true)}
                  />
                </>
              ) : confirmation?.kind === 'configureDirectories' ? (
                <>
                  <Button
                    variant="secondary"
                    label={copy.cancel}
                    isDisabled={loading}
                    onClick={() => setConfirmation(undefined)}
                  />
                  <Button
                    variant="destructive"
                    label={copy.configureDirectoriesInterrupt}
                    isDisabled={loading}
                    onClick={() => void configureDirectories(true)}
                  />
                </>
              ) : confirmation?.kind === 'uninstall' ? (
                <>
                  <Button
                    variant="secondary"
                    label={copy.cancel}
                    isDisabled={loading}
                    onClick={() => setConfirmation(undefined)}
                  />
                  <Button
                    variant="destructive"
                    label={confirmation.allowInterruptActiveTasks
                      ? copy.interruptAndUninstall
                      : copy.uninstallConfirm}
                    isDisabled={loading}
                    onClick={() => void run(
                      'uninstall',
                      confirmation.allowInterruptActiveTasks,
                    )}
                  />
                </>
              ) : confirmation?.kind === 'rotate' ? (
                <>
                  <Button
                    variant="secondary"
                    label={copy.cancel}
                    isDisabled={loading}
                    onClick={() => setConfirmation(undefined)}
                  />
                  <Button
                    variant="primary"
                    label={copy.rotateCredentialConfirm}
                    isDisabled={loading}
                    onClick={() => void rotateCredential().then(() => setConfirmation(undefined))}
                  />
                </>
              ) : access ? (
                <>
                  <Button
                    variant="secondary"
                    label={copy.back}
                    isDisabled={loading}
                    onClick={() => {
                      setAccess(undefined);
                      setConfirmation(undefined);
                      setError(undefined);
                    }}
                  />
                  <Button
                    variant="primary"
                    label={copy.refresh}
                    isDisabled={loading}
                    onClick={() => void loadAccess()}
                  />
                </>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    label={copy.setupDone}
                    isDisabled={loading}
                    onClick={props.onClose}
                  />
                  {target && !uninstalled ? (
                    <MoreMenu
                      label={copy.moreActions(target.name)}
                      size="sm"
                      isDisabled={loading}
                      items={[
                        ...(serviceInstalled && result?.accessManagementAvailable
                          ? [{ label: copy.manageAccess, onClick: () => void loadAccess() }]
                          : []),
                        ...(serviceInstalled
                          ? [
                              { label: copy.updateService, onClick: () => void update(false) },
                              { label: copy.showLogs, onClick: () => void run('logs') },
                            ]
                          : []),
                        {
                          label: copy.uninstallService,
                          onClick: () => setConfirmation({
                            kind: 'uninstall',
                            allowInterruptActiveTasks: false,
                          }),
                        },
                      ]}
                    />
                  ) : null}
                  {result && target && !uninstalled ? (
                    <>
                      <Button
                        variant="secondary"
                        label={copy.refresh}
                        isDisabled={loading}
                        onClick={() => void run('status')}
                      />
                      {serviceInstalled && supervised && serviceActive ? (
                        <Button
                          variant="primary"
                          label={copy.restartService}
                          isDisabled={loading}
                          onClick={() => void run('restart')}
                        />
                      ) : serviceInstalled && supervised ? (
                        <Button
                          variant="primary"
                          label={copy.startService}
                          isDisabled={loading}
                          onClick={() => void run('start')}
                        />
                      ) : null}
                    </>
                  ) : null}
                </>
              )}
            </div>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function updatePolicyChoiceOf(snapshot: DesktopRuntimeHostUpdatePolicySnapshot): UpdatePolicyChoice {
  const policy = snapshot.policy;
  if (policy.kind === 'manual' || policy.kind === 'fixed') return policy.kind;
  return policy.channel;
}

function Fact(props: {
  readonly label: string;
  readonly value: string;
  readonly wide?: boolean;
}) {
  return (
    <div className={props.wide ? 'settingsRuntimeHostManagementFactWide' : undefined}>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

function formatCredentialDate(value: string, locale: UiLocale): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(uiLocaleToIntlLocale(locale), {
    dateStyle: 'medium',
  }).format(timestamp);
}
