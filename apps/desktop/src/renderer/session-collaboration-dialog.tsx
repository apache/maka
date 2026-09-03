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

import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core';
import {
  Button,
  Banner,
  FormLayout,
  Text,
  TextArea,
  useToast,
  useUiLocale,
} from '@maka/ui';
import type {
  CollaborationAccessQueryResult,
  CollaborationInvitationPrepareResult,
  SessionCollaborationGrant,
  SessionTurnAccessRequest,
} from '@maka/runtime-host/protocol';
import { getSessionCollaborationCopy } from './locales/session-collaboration-copy.js';
import {
  describeTurnRequestIntent,
  turnRequestStateLabel,
} from './features/session-collaboration';

type Props = {
  readonly target?: {
    readonly sessionId: string;
    readonly sessionName: string;
    readonly requiresRemoteAccess: boolean;
  };
  readonly onOpenRemoteAccessSettings: () => void;
  readonly onClose: () => void;
};

type ShareSessionDialogProps = NonNullable<Props['target']> & Omit<Props, 'target'>;

type CollaborationAuthorityState =
  | 'loading'
  | 'available'
  | 'remote_access_off'
  | 'unavailable';

type PreparedInvitation = CollaborationInvitationPrepareResult & {
  readonly connectivity:
    | { readonly kind: 'peer'; readonly coordinationRelayCount: number }
    | { readonly kind: 'configured' };
};

export function SessionCollaborationDialog(props: Props) {
  if (!props.target) return null;
  return (
    <ShareSessionDialog
      {...props.target}
      onOpenRemoteAccessSettings={props.onOpenRemoteAccessSettings}
      onClose={props.onClose}
    />
  );
}

function ShareSessionDialog(props: ShareSessionDialogProps) {
  const copy = getSessionCollaborationCopy(useUiLocale());
  const toast = useToast();
  const [preset, setPreset] = useState<'observe' | 'request_turn'>('observe');
  const [access, setAccess] = useState<CollaborationAccessQueryResult>();
  const [invitation, setInvitation] = useState<PreparedInvitation>();
  const [turnRequests, setTurnRequests] = useState<readonly SessionTurnAccessRequest[]>();
  const [authorityState, setAuthorityState] = useState<CollaborationAuthorityState>('loading');
  const [working, setWorking] = useState(false);

  async function readProjection() {
    if (props.requiresRemoteAccess) {
      const remoteAccess = await window.maka.localRuntimeHostRemoteAccess.getSnapshot();
      if (remoteAccess.state !== 'on') return { kind: 'remote_access_off' } as const;
    }
    const [nextAccess, nextRequests] = await Promise.all([
      window.maka.sessionCollaboration.getAccess(props.sessionId),
      window.maka.sessionCollaboration.getTurnRequests(props.sessionId),
    ]);
    return {
      kind: 'available',
      access: nextAccess,
      turnRequests: nextRequests.requests,
    } as const;
  }

  function applyProjection(projection: Awaited<ReturnType<typeof readProjection>>): void {
    if (projection.kind === 'remote_access_off') {
      setAuthorityState('remote_access_off');
      return;
    }
    setAccess(projection.access);
    setTurnRequests(projection.turnRequests);
    setAuthorityState('available');
    setInvitation((current) => {
      if (!current || Date.parse(current.expiresAt) <= Date.now()) return undefined;
      const principal = projection.access.principals.find(
        (candidate) => candidate.principalId === current.principalId,
      );
      return principal?.status === 'pending' ? current : undefined;
    });
  }

  async function refresh(): Promise<void> {
    try {
      applyProjection(await readProjection());
    } catch {
      setAuthorityState('unavailable');
    }
  }

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const projection = await readProjection();
        if (!disposed) applyProjection(projection);
      } catch {
        if (!disposed) setAuthorityState('unavailable');
      } finally {
        if (!disposed) timer = window.setTimeout(() => void poll(), 2_000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [props.sessionId, props.requiresRemoteAccess]);

  async function createInvitation(allowInsecure = false): Promise<void> {
    setWorking(true);
    try {
      if (authorityState === 'remote_access_off') {
        openRemoteAccessSettings();
        return;
      }
      if (authorityState !== 'available') return;
      if (props.requiresRemoteAccess) {
        const access = await window.maka.localRuntimeHostRemoteAccess.getSnapshot();
        if (access.state !== 'on') {
          openRemoteAccessSettings();
          return;
        }
      }
      const created = await window.maka.sessionCollaboration.prepareInvitation(
        props.sessionId,
        preset,
        allowInsecure,
      );
      if (created.kind === 'insecure_confirmation_required') {
        const confirmed = await toast.confirm({
          title: copy.insecureTitle,
          description: copy.insecureBody,
          confirmLabel: copy.shareInsecure,
          cancelLabel: copy.close,
        });
        if (confirmed) await createInvitation(true);
        return;
      }
      setInvitation(created.invitation);
      await refresh();
    } catch (error) {
      toast.error(copy.shareTitle, errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  function openRemoteAccessSettings(): void {
    props.onClose();
    toast.info(copy.enableRemoteAccessTitle, copy.enableRemoteAccessBody);
    props.onOpenRemoteAccessSettings();
  }

  async function copyInvitation(): Promise<void> {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.invitationCode);
      toast.success(copy.copied);
    } catch (error) {
      toast.error(copy.shareTitle, errorMessage(error));
    }
  }

  async function revokePrincipal(principalId: string): Promise<void> {
    setWorking(true);
    try {
      await window.maka.sessionCollaboration.revokePrincipal(props.sessionId, principalId);
      await refresh();
    } catch (error) {
      toast.error(copy.shareTitle, errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  async function revokeGrant(grant: SessionCollaborationGrant): Promise<void> {
    setWorking(true);
    try {
      await window.maka.sessionCollaboration.revokeGrant(
        props.sessionId,
        grant.grantId,
      );
      await refresh();
    } catch (error) {
      toast.error(copy.shareTitle, errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  async function decideTurnRequest(
    request: SessionTurnAccessRequest,
    decision: 'approve' | 'reject',
  ): Promise<void> {
    setWorking(true);
    try {
      await window.maka.sessionCollaboration.decideTurnRequest(
        props.sessionId,
        request.requestId,
        decision,
      );
      await refresh();
    } catch (error) {
      toast.error(copy.turnRequests, errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  const grantsByPrincipal = useMemo(() => {
    const groups = new Map<string, SessionCollaborationGrant[]>();
    for (const grant of access?.grants ?? []) {
      const grants = groups.get(grant.principalId) ?? [];
      grants.push(grant);
      groups.set(grant.principalId, grants);
    }
    return groups;
  }, [access]);
  return (
    <Dialog isOpen onOpenChange={(open) => !open && !working && props.onClose()} purpose="form" width={620}>
      <Layout
        header={<DialogHeader title={copy.shareTitle} subtitle={props.sessionName} onOpenChange={(open) => !open && !working && props.onClose()} />}
        content={(
          <LayoutContent padding={4}>
            <div className="sessionCollaborationStack">
              <section className="sessionCollaborationDisclosure">
                <Text type="body" weight="semibold">{copy.disclosureTitle}</Text>
                <Text type="supporting" color="secondary">{copy.disclosureBody}</Text>
              </section>
              <SegmentedControl
                label={copy.accessLabel}
                value={preset}
                layout="fill"
                size="sm"
                isDisabled={working || invitation !== undefined}
                onChange={(value) => setPreset(value as typeof preset)}
              >
                <SegmentedControlItem value="observe" label={copy.observe} />
                <SegmentedControlItem value="request_turn" label={copy.requestTurn} />
              </SegmentedControl>
              <Text type="supporting" color="secondary">
                {preset === 'observe' ? copy.observeHelp : copy.requestTurnHelp}
              </Text>
              {invitation ? (
                <FormLayout>
                  <TextArea
                    label={copy.invitationCode}
                    value={invitation.invitationCode}
                    rows={4}
                    hasSpellCheck={false}
                    isReadOnly
                    onChange={() => undefined}
                  />
                  <Text type="supporting" color="secondary">{copy.invitationHelp}</Text>
                  {invitation.connectivity.kind === 'peer' ? (
                    invitation.connectivity.coordinationRelayCount > 0 ? (
                      <Banner
                        status="success"
                        title={copy.coordinationReady}
                        description={copy.coordinationReadyBody}
                      />
                    ) : (
                      <Banner
                        status="warning"
                        title={copy.coordinationUnavailable}
                        description={copy.coordinationUnavailableBody}
                      />
                    )
                  ) : null}
                </FormLayout>
              ) : (
                <Button
                  variant="primary"
                  label={copy.createInvitation}
                  isDisabled={
                    working ||
                    (authorityState !== 'available' && authorityState !== 'remote_access_off')
                  }
                  onClick={() => void createInvitation()}
                />
              )}
              {authorityState === 'remote_access_off' ? (
                <Text type="supporting" color="secondary">{copy.enableRemoteAccessBody}</Text>
              ) : authorityState === 'unavailable' ? (
                <Text type="supporting" color="secondary">{copy.accessUnavailable}</Text>
              ) : null}
              <section className="sessionCollaborationAccess">
                <Text type="body" weight="semibold">{copy.activeAccess}</Text>
                {access?.principals.length === 0 ? (
                  <Text type="supporting" color="secondary">{copy.noAccess}</Text>
                ) : access?.principals.map((principal) => {
                  const grants = grantsByPrincipal.get(principal.principalId) ?? [];
                  const requestGrant = grants.find((grant) => grant.kind === 'session_turn_request');
                  return (
                    <div className="sessionCollaborationAccessRow" key={principal.principalId}>
                      <div>
                        <Text type="body">{guestIdentityLabel(principal.principalId, copy.guest)}</Text>
                        <Text type="supporting" color="secondary">
                          {principal.status === 'pending' ? copy.pending : copy.active}
                          {' · '}
                          {requestGrant ? `${copy.observe} · ${copy.requestTurn}` : copy.observe}
                        </Text>
                      </div>
                      <div className="sessionCollaborationAccessActions">
                        {requestGrant ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            label={copy.revokeTurnRequests}
                            isDisabled={working || authorityState !== 'available'}
                            onClick={() => void revokeGrant(requestGrant)}
                          />
                        ) : null}
                        <Button
                          variant="secondary"
                          size="sm"
                          label={copy.revoke}
                          isDisabled={working || authorityState !== 'available'}
                          onClick={() => void revokePrincipal(principal.principalId)}
                        />
                      </div>
                    </div>
                  );
                })}
              </section>
              <section className="sessionCollaborationAccess">
                <Text type="body" weight="semibold">{copy.turnRequests}</Text>
                {turnRequests?.length === 0 ? (
                  <Text type="supporting" color="secondary">{copy.noTurnRequests}</Text>
                ) : turnRequests?.map((request) => (
                  <div className="sessionCollaborationTurnRequest" key={request.requestId}>
                    <div>
                      <Text type="body" className="sessionCollaborationTurnRequestText">
                        {describeTurnRequestIntent(request.intent, copy.regenerateRequest)}
                      </Text>
                      <Text type="supporting" color="secondary">
                        {guestIdentityLabel(request.principalId, copy.guest)}
                        {' · '}
                        {turnRequestStateLabel(request, copy)}
                      </Text>
                    </div>
                    {request.state.kind === 'pending' ? (
                      <div className="sessionCollaborationAccessActions">
                        <Button
                          variant="secondary"
                          size="sm"
                          label={copy.reject}
                          isDisabled={working || authorityState !== 'available'}
                          onClick={() => void decideTurnRequest(request, 'reject')}
                        />
                        <Button
                          variant="primary"
                          size="sm"
                          label={copy.approve}
                          isDisabled={working || authorityState !== 'available'}
                          onClick={() => void decideTurnRequest(request, 'approve')}
                        />
                      </div>
                    ) : null}
                  </div>
                ))}
              </section>
            </div>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter>
            <Button
              variant="secondary"
              label={copy.close}
              isDisabled={working}
              onClick={props.onClose}
            />
            {invitation ? (
              <Button
                variant="primary"
                label={copy.copy}
                isDisabled={working}
                onClick={() => void copyInvitation()}
              />
            ) : null}
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function guestIdentityLabel(principalId: string, label: string): string {
  const identity = principalId.includes(':') ? principalId.slice(principalId.lastIndexOf(':') + 1) : principalId;
  return `${label} ${identity.slice(0, 8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
