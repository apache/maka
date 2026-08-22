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
import { Banner, Button, Spinner, useToast, useUiLocale } from '@maka/ui';
import type { RemoteRuntimeHostProfile } from '@maka/runtime-host/client';
import type {
  DesktopRuntimeHostManagementAction,
  DesktopRuntimeHostManagementResult,
} from '../../preload/bridge-contract.js';
import { getSettingsProjectsCopy } from '../locales/settings-projects-copy.js';
import { settingsActionErrorMessage } from './settings-error-copy.js';

export function RuntimeHostManagementDialog(props: {
  readonly profile: RemoteRuntimeHostProfile | undefined;
  readonly onClose: () => void;
}) {
  const locale = useUiLocale();
  const copy = getSettingsProjectsCopy(locale).runtimeHost;
  const toast = useToast();
  const [result, setResult] = useState<DesktopRuntimeHostManagementResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [uninstalledRoot, setUninstalledRoot] = useState<string>();
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const logsRef = useRef<HTMLPreElement>(null);

  const profile = props.profile;
  useEffect(() => {
    if (!profile) return;
    let disposed = false;
    setResult(undefined);
    setError(undefined);
    setUninstalledRoot(undefined);
    setConfirmingUninstall(false);
    setLoading(true);
    void window.maka.runtimeHostManagement.run(profile.id, 'status').then(
      (response) => {
        if (disposed) return;
        if (response.kind === 'result') setResult(response);
        else if (response.kind === 'error') setError(response.error.message);
        else setUninstalledRoot(response.retainedStateRoot);
      },
      (failure) => {
        if (!disposed) setError(settingsActionErrorMessage(failure, locale));
      },
    ).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [locale, profile]);

  useLayoutEffect(() => {
    if (result?.action !== 'logs') return;
    const logs = logsRef.current;
    if (logs) logs.scrollTop = logs.scrollHeight;
  }, [result]);

  async function run(action: DesktopRuntimeHostManagementAction): Promise<void> {
    if (!profile) return;
    setLoading(true);
    setError(undefined);
    try {
      const response = await window.maka.runtimeHostManagement.run(profile.id, action);
      if (response.kind === 'error') {
        setError(response.error.message);
        toast.error(copy.managementActionFailed, response.error.message);
        return;
      }
      if (response.kind === 'uninstalled') {
        setResult(undefined);
        setUninstalledRoot(response.retainedStateRoot);
        return;
      }
      setResult(response);
    } catch (failure) {
      const message = settingsActionErrorMessage(failure, locale);
      setError(message);
      toast.error(copy.managementActionFailed, message);
    } finally {
      setLoading(false);
    }
  }

  const service = result?.service;
  const uninstalled = uninstalledRoot !== undefined;
  const serviceInstalled = service !== undefined && service.state !== 'not_installed';
  const serviceActive = service?.state === 'running';
  return (
    <Dialog
      isOpen={profile !== undefined}
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
            title={profile ? copy.managementTitle(profile.name) : copy.title}
            subtitle={profile?.transport.kind === 'ssh' ? profile.transport.destination : undefined}
            onOpenChange={(open) => {
              if (!open && !loading) props.onClose();
            }}
          />
        )}
        content={(
          <LayoutContent padding={4}>
            <div className="settingsRuntimeHostManagement">
              {loading && !result ? (
                <div className="settingsRuntimeHostSetupProgress" role="status">
                  <Spinner size="sm" />
                </div>
              ) : null}
              {error ? <Banner status="error" title={error} /> : null}
              {confirmingUninstall ? (
                <Banner
                  status="warning"
                  title={copy.uninstallConfirmTitle}
                  description={copy.uninstallConfirmBody}
                />
              ) : null}
              {uninstalledRoot ? (
                <Banner
                  status="success"
                  title={copy.uninstallRetained(uninstalledRoot)}
                />
              ) : null}
              {service ? (
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
                  <div className="settingsRuntimeHostManagementDirectoryRoots">
                    <Text type="body" weight="semibold">{copy.directoryRoots}</Text>
                    {service.projectDirectoryRoots.length > 0 ? (
                      <ul className="settingsRuntimeHostManagementRoots">
                        {service.projectDirectoryRoots.map((root) => (
                          <li key={`${root.label}:${root.path}`}>
                            <span>{root.label}</span>
                            <code>{root.path}</code>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <Text type="supporting" color="secondary">{copy.noDirectoryRoots}</Text>
                    )}
                  </div>
                  {result.action === 'logs' ? (
                    <pre ref={logsRef} className="settingsRuntimeHostManagementLogs">
                      {result.logs || copy.noLogs}
                    </pre>
                  ) : null}
                </>
              ) : null}
            </div>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <div className="settingsRuntimeHostManagementActions">
              {confirmingUninstall ? (
                <>
                  <Button
                    variant="secondary"
                    label={copy.cancel}
                    isDisabled={loading}
                    onClick={() => setConfirmingUninstall(false)}
                  />
                  <Button
                    variant="destructive"
                    label={copy.uninstallConfirm}
                    isDisabled={loading}
                    clickAction={async () => {
                      await run('uninstall');
                      setConfirmingUninstall(false);
                    }}
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
                  {profile?.transport.kind === 'ssh' && !uninstalled ? (
                    <Button
                      variant="secondary"
                      label={copy.repairService}
                      isDisabled={loading}
                      clickAction={() => run('install')}
                    />
                  ) : null}
                  {result && profile && !uninstalled ? (
                    <>
                      <Button
                        variant="secondary"
                        label={copy.refresh}
                        isDisabled={loading}
                        clickAction={() => run('status')}
                      />
                      {serviceInstalled ? (
                        <Button
                          variant="secondary"
                          label={copy.showLogs}
                          isDisabled={loading}
                          clickAction={() => run('logs')}
                        />
                      ) : null}
                      {serviceInstalled && serviceActive ? (
                        <Button
                          variant="primary"
                          label={copy.restartService}
                          isDisabled={loading}
                          clickAction={() => run('restart')}
                        />
                      ) : serviceInstalled ? (
                        <Button
                          variant="primary"
                          label={copy.startService}
                          isDisabled={loading}
                          clickAction={() => run('start')}
                        />
                      ) : null}
                    </>
                  ) : null}
                  {profile && !uninstalled ? (
                    <Button
                      variant="secondary"
                      label={copy.uninstallService}
                      isDisabled={loading}
                      onClick={() => setConfirmingUninstall(true)}
                    />
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
