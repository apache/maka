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
import { LoadingIndicator } from './Loading';
import { tr } from './locale';
import {
  SettingsBody,
  SettingsButton,
  SettingsLede,
  SettingsProblem,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from './SettingsPage';

function installationText(value: AgentExternalRuntime['installation']) {
  switch (value.kind) {
    case 'available':
      return value.version
        ? tr('Installed ({version})', { version: value.version })
        : tr('Installed');
    case 'not_found':
      return tr('Not installed');
    case 'unsupported':
      return tr('Unsupported: {detail}', { detail: value.detail });
    case 'error':
      return tr('Error: {detail}', { detail: value.detail });
  }
}
function authenticationText(value: AgentExternalRuntime['authentication']) {
  switch (value.kind) {
    case 'authenticated':
      return tr('Signed in ({source})', { source: value.source });
    case 'unauthenticated':
      return [tr('Not signed in ({source})', { source: value.source }), value.detail]
        .filter(Boolean)
        .join(' — ');
    case 'unsupported':
      return tr('Authentication status is not supported');
    case 'unknown':
      return [
        tr('Authentication status unknown'),
        value.source,
        value.detail,
        value.configured?.join(', '),
      ]
        .filter(Boolean)
        .join(' — ');
    case 'error':
      return tr('Error: {detail}', { detail: value.detail });
  }
}
function modelsText(value: AgentExternalRuntime['models']) {
  switch (value.kind) {
    case 'ready':
      return tr('{count} models available', { count: value.count });
    case 'unauthenticated':
      return [tr('Sign in to discover models'), value.detail].filter(Boolean).join(' — ');
    case 'unsupported':
      return tr('Unsupported: {detail}', { detail: value.detail });
    case 'unavailable':
      return tr('Models unavailable');
    case 'error':
      return tr('Error: {detail}', { detail: value.detail });
  }
}

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

export function ExternalAgentSettings(props: { owner: ExternalAgentSettingsOwner }) {
  const owner = props.owner;
  const unavailable = () => {
    const state = owner.catalog()?.state;
    return owner.failure() ?? (state?.kind === 'unavailable' ? state.message : null);
  };
  const description = (id: string) => {
    const status = owner.status(id);
    if (status?.models.kind === 'ready')
      return tr('{count} models available', { count: status.models.count });
    if (status) return undefined;
    if (owner.catalog()?.state.kind === 'workspace_required')
      return tr('Choose a workspace to check status');
    return undefined;
  };
  return (
    <If when={!owner.confirmation()} else={<Confirmation owner={owner} />}>
      <SettingsBody accessibilityLabel={tr('External agent runtimes')}>
        <If when={owner.loading() && !owner.basis()}>
          <LoadingIndicator label={tr('Checking external agents…')} />
        </If>
        <If when={unavailable()}>
          <SettingsProblem
            message={unavailable()!}
            retry={inputAction(owner.reload, owner.action())}
          />
        </If>
        <If when={owner.runtimes().length > 0}>
          <SettingsSection>
            <Each of={owner.runtimes()} key={(runtime) => runtime.id}>
              {(runtime) => (
                <>
                  <SettingsSwitch
                    label={runtime().name}
                    description={runtime().enabled ? description(runtime().id) : undefined}
                    status={
                      runtime().enabled && owner.status(runtime().id)
                        ? (attention(owner.status(runtime().id)!) ?? undefined)
                        : undefined
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
                  <If when={runtime().enabled && owner.status(runtime().id)}>
                    <SettingsRow
                      label={owner.details() === runtime().id ? tr('Hide details') : tr('Details')}
                      accessibilityLabel={tr(
                        owner.details() === runtime().id
                          ? 'Hide {name} details'
                          : 'Show {name} details',
                        { name: runtime().name },
                      )}
                      tone="muted"
                      onPress={inputAction(owner.toggleDetails, {
                        ...owner.action(),
                        runtime: runtime().id,
                      })}
                    />
                    <If when={owner.details() === runtime().id}>
                      <Details status={owner.status(runtime().id)!} />
                    </If>
                  </If>
                </>
              )}
            </Each>
          </SettingsSection>
        </If>
      </SettingsBody>
    </If>
  );
}

function Details(props: { status: AgentExternalRuntime }) {
  const available = () => props.status.installation.kind === 'available';
  return (
    <>
      <SettingsRow
        label={tr('Installation')}
        description={installationText(props.status.installation)}
      />
      <If when={available()}>
        <SettingsRow
          label={tr('Sign-in')}
          description={authenticationText(props.status.authentication)}
        />
        <SettingsRow label={tr('Models')} description={modelsText(props.status.models)} />
      </If>
      <SettingsRow
        label=""
        tone="muted"
        description={
          available()
            ? tr('Sign in using the agent’s native login. Maka does not manage these credentials.')
            : tr('Install and sign in using the native CLI.')
        }
      />
    </>
  );
}

function Confirmation(props: { owner: ExternalAgentSettingsOwner }) {
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
