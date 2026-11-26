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

import { inputAction } from 'nsh';
import type { AgentExternalRuntime } from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { ExternalAgentSettingsOwner } from './externalAgentSettingsState';
import { InlineSkeletonLine, SettingsSkeleton } from './Loading';
import { tr } from './locale';
import { UsageLimits } from './UsageLimits';
import {
  SettingsBody,
  SettingsButton,
  SettingsLede,
  SettingsMonogram,
  SettingsProblem,
  SettingsSection,
  SettingsSwitch,
} from './SettingsPage';

/** What an enabled agent needs before it can be used, or null when it is ready. */
function attention(value: AgentExternalRuntime) {
  if (value.installation.kind === 'not_found') return tr('Not installed');
  if (value.installation.kind === 'unsupported') return tr('Not supported on this device');
  if (value.installation.kind === 'error') return tr('Could not check installation');
  if (value.authentication.kind === 'unauthenticated') return tr('Sign in required');
  if (value.models.kind === 'ready') return null;
  if (value.authentication.kind === 'error' || value.authentication.kind === 'unknown')
    return tr('Could not verify sign-in');
  if (value.models.kind === 'unauthenticated') return tr('Sign in required');
  return tr('Models unavailable');
}

function runtimeDescription(owner: ExternalAgentSettingsOwner, id: string, enabled: boolean) {
  if (!enabled) return tr('Disabled');
  const status = owner.status(id);
  if (!status) {
    return owner.catalog()?.state.kind === 'workspace_required'
      ? tr('Choose a workspace to check status')
      : undefined;
  }
  if (status.installation.kind === 'not_found')
    return tr('Install and sign in using the native CLI.');
  if (status.installation.kind === 'unsupported' || status.installation.kind === 'error')
    return status.installation.detail;
  if (status.authentication.kind === 'unauthenticated')
    return (
      status.authentication.detail ||
      tr('Sign in using the agent’s native login. Maka does not manage these credentials.')
    );
  const version = status.installation.version;
  if (status.models.kind === 'ready')
    return [version, tr('{count} models available', { count: status.models.count })]
      .filter(Boolean)
      .join(' · ');
  if (status.authentication.kind === 'error' || status.authentication.kind === 'unknown')
    return status.authentication.detail || version || undefined;
  if (status.models.kind === 'unauthenticated')
    return (
      status.models.detail ||
      tr('Sign in using the agent’s native login. Maka does not manage these credentials.')
    );
  if (status.models.kind === 'unsupported' || status.models.kind === 'error')
    return status.models.detail;
  return version || undefined;
}

export function ExternalAgentSection(props: { owner: ExternalAgentSettingsOwner; query: string }) {
  const owner = props.owner;
  const unavailable = () => {
    const state = owner.catalog()?.state;
    return owner.failure() ?? (state?.kind === 'unavailable' ? state.message : null);
  };
  const filtered = () => {
    const query = props.query.trim().toLowerCase();
    return query
      ? owner
          .runtimes()
          .filter(
            (item) =>
              item.name.toLowerCase().includes(query) || item.id.toLowerCase().includes(query),
          )
      : owner.runtimes();
  };
  return (
    <>
      <If when={filtered().length > 0}>
        <SettingsSection title={tr('External agents')}>
          <Each of={filtered()} key={(runtime) => runtime.id}>
            {(runtime) => (
              <SettingsSwitch
                label={runtime().name}
                tone={runtime().enabled ? undefined : 'muted'}
                leading={<SettingsMonogram name={runtime().name} muted={!runtime().enabled} />}
                description={runtimeDescription(owner, runtime().id, runtime().enabled)}
                status={
                  runtime().enabled && owner.status(runtime().id)
                    ? (attention(owner.status(runtime().id)!) ?? undefined)
                    : undefined
                }
                detail={
                  <>
                    <If when={runtime().enabled && owner.checking() && !owner.status(runtime().id)}>
                      <InlineSkeletonLine width={148} label={tr('Checking external agents…')} />
                    </If>
                    <If when={runtime().enabled && runtime().usageLimits}>
                      <UsageLimits target={() => ({ kind: 'external', runtime: runtime().id })} />
                    </If>
                  </>
                }
                accessibilityLabel={tr(runtime().enabled ? 'Disable {name}' : 'Enable {name}', {
                  name: runtime().name,
                })}
                checked={runtime().enabled}
                disabled={owner.disabled()}
                onPress={
                  runtime().enabled
                    ? inputAction(owner.disable, { ...owner.action(), runtime: runtime().id })
                    : inputAction(owner.requestEnable, {
                        ...owner.action(),
                        runtime: runtime().id,
                      })
                }
              />
            )}
          </Each>
        </SettingsSection>
      </If>
      <If when={owner.loading() && !owner.basis()}>
        <SettingsSkeleton padded={false} rows={2} label={tr('Checking external agents…')} />
      </If>
      <If when={unavailable()}>
        <SettingsProblem
          message={unavailable()!}
          retry={inputAction(owner.reload, owner.action())}
        />
      </If>
    </>
  );
}

export function ExternalAgentConfirmation(props: { owner: ExternalAgentSettingsOwner }) {
  const owner = props.owner;
  const confirmation = () => owner.confirmation()!;
  return (
    <SettingsBody
      accessibilityLabel={tr('External agent runtimes')}
      footer={
        <>
          <SettingsButton
            label={tr('Cancel')}
            accessibilityLabel={tr('Cancel enabling external agents')}
            tone="quiet"
            disabled={owner.disabled()}
            onPress={inputAction(owner.cancel, owner.action())}
          />
          <SettingsButton
            label={tr('Confirm permissions and enable')}
            tone="primary"
            disabled={owner.disabled() || !confirmation().acknowledged}
            onPress={inputAction(owner.enable, owner.action())}
          />
        </>
      }
    >
      <SettingsLede>
        {tr(
          'This agent runs in its native full-access mode. It can read and write files, run commands and access the network outside the Maka sandbox.',
        )}
      </SettingsLede>
      <SettingsSection note={tr('Other Maka permissions stay unchanged.')}>
        <SettingsSwitch
          label={tr('I understand and accept these permissions')}
          accessibilityLabel={tr('I understand and accept the external agent permissions')}
          checked={confirmation().acknowledged}
          disabled={owner.disabled()}
          onPress={inputAction(owner.acknowledge, {
            ...owner.action(),
            value: !confirmation().acknowledged,
          })}
        />
      </SettingsSection>
    </SettingsBody>
  );
}
