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
import type { PeerMeshProjection, PeerMeshQueryResult } from '@maka/runtime-host/protocol';
import { Badge, Button, MoreMenu, Text, TextArea, useToast, useUiLocale } from '@maka/ui';
import type { DesktopRuntimeHostPeerMeshTarget } from '../../preload/bridge-contract.js';
import { settingsActionErrorMessage } from './settings-error-copy.js';

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
  const [invitation, setInvitation] = useState<{
    readonly meshId: string;
    readonly code: string;
    readonly expiresAt: number;
  }>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  const refresh = useCallback(async () => {
    const result = await window.maka.runtimeHostPeerMesh.execute(props.target, 'status');
    if (!isSnapshot(result)) throw new Error(copy.invalidResult);
    setSnapshot(result);
  }, [copy.invalidResult, props.target]);

  useEffect(() => {
    void refresh().catch((failure) => setError(settingsActionErrorMessage(failure, locale)));
  }, [locale, refresh]);

  async function run(action: 'create' | 'reconcile'): Promise<void> {
    setWorking(true);
    setError(undefined);
    try {
      await window.maka.runtimeHostPeerMesh.execute(props.target, action);
      await refresh();
    } catch (failure) {
      setError(settingsActionErrorMessage(failure, locale));
    } finally {
      setWorking(false);
    }
  }

  async function join(): Promise<void> {
    setWorking(true);
    setError(undefined);
    try {
      await window.maka.runtimeHostPeerMesh.execute(props.target, 'join', {
        invitation: joinDraft.trim(),
      });
      setJoinDraft('');
      await refresh();
    } catch (failure) {
      setError(settingsActionErrorMessage(failure, locale));
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
      if (!('expiresAt' in result)) throw new Error(copy.invalidResult);
      setInvitation({ meshId, code: JSON.stringify(result), expiresAt: result.expiresAt });
      await refresh();
    } catch (failure) {
      setError(settingsActionErrorMessage(failure, locale));
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
      await window.maka.runtimeHostPeerMesh.execute(props.target, action, { meshId, peerId });
      if (action === 'close' && invitation?.meshId === meshId) setInvitation(undefined);
      await refresh();
    } catch (failure) {
      setError(settingsActionErrorMessage(failure, locale));
    } finally {
      setWorking(false);
    }
  }

  async function copyInvitation(): Promise<void> {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.code);
      toast.success(copy.invitationCopied);
    } catch (failure) {
      setError(settingsActionErrorMessage(failure, locale));
    }
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open && !working) props.onClose();
      }}
      purpose="form"
      width={680}
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
              {snapshot && !snapshot.available ? (
                <Banner status="warning" title={copy.unavailable} />
              ) : null}
              {snapshot?.available ? (
                <div className="settingsPeerMeshIdentity">
                  <Text type="supporting" color="secondary">{copy.thisPeer}</Text>
                  <code>{snapshot.localPeerId ? abbreviate(snapshot.localPeerId) : '—'}</code>
                </div>
              ) : null}
              {snapshot?.meshes.length === 0 ? (
                <Text type="supporting" color="secondary">{copy.empty}</Text>
              ) : null}
              {snapshot?.meshes.map((mesh) => (
                <MeshCard
                  key={mesh.meshId}
                  mesh={mesh}
                  copy={copy}
                  working={working}
                  onInvite={() => void createInvitation(mesh.meshId)}
                  onRemove={(peerId) => void mutate('remove', mesh.meshId, peerId)}
                  onLeave={() => void mutate('leave', mesh.meshId)}
                  onClose={() => void mutate('close', mesh.meshId)}
                />
              ))}
              {snapshot?.available ? (
                <div className="settingsPeerMeshJoin">
                  <TextArea
                    label={copy.joinCode}
                    value={joinDraft}
                    rows={3}
                    hasSpellCheck={false}
                    isDisabled={working}
                    onChange={setJoinDraft}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    label={copy.join}
                    isDisabled={working || !joinDraft.trim()}
                    onClick={() => void join()}
                  />
                </div>
              ) : null}
              {invitation ? (
                <div className="settingsPeerMeshInvitation">
                  <Banner status="warning" title={copy.invitationWarning} />
                  <Text type="supporting" color="secondary">
                    {copy.invitationExpires(new Date(invitation.expiresAt).toLocaleString())}
                  </Text>
                  <TextArea
                    label={copy.invitation}
                    value={invitation.code}
                    rows={4}
                    hasSpellCheck={false}
                    isReadOnly
                    onChange={() => undefined}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    label={copy.copyInvitation}
                    onClick={() => void copyInvitation()}
                  />
                </div>
              ) : null}
            </div>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter>
            <Button variant="secondary" label={copy.done} isDisabled={working} onClick={props.onClose} />
            <Button
              variant="secondary"
              label={copy.refresh}
              isDisabled={working || !snapshot?.available}
              onClick={() => void run('reconcile')}
            />
            <Button
              variant="primary"
              label={copy.create}
              isDisabled={working || !snapshot?.available}
              onClick={() => void run('create')}
            />
          </LayoutFooter>
        )}
      />
    </Dialog>
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
          <Text type="body" weight="semibold">{copy.mesh} {fingerprint(mesh.meshId)}</Text>
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
        {mesh.members.map((peerId) => (
          <div className="settingsPeerMeshMember" key={peerId}>
            <code title={peerId}>{abbreviate(peerId)}</code>
            <div className="settingsPeerMeshMemberActions">
              <Badge
                variant="neutral"
                label={copy.routeState[
                  mesh.memberRoutes.find((route) => route.peerId === peerId)?.state ?? 'unknown'
                ]}
              />
              {peerId === mesh.localPeerId ? <Badge variant="neutral" label={copy.you} /> : null}
              {peerId === mesh.authorityPeerId ? <Badge variant="neutral" label={copy.authority} /> : null}
              {mesh.role === 'authority' && peerId !== mesh.localPeerId && !mesh.closed ? (
                <MoreMenu
                  label={copy.memberActions(peerId)}
                  size="sm"
                  items={[{ label: copy.remove, isDisabled: props.working, onClick: () => props.onRemove(peerId) }]}
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

function fingerprint(meshId: string): string {
  return meshId.length <= 16 ? meshId : `${meshId.slice(0, 8)}…${meshId.slice(-6)}`;
}

function abbreviate(peerId: string): string {
  return peerId.length <= 22 ? peerId : `${peerId.slice(0, 11)}…${peerId.slice(-7)}`;
}

function peerMeshCopy(locale: string) {
  const zh = locale.startsWith('zh');
  return zh ? {
    title: 'Peer Mesh（实验性）', failed: 'Peer Mesh 操作失败', invalidResult: 'Peer Mesh 返回了无效结果',
    unavailable: '当前 endpoint 不支持 Peer Mesh', thisPeer: '当前 Peer', empty: '尚未加入任何 Mesh',
    mesh: 'Mesh', authority: '管理者', member: '成员', closed: '已关闭', you: '本机',
    revision: (value: number) => `版本 ${value}`, memberCount: (value: number) => `${value} 个成员`,
    pending: (value: number) => `${value} 个待使用邀请`,
    routeState: { local: '本机', route_available: '路径可用', coordination_only: '仅协调路径', stale: '路径已过期', unknown: '路径未知' },
    joinCode: '邀请代码', join: '加入', invitation: '邀请代码', invite: '邀请成员',
    invitationWarning: '该代码只能使用一次；获得代码的人可以让一个 peer 加入此 Mesh。',
    invitationExpires: (value: string) => `有效期至 ${value}`,
    invitationCopied: '邀请代码已复制', copyInvitation: '复制', create: '创建 Mesh', refresh: '同步', done: '完成',
    leave: '退出 Mesh', closeMesh: '关闭 Mesh', remove: '移除成员', cancel: '取消',
    closeConfirm: '关闭这个 Mesh？', leaveConfirm: '退出这个 Mesh？', removeConfirm: '移除这个成员？',
    meshActions: 'Mesh 操作', memberActions: (peerId: string) => `${peerId} 的操作`,
  } : {
    title: 'Peer Mesh (experimental)', failed: 'Peer Mesh operation failed', invalidResult: 'Peer Mesh returned an invalid result',
    unavailable: 'Peer Mesh is unavailable for this endpoint', thisPeer: 'This peer', empty: 'Not a member of any Mesh yet',
    mesh: 'Mesh', authority: 'Authority', member: 'Member', closed: 'Closed', you: 'This peer',
    revision: (value: number) => `Revision ${value}`, memberCount: (value: number) => `${value} members`,
    pending: (value: number) => `${value} pending invites`,
    routeState: { local: 'Local', route_available: 'Route known', coordination_only: 'Coordination only', stale: 'Stale route', unknown: 'Route unknown' },
    joinCode: 'Invitation code', join: 'Join', invitation: 'Invitation code', invite: 'Invite member',
    invitationWarning: 'This code works once. Anyone holding it can admit one peer to this Mesh.',
    invitationExpires: (value: string) => `Expires ${value}`,
    invitationCopied: 'Invitation code copied', copyInvitation: 'Copy', create: 'Create Mesh', refresh: 'Sync', done: 'Done',
    leave: 'Leave Mesh', closeMesh: 'Close Mesh', remove: 'Remove member', cancel: 'Cancel',
    closeConfirm: 'Close this Mesh?', leaveConfirm: 'Leave this Mesh?', removeConfirm: 'Remove this member?',
    meshActions: 'Mesh actions', memberActions: (peerId: string) => `Actions for ${peerId}`,
  };
}
