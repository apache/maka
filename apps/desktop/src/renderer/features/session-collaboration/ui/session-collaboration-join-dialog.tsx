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

import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import {
  Banner,
  Button,
  FormLayout,
  TextArea,
  useToast,
} from '@maka/ui';
import { useSessionCollaborationServices } from '../services-context.js';
import type {
  SessionCollaborationImportPhase,
  SessionCollaborationMountSummary,
} from '../ports.js';

export interface SessionCollaborationJoinCopy {
  readonly joinTitle: string;
  readonly joinDescription: string;
  readonly insecureTitle: string;
  readonly insecureBody: string;
  readonly joinInsecure: string;
  readonly close: string;
  readonly connectionFailed: string;
  readonly invalidCode: string;
  readonly directPathUnavailable: string;
  readonly code: string;
  readonly pasteInvitation: string;
  readonly clipboardEmpty: string;
  readonly clipboardUnavailable: string;
  readonly join: string;
  readonly validatingInvitation: string;
  readonly discoveringHost: string;
  readonly preparingRoute: string;
  readonly connectingHost: string;
  readonly authenticatingGuest: string;
  readonly finalizingAccess: string;
  readonly loadingSession: string;
  readonly recoveryStarted: string;
  readonly recoveryStartedBody: string;
  readonly retainedTasks: string;
  readonly disconnect: string;
  readonly disconnectFailed: string;
}

export function SessionCollaborationJoinDialog(props: {
  readonly copy: SessionCollaborationJoinCopy;
  readonly onImported: () => void;
  readonly onClose: () => void;
}) {
  const services = useSessionCollaborationServices();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [readingClipboard, setReadingClipboard] = useState(false);
  const [mounts, setMounts] = useState<readonly SessionCollaborationMountSummary[]>([]);
  const [removingMountId, setRemovingMountId] = useState<string>();
  const activeOperationId = useRef<string | undefined>(undefined);
  const closeAfterSettlement = useRef(false);
  const open = useRef(true);
  const [joinState, setJoinState] = useState<
    | { readonly kind: 'idle' }
    | { readonly kind: 'working'; readonly phase: SessionCollaborationImportPhase }
    | { readonly kind: 'failed'; readonly message: string }
  >({ kind: 'idle' });
  const working = joinState.kind === 'working';
  const failure = joinState.kind === 'failed' ? joinState.message : undefined;

  useEffect(() => {
    open.current = true;
    let disposed = false;
    void services.listMounts().then(
      (next) => {
        if (!disposed) setMounts(next);
      },
      () => undefined,
    );
    return () => {
      disposed = true;
      open.current = false;
      const operationId = activeOperationId.current;
      if (operationId) void services.cancelImport(operationId);
    };
  }, [services]);

  async function join(allowInsecure = false): Promise<void> {
    const operationId = services.createOperationId();
    activeOperationId.current = operationId;
    closeAfterSettlement.current = false;
    setJoinState({ kind: 'working', phase: 'validating_invitation' });
    try {
      const result = await services.importInvitation({
        code: code.trim(),
        allowInsecure,
        operationId,
      }, (phase) => {
        if (open.current && activeOperationId.current === operationId) {
          setJoinState({ kind: 'working', phase });
        }
      });
      if (!open.current || activeOperationId.current !== operationId) return;
      if (result.kind === 'error' && result.reason === 'insecure_confirmation_required') {
        if (closeAfterSettlement.current) {
          finishClose();
          return;
        }
        const confirmed = await toast.confirm({
          title: props.copy.insecureTitle,
          description: props.copy.insecureBody,
          confirmLabel: props.copy.joinInsecure,
          cancelLabel: props.copy.close,
          destructive: true,
        });
        if (confirmed && open.current && activeOperationId.current === operationId) {
          await join(true);
        }
        return;
      }
      if (result.kind === 'error') {
        if (closeAfterSettlement.current) {
          finishClose();
          return;
        }
        const message = importError(props.copy, result.reason, result.message);
        setJoinState({ kind: 'failed', message });
        toast.error(props.copy.joinTitle, message);
        return;
      }
      props.onImported();
      if (result.kind === 'recovering') {
        toast.info(props.copy.recoveryStarted, props.copy.recoveryStartedBody);
      }
      finishClose();
    } catch (error) {
      if (!open.current || activeOperationId.current !== operationId) return;
      if (closeAfterSettlement.current) {
        finishClose();
        return;
      }
      const message = errorMessage(error);
      setJoinState({ kind: 'failed', message });
      toast.error(props.copy.joinTitle, message);
    } finally {
      if (activeOperationId.current === operationId) activeOperationId.current = undefined;
      if (open.current) {
        setJoinState((current) => current.kind === 'working' ? { kind: 'idle' } : current);
      }
    }
  }

  function finishClose(): void {
    open.current = false;
    props.onClose();
  }

  async function requestClose(): Promise<void> {
    const operationId = activeOperationId.current;
    if (!operationId) {
      finishClose();
      return;
    }
    closeAfterSettlement.current = true;
    try {
      const result = await services.cancelImport(operationId);
      if (!open.current || activeOperationId.current !== operationId) return;
      if (result === 'settling') {
        setJoinState((current) =>
          current.kind === 'working' && current.phase === 'loading_session'
            ? current
            : { kind: 'working', phase: 'finalizing_access' },
        );
        return;
      }
      finishClose();
    } catch (error) {
      if (!open.current || activeOperationId.current !== operationId) return;
      const message = errorMessage(error);
      setJoinState({ kind: 'failed', message });
      toast.error(props.copy.joinTitle, message);
    }
  }

  async function disconnect(mountId: string): Promise<void> {
    setRemovingMountId(mountId);
    try {
      await services.removeMount(mountId);
      setMounts((current) => current.filter((mount) => mount.mountId !== mountId));
    } catch (error) {
      toast.error(props.copy.disconnectFailed, errorMessage(error));
    } finally {
      setRemovingMountId(undefined);
    }
  }

  async function pasteInvitation(): Promise<void> {
    if (working || readingClipboard) return;
    setReadingClipboard(true);
    try {
      const invitation = await services.readInvitationClipboard();
      if (!open.current) return;
      if (!invitation) {
        toast.info(props.copy.joinTitle, props.copy.clipboardEmpty);
        return;
      }
      setCode(invitation);
      setJoinState({ kind: 'idle' });
    } catch {
      if (open.current) {
        toast.error(props.copy.joinTitle, props.copy.clipboardUnavailable);
      }
    } finally {
      if (open.current) setReadingClipboard(false);
    }
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(nextOpen) => {
        if (!nextOpen) void requestClose();
      }}
      purpose="form"
      width={560}
    >
      <Layout
        header={(
          <DialogHeader
            title={props.copy.joinTitle}
            subtitle={props.copy.joinDescription}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) void requestClose();
            }}
          />
        )}
        content={(
          <LayoutContent padding={4}>
            <FormLayout>
              {joinState.kind === 'working' ? (
                <Banner status="info" title={importPhaseLabel(props.copy, joinState.phase)} />
              ) : null}
              {failure ? (
                <Banner
                  status="error"
                  title={props.copy.connectionFailed}
                  description={failure}
                />
              ) : null}
              <TextArea
                label={props.copy.code}
                value={code}
                rows={6}
                hasSpellCheck={false}
                isDisabled={working || readingClipboard}
                onChange={(value) => {
                  setCode(value);
                  if (joinState.kind === 'failed') setJoinState({ kind: 'idle' });
                }}
              />
              <div className="sessionCollaborationInvitationAction">
                <Button
                  variant="secondary"
                  size="sm"
                  label={props.copy.pasteInvitation}
                  isDisabled={working}
                  isLoading={readingClipboard}
                  onClick={() => void pasteInvitation()}
                />
              </div>
              {mounts.length > 0 ? (
                <List density="compact" hasDividers aria-label={props.copy.retainedTasks}>
                  {mounts.map((mount) => (
                    <ListItem
                      key={mount.mountId}
                      label={mount.name}
                      endContent={(
                        <Button
                          variant="secondary"
                          size="sm"
                          label={props.copy.disconnect}
                          isDisabled={working || removingMountId !== undefined}
                          isLoading={removingMountId === mount.mountId}
                          onClick={() => void disconnect(mount.mountId)}
                        />
                      )}
                    />
                  ))}
                </List>
              ) : null}
            </FormLayout>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter>
            <Button
              variant="secondary"
              label={props.copy.close}
              isDisabled={joinState.kind === 'working' && joinState.phase === 'finalizing_access'}
              onClick={() => void requestClose()}
            />
            <Button
              variant="primary"
              label={props.copy.join}
              isDisabled={working || readingClipboard || !code.trim()}
              isLoading={working}
              onClick={() => void join()}
            />
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function importError(
  copy: SessionCollaborationJoinCopy,
  reason:
    | 'invalid_code'
    | 'insecure_confirmation_required'
    | 'peer_path_unavailable'
    | 'connection_failed',
  message?: string,
): string {
  if (reason === 'invalid_code') return copy.invalidCode;
  if (reason === 'insecure_confirmation_required') return copy.insecureBody;
  if (reason === 'peer_path_unavailable') return copy.directPathUnavailable;
  return message ?? copy.connectionFailed;
}

function importPhaseLabel(
  copy: SessionCollaborationJoinCopy,
  phase: SessionCollaborationImportPhase,
): string {
  switch (phase) {
    case 'validating_invitation': return copy.validatingInvitation;
    case 'discovering_host': return copy.discoveringHost;
    case 'preparing_route': return copy.preparingRoute;
    case 'connecting': return copy.connectingHost;
    case 'authenticating': return copy.authenticatingGuest;
    case 'finalizing_access': return copy.finalizingAccess;
    case 'loading_session': return copy.loadingSession;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
