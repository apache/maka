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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Banner, HStack, Link, List, ListItem, Text } from '@astryxdesign/core';
import { ChevronRight, ICON_SIZE } from '@maka/ui/icons';
import { SettingsRouteHeader } from '../../application/contracts/settings-presentation/settings-route-header.js';
import { Button, useUiLocale } from '@maka/ui';
import type {
  AppSettings,
  RuntimeHostSettingsUpdateGuard,
  UpdateAppSettingsInput,
  UpdateAppSettingsResult,
} from '@maka/core/settings';
import type {
  ExternalAgentSetupAction,
  ExternalAgentSetupProjection,
} from '@maka/runtime-host/protocol';
import { ANTIGRAVITY_ACP_RELEASE } from '@maka/runtime-host/protocol';
import { getExternalAgentsCopy } from '../../locales/settings-external-agents-copy.js';
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '../../application/contracts/settings-presentation/index.js';
import {
  RuntimeHostSettingsGenerationBoundary,
  useRuntimeHostSettingsTarget,
} from '../../application/contracts/settings-presentation/index.js';
import { useActionGuard } from '../../application/contracts/settings-presentation/index.js';

import { useExternalAgentSettingsServices } from './services.js';

type Props = {
  settings: AppSettings;
  onUpdate(
    patch: UpdateAppSettingsInput,
    guard?: RuntimeHostSettingsUpdateGuard,
  ): Promise<UpdateAppSettingsResult>;
};
export function ExternalAgentsSettingsPage(props: Props) {
  return (
    <RuntimeHostSettingsGenerationBoundary>
      <ExternalAgentsContent {...props} />
    </RuntimeHostSettingsGenerationBoundary>
  );
}
function AntigravityLogo() {
  return (
    <span className="providerLogo" data-compact="true" aria-hidden="true">
      <img
        src={new URL('../../assets/provider-brands/antigravity.svg', import.meta.url).href}
        alt=""
      />
    </span>
  );
}
function ExternalAgentsContent(props: Props) {
  const [showSetup, setShowSetup] = useState(false);
  const copy = getExternalAgentsCopy(useUiLocale());
  const configured = Boolean(props.settings.externalAgents.antigravity.executable);
  if (showSetup) return <AntigravitySetup {...props} onBack={() => setShowSetup(false)} />;
  return (
    <SettingsPage>
      <SettingsSection
        title={copy.catalogTitle}
        description={copy.catalogDescription}
        variant="bare"
      >
        <List hasDividers>
          <ListItem
            startContent={<AntigravityLogo />}
            label={copy.title}
            description={copy.agentDescription}
            endContent={
              <HStack gap={2} vAlign="center">
                {configured ? <Badge variant="neutral" label={copy.configured} /> : null}
                <ChevronRight size={ICON_SIZE.chrome} aria-hidden="true" />
              </HStack>
            }
            onClick={() => setShowSetup(true)}
          />
        </List>
      </SettingsSection>
    </SettingsPage>
  );
}
function AntigravitySetup(props: Props & { onBack(): void }) {
  const services = useExternalAgentSettingsServices();
  const target = useRuntimeHostSettingsTarget();
  const host = useMemo(
    () => ({ profileId: target.profileId, hostId: target.hostId }),
    [target.profileId, target.hostId],
  );
  const copy = getExternalAgentsCopy(useUiLocale());
  const saved = props.settings.externalAgents.antigravity.executable;
  const [connectionVerified, setConnectionVerified] = useState(false);
  const verifiedPath = useRef<string | undefined>(undefined);
  const [available, setAvailable] = useState<boolean>();
  const [availabilityRetry, setAvailabilityRetry] = useState(0);
  const [projection, setProjection] = useState<ExternalAgentSetupProjection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const guard = useActionGuard<string>();
  const attempt = useRef<string | undefined>(undefined);
  const mounted = useRef(false);
  const configuration = useRef({ executable: saved });
  if (configuration.current.executable !== saved) configuration.current = { executable: saved };
  const attemptBasis = useRef(configuration.current);
  useEffect(() => {
    setConnectionVerified(verifiedPath.current === saved);
    setProjection(undefined);
    setError(false);
  }, [saved]);
  useEffect(() => {
    mounted.current = true;
    let retired = false;
    void services
      .isAvailable(host)
      .then((value) => {
        if (!retired) setAvailable(value);
      })
      .catch(() => {
        if (!retired) {
          setAvailable(false);
          setError(true);
        }
      });
    return () => {
      retired = true;
      mounted.current = false;
      const id = attempt.current;
      attempt.current = undefined;
      if (id) void services.cancel(id, host).catch(() => undefined);
    };
  }, [host, availabilityRetry, services]);
  const current = projection?.expectedExecutable === saved ? projection : undefined;
  const isCurrent = (id: string) => mounted.current && attempt.current === id;
  async function selectExisting() {
    if (!available || !guard.begin('select')) return;
    const basis = configuration.current;
    setBusy(true);
    setError(false);
    try {
      const selected = await services.selectExecutable(host);
      if (!selected || !mounted.current || configuration.current !== basis) return;
      verifiedPath.current = undefined;
      setConnectionVerified(false);
      setProjection(undefined);
      await props.onUpdate({ externalAgents: { antigravity: { executable: selected } } });
    } catch {
      if (mounted.current) setError(true);
    } finally {
      if (mounted.current) setBusy(false);
      guard.finish();
    }
  }
  async function start(action: ExternalAgentSetupAction) {
    if (!available || (action !== 'install' && !saved) || !guard.begin(action)) return;
    const id = services.createAttemptId();
    attempt.current = id;
    if (action === 'check') setConnectionVerified(false);
    const basis = configuration.current;
    attemptBasis.current = basis;
    setBusy(true);
    setError(false);
    setProjection(undefined);
    try {
      let result = await services.start({ attemptId: id, action, expectedExecutable: saved }, host);
      // Unmount may have cancelled before start admission; cancel again after the response.
      if (!isCurrent(id)) {
        await services.cancel(id, host);
        return;
      }
      while (isCurrent(id)) {
        if (configuration.current === basis) {
          setProjection(result);
          if (result.phase === 'succeeded' || result.phase === 'awaiting_authorization') {
            if (action === 'install' && result.phase === 'succeeded' && result.installedExecutable) {
              verifiedPath.current = result.installedExecutable;
              const updated = await props.onUpdate(
                { externalAgents: { antigravity: { executable: result.installedExecutable } } },
                { expectedExternalAgentExecutable: basis.executable },
              );
              if (!isCurrent(id)) return;
              if (updated.settings.externalAgents.antigravity.executable !== result.installedExecutable)
                return;
            }
            setConnectionVerified(true);
          }
        }
        if (['succeeded', 'failed', 'cancelled'].includes(result.phase)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!isCurrent(id)) break;
        result = await services.query(id, host);
      }
    } catch {
      if (isCurrent(id)) setError(true);
      await services.cancel(id, host).catch(() => undefined);
    } finally {
      if (isCurrent(id)) {
        attempt.current = undefined;
        setBusy(false);
        guard.finish();
      }
    }
  }
  async function cancel() {
    const id = attempt.current;
    if (!id) return;
    try {
      const result = await services.cancel(id, host);
      if (isCurrent(id) && attemptBasis.current === configuration.current) setProjection(result);
    } catch {
      if (isCurrent(id)) setError(true);
    }
  }
  const status = error
    ? copy.error
    : available === undefined
      ? copy.loading
      : !available
        ? copy.unavailable
        : !current
              ? copy.unchecked
              : current.phase === 'failed'
                ? copy.failures[current.failure!]
                : current.phase === 'succeeded'
                  ? current.action === 'install' ? copy.installed : current.action === 'login'
                    ? copy.authenticated
                    : copy.connected
                  : copy[current.phase];
  const canStart = Boolean(available && saved);
  const activeAction = busy && attempt.current ? guard.current : undefined;
  const retryAction =
    current && ['failed', 'cancelled'].includes(current.phase) ? current.action : undefined;
  function setupAction(action: ExternalAgentSetupAction) {
    if (activeAction === action)
      return (
        <Button
          variant="secondary"
          label={copy.cancel}
          isDisabled={current?.phase === 'cancelling'}
          onClick={() => void cancel()}
        />
      );
    return (
      <Button
        variant={
          !busy && (action === 'install' ? available && !saved : canStart && (action === 'check' ? !connectionVerified : connectionVerified && current?.phase !== 'succeeded'))
            ? 'primary'
            : 'secondary'
        }
        label={retryAction === action ? copy.retry : action === 'install' ? saved ? copy.reinstall : copy.install : action === 'check' ? copy.check : current?.action === 'login' && current.phase === 'succeeded' ? copy.reverify : copy.login}
        isDisabled={busy || (action === 'install' ? !available : !canStart)}
        onClick={() => void start(action)}
      />
    );
  }
  return (
    <SettingsPage>
      <SettingsRouteHeader
        title={copy.title}
        subtitle={copy.agentDescription}
        logo={<AntigravityLogo />}
        backLabel={copy.backToAgents}
        onBack={props.onBack}
        isBackDisabled={busy && !attempt.current}
      />
      {(error || available === false || available === undefined) && (
        <Banner
          status={error ? 'error' : 'info'}
          role={error ? 'alert' : 'status'}
          title={status}
        />
      )}
      {error && available === false && !busy && (
        <Button
          label={copy.retry}
          onClick={() => {
            setError(false);
            setAvailable(undefined);
            setAvailabilityRetry((value) => value + 1);
          }}
        />
      )}
      <SettingsSection title={copy.programTitle} description={copy.existingProgramHelp}>
        <SettingsRow
          label={copy.programName}
          description={
            <div>
              <span role="status" aria-live="polite">
                {current?.action === 'install' ? `${status}${current.downloadPercent !== undefined && current.phase === 'downloading' ? ` ${current.downloadPercent}%` : ''}` : saved ? copy.programConfigured : copy.installHelp}
              </span>
              <div className="externalAgentRelease">
                <Text type="supporting" color="secondary">{copy.release}</Text>
                <Link href={ANTIGRAVITY_ACP_RELEASE.url} target="_blank" rel="noreferrer noopener">{copy.source} · dl.google.com</Link>
              </div>
              {current?.action === 'install' && current.phase === 'downloading' && (
                <progress className="externalAgentDownloadProgress" max={100} value={current.downloadPercent ?? 0} aria-label={copy.downloading} />
              )}
            </div>
          }
          end={
            <HStack gap={2} vAlign="center">
              {setupAction('install')}
              <Button variant="secondary" label={copy.selectExisting} isDisabled={busy || !available} onClick={() => void selectExisting()} />
            </HStack>
          }
        />
        {saved && <SettingsRow
          label={copy.connectionStatus}
          description={<span role="status" aria-live="polite">{current?.action === 'check' ? status : connectionVerified ? copy.connectionVerified : copy.unchecked}</span>}
          end={setupAction('check')}
        />}
      </SettingsSection>
      <SettingsSection title={copy.accountTitle} description={copy.accountDescription}>
        <SettingsRow
          label={copy.googleAccount}
          description={<span role="status" aria-live="polite">{!saved ? copy.accountBeforeSave : current?.action === 'login' ? status : copy.accountUnchecked}</span>}
          end={setupAction('login')}
        />
      </SettingsSection>

    </SettingsPage>
  );
}
