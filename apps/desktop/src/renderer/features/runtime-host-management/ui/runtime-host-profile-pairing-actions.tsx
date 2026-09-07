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

import { useState } from 'react';
import { Button, MoreMenu, type MoreMenuProps, useToast } from '@maka/ui';
import { useRuntimeHostManagementServices } from '../services-context.js';

export interface RuntimeHostPairingActionCopy {
  readonly retry: string;
  readonly retryFailed: string;
  readonly discard: string;
  readonly discardConfirmTitle: string;
  readonly discardConfirmBody: string;
  readonly discardFailed: string;
  readonly cancel: string;
}

interface PairingActionProps {
  readonly profileId?: string;
  readonly isDisabled: boolean;
  readonly copy: RuntimeHostPairingActionCopy;
  readonly errorMessage: (error: unknown) => string;
  readonly onChanged: () => void;
  readonly onWorkingChange: (working: boolean) => void;
}

export function RuntimeHostPairingRecoveryButton(props: PairingActionProps) {
  const [working, setWorking] = useState(false);
  const services = useRuntimeHostManagementServices();
  const toast = useToast();

  async function retry(): Promise<void> {
    setWorking(true);
    props.onWorkingChange(true);
    try {
      await services.profilePairing.retry(props.profileId);
      props.onChanged();
    } catch (error) {
      props.onChanged();
      toast.error(props.copy.retryFailed, props.errorMessage(error));
    } finally {
      setWorking(false);
      props.onWorkingChange(false);
    }
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      label={props.copy.retry}
      isDisabled={props.isDisabled || working}
      isLoading={working}
      onClick={() => void retry()}
    />
  );
}

export function RuntimeHostProfileMoreMenu(props: PairingActionProps & {
  readonly label: string;
  readonly pairingPending: boolean;
  readonly items: MoreMenuProps['items'];
}) {
  const [working, setWorking] = useState(false);
  const services = useRuntimeHostManagementServices();
  const toast = useToast();

  async function retry(): Promise<void> {
    if (!props.profileId) return;
    setWorking(true);
    props.onWorkingChange(true);
    try {
      await services.profilePairing.retry(props.profileId);
      props.onChanged();
    } catch (error) {
      props.onChanged();
      toast.error(props.copy.retryFailed, props.errorMessage(error));
    } finally {
      setWorking(false);
      props.onWorkingChange(false);
    }
  }

  async function discard(): Promise<void> {
    if (!props.profileId) return;
    const confirmed = await toast.confirm({
      title: props.copy.discardConfirmTitle,
      description: props.copy.discardConfirmBody,
      confirmLabel: props.copy.discard,
      cancelLabel: props.copy.cancel,
      destructive: true,
    });
    if (!confirmed) return;
    setWorking(true);
    props.onWorkingChange(true);
    try {
      await services.profilePairing.discard(props.profileId);
      props.onChanged();
    } catch (error) {
      props.onChanged();
      toast.error(props.copy.discardFailed, props.errorMessage(error));
    } finally {
      setWorking(false);
      props.onWorkingChange(false);
    }
  }

  return (
    <MoreMenu
      label={props.label}
      size="sm"
      isDisabled={props.isDisabled || working}
      items={[
        ...(props.pairingPending
          ? [
              { label: props.copy.retry, onClick: () => void retry() },
              { label: props.copy.discard, onClick: () => void discard() },
            ]
          : []),
        ...props.items,
      ]}
    />
  );
}
