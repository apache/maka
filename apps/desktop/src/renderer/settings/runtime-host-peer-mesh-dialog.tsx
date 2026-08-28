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

import { useCallback, useEffect, useState } from 'react';
import { Banner } from '@astryxdesign/core';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { HStack } from '@astryxdesign/core/Stack';
import type { PeerMeshProjection, PeerMeshQueryResult } from '@maka/runtime-host/protocol';
import {
  Badge,
  Button,
  MoreMenu,
  redactSecrets,
  Text,
  TextArea,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { ArrowLeft, Copy, RefreshCcw } from '@maka/ui/icons';
import type { DesktopRuntimeHostPeerMeshTarget } from '../../preload/bridge-contract.js';

type PeerMeshDialogView =
  | { readonly kind: 'overview' }
  | { readonly kind: 'join' }
  | {
      readonly kind: 'invitation';
      readonly meshId: string;
      readonly code: string;
      readonly expiresAt: number;
    };

export function RuntimeHostPeerMeshDialog(props: {
  readonly target: DesktopRuntimeHostPeerMeshTarget;
  readonly targetName: string;
  readonly onClose: () => void;
}) {
  const locale = useUiLocale();
  const copy = peerMeshCopy(locale);
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<PeerMeshQueryResult>();
  const [joinDraft, setJoinDraft] = useState('');
  const [view, setView] = useState<PeerMeshDialogView>({ kind: 'overview' });
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  const refresh = useCallback(async () => {
    const result = await window.maka.runtimeHostPeerMesh.execute(props.target, 'status');
    if (!isSnapshot(result)) throw new Error(copy.invalidResult);
    setSnapshot(result);
  }, [copy.invalidResult, props.target]);

  useEffect(() => {
    void refresh().catch((failure) => setError(peerMeshErrorMessage(failure, copy.unknownError)));
  }, [copy.unknownError, refresh]);

  async function run(action: 'create' | 'reconcile'): Promise<void> {
    setWorking(true);
    setError(undefined);
    try {
      const result = await window.maka.runtimeHostPeerMesh.execute(props.target, action);
      if (!isSnapshot(result)) throw new Error(copy.invalidResult);
      setSnapshot(result);
    } catch (failure) {
      setError(peerMeshErrorMessage(failure, copy.unknownError));
    } finally {
      setWorking(false);
    }
  }

  async function join(): Promise<void> {
    setWorking(true);
    setError(undefined);
    try {
      const result = await window.maka.runtimeHostPeerMesh.execute(props.target, 'join', {
        invitation: joinDraft.trim(),
      });
      if (!isSnapshot(result)) throw new Error(copy.invalidResult);
      setJoinDraft('');
      setView({ kind: 'overview' });
      setSnapshot(result);
    } catch (failure) {
      setError(peerMeshErrorMessage(failure, copy.unknownError));
    } finally {
      setWorking(false);
    }
  }

  async function createInvitation(meshId: string): Promise<void> {
    setWorking(true);
    setError(undefined);
    try {
      const result = await window.maka.runtimeHostPeerMesh.execute(props.target, 'invite', {
        meshId,
      });
      if (!isInvitationResult(result)) throw new Error(copy.invalidResult);
      setView({
        kind: 'invitation',
        meshId,
        code: JSON.stringify(result.invitation),
        expiresAt: result.invitation.expiresAt,
      });
      setSnapshot(result.snapshot);
    } catch (failure) {
      setError(peerMeshErrorMessage(failure, copy.unknownError));
    } finally {
      setWorking(false);
    }
  }

  async function mutate(
    action: 'remove' | 'leave' | 'close',
    meshId: string,
    peerId?: string,
  ): Promise<void> {
    const confirmed = await toast.confirm({
      title: action === 'close' ? copy.closeConfirm : action === 'leave' ? copy.leaveConfirm : copy.removeConfirm,
      confirmLabel: action === 'close' ? copy.closeMesh : action === 'leave' ? copy.leave : copy.remove,
      cancelLabel: copy.cancel,
      destructive: action !== 'leave',
    });
    if (!confirmed) return;
    setWorking(true);
    setError(undefined);
    try {
      const result = await window.maka.runtimeHostPeerMesh.execute(props.target, action, {
        meshId,
        peerId,
      });
      if (!isSnapshot(result)) throw new Error(copy.invalidResult);
      setSnapshot(result);
    } catch (failure) {
      setError(peerMeshErrorMessage(failure, copy.unknownError));
    } finally {
      setWorking(false);
    }
  }

  async function copyInvitation(): Promise<void> {
    if (view.kind !== 'invitation') return;
    try {
      await navigator.clipboard.writeText(view.code);
      toast.success(copy.invitationCopied);
    } catch (failure) {
      setError(peerMeshErrorMessage(failure, copy.unknownError));
    }
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open && !working) props.onClose();
      }}
      purpose="form"
      width={720}
      maxHeight="calc(100dvh - 64px)"
    >
      <Layout
        header={(
          <DialogHeader
            title={copy.title}
            subtitle={props.targetName}
            onOpenChange={(open) => {
              if (!open && !working) props.onClose();
            }}
          />
        )}
        content={(
          <LayoutContent padding={4}>
            <div className="settingsPeerMesh">
              {error ? <Banner status="error" title={copy.failed} description={error} /> : null}
              {view.kind === 'invitation' ? (
                <InvitationView invitation={view} copy={copy} />
              ) : view.kind === 'join' ? (
                <JoinView
                  value={joinDraft}
                  working={working}
                  copy={copy}
                  onChange={setJoinDraft}
                />
              ) : (
                <Overview
                  snapshot={snapshot}
                  copy={copy}
                  working={working}
                  onInvite={(meshId) => void createInvitation(meshId)}
                  onRemove={(meshId, peerId) => void mutate('remove', meshId, peerId)}
                  onLeave={(meshId) => void mutate('leave', meshId)}
                  onClose={(meshId) => void mutate('close', meshId)}
                />
              )}
            </div>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            {view.kind === 'overview' ? (
              <HStack gap={2} hAlign="between" vAlign="center">
                <Button
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  label={copy.refresh}
                  icon={<RefreshCcw size={16} aria-hidden="true" />}
                  isDisabled={working}
                  onClick={() => void run('reconcile')}
                />
                <HStack gap={2}>
                  <Button
                    variant="secondary"
                    label={copy.joinMesh}
                    isDisabled={working || !snapshot?.available}
                    onClick={() => setView({ kind: 'join' })}
                  />
                  <Button
                    variant="primary"
                    label={copy.create}
                    isDisabled={working || !snapshot?.available}
                    onClick={() => void run('create')}
                  />
                </HStack>
              </HStack>
            ) : (
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
            )}
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function Overview(props: {
  readonly snapshot: PeerMeshQueryResult | undefined;
  readonly copy: ReturnType<typeof peerMeshCopy>;
  readonly working: boolean;
  readonly onInvite: (meshId: string) => void;
  readonly onRemove: (meshId: string, peerId: string) => void;
  readonly onLeave: (meshId: string) => void;
  readonly onClose: (meshId: string) => void;
}) {
  const { snapshot, copy } = props;
  if (!snapshot) {
    return <Text type="supporting" color="secondary">{copy.loading}</Text>;
  }
  if (!snapshot.available) {
    return <Banner status="warning" title={copy.unavailable} />;
  }
  return (
    <>
      <div className="settingsPeerMeshIdentity">
        <Text type="supporting" color="secondary">{copy.thisPeer}</Text>
        <code title={snapshot.localPeerId}>{snapshot.localPeerId ? abbreviate(snapshot.localPeerId) : '—'}</code>
      </div>
      {snapshot.meshes.length === 0 ? (
        <div className="settingsPeerMeshEmpty">
          <Text type="body" weight="semibold">{copy.empty}</Text>
          <Text type="supporting" color="secondary">{copy.emptyHint}</Text>
        </div>
      ) : (
        <div className="settingsPeerMeshList">
          {snapshot.meshes.map((mesh) => (
            <MeshCard
              key={mesh.meshId}
              mesh={mesh}
              copy={copy}
              working={props.working}
              onInvite={() => props.onInvite(mesh.meshId)}
              onRemove={(peerId) => props.onRemove(mesh.meshId, peerId)}
              onLeave={() => props.onLeave(mesh.meshId)}
              onClose={() => props.onClose(mesh.meshId)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function JoinView(props: {
  readonly value: string;
  readonly working: boolean;
  readonly copy: ReturnType<typeof peerMeshCopy>;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="settingsPeerMeshFocusedView">
      <div>
        <Text type="body" weight="semibold">{props.copy.joinTitle}</Text>
        <Text type="supporting" color="secondary">{props.copy.joinHint}</Text>
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
  readonly copy: ReturnType<typeof peerMeshCopy>;
}) {
  return (
    <div className="settingsPeerMeshFocusedView">
      <div>
        <Text type="body" weight="semibold">{props.copy.invitationTitle}</Text>
        <Text type="supporting" color="secondary">
          {props.copy.invitationFor(fingerprint(props.invitation.meshId))}
        </Text>
      </div>
      <Banner status="warning" title={props.copy.invitationWarning} />
      <div className="settingsPeerMeshInvitationCode">
        <code>{props.invitation.code}</code>
      </div>
      <Text type="supporting" color="secondary">
        {props.copy.invitationExpires(new Date(props.invitation.expiresAt).toLocaleString())}
      </Text>
    </div>
  );
}

function MeshCard(props: {
  readonly mesh: PeerMeshProjection;
  readonly copy: ReturnType<typeof peerMeshCopy>;
  readonly working: boolean;
  readonly onInvite: () => void;
  readonly onRemove: (peerId: string) => void;
  readonly onLeave: () => void;
  readonly onClose: () => void;
}) {
  const { mesh, copy } = props;
  return (
    <section className="settingsPeerMeshCard">
      <div className="settingsPeerMeshCardHeading">
        <div>
          <code className="settingsPeerMeshName" title={mesh.meshId}>
            {fingerprint(mesh.meshId)}
          </code>
          <Text type="supporting" color="secondary">
            {copy.revision(mesh.revision)} · {copy.memberCount(mesh.members.length)}
            {mesh.pendingInvitationCount > 0 ? ` · ${copy.pending(mesh.pendingInvitationCount)}` : ''}
          </Text>
        </div>
        <Badge
          variant={mesh.closed ? 'neutral' : mesh.role === 'authority' ? 'success' : 'info'}
          label={mesh.closed ? copy.closed : mesh.role === 'authority' ? copy.authority : copy.member}
        />
      </div>
      <div className="settingsPeerMeshMembers">
        {mesh.members.map((member) => (
          <div className="settingsPeerMeshMember" key={member.peerId}>
            <code title={member.peerId}>{abbreviate(member.peerId)}</code>
            <div className="settingsPeerMeshMemberActions">
              <Badge variant="neutral" label={copy.routeState[member.state]} />
              {member.peerId === mesh.authorityPeerId ? (
                <Badge variant="neutral" label={copy.authority} />
              ) : null}
              {mesh.role === 'authority' && member.state !== 'local' && !mesh.closed ? (
                <MoreMenu
                  label={copy.memberActions(member.peerId)}
                  size="sm"
                  items={[{
                    label: copy.remove,
                    isDisabled: props.working,
                    onClick: () => props.onRemove(member.peerId),
                  }]}
                />
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {!mesh.closed ? (
        <div className="settingsPeerMeshActions">
          {mesh.role === 'authority' ? (
            <>
              <Button variant="secondary" size="sm" label={copy.invite} isDisabled={props.working} onClick={props.onInvite} />
              <MoreMenu
                label={copy.meshActions}
                size="sm"
                items={[{ label: copy.closeMesh, isDisabled: props.working, onClick: props.onClose }]}
              />
            </>
          ) : (
            <Button variant="secondary" size="sm" label={copy.leave} isDisabled={props.working} onClick={props.onLeave} />
          )}
        </div>
      ) : null}
    </section>
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

function peerMeshCopy(locale: string) {
  const zh = locale.startsWith('zh');
  return zh ? {
    title: 'Peer Mesh（实验性）', failed: 'Peer Mesh 操作失败', invalidResult: 'Peer Mesh 返回了无效结果', unknownError: 'Peer Mesh 操作失败',
    unavailable: '当前 endpoint 不支持 Peer Mesh', loading: '正在读取 Mesh 状态…', thisPeer: '当前 Peer', empty: '尚未加入 Mesh',
    emptyHint: '创建一个新 Mesh，或使用邀请码加入现有 Mesh。',
    authority: '管理者', member: '成员', closed: '已关闭',
    revision: (value: number) => `版本 ${value}`, memberCount: (value: number) => `${value} 个成员`,
    pending: (value: number) => `${value} 个待使用邀请`,
    routeState: { local: '本机', route_available: '路径可用', coordination_only: '仅协调路径', stale: '路径已过期', unknown: '路径未知' },
    joinTitle: '加入 Mesh', joinHint: '粘贴另一个 Peer 生成的一次性邀请码。', joinCode: '邀请码', join: '加入', joinMesh: '加入 Mesh', invite: '邀请成员',
    invitationTitle: '邀请成员', invitationFor: (value: string) => `Mesh ${value}`,
    invitationWarning: '该代码只能使用一次；获得代码的人可以让一个 peer 加入此 Mesh。',
    invitationExpires: (value: string) => `有效期至 ${value}`,
    invitationCopied: '邀请码已复制', copyInvitation: '复制邀请码', create: '创建 Mesh', refresh: '同步', back: '返回',
    leave: '退出 Mesh', closeMesh: '关闭 Mesh', remove: '移除成员', cancel: '取消',
    closeConfirm: '关闭这个 Mesh？', leaveConfirm: '退出这个 Mesh？', removeConfirm: '移除这个成员？',
    meshActions: 'Mesh 操作', memberActions: (peerId: string) => `${peerId} 的操作`,
  } : {
    title: 'Peer Mesh (experimental)', failed: 'Peer Mesh operation failed', invalidResult: 'Peer Mesh returned an invalid result', unknownError: 'Peer Mesh operation failed',
    unavailable: 'Peer Mesh is unavailable for this endpoint', loading: 'Loading Mesh status…', thisPeer: 'This peer', empty: 'Not a member of a Mesh yet',
    emptyHint: 'Create a new Mesh or join an existing one with an invitation.',
    authority: 'Authority', member: 'Member', closed: 'Closed',
    revision: (value: number) => `Revision ${value}`, memberCount: (value: number) => `${value} members`,
    pending: (value: number) => `${value} pending invites`,
    routeState: { local: 'Local', route_available: 'Route known', coordination_only: 'Coordination only', stale: 'Stale route', unknown: 'Route unknown' },
    joinTitle: 'Join a Mesh', joinHint: 'Paste a one-time invitation created by another peer.', joinCode: 'Invitation', join: 'Join', joinMesh: 'Join Mesh', invite: 'Invite member',
    invitationTitle: 'Invite a member', invitationFor: (value: string) => `Mesh ${value}`,
    invitationWarning: 'This code works once. Anyone holding it can admit one peer to this Mesh.',
    invitationExpires: (value: string) => `Expires ${value}`,
    invitationCopied: 'Invitation copied', copyInvitation: 'Copy invitation', create: 'Create Mesh', refresh: 'Sync', back: 'Back',
    leave: 'Leave Mesh', closeMesh: 'Close Mesh', remove: 'Remove member', cancel: 'Cancel',
    closeConfirm: 'Close this Mesh?', leaveConfirm: 'Leave this Mesh?', removeConfirm: 'Remove this member?',
    meshActions: 'Mesh actions', memberActions: (peerId: string) => `Actions for ${peerId}`,
  };
}
