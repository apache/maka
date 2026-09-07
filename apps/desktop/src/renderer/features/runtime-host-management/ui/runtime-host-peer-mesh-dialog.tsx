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
import { Banner } from '@astryxdesign/core';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { HStack } from '@astryxdesign/core/Stack';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import type { PeerMeshProjection, PeerMeshQueryResult } from '@maka/runtime-host/protocol';
import {
  decodeRuntimeHostWebRtcStunPolicy,
  type RuntimeHostWebRtcStunPolicy,
} from '@maka/runtime-host/webrtc-stun-policy';
import {
  Badge,
  Button,
  MoreMenu,
  redactSecrets,
  Selector,
  Switch,
  Text,
  TextArea,
  TextInput,
  useToast,
  useUiLocale,
} from '@maka/ui';
import {
  ArrowLeft,
  ChevronDown,
  Copy,
  HelpCircle,
  ICON_SIZE,
  KeyRound,
  Network,
  Pencil,
  Plus,
  RefreshCcw,
  Workflow,
} from '@maka/ui/icons';
import { getPeerMeshCopy, type PeerMeshCopy } from '../../../locales/peer-mesh-copy.js';
import { useRuntimeHostManagementServices } from '../services-context.js';
import {
  PeerMeshOperationOutcomeUnknownError,
  type PeerMeshDirectPeerSnapshot,
  type PeerMeshTarget,
} from '../ports.js';

type PeerMeshDialogView =
  | { readonly kind: 'overview' }
  | { readonly kind: 'join' }
  | {
      readonly kind: 'invitation';
      readonly meshId: string;
      readonly code: string;
      readonly expiresAt: number;
      readonly hasCoordinationRelay: boolean;
    };

type PeerMeshWorkingAction =
  | 'refresh'
  | 'create'
  | 'join'
  | 'invite'
  | 'add-host'
  | 'enable-peer'
  | 'update'
  | 'rename';

type ManagedHostPeerSetup =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly snapshot: PeerMeshDirectPeerSnapshot }
  | { readonly kind: 'failed'; readonly message: string };

type LocalHostAvailability =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'available'; readonly peerId: string };

type DesktopConnectivityPolicyState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly policy: RuntimeHostWebRtcStunPolicy };

interface DesktopConnectivityControls {
  readonly state: DesktopConnectivityPolicyState;
  readonly selectedKind: RuntimeHostWebRtcStunPolicy['kind'];
  readonly customUrls: string;
  readonly restartRequired: boolean;
  readonly saving: boolean;
  readonly inputInvalid: boolean;
  readonly onKindChange: (kind: RuntimeHostWebRtcStunPolicy['kind']) => void;
  readonly onCustomUrlsChange: (value: string) => void;
  readonly onSave: () => void;
  readonly onReset: () => void;
}

interface ActivePeerMeshOperation {
  readonly operationId: string;
  readonly cancellable: boolean;
}

const LOCAL_HOST_TARGET = { kind: 'local_host' } as const;

export function RuntimeHostPeerMeshDialog(props: {
  readonly target: PeerMeshTarget;
  readonly targetName: string;
  readonly offerLocalHost?: boolean;
  readonly onClose: () => void;
}) {
  const locale = useUiLocale();
  const copy = getPeerMeshCopy(locale);
  const toast = useToast();
  const services = useRuntimeHostManagementServices().peerMesh;
  const [snapshot, setSnapshot] = useState<PeerMeshQueryResult>();
  const [localHost, setLocalHost] = useState<LocalHostAvailability>({ kind: 'loading' });
  const [joinDraft, setJoinDraft] = useState('');
  const [view, setView] = useState<PeerMeshDialogView>({ kind: 'overview' });
  const [error, setError] = useState<string>();
  const [workingAction, setWorkingAction] = useState<PeerMeshWorkingAction>();
  const [settling, setSettling] = useState(false);
  const [operationCancellable, setOperationCancellable] = useState(false);
  const [connectivityPolicy, setConnectivityPolicy] = useState<DesktopConnectivityPolicyState>(
    { kind: 'loading' },
  );
  const [connectivityPolicyKind, setConnectivityPolicyKind] =
    useState<RuntimeHostWebRtcStunPolicy['kind']>('default');
  const [customStunUrls, setCustomStunUrls] = useState('');
  const [savingConnectivityPolicy, setSavingConnectivityPolicy] = useState(false);
  const [connectivityPolicyInputInvalid, setConnectivityPolicyInputInvalid] = useState(false);
  const [connectivityPolicyRestartRequired, setConnectivityPolicyRestartRequired] =
    useState(false);
  const [managedHostPeerSetup, setManagedHostPeerSetup] = useState<ManagedHostPeerSetup>(
    props.target.kind === 'managed_host' ? { kind: 'loading' } : { kind: 'idle' },
  );
  const working = workingAction !== undefined;
  const activeOperation = useRef<ActivePeerMeshOperation | undefined>(undefined);
  const cancelRequestedOperationId = useRef<string | undefined>(undefined);
  const closeRequested = useRef(false);
  const statusOperationIds = useRef(new Set<string>());
  const refreshSequence = useRef(0);
  const closed = useRef(false);
  const [selectedEndpoint, setSelectedEndpoint] = useState<'desktop' | 'local_host'>(
    props.target.kind === 'desktop' ? 'desktop' : 'local_host',
  );
  const canSelectLocalHost = props.target.kind === 'desktop' && props.offerLocalHost === true;
  const activeTarget =
    canSelectLocalHost && selectedEndpoint === 'local_host' ? LOCAL_HOST_TARGET : props.target;
  const offerLocalHost = canSelectLocalHost && selectedEndpoint === 'desktop';
  const managedProfileId =
    activeTarget.kind === 'managed_host' ? activeTarget.profileId : undefined;

  const executeStatus = useCallback(async (target: PeerMeshTarget) => {
    const operationId = services.createOperationId();
    statusOperationIds.current.add(operationId);
    const cancelDeadline = services.schedule(() => {
      void services.cancel(operationId);
    }, 10_000);
    try {
      return await services.execute(target, 'status', { operationId });
    } finally {
      cancelDeadline();
      statusOperationIds.current.delete(operationId);
    }
  }, [services]);

  const cancelStatusOperations = useCallback(() => {
    for (const operationId of statusOperationIds.current) {
      void services.cancel(operationId);
    }
    statusOperationIds.current.clear();
  }, [services]);

  const inspectManagedHostPeer = useCallback(async (profileId: string) => {
    setManagedHostPeerSetup({ kind: 'loading' });
    try {
      const directPeer = await services.getDirectPeer(profileId);
      if (!closed.current) {
        setManagedHostPeerSetup({ kind: 'ready', snapshot: directPeer });
      }
    } catch (failure) {
      if (!closed.current) {
        setManagedHostPeerSetup({
          kind: 'failed',
          message: peerMeshErrorMessage(failure, copy.unknownError),
        });
      }
    }
  }, [copy.unknownError, services]);

  const refresh = useCallback(async () => {
    if (closed.current) return;
    const sequence = ++refreshSequence.current;
    const result = await executeStatus(activeTarget);
    if (!isSnapshot(result)) throw new Error(copy.invalidResult);
    if (closed.current || sequence !== refreshSequence.current) return;
    setSnapshot(result);
    setError(undefined);
    if (offerLocalHost) {
      setLocalHost({ kind: 'loading' });
      void executeStatus(LOCAL_HOST_TARGET).then(
        (localHost) => {
          if (closed.current || sequence !== refreshSequence.current) return;
          setLocalHost(
            isSnapshot(localHost) && localHost.localPeerId
              ? { kind: 'available', peerId: localHost.localPeerId }
              : { kind: 'unavailable' },
          );
        },
        () => {
          if (!closed.current && sequence === refreshSequence.current) {
            setLocalHost({ kind: 'unavailable' });
          }
        },
      );
    }
  }, [activeTarget, copy.invalidResult, executeStatus, offerLocalHost]);

  useEffect(() => {
    closed.current = false;
    let disposed = false;
    void refresh().catch((failure) => {
      if (!disposed) {
        if (offerLocalHost) setLocalHost({ kind: 'unavailable' });
        setError(peerMeshErrorMessage(failure, copy.unknownError));
      }
    });
    return () => {
      disposed = true;
      closed.current = true;
      refreshSequence.current += 1;
      cancelStatusOperations();
    };
  }, [cancelStatusOperations, copy.unknownError, offerLocalHost, refresh]);

  useEffect(() => {
    if (props.target.kind !== 'desktop') return;
    let disposed = false;
    setConnectivityPolicy({ kind: 'loading' });
    void services.getConnectivityPolicy().then(
      (policy) => {
        if (disposed) return;
        setConnectivityPolicy({ kind: 'ready', policy });
        setConnectivityPolicyKind(policy.kind);
        setCustomStunUrls(policy.kind === 'custom' ? policy.urls.join(', ') : '');
      },
      (failure) => {
        if (!disposed) {
          setConnectivityPolicy({
            kind: 'failed',
            message: peerMeshErrorMessage(failure, copy.connectivityPolicyLoadFailed),
          });
        }
      },
    );
    return () => {
      disposed = true;
    };
  }, [copy.connectivityPolicyLoadFailed, props.target.kind, services]);

  useEffect(() => {
    if (view.kind !== 'overview' || working) return;
    let disposed = false;
    let cancelTimer: (() => void) | undefined;
    const poll = async () => {
      try {
        await refresh();
      } catch (failure) {
        if (!disposed) {
          setError(peerMeshErrorMessage(failure, copy.unknownError));
        }
      } finally {
        if (!disposed) cancelTimer = services.schedule(() => void poll(), 15_000);
      }
    };
    cancelTimer = services.schedule(() => void poll(), 15_000);
    return () => {
      disposed = true;
      cancelTimer?.();
      cancelStatusOperations();
    };
  }, [cancelStatusOperations, copy.unknownError, refresh, services, view.kind, working]);

  useEffect(() => {
    if (!managedProfileId) {
      setManagedHostPeerSetup({ kind: 'idle' });
      return;
    }
    if (snapshot?.available === true) {
      setManagedHostPeerSetup({ kind: 'idle' });
      return;
    }
    if (snapshot?.available !== false) return;
    void inspectManagedHostPeer(managedProfileId);
  }, [inspectManagedHostPeer, managedProfileId, snapshot?.available]);

  async function runOperation(
    action: PeerMeshWorkingAction,
    operation: (operationId: string) => Promise<void>,
    policy: {
      readonly cancellable?: boolean;
      readonly preserveResultOnClose?: boolean;
    } = {},
  ): Promise<boolean> {
    if (closed.current) return false;
    const operationId = services.createOperationId();
    activeOperation.current = { operationId, cancellable: policy.cancellable === true };
    cancelRequestedOperationId.current = undefined;
    setSettling(false);
    setOperationCancellable(policy.cancellable === true);
    setWorkingAction(action);
    setError(undefined);
    let completed = false;
    let unknownOutcome = false;
    let unknownOutcomeReconciled = false;
    try {
      await operation(operationId);
      completed = true;
    } catch (failure) {
      if (
        failure instanceof PeerMeshOperationOutcomeUnknownError &&
        !closed.current &&
        cancelRequestedOperationId.current !== operationId
      ) {
        unknownOutcome = true;
        setSettling(true);
        setOperationCancellable(false);
        try {
          await refresh();
          unknownOutcomeReconciled = true;
          setError(
            failure.action === 'invite'
              ? copy.invitationOutcomeUnknown
              : copy.outcomeUnknown,
          );
        } catch {
          if (!closed.current) setError(copy.outcomeUnknownRefreshFailed);
        }
      } else if (!closed.current && cancelRequestedOperationId.current !== operationId) {
        setError(peerMeshErrorMessage(failure, copy.unknownError));
      }
    } finally {
      const cancelled = cancelRequestedOperationId.current === operationId;
      if (cancelled && !closed.current) {
        try {
          await refresh();
        } catch (failure) {
          if (!closed.current) setError(peerMeshErrorMessage(failure, copy.unknownError));
        }
      }
      if (cancelRequestedOperationId.current === operationId) {
        cancelRequestedOperationId.current = undefined;
      }
      if (activeOperation.current?.operationId === operationId) activeOperation.current = undefined;
      if (cancelled) completed = false;
      if (!closed.current && activeOperation.current === undefined) {
        setWorkingAction(undefined);
        setSettling(false);
        setOperationCancellable(false);
      }
      if (!closed.current && closeRequested.current) {
        if (unknownOutcome && !unknownOutcomeReconciled) closeRequested.current = false;
        else if (completed && policy.preserveResultOnClose) closeRequested.current = false;
        else finishClose();
      }
    }
    return completed && !closed.current;
  }

  function operationIsCurrent(operationId: string): boolean {
    return (
      !closed.current &&
      activeOperation.current?.operationId === operationId &&
      cancelRequestedOperationId.current !== operationId
    );
  }

  async function refreshNow(): Promise<void> {
    if (working || closed.current) return;
    setWorkingAction('refresh');
    setError(undefined);
    try {
      await refresh();
    } catch (failure) {
      if (!closed.current) setError(peerMeshErrorMessage(failure, copy.unknownError));
    } finally {
      if (!closed.current) setWorkingAction(undefined);
    }
  }

  function cancelOperation(): void {
    const operation = activeOperation.current;
    if (
      !operation?.cancellable ||
      cancelRequestedOperationId.current === operation.operationId
    ) return;
    const operationId = operation.operationId;
    cancelRequestedOperationId.current = operationId;
    if (!closed.current) setSettling(true);
    void services.cancel(operationId);
  }

  function finishClose(): void {
    if (closed.current) return;
    closed.current = true;
    cancelStatusOperations();
    props.onClose();
  }

  function requestClose(): void {
    if (workingAction && workingAction !== 'refresh') {
      if (activeOperation.current?.cancellable) {
        cancelOperation();
        finishClose();
        return;
      }
      closeRequested.current = true;
      setSettling(true);
      return;
    }
    finishClose();
  }

  async function createMesh(): Promise<void> {
    await runOperation('create', async (operationId) => {
      const previousMeshIds = new Set(snapshot?.meshes.map(({ meshId }) => meshId));
      const result = await services.execute(activeTarget, 'create', {
        operationId,
      });
      if (!isSnapshot(result)) throw new Error(copy.invalidResult);
      if (!operationIsCurrent(operationId)) return;
      setSnapshot(result);
      const created = result.meshes.find(({ meshId }) => !previousMeshIds.has(meshId));
      if (created && offerLocalHost) {
        await joinLocalHost(created.meshId, operationId);
        if (!operationIsCurrent(operationId)) return;
        await refresh();
      }
    });
  }

  async function join(): Promise<void> {
    await runOperation(
      'join',
      async (operationId) => {
        const result = await services.execute(activeTarget, 'join', {
          invitation: joinDraft.trim(),
          operationId,
        });
        if (!isSnapshot(result)) throw new Error(copy.invalidResult);
        if (!operationIsCurrent(operationId)) return;
        setJoinDraft('');
        setView({ kind: 'overview' });
        setSnapshot(result);
      },
      { cancellable: activeTarget.kind === 'desktop' },
    );
  }

  async function createInvitation(meshId: string): Promise<void> {
    await runOperation(
      'invite',
      async (operationId) => {
        const result = await services.execute(activeTarget, 'invite', {
          meshId,
          operationId,
        });
        if (!isInvitationResult(result)) throw new Error(copy.invalidResult);
        if (!operationIsCurrent(operationId)) return;
        setView({
          kind: 'invitation',
          meshId,
          code: JSON.stringify(result.invitation),
          expiresAt: result.invitation.expiresAt,
          hasCoordinationRelay:
            result.invitation.reachability.lease.coordinationRoutes.length > 0,
        });
        setSnapshot(result.snapshot);
      },
      { preserveResultOnClose: true },
    );
  }

  async function addLocalHost(meshId: string): Promise<void> {
    await runOperation('add-host', async (operationId) => {
      await joinLocalHost(meshId, operationId);
      if (!operationIsCurrent(operationId)) return;
      await refresh();
    });
  }

  async function enableManagedHostPeer(): Promise<void> {
    if (!managedProfileId || working || closed.current) return;
    setWorkingAction('enable-peer');
    setError(undefined);
    try {
      const directPeer = await services.configureDirectPeer(
        managedProfileId,
        true,
        [],
        true,
      );
      if (closed.current) return;
      setManagedHostPeerSetup({ kind: 'ready', snapshot: directPeer });
      await refresh();
    } catch (failure) {
      if (!closed.current) setError(peerMeshErrorMessage(failure, copy.unknownError));
    } finally {
      if (!closed.current) {
        setWorkingAction(undefined);
        if (closeRequested.current) finishClose();
      }
    }
  }

  async function saveConnectivityPolicy(
    override?: RuntimeHostWebRtcStunPolicy,
  ): Promise<void> {
    if (savingConnectivityPolicy || (!override && connectivityPolicy.kind !== 'ready')) return;
    let normalizedCandidate: RuntimeHostWebRtcStunPolicy;
    try {
      normalizedCandidate = override
        ? decodeRuntimeHostWebRtcStunPolicy(override)
        : decodeConnectivityPolicyDraft(connectivityPolicyKind, customStunUrls);
    } catch {
      setConnectivityPolicyInputInvalid(true);
      return;
    }
    setSavingConnectivityPolicy(true);
    setConnectivityPolicyInputInvalid(false);
    setError(undefined);
    try {
      const policy = await services.setConnectivityPolicy(normalizedCandidate);
      if (closed.current) return;
      setConnectivityPolicy({ kind: 'ready', policy });
      setConnectivityPolicyKind(policy.kind);
      setCustomStunUrls(policy.kind === 'custom' ? policy.urls.join(', ') : '');
      setConnectivityPolicyRestartRequired(true);
    } catch (failure) {
      if (!closed.current) {
        setError(peerMeshErrorMessage(failure, copy.connectivityPolicySaveFailed));
      }
    } finally {
      if (!closed.current) setSavingConnectivityPolicy(false);
    }
  }

  async function joinLocalHost(meshId: string, operationId: string): Promise<void> {
    const prepared = await services.execute(activeTarget, 'invite', {
      meshId,
      operationId,
    });
    if (!isInvitationResult(prepared)) throw new Error(copy.invalidResult);
    if (!operationIsCurrent(operationId)) {
      throw new Error('Peer Mesh operation was cancelled');
    }
    const joined = await services.execute(
      LOCAL_HOST_TARGET,
      'join',
      { invitation: JSON.stringify(prepared.invitation), operationId },
    );
    if (!isSnapshot(joined)) throw new Error(copy.invalidResult);
    if (!operationIsCurrent(operationId)) {
      throw new Error('Peer Mesh operation was cancelled');
    }
  }

  async function mutate(
    action: 'remove' | 'leave' | 'close',
    meshId: string,
    peerId?: string,
  ): Promise<void> {
    const confirmed = await toast.confirm({
      title:
        action === 'close'
          ? copy.closeConfirm
          : action === 'leave'
            ? copy.leaveConfirm
            : copy.removeConfirm,
      confirmLabel:
        action === 'close' ? copy.closeMesh : action === 'leave' ? copy.leave : copy.remove,
      cancelLabel: copy.cancel,
      destructive: action !== 'leave',
    });
    if (!confirmed) return;
    await runOperation('update', async (operationId) => {
      const result = await services.execute(activeTarget, action, {
        meshId,
        peerId,
        operationId,
      });
      if (!isSnapshot(result)) throw new Error(copy.invalidResult);
      if (!operationIsCurrent(operationId)) return;
      setSnapshot(result);
    });
  }

  async function setTransit(meshId: string, enabled: boolean): Promise<void> {
    await runOperation('update', async (operationId) => {
      const result = await services.execute(activeTarget, 'transit', {
        meshId: enabled ? meshId : null,
        operationId,
      });
      if (!isSnapshot(result)) throw new Error(copy.invalidResult);
      if (!operationIsCurrent(operationId)) return;
      setSnapshot(result);
    });
  }

  async function copyInvitation(): Promise<void> {
    if (view.kind !== 'invitation') return;
    try {
      await services.copyText(view.code);
      toast.success(copy.invitationCopied);
    } catch (failure) {
      setError(peerMeshErrorMessage(failure, copy.unknownError));
    }
  }

  async function rename(displayName: string | null): Promise<void> {
    const completed = await runOperation('rename', async (operationId) => {
      const result = await services.execute(activeTarget, 'rename', {
        displayName,
        operationId,
      });
      if (!isSnapshot(result)) throw new Error(copy.invalidResult);
      if (!operationIsCurrent(operationId)) return;
      setSnapshot(result);
    });
    if (!completed) throw new Error('Peer Mesh rename did not complete');
  }

  async function renameMesh(meshId: string, displayName: string | null): Promise<void> {
    const completed = await runOperation('rename', async (operationId) => {
      const result = await services.execute(activeTarget, 'rename-mesh', {
        meshId,
        displayName,
        operationId,
      });
      if (!isSnapshot(result)) throw new Error(copy.invalidResult);
      if (!operationIsCurrent(operationId)) return;
      setSnapshot(result);
    });
    if (!completed) throw new Error('Peer Mesh rename did not complete');
  }

  async function copyPeerId(peerId: string): Promise<void> {
    try {
      await services.copyText(peerId);
      toast.success(copy.peerIdCopied);
    } catch (failure) {
      setError(peerMeshErrorMessage(failure, copy.unknownError));
    }
  }

  async function copyMeshId(meshId: string): Promise<void> {
    try {
      await services.copyText(meshId);
      toast.success(copy.meshIdCopied);
    } catch (failure) {
      setError(peerMeshErrorMessage(failure, copy.unknownError));
    }
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      purpose="form"
      width={680}
      maxHeight="calc(100dvh - 64px)"
    >
      <Layout
        header={
          <DialogHeader
            title={copy.title}
            subtitle={props.targetName}
            endContent={<Badge variant="info" label={copy.experimental} />}
            onOpenChange={(open) => {
              if (!open) requestClose();
            }}
          />
        }
        content={
          <LayoutContent padding={4}>
            <div className="settingsPeerMesh">
              {canSelectLocalHost ? (
                <div className="settingsPeerMeshEndpoint">
                  <SegmentedControl
                    label={copy.endpoint}
                    value={selectedEndpoint}
                    layout="fill"
                    size="sm"
                    isDisabled={working}
                    onChange={(value) => {
                      refreshSequence.current += 1;
                      setSelectedEndpoint(value as 'desktop' | 'local_host');
                      setSnapshot(undefined);
                      setLocalHost({ kind: 'loading' });
                      setJoinDraft('');
                      setView({ kind: 'overview' });
                      setError(undefined);
                    }}
                  >
                    <SegmentedControlItem value="desktop" label={copy.desktopEndpoint} />
                    <SegmentedControlItem value="local_host" label={copy.hostEndpoint} />
                  </SegmentedControl>
                  <Text type="supporting" color="secondary">
                    {selectedEndpoint === 'local_host'
                      ? copy.hostEndpointHelp
                      : copy.desktopEndpointHelp}
                  </Text>
                </div>
              ) : null}
              {workingAction ? (
                <Banner
                  status="info"
                  title={settling ? copy.settling : copy.working[workingAction]}
                  endContent={
                    settling || !operationCancellable ? undefined : (
                      <Button
                        variant="secondary"
                        size="sm"
                        label={copy.cancel}
                        onClick={cancelOperation}
                      />
                    )
                  }
                />
              ) : null}
              {error ? <Banner status="error" title={copy.failed} description={error} /> : null}
              {view.kind === 'invitation' ? (
                <InvitationView invitation={view} copy={copy} />
              ) : view.kind === 'join' ? (
                <JoinView value={joinDraft} working={working} copy={copy} onChange={setJoinDraft} />
              ) : (
                <>
                  <Overview
                    snapshot={snapshot}
                    copy={copy}
                    working={working}
                    localPeerLabel={
                      selectedEndpoint === 'local_host' ? copy.thisRuntimeHost : copy.thisDesktop
                    }
                    onInvite={(meshId) => void createInvitation(meshId)}
                    onRemove={(meshId, peerId) => void mutate('remove', meshId, peerId)}
                    onLeave={(meshId) => void mutate('leave', meshId)}
                    onClose={(meshId) => void mutate('close', meshId)}
                    onJoin={() => setView({ kind: 'join' })}
                    onCreate={() => void createMesh()}
                    onRefresh={() => void refreshNow()}
                    onSetTransit={(meshId, enabled) => void setTransit(meshId, enabled)}
                    onRename={rename}
                    onRenameMesh={renameMesh}
                    onCopyPeerId={(peerId) => void copyPeerId(peerId)}
                    onCopyMeshId={(meshId) => void copyMeshId(meshId)}
                    localHost={localHost}
                    onAddLocalHost={offerLocalHost ? (meshId) => void addLocalHost(meshId) : undefined}
                    managedHostPeerSetup={managedHostPeerSetup}
                    onEnableManagedHostPeer={() => void enableManagedHostPeer()}
                    onInspectManagedHostPeer={
                      managedProfileId
                        ? () => void inspectManagedHostPeer(managedProfileId)
                        : undefined
                    }
                  />
                  {activeTarget.kind === 'desktop' || snapshot?.available ? (
                    <PeerMeshAdvancedSettings
                      localPeerId={snapshot?.available ? snapshot.localPeerId : undefined}
                      connectivity={
                        activeTarget.kind === 'desktop'
                          ? {
                              state: connectivityPolicy,
                              selectedKind: connectivityPolicyKind,
                              customUrls: customStunUrls,
                              restartRequired: connectivityPolicyRestartRequired,
                              saving: savingConnectivityPolicy,
                              inputInvalid: connectivityPolicyInputInvalid,
                              onKindChange: (kind) => {
                                setConnectivityPolicyKind(kind);
                                setConnectivityPolicyInputInvalid(false);
                              },
                              onCustomUrlsChange: (value) => {
                                setCustomStunUrls(value);
                                setConnectivityPolicyInputInvalid(false);
                              },
                              onSave: () => void saveConnectivityPolicy(),
                              onReset: () => void saveConnectivityPolicy({ kind: 'default' }),
                            }
                          : undefined
                      }
                      copy={copy}
                      onCopyPeerId={(peerId) => void copyPeerId(peerId)}
                    />
                  ) : null}
                </>
              )}
            </div>
          </LayoutContent>
        }
        footer={
          view.kind === 'overview' ? undefined : (
            <LayoutFooter hasDivider>
              <HStack gap={2} hAlign="between" vAlign="center">
                <Button
                  variant="ghost"
                  label={copy.back}
                  icon={<ArrowLeft size={16} aria-hidden="true" />}
                  isDisabled={working}
                  onClick={() => setView({ kind: 'overview' })}
                />
                {view.kind === 'join' ? (
                  <Button
                    variant="primary"
                    label={copy.join}
                    isDisabled={working || !joinDraft.trim()}
                    onClick={() => void join()}
                  />
                ) : (
                  <Button
                    variant="primary"
                    label={copy.copyInvitation}
                    icon={<Copy size={16} aria-hidden="true" />}
                    onClick={() => void copyInvitation()}
                  />
                )}
              </HStack>
            </LayoutFooter>
          )
        }
      />
    </Dialog>
  );
}

function PeerMeshAdvancedSettings(props: {
  readonly localPeerId?: string;
  readonly connectivity?: DesktopConnectivityControls;
  readonly copy: PeerMeshCopy;
  readonly onCopyPeerId: (peerId: string) => void;
}) {
  const { connectivity } = props;
  const savedPolicy =
    connectivity?.state.kind === 'ready' ? connectivity.state.policy : undefined;
  const connectivitySummary =
    savedPolicy !== undefined
      ? savedPolicy.kind === 'default'
        ? props.copy.connectivityAutomatic
        : savedPolicy.kind === 'disabled'
          ? props.copy.connectivityKnownRoutesOnly
          : props.copy.connectivityCustom
      : undefined;
  const draftPolicy = connectivity
    ? tryDecodeConnectivityPolicyDraft(connectivity.selectedKind, connectivity.customUrls)
    : undefined;
  const connectivityPolicyChanged = savedPolicy
    ? draftPolicy === undefined || !connectivityPoliciesEqual(savedPolicy, draftPolicy)
    : false;
  return (
    <details className="settingsPeerMeshConnectivity">
      <summary>
        <span className="settingsPeerMeshConnectivitySummary">
          <span>
            <Text type="body" weight="semibold">{props.copy.advancedSettings}</Text>
            <Text type="supporting" color="secondary">
              {connectivitySummary ?? props.copy.technicalDetails}
            </Text>
          </span>
          {connectivity?.restartRequired ? (
            <Badge variant="info" label={props.copy.restartRequired} />
          ) : null}
        </span>
        <ChevronDown
          className="settingsPeerMeshConnectivityChevron"
          size={ICON_SIZE.chrome}
          aria-hidden="true"
        />
      </summary>
      <div className="settingsPeerMeshConnectivityBody">
        {props.localPeerId ? (
          <div className="settingsPeerMeshTechnicalIdentity">
            <div>
              <Text type="supporting" weight="semibold">{props.copy.peerId}</Text>
              <Text type="supporting" color="secondary">{props.copy.peerIdHelp}</Text>
            </div>
            <PeerIdText
              peerId={props.localPeerId}
              copy={props.copy}
              onCopy={props.onCopyPeerId}
            />
          </div>
        ) : null}
        {connectivity ? (
          <div className="settingsPeerMeshConnectivitySection">
            <div className="settingsPeerMeshConnectivityHeading">
              <Text type="supporting" weight="semibold">{props.copy.adaptiveConnectivity}</Text>
              <Tooltip content={props.copy.adaptiveConnectivityHelp}>
                <span
                  className="settingsPeerMeshConnectivityHelp"
                  aria-label={props.copy.adaptiveConnectivityHelp}
                >
                  <HelpCircle size={ICON_SIZE.control} aria-hidden="true" />
                </span>
              </Tooltip>
            </div>
            {connectivity.state.kind === 'loading' ? (
              <Text type="supporting" color="secondary">
                {props.copy.connectivityPolicyLoading}
              </Text>
            ) : connectivity.state.kind === 'failed' ? (
              <>
                <Banner
                  status="error"
                  title={props.copy.connectivityPolicyLoadFailed}
                  description={connectivity.state.message}
                />
                <HStack hAlign="end">
                  <Button
                    variant="secondary"
                    size="sm"
                    label={props.copy.restoreDefaultConnectivityPolicy}
                    isDisabled={connectivity.saving}
                    onClick={connectivity.onReset}
                  />
                </HStack>
              </>
            ) : (
              <>
                <Selector
                  label={props.copy.publicAddressDiscovery}
                  value={connectivity.selectedKind}
                  options={[
                    { value: 'default', label: props.copy.publicStunDefault },
                    { value: 'disabled', label: props.copy.publicStunDisabled },
                    { value: 'custom', label: props.copy.publicStunCustom },
                  ]}
                  isDisabled={connectivity.saving}
                  onChange={(value) =>
                    connectivity.onKindChange(value as RuntimeHostWebRtcStunPolicy['kind'])
                  }
                />
                {connectivity.selectedKind === 'custom' ? (
                  <TextInput
                    label={props.copy.customStunUrls}
                    value={connectivity.customUrls}
                    placeholder="stun:stun.example.com:3478"
                    isDisabled={connectivity.saving}
                    status={
                      connectivity.inputInvalid
                        ? { type: 'error', message: props.copy.customStunUrlsInvalid }
                        : undefined
                    }
                    onChange={connectivity.onCustomUrlsChange}
                  />
                ) : null}
                <Text type="supporting" color="secondary">
                  {connectivity.selectedKind === 'default'
                    ? props.copy.publicStunDefaultHelp
                    : connectivity.selectedKind === 'disabled'
                      ? props.copy.publicStunDisabledHelp
                      : props.copy.publicStunCustomHelp}
                </Text>
                {connectivity.restartRequired ? (
                  <Banner status="info" title={props.copy.connectivityPolicyRestartRequired} />
                ) : null}
                <HStack hAlign="end">
                  <Button
                    variant="secondary"
                    size="sm"
                    label={props.copy.saveConnectivityPolicy}
                    isDisabled={
                      connectivity.saving ||
                      !connectivityPolicyChanged ||
                      (connectivity.selectedKind === 'custom' &&
                        connectivity.customUrls.trim().length === 0)
                    }
                    onClick={connectivity.onSave}
                  />
                </HStack>
              </>
            )}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function Overview(props: {
  readonly snapshot: PeerMeshQueryResult | undefined;
  readonly copy: PeerMeshCopy;
  readonly working: boolean;
  readonly localPeerLabel: string;
  readonly onInvite: (meshId: string) => void;
  readonly onRemove: (meshId: string, peerId: string) => void;
  readonly onLeave: (meshId: string) => void;
  readonly onClose: (meshId: string) => void;
  readonly onJoin: () => void;
  readonly onCreate: () => void;
  readonly onRefresh: () => void;
  readonly onSetTransit: (meshId: string, enabled: boolean) => void;
  readonly onRename: (displayName: string | null) => Promise<void>;
  readonly onRenameMesh: (meshId: string, displayName: string | null) => Promise<void>;
  readonly onCopyPeerId: (peerId: string) => void;
  readonly onCopyMeshId: (meshId: string) => void;
  readonly localHost: LocalHostAvailability;
  readonly onAddLocalHost?: (meshId: string) => void;
  readonly managedHostPeerSetup: ManagedHostPeerSetup;
  readonly onEnableManagedHostPeer: () => void;
  readonly onInspectManagedHostPeer?: () => void;
}) {
  const { snapshot, copy } = props;
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [showClosedMeshes, setShowClosedMeshes] = useState(false);
  if (!snapshot) {
    return (
      <Text type="supporting" color="secondary">
        {copy.loading}
      </Text>
    );
  }
  if (!snapshot.available) {
    return (
      <UnavailableEndpoint
        setup={props.managedHostPeerSetup}
        working={props.working}
        copy={copy}
        onEnable={props.onEnableManagedHostPeer}
        onInspect={props.onInspectManagedHostPeer}
        onRefresh={props.onRefresh}
      />
    );
  }
  const activeMeshes = snapshot.meshes.filter((mesh) => !mesh.closed);
  const closedMeshCount = snapshot.meshes.length - activeMeshes.length;
  const visibleMeshes = showClosedMeshes ? snapshot.meshes : activeMeshes;
  return (
    <>
      <div className="settingsPeerMeshIdentity">
        <span className="settingsPeerMeshIdentityIcon" aria-hidden="true">
          <Network size={ICON_SIZE.chrome} />
        </span>
        <div>
          <Text type="body" weight="semibold">
            {snapshot.localDisplayName ?? props.localPeerLabel}
          </Text>
          {snapshot.localDisplayName ? (
            <Text type="supporting" color="secondary">
              {props.localPeerLabel}
            </Text>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          label={copy.rename}
          icon={<Pencil size={ICON_SIZE.chrome} aria-hidden="true" />}
          isDisabled={props.working}
          onClick={() => {
            setNameDraft(snapshot.localDisplayName ?? '');
            setEditingName(true);
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          label={copy.refresh}
          icon={<RefreshCcw size={ICON_SIZE.chrome} aria-hidden="true" />}
          isDisabled={props.working}
          onClick={props.onRefresh}
        />
      </div>
      {editingName ? (
        <div className="settingsPeerMeshRename">
          <TextInput
            label={copy.displayName}
            value={nameDraft}
            placeholder={props.localPeerLabel}
            isDisabled={props.working}
            onChange={setNameDraft}
          />
          <HStack gap={2} hAlign="end">
            <Button
              variant="ghost"
              size="sm"
              label={copy.cancel}
              isDisabled={props.working}
              onClick={() => setEditingName(false)}
            />
            <Button
              variant="primary"
              size="sm"
              label={copy.save}
              isDisabled={props.working || nameDraft.trim().length > 80}
              onClick={() => {
                void props
                  .onRename(nameDraft.trim() || null)
                  .then(() => setEditingName(false))
                  .catch(() => undefined);
              }}
            />
          </HStack>
        </div>
      ) : null}
      {snapshot.meshes.length === 0 ? (
        <div className="settingsPeerMeshEmpty">
          <span className="settingsPeerMeshEmptyIcon" aria-hidden="true">
            <Network size={ICON_SIZE.plate} />
          </span>
          <Text type="body" weight="semibold">
            {copy.empty}
          </Text>
          <Text type="supporting" color="secondary">
            {copy.emptyHint}
          </Text>
          <HStack gap={2}>
            <Button
              variant="primary"
              label={copy.create}
              icon={<Plus size={ICON_SIZE.chrome} aria-hidden="true" />}
              isDisabled={props.working}
              onClick={props.onCreate}
            />
            <Button
              variant="secondary"
              label={copy.joinMesh}
              isDisabled={props.working}
              onClick={props.onJoin}
            />
          </HStack>
        </div>
      ) : (
        <>
          <div className="settingsPeerMeshToolbar">
            <div>
              <Text type="body" weight="semibold">
                {copy.meshes}
              </Text>
              <Text type="supporting" color="secondary">
                {copy.activeMeshCount(activeMeshes.length)}
              </Text>
            </div>
            <HStack gap={2}>
              <Button
                variant="secondary"
                size="sm"
                label={copy.joinMesh}
                isDisabled={props.working}
                onClick={props.onJoin}
              />
              <Button
                variant="primary"
                size="sm"
                label={copy.create}
                icon={<Plus size={ICON_SIZE.chrome} aria-hidden="true" />}
                isDisabled={props.working}
                onClick={props.onCreate}
              />
            </HStack>
          </div>
          {closedMeshCount > 0 ? (
            <div className="settingsPeerMeshFilter">
              <Switch
                label={copy.showClosedMeshes(closedMeshCount)}
                value={showClosedMeshes}
                isDisabled={props.working}
                onChange={setShowClosedMeshes}
              />
            </div>
          ) : null}
          {visibleMeshes.length === 0 ? (
            <div className="settingsPeerMeshFilteredEmpty">
              <Text type="body" weight="semibold">{copy.noActiveMeshes}</Text>
              <Text type="supporting" color="secondary">{copy.noActiveMeshesHint}</Text>
            </div>
          ) : (
            <div className="settingsPeerMeshList">
              {visibleMeshes.map((mesh) => (
                <MeshCard
                  key={mesh.meshId}
                  mesh={mesh}
                  transit={snapshot.transit}
                  copy={copy}
                  working={props.working}
                  onInvite={() => props.onInvite(mesh.meshId)}
                  onRemove={(peerId) => props.onRemove(mesh.meshId, peerId)}
                  onLeave={() => props.onLeave(mesh.meshId)}
                  onClose={() => props.onClose(mesh.meshId)}
                  onSetTransit={(enabled) => props.onSetTransit(mesh.meshId, enabled)}
                  onRename={(displayName) => props.onRenameMesh(mesh.meshId, displayName)}
                  onCopyPeerId={props.onCopyPeerId}
                  onCopyMeshId={props.onCopyMeshId}
                  localPeerLabel={props.localPeerLabel}
                  localHost={props.localHost}
                  onAddLocalHost={
                    props.onAddLocalHost
                      ? () => props.onAddLocalHost?.(mesh.meshId)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

function UnavailableEndpoint(props: {
  readonly setup: ManagedHostPeerSetup;
  readonly working: boolean;
  readonly copy: PeerMeshCopy;
  readonly onEnable: () => void;
  readonly onInspect?: () => void;
  readonly onRefresh: () => void;
}) {
  const { copy, setup } = props;
  if (setup.kind === 'loading') {
    return <Banner status="info" title={copy.checkingPeerConnection} />;
  }
  if (setup.kind === 'failed') {
    return (
      <Banner
        status="warning"
        title={copy.unavailable}
        description={setup.message}
        endContent={(
          <Button
            variant="secondary"
            size="sm"
            label={copy.refresh}
            isDisabled={props.working}
            onClick={props.onInspect}
          />
        )}
      />
    );
  }
  if (setup.kind === 'idle') {
    return <Banner status="warning" title={copy.unavailable} />;
  }
  const directPeer = setup.snapshot;
  if (!directPeer.managementAvailable) {
    return (
      <Banner
        status="warning"
        title={copy.peerConnectionUpgradeRequired}
        description={copy.peerConnectionUpgradeRequiredHint}
      />
    );
  }
  if (directPeer.state === 'enabled') {
    return (
      <Banner
        status="info"
        title={copy.peerConnectionStarting}
        description={copy.peerConnectionStartingHint}
        endContent={(
          <Button
            variant="secondary"
            size="sm"
            label={copy.refresh}
            isDisabled={props.working}
            onClick={props.onRefresh}
          />
        )}
      />
    );
  }
  return (
    <Banner
      status="info"
      title={copy.peerConnectionDisabled}
      description={
        directPeer.profileEnabled
          ? copy.peerConnectionDisableProfileFirst
          : copy.peerConnectionDisabledHint
      }
      endContent={(
        <Button
          variant="primary"
          size="sm"
          label={copy.enablePeerConnection}
          isDisabled={props.working || directPeer.profileEnabled}
          onClick={props.onEnable}
        />
      )}
    />
  );
}

function JoinView(props: {
  readonly value: string;
  readonly working: boolean;
  readonly copy: PeerMeshCopy;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="settingsPeerMeshFocusedView">
      <div className="settingsPeerMeshFocusedHeading">
        <span className="settingsPeerMeshFocusedIcon" aria-hidden="true">
          <KeyRound size={ICON_SIZE.empty} />
        </span>
        <div>
          <Text type="body" weight="semibold">
            {props.copy.joinTitle}
          </Text>
          <Text type="supporting" color="secondary">
            {props.copy.joinHint}
          </Text>
        </div>
      </div>
      <TextArea
        label={props.copy.joinCode}
        value={props.value}
        rows={6}
        hasSpellCheck={false}
        isDisabled={props.working}
        onChange={props.onChange}
      />
    </div>
  );
}

function InvitationView(props: {
  readonly invitation: Extract<PeerMeshDialogView, { readonly kind: 'invitation' }>;
  readonly copy: PeerMeshCopy;
}) {
  return (
    <div className="settingsPeerMeshFocusedView">
      <div className="settingsPeerMeshFocusedHeading">
        <span className="settingsPeerMeshFocusedIcon" aria-hidden="true">
          <KeyRound size={ICON_SIZE.empty} />
        </span>
        <div>
          <Text type="body" weight="semibold">
            {props.copy.invitationTitle}
          </Text>
          <Text type="supporting" color="secondary">
            {props.copy.invitationFor(fingerprint(props.invitation.meshId))}
          </Text>
        </div>
      </div>
      <div className="settingsPeerMeshInvitation">
        <div className="settingsPeerMeshInvitationLabel">
          <Text type="supporting" color="secondary">
            {props.copy.joinCode}
          </Text>
          <Text type="supporting" color="secondary">
            {props.copy.invitationExpires(new Date(props.invitation.expiresAt).toLocaleString())}
          </Text>
        </div>
        <div className="settingsPeerMeshInvitationCode">
          <code>{props.invitation.code}</code>
        </div>
      </div>
      <div className="settingsPeerMeshInvitationNote">
        <KeyRound size={ICON_SIZE.control} aria-hidden="true" />
        <Text type="supporting" color="secondary">
          {props.copy.invitationWarning}
        </Text>
      </div>
      {!props.invitation.hasCoordinationRelay ? (
        <div className="settingsPeerMeshInvitationNote">
          <Network size={ICON_SIZE.control} aria-hidden="true" />
          <Text type="supporting" color="secondary">
            {props.copy.invitationDirectOnly}
          </Text>
        </div>
      ) : null}
    </div>
  );
}

function MeshCard(props: {
  readonly mesh: PeerMeshProjection;
  readonly transit: PeerMeshQueryResult['transit'];
  readonly copy: PeerMeshCopy;
  readonly working: boolean;
  readonly onInvite: () => void;
  readonly onRemove: (peerId: string) => void;
  readonly onLeave: () => void;
  readonly onClose: () => void;
  readonly onSetTransit: (enabled: boolean) => void;
  readonly onRename: (displayName: string | null) => Promise<void>;
  readonly onCopyPeerId: (peerId: string) => void;
  readonly onCopyMeshId: (meshId: string) => void;
  readonly localPeerLabel: string;
  readonly localHost: LocalHostAvailability;
  readonly onAddLocalHost?: () => void;
}) {
  const { mesh, copy } = props;
  const [expanded, setExpanded] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const transitEnabled = props.transit?.meshId === mesh.meshId;
  const localHostPeerId = props.localHost.kind === 'available' ? props.localHost.peerId : undefined;
  const localHostIsMember =
    localHostPeerId !== undefined && mesh.members.some(({ peerId }) => peerId === localHostPeerId);
  return (
    <section className="settingsPeerMeshCard">
      <div className="settingsPeerMeshCardHeading">
        <Button
          variant="ghost"
          size="sm"
          className="settingsPeerMeshCardDisclosure"
          label={mesh.displayName ?? copy.unnamedMesh}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          endContent={(
            <ChevronDown
              className={expanded ? 'settingsPeerMeshChevron isExpanded' : 'settingsPeerMeshChevron'}
              size={ICON_SIZE.chrome}
              aria-hidden="true"
            />
          )}
        >
          <span className="settingsPeerMeshCardTitleBlock">
            <span className="settingsPeerMeshCardTitle">
              {mesh.displayName ?? copy.unnamedMesh}
            </span>
            <span className="settingsPeerMeshCardSubtitle">
              {copy.memberCount(mesh.members.length)}
              {mesh.pendingInvitationCount > 0
                ? ` · ${copy.pending(mesh.pendingInvitationCount)}`
                : ''}
            </span>
          </span>
        </Button>
        <div className="settingsPeerMeshCardControls">
          <Badge
            variant="neutral"
            label={
              mesh.closed ? copy.closed : mesh.role === 'authority' ? copy.authority : copy.member
            }
          />
          {mesh.role === 'authority' && !mesh.closed ? (
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              label={copy.renameMesh}
              icon={<Pencil size={ICON_SIZE.chrome} aria-hidden="true" />}
              isDisabled={props.working}
              onClick={() => {
                setNameDraft(mesh.displayName ?? '');
                setEditingName(true);
                setExpanded(true);
              }}
            />
          ) : null}
          {!mesh.closed ? (
            <MoreMenu
              label={copy.meshActions}
              size="sm"
              items={
                mesh.role === 'authority'
                  ? [
                      {
                        label: copy.closeMesh,
                        isDisabled: props.working,
                        onClick: props.onClose,
                      },
                    ]
                  : [
                      {
                        label: copy.leave,
                        isDisabled: props.working,
                        onClick: props.onLeave,
                      },
                    ]
              }
            />
          ) : null}
        </div>
      </div>
      {expanded ? (
        <div className="settingsPeerMeshCardDetails">
          {editingName ? (
            <div className="settingsPeerMeshRename">
              <TextInput
                label={copy.meshDisplayName}
                value={nameDraft}
                placeholder={copy.mesh}
                isDisabled={props.working}
                onChange={setNameDraft}
              />
              <HStack gap={2} hAlign="end">
                <Button
                  variant="ghost"
                  size="sm"
                  label={copy.cancel}
                  isDisabled={props.working}
                  onClick={() => setEditingName(false)}
                />
                <Button
                  variant="primary"
                  size="sm"
                  label={copy.save}
                  isDisabled={props.working || nameDraft.trim().length > 80}
                  onClick={() => {
                    void props
                      .onRename(nameDraft.trim() || null)
                      .then(() => setEditingName(false))
                      .catch(() => undefined);
                  }}
                />
              </HStack>
            </div>
          ) : null}
          {!mesh.closed ? (
            <div className="settingsPeerMeshTransit">
              <div className="settingsPeerMeshTransitIdentity">
                <span className="settingsPeerMeshTransitIcon" aria-hidden="true">
                  <Workflow size={ICON_SIZE.chrome} />
                </span>
                <div>
                  <div className="settingsPeerMeshTransitTitle">
                    <Text type="supporting" weight="semibold">
                      {copy.transit}
                    </Text>
                    <span
                      className="settingsPeerMeshTransitHelp"
                      role="img"
                      aria-label={copy.transitLimitsLabel}
                      title={copy.transitLimits(props.transit)}
                    >
                      <HelpCircle size={ICON_SIZE.meta} aria-hidden="true" />
                    </span>
                  </div>
                  <Text type="supporting" color="secondary">
                    {copy.transitHelp}
                  </Text>
                </div>
              </div>
              <Switch
                label={copy.transitToggle}
                isLabelHidden
                value={transitEnabled}
                isDisabled={props.working}
                onChange={props.onSetTransit}
              />
            </div>
          ) : null}
          {props.onAddLocalHost &&
          props.localHost.kind === 'available' &&
          mesh.role === 'authority' &&
          !localHostIsMember &&
          !mesh.closed ? (
            <Banner
              status="info"
              title={copy.localHostMissing}
              description={copy.localHostMissingHint}
              endContent={
                <Button
                  variant="secondary"
                  size="sm"
                  label={copy.addLocalHost}
                  isDisabled={props.working}
                  onClick={props.onAddLocalHost}
                />
              }
            />
          ) : null}
          {transitEnabled && props.transit ? (
            <div className="settingsPeerMeshTransitMetrics" aria-label={copy.transitStatus}>
              <TransitMetric
                label={copy.allowedMembers}
                value={String(props.transit.allowedMemberCount)}
              />
              <TransitMetric
                label={copy.reservations}
                value={`${props.transit.activeReservationCount}/${props.transit.maxReservationCount}`}
              />
              <TransitMetric
                label={copy.circuits}
                value={`${props.transit.activeCircuitCount}/${props.transit.maxCircuitCount}`}
              />
            </div>
          ) : null}
          <div className="settingsPeerMeshMembersHeading">
            <Text type="supporting" color="secondary">
              {copy.members}
            </Text>
            {mesh.role === 'authority' && !mesh.closed ? (
              <Button
                variant="ghost"
                size="sm"
                label={copy.invite}
                isDisabled={props.working}
                onClick={props.onInvite}
              />
            ) : null}
          </div>
          <div className="settingsPeerMeshMembers">
            {mesh.members.map((member) => (
              <div className="settingsPeerMeshMember" key={member.peerId}>
                <div className="settingsPeerMeshMemberIdentity">
                  <span
                    className={`settingsPeerMeshMemberState settingsPeerMeshMemberState-${member.state}`}
                    aria-hidden="true"
                  />
                  <div>
                    <div className="settingsPeerMeshMemberHeading">
                      <div className="settingsPeerMeshMemberName">
                        {member.displayName ? (
                          <Text type="body" weight="semibold">
                            {member.displayName}
                          </Text>
                        ) : null}
                        <PeerIdText
                          peerId={member.peerId}
                          copy={copy}
                          onCopy={props.onCopyPeerId}
                        />
                      </div>
                      <Tooltip content={copy.endpointKindHelp[member.endpointKind ?? 'unknown']}>
                        <Badge
                          variant={member.endpointKind === 'host' ? 'blue' : 'neutral'}
                          label={copy.endpointKind[member.endpointKind ?? 'unknown']}
                        />
                      </Tooltip>
                    </div>
                    <Text type="supporting" color="secondary">
                      {member.state === 'local'
                        ? props.localPeerLabel
                        : copy.routeState[member.state]}
                      {member.peerId === mesh.authorityPeerId ? ` · ${copy.authority}` : ''}
                    </Text>
                  </div>
                </div>
                <div className="settingsPeerMeshMemberActions">
                  {mesh.role === 'authority' && member.state !== 'local' && !mesh.closed ? (
                    <MoreMenu
                      label={copy.memberActions(member.peerId)}
                      size="sm"
                      items={[
                        {
                          label: copy.remove,
                          isDisabled: props.working,
                          onClick: () => props.onRemove(member.peerId),
                        },
                      ]}
                    />
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <div className="settingsPeerMeshTechnicalIdentity settingsPeerMeshMeshId">
            <div>
              <Text type="supporting" weight="semibold">{copy.meshId}</Text>
              <Text type="supporting" color="secondary">{copy.meshIdHelp}</Text>
            </div>
            <MeshIdText meshId={mesh.meshId} copy={copy} onCopy={props.onCopyMeshId} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TransitMetric(props: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <Text type="supporting" color="secondary">
        {props.label}
      </Text>
      <Text type="body" weight="semibold">
        {props.value}
      </Text>
    </div>
  );
}

function PeerIdText(props: {
  readonly peerId: string;
  readonly copy: PeerMeshCopy;
  readonly onCopy: (peerId: string) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="settingsPeerMeshPeerId"
      label={props.copy.copyPeerId(props.peerId)}
      tooltip={props.copy.copyPeerId(props.peerId)}
      onClick={() => props.onCopy(props.peerId)}
    >
      <code>{abbreviate(props.peerId)}</code>
    </Button>
  );
}

function MeshIdText(props: {
  readonly meshId: string;
  readonly copy: PeerMeshCopy;
  readonly onCopy: (meshId: string) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="settingsPeerMeshPeerId"
      label={props.copy.copyMeshId(props.meshId)}
      tooltip={props.copy.copyMeshId(props.meshId)}
      onClick={() => props.onCopy(props.meshId)}
    >
      <code>{fingerprint(props.meshId)}</code>
    </Button>
  );
}

function decodeConnectivityPolicyDraft(
  kind: RuntimeHostWebRtcStunPolicy['kind'],
  customUrls: string,
): RuntimeHostWebRtcStunPolicy {
  return decodeRuntimeHostWebRtcStunPolicy(
    kind === 'custom'
      ? {
          kind,
          urls: customUrls
            .split(',')
            .map((url) => url.trim())
            .filter(Boolean),
        }
      : { kind },
  );
}

function tryDecodeConnectivityPolicyDraft(
  kind: RuntimeHostWebRtcStunPolicy['kind'],
  customUrls: string,
): RuntimeHostWebRtcStunPolicy | undefined {
  try {
    return decodeConnectivityPolicyDraft(kind, customUrls);
  } catch {
    return undefined;
  }
}

function connectivityPoliciesEqual(
  left: RuntimeHostWebRtcStunPolicy,
  right: RuntimeHostWebRtcStunPolicy,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind !== 'custom' || right.kind !== 'custom') return true;
  return (
    left.urls.length === right.urls.length &&
    left.urls.every((url, index) => url === right.urls[index])
  );
}

function isSnapshot(value: unknown): value is PeerMeshQueryResult {
  return Boolean(value && typeof value === 'object' && 'available' in value && 'meshes' in value);
}

function isInvitationResult(
  value: unknown,
): value is import('@maka/runtime-host/protocol').PeerMeshInvitationResult {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'invitation' in value &&
    'snapshot' in value &&
    isSnapshot((value as { readonly snapshot: unknown }).snapshot),
  );
}

function peerMeshErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return redactSecrets(raw).trim() || fallback;
}

function fingerprint(meshId: string): string {
  return meshId.length <= 16 ? meshId : `${meshId.slice(0, 8)}…${meshId.slice(-6)}`;
}

function abbreviate(peerId: string): string {
  return peerId.length <= 22 ? peerId : `${peerId.slice(0, 11)}…${peerId.slice(-7)}`;
}
