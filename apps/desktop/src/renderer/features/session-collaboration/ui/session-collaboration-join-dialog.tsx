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
import { List, ListItem } from '@astryxdesign/core/List';
import {
  Banner,
  Button,
  FormLayout,
  TextArea,
  useToast,
} from '@maka/ui';
import { useSessionCollaborationServices } from '../services-context.js';
import type { SessionCollaborationMountSummary } from '../ports.js';

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
  readonly join: string;
  readonly joining: string;
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
  const [mounts, setMounts] = useState<readonly SessionCollaborationMountSummary[]>([]);
  const [removingMountId, setRemovingMountId] = useState<string>();
  const [joinState, setJoinState] = useState<
    | { readonly kind: 'idle' }
    | { readonly kind: 'working' }
    | { readonly kind: 'failed'; readonly message: string }
  >({ kind: 'idle' });
  const working = joinState.kind === 'working';
  const failure = joinState.kind === 'failed' ? joinState.message : undefined;

  useEffect(() => {
    let disposed = false;
    void services.listMounts().then(
      (next) => {
        if (!disposed) setMounts(next);
      },
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, [services]);

  async function join(allowInsecure = false): Promise<void> {
    setJoinState({ kind: 'working' });
    try {
      const result = await services.importInvitation({
        code: code.trim(),
        allowInsecure,
      });
      if (result.kind === 'error' && result.reason === 'insecure_confirmation_required') {
        const confirmed = await toast.confirm({
          title: props.copy.insecureTitle,
          description: props.copy.insecureBody,
          confirmLabel: props.copy.joinInsecure,
          cancelLabel: props.copy.close,
          destructive: true,
        });
        if (confirmed) await join(true);
        return;
      }
      if (result.kind === 'error') {
        const message = importError(props.copy, result.reason, result.message);
        setJoinState({ kind: 'failed', message });
        toast.error(props.copy.joinTitle, message);
        return;
      }
      props.onImported();
      props.onClose();
    } catch (error) {
      const message = errorMessage(error);
      setJoinState({ kind: 'failed', message });
      toast.error(props.copy.joinTitle, message);
    } finally {
      setJoinState((current) => current.kind === 'working' ? { kind: 'idle' } : current);
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

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && !working && props.onClose()}
      purpose="form"
      width={560}
    >
      <Layout
        header={(
          <DialogHeader
            title={props.copy.joinTitle}
            subtitle={props.copy.joinDescription}
            onOpenChange={(open) => !open && !working && props.onClose()}
          />
        )}
        content={(
          <LayoutContent padding={4}>
            <FormLayout>
              {working ? <Banner status="info" title={props.copy.joining} /> : null}
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
                isDisabled={working}
                onChange={setCode}
              />
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
              isDisabled={working}
              onClick={props.onClose}
            />
            <Button
              variant="primary"
              label={props.copy.join}
              isDisabled={working || !code.trim()}
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
