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

import {
  contracts,
  type AgentConfiguration,
  type AcpExecutorConfiguration,
  type SkillLibraryConfiguration,
  type WorkspaceProcessConfiguration,
  type WorkspaceWebConfiguration,
  type ComputerConfiguration,
  type WorkspaceJevConfiguration,
  type CompositionInput,
  type CompositionNode,
  type PackageRef,
  type Target as BindingTarget,
} from '../../../../packages/plugin-sdk/src/index.js';
export { installation } from './installation.js';
export const packageNames = [
  'workbench',
  'workhub',
  'host-logs',
  'recovery-gateway',
  'host-deployment-manager',
  'deployment-gateway',
  'settings',
  'settings-authentication',
  'settings-setup',
  'skill-outcomes',
  'receipts',
  'gateway',
  'agent',
  'forms',
  'questions',
  'workspace-files',
  'workspace-processes',
  'protocol-processes',
  'acp-executor',
  'skills',
  'workspace-computer',
  'workspace-web',
  'workspace-jev',
] as const;
export type PackageName = (typeof packageNames)[number];
export const instanceNames = [
  ...packageNames,
  'host-deployment-gateway',
  'coordinator-workspace-processes',
  'coordinator-protocol-processes',
  'workbench-ui',
  'workspace-files-ui',
] as const;
export type InstanceName = (typeof instanceNames)[number];
type ExecutorInstanceName = `acp-${string}` | `coordinator-acp-${string}`;
export interface AcpExecutor {
  name: string;
  configuration: AcpExecutorConfiguration;
}
export interface CompositionConfiguration {
  locale: string;
  packages: Record<PackageName, PackageRef>;
  keys: Record<InstanceName, string> & Partial<Record<ExecutorInstanceName, string>>;
  agent: AgentConfiguration;
  processes?: WorkspaceProcessConfiguration;
  web?: WorkspaceWebConfiguration;
  computer?: ComputerConfiguration;
  jev?: WorkspaceJevConfiguration;
  coordinator?: AgentConfiguration;
  coordinatorProcesses?: WorkspaceProcessConfiguration;
  acpExecutors?: AcpExecutor[];
  executorProcesses?: WorkspaceProcessConfiguration;
  coordinatorAcpExecutors?: AcpExecutor[];
  coordinatorExecutorProcesses?: WorkspaceProcessConfiguration;
  skills?: SkillLibraryConfiguration;
  hostDeployment: string;
}
/** The launcher assigns identities without knowing the product's instance structure. */
export function installationNames(
  configuration: Pick<CompositionConfiguration, 'acpExecutors' | 'coordinatorAcpExecutors'>,
): string[] {
  return [
    ...new Set([
      ...instanceNames,
      ...(configuration.acpExecutors ?? []).map((e) => `acp-${e.name}`),
      ...(configuration.coordinatorAcpExecutors ?? []).map((e) => `coordinator-acp-${e.name}`),
    ]),
  ];
}
interface Endpoint {
  consumer: string[];
  import: string;
  grant: { methods: string[]; recovery: boolean };
}
interface NativeGrant {
  origin: string[];
  consumer: string[];
  provider: string[];
  export: string;
  methods: string[];
  recovery: boolean;
}
interface ApplicationSources {
  host: CompositionInput;
  deployment: string;
  endpoints: Record<string, Endpoint>;
  native: NativeGrant[];
}
/** The shared business Host owns services independently of either shell. */
function settingsComposition(configuration: CompositionConfiguration) {
  const { packages, keys } = configuration;
  const local = (name: InstanceName, exportName: string): BindingTarget => ({
    kind: 'instance',
    path: [name],
    export: exportName,
  });
  const node = (
    name: PackageName,
    values: Record<string, unknown> = {},
    bindings: Record<string, BindingTarget[]> = {},
    identity: InstanceName = name,
  ): CompositionNode => ({
    key: keys[identity],
    package: { source: 'pinned', package: packages[name] },
    usePackage: 'host',
    configuration: { values },
    bindings,
  });
  const host: CompositionInput = {
    ui: { path: ['workbench-ui'], id: 'root' },
    instances: {
      'workbench-ui': {
        ...node('workbench', {}, {}, 'workbench-ui'),
        usePackage: 'ui',
      },
      'host-deployment-manager': node('host-deployment-manager'),
      'host-logs': node('host-logs'),
      'host-deployment-gateway': node(
        'deployment-gateway',
        {},
        {
          management: [local('host-deployment-manager', 'Management')],
          receipts: [local('receipts', 'Receipts')],
        },
        'host-deployment-gateway',
      ),
      settings: node('settings', {
        locale: configuration.locale,
        workspaceLocations: {
          agent: 'agent',
          skills: configuration.skills ? 'skills' : null,
          processes: configuration.processes ? 'workspace-processes' : null,
        },
      }),
      'settings-authentication': node('settings-authentication'),
      'settings-setup': node('settings-setup'),
      'skill-outcomes': node('skill-outcomes'),
      receipts: node('receipts'),
      'recovery-gateway': node(
        'recovery-gateway',
        {},
        {
          skillOutcomes: [local('skill-outcomes', 'Outcomes')],
          receipts: [local('receipts', 'Receipts')],
        },
      ),
      gateway: node(
        'gateway',
        {},
        {
          hostLogs: [local('host-logs', 'HostLogs')],
          settings: [local('settings', 'Settings')],
          authentication: [local('settings-authentication', 'Authentication')],
          setup: [local('settings-setup', 'Setup')],
        },
      ),
    },
  };
  const expose = (consumer: InstanceName, name: string, methods: string[], recovery: boolean) => ({
    consumer: [keys[consumer]],
    import: name,
    grant: { methods, recovery },
  });
  const endpoints: Record<string, Endpoint> = {
    management: expose(
      'host-deployment-gateway',
      'management',
      [
        'read',
        'readUi',
        'watch',
        'instances',
        'setEnabled',
        'readSettings',
        'configure',
        'bindingCandidates',
        'packageSettings',
        'editComposition',
        'readDocument',
        'replace',
        'install',
        'installSource',
        'installUrl',
        'readPackage',
        'exportPackage',
        'replaceSource',
      ],
      false,
    ),
    receipts: expose('recovery-gateway', 'receipts', ['read'], true),
    settings: expose(
      'gateway',
      'settings',
      Object.keys(contracts.settings.interface.methods),
      true,
    ),
    authentication: expose(
      'gateway',
      'authentication',
      Object.keys(contracts.settingsAuthentication.interface.methods),
      true,
    ),
    setup: expose('gateway', 'setup', Object.keys(contracts.settingsSetup.interface.methods), true),
    skillOutcomes: expose('recovery-gateway', 'skillOutcomes', ['read'], true),
  };
  return { host, endpoints, local, node, expose };
}
/** Keys and deployment belong to the installation, not to a build or shell. */
export function composition(configuration: CompositionConfiguration): ApplicationSources {
  const source = configuration.coordinator
    ? workhubComposition(configuration)
    : agentComposition(configuration);
  source.host.instances['workbench-ui']!.bindings = {
    ...source.host.instances.gateway!.bindings,
    management: [{ kind: 'instance', path: ['host-deployment-manager'], export: 'Management' }],
    receipts: [{ kind: 'instance', path: ['receipts'], export: 'Receipts' }],
    skillOutcomes: [{ kind: 'instance', path: ['skill-outcomes'], export: 'Outcomes' }],
  };
  return source;
}

function agentComposition(configuration: CompositionConfiguration): ApplicationSources {
  const { keys } = configuration;
  const { host, endpoints, local, node, expose } = settingsComposition(configuration);
  const executors = configuration.acpExecutors ?? [];
  if (
    new Set(executors.map((e) => e.name)).size !== executors.length ||
    executors.some((e) => !/^[a-zA-Z][a-zA-Z0-9._:-]*$/.test(e.name))
  )
    throw new Error('ACP backends require valid distinct executor names');
  if (configuration.agent.executors?.length)
    throw new Error('The standard composition selects executor imports through acpExecutors');
  if (executors.length && !configuration.executorProcesses)
    throw new Error('ACP backends require an explicit executorProcesses installation ceiling');
  const executorPath = (name: string): ExecutorInstanceName => `acp-${name}`;
  const computerMethods = [
    ...new Set(
      configuration.agent.tools
        .filter((tool) => tool.import === 'computer')
        .map((tool) => tool.method),
    ),
  ];
  if (computerMethods.length && !configuration.computer)
    throw new Error('Computer tools require an explicit native installation');
  if (computerMethods.some((method) => !['evaluate', 'reset'].includes(method)))
    throw new Error('Model Computer tools select only evaluate and reset');
  if (computerMethods.length)
    host.instances['workspace-computer'] = node('workspace-computer', {
      ...configuration.computer,
    });
  const webMethods = [
    ...new Set(
      configuration.agent.tools.filter((tool) => tool.import === 'web').map((tool) => tool.method),
    ),
  ];
  if (webMethods.length && !configuration.web)
    throw new Error('Web tools require an explicit network installation ceiling');
  if (webMethods.some((method) => method !== 'fetch' && method !== 'search'))
    throw new Error('Model Web tools select only fetch and search');
  const uiMethods = [
    ...new Set(
      configuration.agent.tools.filter((tool) => tool.import === 'ui').map((tool) => tool.method),
    ),
  ];
  const asksForms = configuration.agent.tools.some((tool) => tool.import === 'forms');
  const asksQuestions = configuration.agent.tools.some((tool) => tool.import === 'questions');
  const fileMethods = [
    ...new Set(
      configuration.agent.tools
        .filter((tool) => tool.import === 'files')
        .map((tool) => tool.method),
    ),
  ];
  const processMethods = [
    ...new Set(
      configuration.agent.tools
        .filter((tool) => tool.import === 'processes')
        .map((tool) => tool.method),
    ),
  ];
  const skillMethods = [
    ...new Set(
      configuration.agent.tools
        .filter((tool) => tool.import === 'skills')
        .map((tool) => tool.method),
    ),
  ];
  if (configuration.agent.skillLibrary != null && configuration.agent.skillLibrary !== 'skills')
    throw new Error('Skill input preparation selects the skills Library import');
  const skillCalls = [
    ...new Set([
      ...skillMethods,
      ...(configuration.agent.skillLibrary ? ['prepare', 'search'] : []),
    ]),
  ];
  if (skillCalls.length && !configuration.skills)
    throw new Error('Skill tools require explicitly selected skill collections');
  if (skillMethods.some((method) => method !== 'search' && method !== 'load'))
    throw new Error('Model skill tools select only search and load');
  if (processMethods.length && !configuration.processes)
    throw new Error(
      'Process tools require an explicit installation filesystem and network ceiling',
    );
  host.instances.agent = node(
    'agent',
    {
      ...configuration.agent,
      locale: configuration.locale,
      executors: executors.map((e, member) => ({
        name: e.name,
        import: 'executors',
        member,
        ...(configuration.executorProcesses?.setupDirectory
          ? { setup: { import: 'executorSetups', member } }
          : {}),
      })),
      // These imports bind known native v1 contracts. Freeze presentation in
      // the configuration; tool names and response shapes cannot opt into it.
      tools: configuration.agent.tools.map((tool) => {
        if (tool.import === 'web')
          return {
            ...tool,
            input: 'web' as const,
            ...(tool.presentation === undefined
              ? { presentation: `maka.workspace.Web@1/${tool.method}` }
              : {}),
          };
        if (tool.import === 'skills') return { ...tool, input: 'skill' as const };
        if (tool.import === 'processes' && tool.method === 'execute')
          tool = { ...tool, input: 'shell' };
        if (tool.presentation !== undefined) return tool;
        const contract =
          tool.import === 'files' &&
          ['readText', 'glob', 'grep', 'write', 'edit', 'applyPatch'].includes(tool.method)
            ? 'maka.workspace.Files'
            : tool.import === 'processes' &&
                ['execute', 'read', 'writeStdin', 'stop'].includes(tool.method)
              ? 'maka.workspace.Processes'
              : null;
        return contract ? { ...tool, presentation: `${contract}@1/${tool.method}` } : tool;
      }),
    },
    {
      ...(executors.length
        ? {
            ...(configuration.executorProcesses?.setupDirectory
              ? {
                  executorSetups: executors.map((e) => ({
                    kind: 'instance' as const,
                    path: [executorPath(e.name)],
                    export: 'setup',
                  })),
                }
              : {}),
            executors: executors.map((e) => ({
              kind: 'instance' as const,
              path: [executorPath(e.name)],
              export: 'executor',
            })),
          }
        : {}),
      ...(computerMethods.length ? { computer: [local('workspace-computer', 'computer')] } : {}),
      ...(webMethods.length ? { web: [local('workspace-web', 'web')] } : {}),
      ...(skillCalls.length ? { skills: [local('skills', 'skills')] } : {}),
      ...(uiMethods.length ? { ui: [local('host-deployment-manager', 'Management')] } : {}),
      ...(asksForms ? { forms: [local('forms', 'forms')] } : {}),
      ...(asksQuestions ? { questions: [local('questions', 'questions')] } : {}),
      ...(fileMethods.length ? { files: [local('workspace-files', 'files')] } : {}),
      ...(processMethods.length ? { processes: [local('workspace-processes', 'processes')] } : {}),
    },
  );
  host.instances['workspace-files-ui'] = {
    ...node('workspace-files', {}, {}, 'workspace-files-ui'),
    usePackage: 'ui',
  };
  if (asksForms || executors.length) host.instances.forms = node('forms');
  if (asksQuestions) host.instances.questions = node('questions');
  if (fileMethods.length || executors.length)
    host.instances['workspace-files'] = node('workspace-files');
  if (executors.length) {
    host.instances['protocol-processes'] = node('protocol-processes', {
      ...configuration.executorProcesses!,
      sessionOwner: [keys.agent],
      sessionKind: 'agent',
    });
    for (const executor of executors) {
      host.instances[executorPath(executor.name)] = {
        ...node(
          'acp-executor',
          { ...executor.configuration },
          {
            processes: [local('protocol-processes', 'protocol')],
            files: [local('workspace-files', 'files')],
            forms: [local('forms', 'forms')],
          },
        ),
        key: keys[executorPath(executor.name)]!,
      };
    }
  }
  if (configuration.processes)
    host.instances['workspace-processes'] = node(
      'workspace-processes',
      {
        ...configuration.processes,
        sessionOwner: [keys.agent],
        sessionKind: 'agent',
      },
      configuration.web && processMethods.includes('health')
        ? { web: [local('workspace-web', 'web')] }
        : {},
    );
  host.instances.gateway!.bindings!.agent = [local('agent', 'agent')];
  if (configuration.processes)
    host.instances.gateway!.bindings!.terminal = [local('workspace-processes', 'terminal')];
  if (configuration.web) {
    host.instances['workspace-web'] = node('workspace-web', { ...configuration.web });
    host.instances.gateway!.bindings!.web = [local('workspace-web', 'web')];
    Object.assign(endpoints, {
      web: expose('gateway', 'web', ['snapshot', 'save', 'saveKey', 'deleteKey', 'checkKey'], true),
    });
  }
  if (configuration.jev) {
    host.instances['workspace-jev'] = node('workspace-jev', { ...configuration.jev });
    host.instances.gateway!.bindings!.jev = [local('workspace-jev', 'jev')];
    Object.assign(endpoints, {
      jev: expose('gateway', 'jev', ['snapshot', 'save', 'credential', 'evaluate'], true),
    });
  }
  if (configuration.skills) {
    host.instances.skills = node('skills', { ...configuration.skills });
    host.instances.gateway!.bindings!.skills = [local('skills', 'skills')];
    Object.assign(endpoints, {
      skills: expose(
        'gateway',
        'skills',
        [
          'list',
          'read',
          ...(configuration.skills.manage
            ? ['preview', 'apply', 'importSource', 'deleteSource']
            : []),
          ...(configuration.skills.preferences ? ['setPreference'] : []),
        ],
        !!(configuration.skills.manage || configuration.skills.preferences),
      ),
    });
  }
  Object.assign(endpoints, {
    agent: expose('gateway', 'agent', Object.keys(contracts.agent.interface.methods), true),
    hostLogs: expose('gateway', 'hostLogs', ['read', 'watch'], false),
  });
  if (configuration.processes) {
    Object.assign(endpoints, {
      terminal: expose(
        'gateway',
        'terminal',
        Object.keys(contracts.terminal.interface.methods),
        true,
      ),
    });
  }
  let native: NativeGrant[] = [];
  if (
    uiMethods.length ||
    asksForms ||
    asksQuestions ||
    fileMethods.length ||
    processMethods.length ||
    skillCalls.length ||
    executors.length
  )
    native = [
      ...(uiMethods.length
        ? [
            {
              origin: [keys.agent],
              consumer: [keys.agent],
              provider: [keys['host-deployment-manager']],
              export: 'Management',
              methods: uiMethods,
              recovery: true,
            },
          ]
        : []),
      ...executors.flatMap((executor) => [
        ...(configuration.executorProcesses?.setupDirectory
          ? [
              {
                origin: [keys.agent],
                consumer: [keys.agent],
                provider: [keys[executorPath(executor.name)]!],
                export: 'setup',
                methods: ['setup'],
                recovery: true,
              },
            ]
          : []),
        {
          origin: [keys.agent],
          consumer: [keys.agent],
          provider: [keys[executorPath(executor.name)]!],
          export: 'executor',
          methods: ['execute'],
          recovery: true,
        },
        ...[
          {
            provider: keys['protocol-processes'],
            export: 'protocol',
            methods: [
              'run',
              'input',
              ...(configuration.executorProcesses?.setupDirectory ? ['launch'] : []),
            ],
          },
          { provider: keys['workspace-files'], export: 'files', methods: ['readText', 'write'] },
          { provider: keys.forms, export: 'forms', methods: ['ask'] },
        ].map((grant) => ({
          ...grant,
          origin: [keys[executorPath(executor.name)]!],
          consumer: [keys[executorPath(executor.name)]!],
          provider: [grant.provider],
          recovery: true,
        })),
      ]),
      ...(computerMethods.length
        ? [
            {
              origin: [keys.agent],
              consumer: [keys.agent],
              provider: [keys['workspace-computer']],
              export: 'computer',
              methods: [...computerMethods, 'state'],
              recovery: true,
            },
          ]
        : []),
      ...(webMethods.length
        ? [
            {
              origin: [keys.agent],
              consumer: [keys.agent],
              provider: [keys['workspace-web']],
              export: 'web',
              methods: [...webMethods, 'capture'],
              recovery: true,
            },
          ]
        : []),
      ...(skillCalls.length
        ? [
            {
              origin: [keys.agent],
              consumer: [keys.agent],
              provider: [keys.skills],
              export: 'skills',
              methods: skillCalls,
              recovery: false,
            },
          ]
        : []),
      ...(asksForms
        ? [
            {
              origin: [keys.agent],
              consumer: [keys.agent],
              provider: [keys.forms],
              export: 'forms',
              methods: ['ask'],
              recovery: true,
            },
          ]
        : []),
      ...(asksQuestions
        ? [
            {
              origin: [keys.agent],
              consumer: [keys.agent],
              provider: [keys.questions],
              export: 'questions',
              methods: ['ask'],
              recovery: true,
            },
          ]
        : []),
      ...(fileMethods.length
        ? [
            {
              origin: [keys.agent],
              consumer: [keys.agent],
              provider: [keys['workspace-files']],
              export: 'files',
              methods: fileMethods,
              recovery: true,
            },
          ]
        : []),
      ...(processMethods.length
        ? [
            {
              origin: [keys.agent],
              consumer: [keys.agent],
              provider: [keys['workspace-processes']],
              export: 'processes',
              methods: processMethods,
              recovery: true,
            },
          ]
        : []),
      ...(processMethods.includes('health') && configuration.web
        ? [
            {
              origin: [keys.agent],
              consumer: [keys['workspace-processes']],
              provider: [keys['workspace-web']],
              export: 'web',
              methods: ['probe'],
              recovery: true,
            },
          ]
        : []),
    ];
  return { host, deployment: configuration.hostDeployment, endpoints, native };
}

/** One native coordinator and an explicitly selected worker share the business Host. */
function workhubComposition(configuration: CompositionConfiguration): ApplicationSources {
  if (!configuration.coordinator)
    throw new Error('WorkHub requires an explicit coordinator Agent configuration');
  const { keys, packages } = configuration;
  const worker = agentComposition(configuration);
  const coordinator = agentComposition({
    ...configuration,
    agent: configuration.coordinator,
    processes: configuration.coordinatorProcesses,
    acpExecutors: configuration.coordinatorAcpExecutors,
    executorProcesses: configuration.coordinatorExecutorProcesses,
    keys: {
      ...keys,
      ...Object.fromEntries(
        (configuration.coordinatorAcpExecutors ?? []).map((e) => [
          `acp-${e.name}`,
          keys[`coordinator-acp-${e.name}`],
        ]),
      ),
    },
  });
  const local = (name: string, exportName: string): BindingTarget => ({
    kind: 'instance',
    path: [name],
    export: exportName,
  });
  const processName = 'coordinator-workspace-processes';
  const protocolName = 'coordinator-protocol-processes';
  const coordinatorExecutors = new Set(
    (configuration.coordinatorAcpExecutors ?? []).map((e) => `acp-${e.name}`),
  );
  const hostName = (name: string) =>
    name === 'agent'
      ? 'workhub'
      : name === 'workspace-processes'
        ? processName
        : name === 'protocol-processes'
          ? protocolName
          : coordinatorExecutors.has(name)
            ? `coordinator-${name}`
            : name;
  const remapHost = (target: BindingTarget): BindingTarget =>
    target.kind === 'instance' && target.path.length === 1
      ? {
          ...target,
          path: [hostName(target.path[0])],
        }
      : target;
  const remapBindings = (node: CompositionNode, map: (target: BindingTarget) => BindingTarget) =>
    Object.fromEntries(
      Object.entries(node.bindings ?? {}).map(([name, targets]) => [name, targets?.map(map)]),
    );
  for (const [name, node] of Object.entries(coordinator.host.instances)) {
    if (!node) continue;
    if (name === 'agent' || name === 'gateway' || name === 'workspace-processes') continue;
    const mapped = hostName(name);
    if (!worker.host.instances[mapped])
      worker.host.instances[mapped] = {
        ...node,
        ...(name === 'protocol-processes'
          ? {
              key: keys[protocolName],
              configuration: {
                values: {
                  ...node.configuration!.values,
                  sessionOwner: [keys.workhub],
                  sessionKind: 'workhub',
                },
              },
            }
          : {}),
        bindings: remapBindings(node, remapHost),
      };
  }
  const agent = coordinator.host.instances.agent!;
  worker.host.instances.workhub = {
    ...agent,
    key: keys.workhub,
    package: { source: 'pinned', package: packages.workhub },
    configuration: { values: { agent: agent.configuration!.values, workers: ['worker'] } },
    bindings: { ...remapBindings(agent, remapHost), worker: [local('agent', 'agent')] },
  };
  if (configuration.coordinatorProcesses) {
    const processes = coordinator.host.instances['workspace-processes']!;
    worker.host.instances[processName] = {
      ...processes,
      key: keys[processName],
      configuration: {
        values: {
          ...processes.configuration!.values,
          sessionOwner: [keys.workhub],
          sessionKind: 'workhub',
        },
      },
    };
  }
  const gateway = worker.host.instances.gateway!.bindings!;
  gateway.coordinator = [local('workhub', 'agent')];
  gateway.workhub = [local('workhub', 'workhub')];
  if (configuration.coordinatorProcesses)
    gateway.coordinatorTerminal = [local(processName, 'terminal')];

  const hostIdentity = (identity: string[]) =>
    identity[0] === keys.agent
      ? [keys.workhub]
      : identity[0] === keys['workspace-processes']
        ? [keys[processName]]
        : identity[0] === keys['protocol-processes']
          ? [keys[protocolName]]
          : identity;
  const endpoint = (name: string, methods: string[]) => ({
    consumer: [keys.gateway],
    import: name,
    grant: { methods, recovery: true },
  });
  worker.endpoints.coordinator = endpoint(
    'coordinator',
    Object.keys(contracts.agent.interface.methods),
  );
  worker.endpoints.workhub = endpoint(
    'workhub',
    Object.keys(contracts.workhubCoordinator.interface.methods),
  );
  if (configuration.coordinatorProcesses)
    worker.endpoints.coordinatorTerminal = endpoint(
      'coordinatorTerminal',
      Object.keys(contracts.terminal.interface.methods),
    );
  worker.native = [
    ...worker.native,
    ...coordinator.native.map((grant) => ({
      ...grant,
      origin: hostIdentity(grant.origin),
      consumer: hostIdentity(grant.consumer),
      provider: hostIdentity(grant.provider),
    })),
    {
      origin: [keys.workhub],
      consumer: [keys.workhub],
      provider: [keys.agent],
      export: 'agent',
      methods: [
        'list',
        'directories',
        'create',
        'uploadAttachment',
        'send',
        'execution',
        'execute',
        'executors',
        'tools',
        'snapshotPatch',
        'readPatch',
        'work',
        'observe',
        'watch',
        'stop',
        'resume',
        'queue',
        'editQueue',
      ],
      recovery: true,
    },
  ];
  return worker;
}
