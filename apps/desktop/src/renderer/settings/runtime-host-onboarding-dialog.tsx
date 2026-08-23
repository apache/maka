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
import { Text } from '@astryxdesign/core/Text';
import { Banner, Button, FormLayout, Spinner, TextInput, useUiLocale } from '@maka/ui';
import type { DesktopRuntimeHostOnboardingSnapshot } from '../../preload/bridge-contract.js';
import { getSettingsProjectsCopy } from '../locales/settings-projects-copy.js';

export function RuntimeHostOnboardingDialog(props: {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onRemoteHostAdded: (profileId: string) => void;
}) {
  const locale = useUiLocale();
  const copy = getSettingsProjectsCopy(locale).runtimeHost;
  const revision = useRef(-1);
  const [snapshot, setSnapshot] = useState<DesktopRuntimeHostOnboardingSnapshot>({
    kind: 'idle',
    revision: 0,
  });
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [sshPort, setSshPort] = useState('');

  useEffect(() => {
    if (!props.isOpen) return;
    let disposed = false;
    const accept = (next: DesktopRuntimeHostOnboardingSnapshot) => {
      if (disposed || next.revision <= revision.current) return;
      revision.current = next.revision;
      setSnapshot(next);
    };
    const unsubscribe = window.maka.runtimeHostOnboarding.subscribe(accept);
    void window.maka.runtimeHostOnboarding.getSnapshot().then(accept);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [props.isOpen]);

  const running = snapshot.kind === 'running';
  const canStart = destination.trim().length > 0 && validOptionalPort(sshPort);

  async function start(): Promise<void> {
    const next = await window.maka.runtimeHostOnboarding.start({
      destination: destination.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(sshPort.trim() ? { sshPort: Number(sshPort) } : {}),
    });
    if (next.revision > revision.current) {
      revision.current = next.revision;
      setSnapshot(next);
    }
  }

  function close(): void {
    if (running) {
      void window.maka.runtimeHostOnboarding.cancel().then((cancelled) => {
        if (cancelled) props.onClose();
      });
      return;
    }
    void window.maka.runtimeHostOnboarding.reset();
    props.onClose();
  }

  function reset(): Promise<void> {
    return window.maka.runtimeHostOnboarding.reset();
  }

  return (
    <Dialog
      isOpen={props.isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      purpose="form"
      width={520}
      maxHeight="calc(100dvh - 64px)"
    >
      <Layout
        header={(
          <DialogHeader
            title={copy.setupTitle}
            subtitle={copy.setupDescription}
            onOpenChange={(open) => {
              if (!open) close();
            }}
          />
        )}
        content={(
          <LayoutContent padding={4}>
            <FormLayout>
              {snapshot.kind === 'failed' ? (
                <Banner status="error" title={snapshot.message} />
              ) : null}
              {snapshot.kind === 'complete' ? (
                <Banner status="success" title={copy.setupComplete} />
              ) : null}
              {running ? (
                <div role="status" aria-live="polite" className="settingsRuntimeHostSetupProgress">
                  <Spinner size="sm" />
                  <Text type="body">{copy.setupPhase[snapshot.phase]}</Text>
                </div>
              ) : snapshot.kind !== 'complete' ? (
                <>
                  <TextInput
                    label={copy.setupName}
                    value={name}
                    isDisabled={running}
                    onChange={setName}
                  />
                  <TextInput
                    label={copy.sshDestination}
                    value={destination}
                    placeholder="user@host.example"
                    isDisabled={running}
                    onChange={setDestination}
                  />
                  <TextInput
                    label={copy.setupSshPort}
                    value={sshPort}
                    placeholder="22"
                    isDisabled={running}
                    onChange={setSshPort}
                  />
                </>
              ) : null}
            </FormLayout>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <div className="settingsRuntimeHostSshTerminalActions">
              {snapshot.kind === 'complete' ? (
                <>
                  <Button variant="secondary" label={copy.setupDone} onClick={close} />
                  <Button
                    variant="primary"
                    label={copy.setupChooseProject}
                    onClick={() => {
                      props.onRemoteHostAdded(snapshot.profileId);
                      void reset();
                      props.onClose();
                    }}
                  />
                </>
              ) : running ? (
                snapshot.phase === 'connecting_host' ? null : (
                  <Button
                    variant="secondary"
                    label={copy.setupCancel}
                    clickAction={async () => {
                      await window.maka.runtimeHostOnboarding.cancel();
                    }}
                  />
                )
              ) : snapshot.kind === 'failed' ? (
                <>
                  <Button variant="secondary" label={copy.setupCancel} onClick={close} />
                  <Button
                    variant="primary"
                    label={copy.setupRetry}
                    clickAction={async () => {
                      await reset();
                      await start();
                    }}
                  />
                </>
              ) : (
                <>
                  <Button variant="secondary" label={copy.setupCancel} onClick={close} />
                  <Button
                    variant="primary"
                    label={copy.setupConnect}
                    isDisabled={!canStart}
                    clickAction={start}
                  />
                </>
              )}
            </div>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function validOptionalPort(value: string): boolean {
  if (!value.trim()) return true;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}
