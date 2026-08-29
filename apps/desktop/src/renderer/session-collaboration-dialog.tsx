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

import { useEffect, useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import {
  Button,
  FormLayout,
  Text,
  TextArea,
  useToast,
  useUiLocale,
} from '@maka/ui';
import type {
  CollaborationAccessQueryResult,
  CollaborationInvitationPrepareResult,
} from '@maka/runtime-host/protocol';
import { getSessionCollaborationCopy } from './locales/session-collaboration-copy.js';

type Props =
  | {
      readonly mode: 'share';
      readonly sessionId: string;
      readonly sessionName: string;
      readonly onClose: () => void;
    }
  | {
      readonly mode: 'join';
      readonly onImported: () => void;
      readonly onClose: () => void;
    };

export function SessionCollaborationDialog(props: Props) {
  return props.mode === 'share'
    ? <ShareSessionDialog {...props} />
    : <JoinSharedSessionDialog {...props} />;
}

function ShareSessionDialog(props: Extract<Props, { readonly mode: 'share' }>) {
  const copy = getSessionCollaborationCopy(useUiLocale());
  const toast = useToast();
  const [access, setAccess] = useState<CollaborationAccessQueryResult>();
  const [invitation, setInvitation] = useState<CollaborationInvitationPrepareResult>();
  const [working, setWorking] = useState(false);

  async function refresh(): Promise<void> {
    const nextAccess = await window.maka.sessionCollaboration.getAccess(props.sessionId);
    setAccess(nextAccess);
    setInvitation((current) => {
      if (!current || Date.parse(current.expiresAt) <= Date.now()) return undefined;
      const principal = nextAccess.principals.find(
        (candidate) => candidate.principalId === current.principalId,
      );
      return principal?.status === 'pending' ? current : undefined;
    });
  }

  useEffect(() => {
    const poll = () => void refresh().catch(() => undefined);
    void refresh().catch((error) => toast.error(copy.shareTitle, errorMessage(error)));
    const timer = window.setInterval(poll, 2_000);
    return () => window.clearInterval(timer);
  }, [props.sessionId]);

  async function createInvitation(allowInsecure = false): Promise<void> {
    setWorking(true);
    try {
      const result = await window.maka.sessionCollaboration.prepareInvitation(
        props.sessionId,
        allowInsecure,
      );
      if (result.kind === 'insecure_confirmation_required') {
        const confirmed = await toast.confirm({
          title: copy.insecureTitle,
          description: copy.insecureBody,
          confirmLabel: copy.shareInsecure,
          cancelLabel: copy.close,
        });
        if (confirmed) await createInvitation(true);
        return;
      }
      setInvitation(result.invitation);
      await refresh();
    } catch (error) {
      toast.error(copy.shareTitle, errorMessage(error));
    } finally {
      setWorking(false);
    }
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
              <Text type="supporting" color="secondary">{copy.observeHelp}</Text>
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
                  <Button variant="secondary" label={copy.copy} onClick={() => void copyInvitation()} />
                </FormLayout>
              ) : (
                <Button
                  variant="primary"
                  label={copy.createInvitation}
                  isDisabled={working}
                  onClick={() => void createInvitation()}
                />
              )}
              <section className="sessionCollaborationAccess">
                <Text type="body" weight="semibold">{copy.activeAccess}</Text>
                {(access?.principals.length ?? 0) === 0 ? (
                  <Text type="supporting" color="secondary">{copy.noAccess}</Text>
                ) : access?.principals.map((principal) => (
                    <div className="sessionCollaborationAccessRow" key={principal.principalId}>
                      <div>
                        <Text type="body">{principal.status === 'pending' ? copy.pending : copy.active}</Text>
                        <Text type="supporting" color="secondary">{copy.observe}</Text>
                      </div>
                      <div className="sessionCollaborationAccessActions">
                        <Button
                          variant="secondary"
                          size="sm"
                          label={copy.revoke}
                          isDisabled={working}
                          onClick={() => void revokePrincipal(principal.principalId)}
                        />
                      </div>
                    </div>
                  ))}
              </section>
            </div>
          </LayoutContent>
        )}
        footer={<LayoutFooter><Button variant="secondary" label={copy.close} isDisabled={working} onClick={props.onClose} /></LayoutFooter>}
      />
    </Dialog>
  );
}

function JoinSharedSessionDialog(props: Extract<Props, { readonly mode: 'join' }>) {
  const copy = getSessionCollaborationCopy(useUiLocale());
  const toast = useToast();
  const [code, setCode] = useState('');
  const [working, setWorking] = useState(false);

  async function join(allowInsecure = false): Promise<void> {
    setWorking(true);
    try {
      const result = await window.maka.sessionCollaboration.importInvitation({
        code: code.trim(),
        allowInsecure,
      });
      if (result.kind === 'error' && result.reason === 'insecure_confirmation_required') {
        const confirmed = await toast.confirm({
          title: copy.insecureTitle,
          description: copy.insecureBody,
          confirmLabel: copy.joinInsecure,
          cancelLabel: copy.close,
          destructive: true,
        });
        if (confirmed) await join(true);
        return;
      }
      if (result.kind === 'error') {
        toast.error(copy.joinTitle, importError(copy, result.reason, result.message));
        return;
      }
      props.onImported();
      props.onClose();
    } catch (error) {
      toast.error(copy.joinTitle, errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog isOpen onOpenChange={(open) => !open && !working && props.onClose()} purpose="form" width={560}>
      <Layout
        header={<DialogHeader title={copy.joinTitle} subtitle={copy.joinDescription} onOpenChange={(open) => !open && !working && props.onClose()} />}
        content={(
          <LayoutContent padding={4}>
            <FormLayout>
              <TextArea
                label={copy.code}
                value={code}
                rows={6}
                hasSpellCheck={false}
                isDisabled={working}
                onChange={setCode}
              />
            </FormLayout>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter>
            <Button variant="secondary" label={copy.close} isDisabled={working} onClick={props.onClose} />
            <Button variant="primary" label={copy.join} isDisabled={working || !code.trim()} onClick={() => void join()} />
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function importError(
  copy: ReturnType<typeof getSessionCollaborationCopy>,
  reason:
    | 'invalid_code'
    | 'insecure_confirmation_required'
    | 'connection_failed',
  message?: string,
): string {
  if (reason === 'invalid_code') return copy.invalidCode;
  if (reason === 'insecure_confirmation_required') return copy.insecureBody;
  return message ?? copy.connectionFailed;
}
