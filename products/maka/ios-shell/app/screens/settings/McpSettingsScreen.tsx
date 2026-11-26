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

import { cleanup, effect, signal, untracked } from 'nsh';
import type {
  AgentMcpConfigurationList,
  AgentWorkspace,
  ConfigurationLocation,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import { tr } from '../../locale';
import { allSessions } from '../../state/sessions';
import { changeMcp, mcpConfig, projectMcpSummary, type McpConfig } from '../../state/settings/mcp';
import { settingsRpc, settingsWork } from '../../state/settings/rpc';
import { credentialFreeUrl } from '../../state/settings/sourceUrl';
import { GroupRow, InsetGroup } from '../../ui';
import {
  confirmSettingAction,
  SettingChoice,
  SettingField,
  SettingStatus,
  SettingSwitch,
  SettingsForm,
  type SettingsPageProps,
} from './SettingsForm';
import { workspaceScope, WorkspaceScope } from './WorkspaceScope';

export type McpTarget = {
  workspace: AgentWorkspace | null;
  location: ConfigurationLocation;
  name: string | null;
};

export function McpSettingsScreen(
  props: SettingsPageProps & { open: (target: McpTarget) => void },
) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.writeGeneration);
  const scope = workspaceScope(props.rootId, work.canWrite);
  const inventory = signal<AgentMcpConfigurationList | null>(null);
  const load = async () => {
    const workspace = scope.workspace();
    const result = await rpc.query('agent', 'mcpConfigurations', { workspace });
    inventory.set(result);
  };
  const reload = () =>
    void work.run(async () => {
      await scope.load();
      await load();
    });
  effect(() => {
    if (props.active?.() ?? true) untracked(reload);
  });
  const visibleLocations = () =>
    (inventory()?.locations ?? []).filter(({ location }) =>
      location.startsWith(scope.workspace() ? 'project:' : 'user:'),
    );
  const session = () => {
    const workspace = scope.workspace();
    return (
      workspace &&
      allSessions().find(
        (item) =>
          item.rootId === props.rootId &&
          item.session.workspace.path === workspace.path &&
          item.session.kind === 'agent' &&
          !item.session.archived,
      )
    );
  };
  const reviewTrust = () =>
    void work.run(async () => {
      const sessionId = session()!.session.id;
      const proposal = await rpc.query('agent', 'projectMcp', { sessionId });
      if (!work.canWrite()) return;
      if (proposal.kind !== 'configuration' || proposal.trusted) {
        work.error.set(tr('No project MCP consent is pending.'));
        return;
      }
      const summary = projectMcpSummary(proposal);
      if (summary === null) {
        work.error.set(tr('Review on Desktop'));
        return;
      }
      if (
        !(await confirmSettingAction(tr('Trust project MCP servers?'), tr('Trust'), false, summary))
      )
        return;
      const result = await rpc.mutate('agent', 'trustProjectMcp', {
        sessionId,
        revision: proposal.revision,
      });
      if (result.kind !== 'trusted') throw new Error(tr('Refresh and try again.'));
    });
  return (
    <SettingsForm
      active={props.active}
      rootId={props.rootId}
      onBack={props.onBack}
      backLabel={props.backLabel}
      title={tr('MCP')}
      work={work}
      ready={!!inventory()}
      reload={reload}
    >
      <InsetGroup>
        <WorkspaceScope
          scope={scope}
          disabled={work.busy()}
          change={(id) => {
            scope.selected.set(id);
            void work.run(load);
          }}
        />
      </InsetGroup>
      <If when={visibleLocations().length === 0}>
        <InsetGroup>
          <GroupRow title={tr('No MCP servers')} />
        </InsetGroup>
      </If>
      <Each of={visibleLocations()} key={(location) => location.location}>
        {(location) => (
          <InsetGroup
            header={location().location.endsWith(':maka') ? '.maka' : '.agents'}
            footer={location().path}
          >
            <Each of={location().servers} key={(entry) => entry.name}>
              {(entry) => (
                <GroupRow
                  title={entry().name}
                  subtitle={mcpConfig(entry()).url ? 'HTTP' : 'stdio'}
                  trailing={
                    <SettingStatus
                      label={
                        mcpConfig(entry()).disabled
                          ? tr('Disabled')
                          : entry().shadowedBy
                            ? tr('Shadowed')
                            : tr('Enabled')
                      }
                      tone={
                        mcpConfig(entry()).disabled
                          ? 'muted-foreground'
                          : entry().shadowedBy
                            ? 'warning'
                            : 'success'
                      }
                    />
                  }
                  divider
                  chevron
                  disabled={work.busy()}
                  onPress={() =>
                    props.open({
                      workspace: scope.workspace(),
                      location: location().location,
                      name: entry().name,
                    })
                  }
                />
              )}
            </Each>
            <GroupRow
              title={tr('Add MCP server')}
              tone="primary"
              disabled={work.busy()}
              onPress={() =>
                props.open({
                  workspace: scope.workspace(),
                  location: location().location,
                  name: null,
                })
              }
            />
          </InsetGroup>
        )}
      </Each>
      <If when={session()}>
        <InsetGroup>
          <GroupRow
            title={tr('Review project MCP consent')}
            tone="primary"
            disabled={work.busy()}
            onPress={reviewTrust}
          />
        </InsetGroup>
      </If>
    </SettingsForm>
  );
}

function stringMap(text: string): Record<string, string> {
  const value = JSON.parse(text);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((entry) => typeof entry !== 'string')
  )
    throw new Error(tr('Enter a JSON object.'));
  return value;
}

export function McpServerEditor(props: SettingsPageProps & { target: McpTarget }) {
  const work = settingsWork(props.rootId, props.active);
  const rpc = settingsRpc(props.rootId, work.writeGeneration);
  const target = props.target;
  const basis = signal<{ revision: string; configuration: McpConfig } | null>(null);
  const name = signal(target.name ?? '');
  const transport = signal<'stdio' | 'http'>('stdio');
  const address = signal('');
  const args = signal('');
  const cwd = signal('');
  const enabled = signal(true);
  const environment = signal('');
  let baseline = '';
  cleanup(() => {
    environment.set('');
  });
  const draft = () =>
    JSON.stringify([name(), transport(), address(), args(), cwd(), enabled(), environment()]);
  const load = () =>
    void work.run(async () => {
      const inventory = await rpc.query('agent', 'mcpConfigurations', {
        workspace: target.workspace,
      });
      const location = inventory.locations.find((row) => row.location === target.location);
      const entry = location?.servers.find((row) => row.name === target.name);
      if (!location || (target.name && !entry)) throw new Error(tr('Unavailable'));
      const configuration = mcpConfig(entry);
      transport.set(configuration.url ? 'http' : 'stdio');
      address.set(configuration.url ?? configuration.command ?? '');
      args.set(configuration.args?.join('\n') ?? '');
      cwd.set(configuration.cwd ?? '');
      enabled.set(!configuration.disabled);
      environment.set(
        configuration.url
          ? JSON.stringify(configuration.headerEnv ?? {})
          : (configuration.passEnv?.join('\n') ?? ''),
      );
      baseline = draft();
      basis.set({ revision: location.revision, configuration });
    });
  load();
  const requiresDesktop = () =>
    Object.keys(basis()?.configuration.env ?? {}).length > 0 ||
    Object.keys(basis()?.configuration.headers ?? {}).length > 0;
  const save = () =>
    void work.run(async () => {
      if (!name().trim() || !address().trim())
        throw new Error(tr('Enter a server name and command or URL.'));
      if (transport() === 'http' && !credentialFreeUrl(address().trim(), 'mcp')) {
        work.error.set(
          tr(
            'Use an HTTP URL without credentials or query parameters. Use environment references or edit on Desktop.',
          ),
        );
        return;
      }
      const original = basis()!.configuration;
      const configuration: McpConfig =
        transport() === 'http'
          ? {
              type: 'http',
              url: address().trim(),
              headerEnv: environment().trim() ? stringMap(environment()) : {},
              disabled: !enabled(),
            }
          : {
              type: 'stdio',
              command: address().trim(),
              cwd: cwd() || undefined,
              args: args().split('\n').filter(Boolean),
              passEnv: environment().split('\n').filter(Boolean),
              disabled: !enabled(),
            };
      if (Object.keys(original.env ?? {}).length || Object.keys(original.headers ?? {}).length)
        throw new Error(tr('Review on Desktop'));
      await changeMcp(rpc, {
        ...target,
        name: name().trim(),
        revision: basis()!.revision,
        change: { kind: 'save', configuration },
      });
      if (work.canWrite()) props.onBack();
    }, tr('Could not save the MCP server.'));
  const remove = async () => {
    const current = work.fence();
    if (
      !(await confirmSettingAction(tr('Remove {name}?', { name: name() }), tr('Remove'))) ||
      !current()
    )
      return;
    await work.run(async () => {
      await changeMcp(rpc, {
        ...target,
        name: target.name!,
        revision: basis()!.revision,
        change: { kind: 'delete' },
      });
      if (work.canWrite()) props.onBack();
    }, tr('Could not remove the MCP server.'));
  };
  return (
    <SettingsForm
      active={props.active}
      rootId={props.rootId}
      onBack={props.onBack}
      backLabel={tr('MCP')}
      title={target.name ?? tr('Add MCP server')}
      work={work}
      ready={!!basis()}
      reload={load}
      dirty={!!basis() && draft() !== baseline}
      save={requiresDesktop() ? undefined : save}
    >
      <If when={requiresDesktop()}>
        <InsetGroup>
          <GroupRow
            title={tr('Review on Desktop')}
            subtitle={tr(
              'This server stores literal environment variables or HTTP headers. Edit it on Desktop.',
            )}
          />
        </InsetGroup>
      </If>
      <InsetGroup>
        <If when={!target.name}>
          <SettingField
            label={tr('Name')}
            value={name()}
            edit={name.set}
            disabled={work.busy() || requiresDesktop()}
            divider
          />
        </If>
        <SettingChoice
          title={tr('Protocol')}
          value={transport()}
          options={[
            { id: 'stdio', label: 'stdio' },
            { id: 'http', label: 'HTTP' },
          ]}
          disabled={work.busy() || requiresDesktop()}
          divider
          change={(value) => {
            if (transport() === value) return;
            transport.set(value);
            address.set('');
            environment.set('');
          }}
        />
        <SettingField
          label={transport() === 'http' ? 'URL' : tr('Command')}
          value={address()}
          edit={address.set}
          disabled={work.busy() || requiresDesktop()}
          divider
        />
        <If when={transport() === 'stdio'}>
          <SettingField
            label={tr('Arguments')}
            value={args()}
            edit={args.set}
            multiline
            disabled={work.busy() || requiresDesktop()}
            divider
          />
          <SettingField
            label={tr('Working directory')}
            value={cwd()}
            edit={cwd.set}
            disabled={work.busy() || requiresDesktop()}
            divider
          />
        </If>
        <SettingSwitch
          title={tr('Enabled')}
          checked={enabled()}
          disabled={work.busy() || requiresDesktop()}
          change={enabled.set}
        />
      </InsetGroup>
      <InsetGroup>
        <SettingField
          label={
            transport() === 'http'
              ? tr('Header environment references (JSON)')
              : tr('Forward environment variables')
          }
          value={environment()}
          edit={environment.set}
          multiline={transport() === 'stdio'}
          disabled={work.busy() || requiresDesktop()}
        />
      </InsetGroup>
      <If when={target.name}>
        <InsetGroup>
          <GroupRow
            title={tr('Remove')}
            tone="destructive"
            disabled={work.busy()}
            onPress={() => void remove()}
          />
        </InsetGroup>
      </If>
    </SettingsForm>
  );
}
