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

import { inputAction, Scroll, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { AgentExternalRuntime } from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { ExternalAgentSettingsOwner } from './externalAgentSettingsState';
import { ChoiceIndicator } from './ChoiceIndicator';
import { LoadingState } from './Loading';
import { tr } from './locale';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
  fieldBoxStyle,
} from './ui';

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

export function ExternalAgentSettings(props: { owner: ExternalAgentSettingsOwner }) {
  const owner = props.owner;
  const buttonStyle = {
    ...controlStyle,
    ...fieldBoxStyle(),
    alignSelf: 'flex-start' as const,
  };
  const textStyle = { ...bodyTextStyle, color: C.text };
  const mutedStyle = { ...captionTextStyle, color: C.muted };
  const allEnabled = () => !!owner.basis()?.targets.every((item) => item.enabled);
  const anyEnabled = () => !!owner.basis()?.targets.some((item) => item.enabled);
  const stateMessage = () => {
    const state = owner.catalog()?.state;
    if (state?.kind === 'disabled')
      return tr('External agents are disabled for the active settings Agent.');
    if (state?.kind === 'workspace_required')
      return tr('Choose a workspace before checking external agents.');
    if (state?.kind === 'unavailable') return state.message;
    return '';
  };
  return (
    <Scroll accessibilityLabel={tr('External agent runtimes')} style={{ flex: 1, minHeight: 0 }}>
      <View style={{ gap: 14, padding: 8 }}>
        <Button
          disabled={owner.disabled()}
          accessibilityLabel={tr('Refresh external agents')}
          onPress={inputAction(owner.reload, owner.action())}
          style={buttonStyle}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={textStyle}>{tr('Refresh')}</Text>
        </Button>
        <If when={owner.loading()}>
          <LoadingState label={tr('Checking external agents…')} />
        </If>
        <If when={owner.basis()}>
          <Text style={textStyle}>
            {allEnabled()
              ? tr('External agents enabled')
              : anyEnabled()
                ? tr('External agents are enabled for some targets')
                : tr('External agents disabled')}
          </Text>
          <Each of={owner.basis()!.targets} key={(item) => JSON.stringify(item.target)}>
            {(item) => (
              <Text style={mutedStyle}>
                {tr('Target {target}: {status}', {
                  target: `${item().target.source.namespace.join('/')} · ${item().target.path.join('.')}`,
                  status: item().enabled ? tr('Enabled') : tr('Disabled'),
                })}
              </Text>
            )}
          </Each>
          <If when={!owner.confirmation()}>
            <If when={!allEnabled()}>
              <Button
                disabled={owner.disabled()}
                accessibilityLabel={tr('Enable external agents')}
                onPress={inputAction(owner.requestEnable, owner.action())}
                style={buttonStyle}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <Text style={textStyle}>{tr('Enable external agents')}</Text>
              </Button>
            </If>
            <If when={anyEnabled()}>
              <Button
                disabled={owner.disabled()}
                accessibilityLabel={tr('Disable external agents')}
                onPress={inputAction(owner.disable, owner.action())}
                style={buttonStyle}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <Text style={textStyle}>{tr('Disable external agents')}</Text>
              </Button>
            </If>
          </If>
          <Text style={mutedStyle}>
            {tr(
              'Disabling does not uninstall agents or sign out. Maka still settles executions already running.',
            )}
          </Text>
        </If>
        <If when={owner.confirmation()}>
          <View style={{ ...fieldBoxStyle(), padding: 12, gap: 12 }}>
            <Text style={textStyle}>
              {tr(
                'External agents use their own default permissions, native tools and existing accounts. They can read and write files, run commands and access the network outside the Maka session sandbox.',
              )}
            </Text>
            <Text style={textStyle}>
              {tr(
                'This does not expand permissions for ordinary plugins, Code Mode or Computer Use.',
              )}
            </Text>
            <Button
              disabled={owner.disabled()}
              selected={owner.confirmation()!.acknowledged}
              accessibilityLabel={tr('I understand and accept the external agent permissions')}
              onPress={inputAction(owner.acknowledge, {
                ...owner.action(),
                value: !owner.confirmation()!.acknowledged,
              })}
              style={{
                ...buttonStyle,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
              }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <ChoiceIndicator
                kind="checkbox"
                checked={owner.confirmation()!.acknowledged}
                disabled={owner.disabled()}
              />
              <Text style={textStyle}>
                {tr('I understand and accept the external agent permissions')}
              </Text>
            </Button>
            <Button
              disabled={owner.disabled() || !owner.confirmation()!.acknowledged}
              accessibilityLabel={tr('Confirm permissions and enable')}
              onPress={inputAction(owner.enable, owner.action())}
              style={buttonStyle}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={textStyle}>{tr('Confirm permissions and enable')}</Text>
            </Button>
            <Button
              disabled={owner.disabled()}
              accessibilityLabel={tr('Cancel enabling external agents')}
              onPress={inputAction(owner.cancel, owner.action())}
              style={buttonStyle}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={textStyle}>{tr('Cancel')}</Text>
            </Button>
          </View>
        </If>
        <If when={stateMessage()}>
          <Text style={mutedStyle}>{stateMessage()}</Text>
        </If>
        <If when={owner.runtimes().length > 0 && !owner.plan()}>
          <Text style={mutedStyle}>
            {tr(
              'Runtime status is checked in the active settings Agent workspace; other scopes may differ.',
            )}
          </Text>
          <Text style={mutedStyle}>
            {tr(
              'Sign in using the agent’s native login, then Refresh. Maka does not manage these credentials.',
            )}
          </Text>
          <Each of={owner.runtimes()} key={(runtime) => runtime.id}>
            {(runtime) => (
              <View style={{ ...fieldBoxStyle(), padding: 12, gap: 8 }}>
                <Text style={{ ...textStyle, fontWeight: '500' }}>{runtime().name}</Text>
                <Text style={textStyle}>
                  {tr('Installation: {status}', {
                    status: installationText(runtime().installation),
                  })}
                </Text>
                <Text style={textStyle}>
                  {tr('Authentication: {status}', {
                    status: authenticationText(runtime().authentication),
                  })}
                </Text>
                <Text style={textStyle}>{modelsText(runtime().models)}</Text>
                <If when={runtime().installation.kind === 'not_found' && runtime().canInstall}>
                  <Each of={runtime().installLines} key={(line) => line.line}>
                    {(line) => (
                      <Button
                        disabled={owner.disabled()}
                        selected={owner.lines()[runtime().id] === line().line}
                        accessibilityLabel={tr('Select {name} installation line {line}', {
                          name: runtime().name,
                          line: line().line,
                        })}
                        onPress={inputAction(owner.chooseLine, {
                          ...owner.action(),
                          runtime: runtime().id,
                          line: line().line,
                        })}
                        style={{
                          ...buttonStyle,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 8,
                        }}
                        hoverStyle={controlHoverStyle()}
                        focusStyle={controlFocusStyle()}
                        disabledStyle={controlDisabledStyle}
                      >
                        <ChoiceIndicator
                          kind="radio"
                          checked={owner.lines()[runtime().id] === line().line}
                          disabled={owner.disabled()}
                        />
                        <Text style={textStyle}>{line().description}</Text>
                      </Button>
                    )}
                  </Each>
                  <Button
                    disabled={
                      owner.disabled() ||
                      (runtime().installLines.length > 0 && !owner.lines()[runtime().id])
                    }
                    accessibilityLabel={tr('View installation plan for {name}', {
                      name: runtime().name,
                    })}
                    onPress={inputAction(owner.viewPlan, {
                      ...owner.action(),
                      runtime: runtime().id,
                      ...(owner.lines()[runtime().id] === undefined
                        ? {}
                        : { line: owner.lines()[runtime().id] }),
                    })}
                    style={buttonStyle}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                    disabledStyle={controlDisabledStyle}
                  >
                    <Text style={textStyle}>{tr('View installation plan')}</Text>
                  </Button>
                </If>
              </View>
            )}
          </Each>
        </If>
        <If when={owner.plan()}>
          <View style={{ ...fieldBoxStyle(), padding: 12, gap: 10 }}>
            <Text style={textStyle}>
              {tr('Installation plan for {name}', { name: owner.plan()!.name })}
            </Text>
            <If when={owner.plan()!.kind === 'unsupported'}>
              <Text style={textStyle}>
                {owner.plan()!.kind === 'unsupported'
                  ? (owner.plan() as { detail: string }).detail
                  : ''}
              </Text>
            </If>
            <Each of={owner.plan()!.steps} key={(step) => step}>
              {(step) => <Text style={textStyle}>{step()}</Text>}
            </Each>
            <If when={owner.plan()!.source}>
              <Text style={mutedStyle}>
                {tr('Installation source: {source}', {
                  source: owner.plan()!.source,
                })}
              </Text>
            </If>
            <If when={owner.plan()!.kind === 'plan'}>
              <Text style={textStyle}>
                {tr(
                  'Network access: yes. Elevated privileges: no. Installation changes files on this machine.',
                )}
              </Text>
              <Button
                disabled={owner.disabled()}
                accessibilityLabel={tr('Install {name}', {
                  name: owner.plan()!.name,
                })}
                onPress={inputAction(owner.install, owner.action())}
                style={buttonStyle}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <Text style={textStyle}>{tr('Install')}</Text>
              </Button>
            </If>
            <Button
              disabled={owner.disabled()}
              accessibilityLabel={tr('Cancel external agent installation')}
              onPress={inputAction(owner.cancel, owner.action())}
              style={buttonStyle}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={textStyle}>{tr('Cancel')}</Text>
            </Button>
          </View>
        </If>
      </View>
    </Scroll>
  );
}
