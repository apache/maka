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

import type { CompositionConfiguration } from './composition.js';

/** Trusted launcher inputs. Product defaults live with the ordinary composition. */
export interface InstallationOptions {
  workspace: string;
  helper: string;
  home?: string;
  locale?: string;
}

export function installation(
  options: InstallationOptions,
): Omit<CompositionConfiguration, 'packages' | 'keys' | 'hostDeployment'> {
  const workspaceRoots: CompositionConfiguration['agent']['workspaceRoots'] = [
    { label: 'Workspace', path: options.workspace },
  ];
  const tools: CompositionConfiguration['agent']['tools'] = [];
  const add = (
    service: string,
    method: string,
    name: string,
    description: string,
    result: 'json' | 'image' | 'computer' = 'json',
  ) =>
    tools.push({
      import: service,
      method,
      name,
      description,
      result,
      confirmation: 'preapproved',
      nestable: ['files', 'processes', 'web', 'skills'].includes(service),
    });
  add('files', 'readText', 'Read', 'Read text from a file in the selected workspace.');
  add('files', 'readImage', 'ReadImage', 'Read an image in the selected workspace.', 'image');
  add('files', 'glob', 'Glob', 'Find files in the selected workspace.');
  add('files', 'grep', 'Grep', 'Search file contents in the selected workspace.');
  add('files', 'write', 'Write', 'Write a file in the selected workspace.');
  add('files', 'edit', 'Edit', 'Edit a file in the selected workspace.');
  add('files', 'applyPatch', 'ApplyPatch', 'Apply a patch in the selected workspace.');
  add('processes', 'execute', 'Shell', 'Run a command under the selected workspace permissions.');
  add('processes', 'read', 'ProcessRead', 'Read output from a previously started command.');
  add(
    'processes',
    'health',
    'BackgroundTaskHealth',
    'Check a Shell process and optionally an HTTP(S) endpoint. Process state and endpoint health are independent; endpoint success does not prove listener ownership or browser readiness. Uses HEAD, falling back to GET for 405/501, without redirects or response bodies. Set include_logs for logs. Endpoint access requires network permission; elapsed time includes approval.',
  );
  add('processes', 'writeStdin', 'ProcessInput', 'Send input to a previously started command.');
  add('processes', 'stop', 'ProcessStop', 'Stop a previously started command.');
  add('web', 'fetch', 'WebFetch', 'Read a web page. Network destinations require permission.');
  add('web', 'search', 'WebSearch', 'Search using the selected model or Tavily.');
  add(
    'computer',
    'evaluate',
    'cua_repl',
    'Execute JavaScript in a persistent, session-owned Computer Use REPL, independent of Code Mode. Start with await cua.getState() or const app = await cua.getApp(...); discovery and selection emit state and API documentation. Variables and targets persist within this Host process. No Node, filesystem or arbitrary network APIs. Cancellation, timeout or heap exhaustion requires cua_reset and target rebinding; dispatched input may already have taken effect.',
    'computer',
  );
  add(
    'computer',
    'reset',
    'cua_reset',
    'Reset this session’s Computer Use REPL and bindings after admitted actions settle. Does not close user applications. Bind targets again afterward.',
    'computer',
  );
  add('questions', 'ask', 'AskUserQuestion', 'Ask the user for decisions needed to continue.');
  for (const [method, name, description] of [
    [
      'read',
      'PluginReadDeployment',
      'Read the current deployment source and immutable package identities.',
    ],
    [
      'readUi',
      'PluginReadUiCatalog',
      'Read enabled UI plugin contributions for the shared workbench.',
    ],
    [
      'instances',
      'PluginInstances',
      'Inspect Host, UI and composition instances in the current deployment.',
    ],
    [
      'readDocument',
      'PluginReadDeploymentDocument',
      'Read the canonical deployment document before editing it.',
    ],
    [
      'readPackage',
      'PluginReadPackage',
      'Read a source file from an immutable installed plugin package.',
    ],
    [
      'installSource',
      'PluginInstallSource',
      'Install plugin files into this deployment. Installation makes a package available; enable a UI instance with PluginEditComposition to show it.',
    ],
    ['installUrl', 'PluginInstallUrl', 'Install an immutable plugin package from a URL.'],
    [
      'editComposition',
      'PluginEditComposition',
      'Insert, remove or update Host, UI and composition instances using the observed source revision.',
    ],
    [
      'setEnabled',
      'PluginSetEnabled',
      'Enable or disable an existing Host, UI or composition instance using the observed source revision.',
    ],
    [
      'readSettings',
      'PluginReadSettings',
      'Read configuration fields and values for an existing instance.',
    ],
    [
      'configure',
      'PluginConfigure',
      'Update an instance configuration using its observed source revision.',
    ],
    [
      'bindingCandidates',
      'PluginBindingCandidates',
      'Inspect compatible bindings in the current deployment.',
    ],
    [
      'packageSettings',
      'PluginPackageSettings',
      'Read the configuration fields for a selected Host, UI or composition entry.',
    ],
    [
      'replaceSource',
      'PluginReplaceDeployment',
      'Replace the canonical deployment source and package selection using its observed revision.',
    ],
  ] as const)
    add(
      'ui',
      method,
      name,
      description +
        ' The maka-plugin-authoring skill documents the shared NSH UI contract. Mutation outcomes use the original operation receipt; an unknown result must be recovered, not retried as a new edit.',
    );
  add('skills', 'search', 'SkillSearch', 'Find applicable skills in the selected collections.');
  add('skills', 'load', 'Skill', 'Read a selected skill and its resources.');
  const agent: CompositionConfiguration['agent'] = {
    toolDiscovery: true,
    isolatedWorkspaces: true,
    workspaceRoots,
    assistant: options.home ? { home: options.home } : {},
    importRoots: [{ label: 'Conversation sources', path: options.home ?? options.workspace }],
    permissions: { access: 'workspace_write', requestPermissions: true },
    recall: true,
    scheduledTasks: true,
    todo: true,
    goals: true,
    plans: true,
    automaticTitles: true,
    recaps: true,
    tools,
    skillLibrary: 'skills',
  };
  const processes: NonNullable<CompositionConfiguration['processes']> = {
    isolatedWorkspaces: true,
    filesystem: {
      default: 'write',
      rules: [],
      denyGlobs: [],
    },
    // Installation ceilings allow approval requests. The session preset still
    // limits writes to workspace/temp and denies networking until approved.
    network: 'allowed',
    helper: options.helper,
  };
  return {
    locale: options.locale ?? 'auto',
    agent,
    processes,
    computer: { desktop: 'auto', browsers: [] },
    web: { network: 'allowed' },
    jev: { network: 'allowed' },
    coordinator: agent,
    coordinatorProcesses: processes,
    skills: {
      sources: [],
      bundled: true,
      manage: true,
      preferences: true,
      projectRoots: workspaceRoots,
      ...(options.home ? { home: options.home } : {}),
    },
  };
}
