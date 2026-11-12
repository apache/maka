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

import type { ServiceMethods } from '../../../../packages/plugin-sdk/src/index.js';
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
      target: { kind: 'import', name: service },
      method,
      name,
      description,
      result,
      confirmation: 'preapproved',
      nestable: ['files', 'processes', 'web', 'skills', 'ui'].includes(service),
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
  for (const [method, name, description] of [
    [
      'models',
      'ModelList',
      'List selectable native models and enabled executor runtimes. Search model IDs, labels and source names with query. Pass a choice selection as SessionCreate/SessionSend backend; its kind preserves the execution source. Thinking levels are source-specific. Continue with the returned revision and next cursor; restart on changed. This is a catalog observation, not an execution or permissions grant.',
    ],
    [
      'presets',
      'SubagentPresetList',
      'List shared subagent preset summaries: stable ID, name, description, native model, revision and availability, without full instructions. For task selection use availability.kind=available; disabled or invalid entries remain visible for management. Query when a role is relevant, not before every conversation. No match or an empty list still permits ordinary delegation.',
    ],
    [
      'preset',
      'SubagentPresetRead',
      'Read a shared subagent preset by stable ID, including its full instruction, revision and availability. Use before editing or resolving an ambiguous role; null means not found. Description explains when to select a role; instruction guides its execution; the current task belongs in SessionSend.',
    ],
    [
      'createPreset',
      'SubagentPresetCreate',
      'Persist a shared subagent preset only when the user explicitly asks to create a reusable role. Do not save one-off task requirements. Clarify an ambiguous name or missing description/model choice. Use a native ModelList kind=model choice as model: {connectionId, modelId}, with its optional thinkingLevel; executor choices are unsupported. Instruction may be empty. Report success only for kind=saved and show the actual returned saved configuration. For an unknown outcome recover the original operation receipt; never submit a replacement creation.',
    ],
    [
      'updatePreset',
      'SubagentPresetUpdate',
      'Modify a shared preset only at the user\'s explicit request. Read its current revision and supply expectedRevision. Send only requested fields; omitted fields remain unchanged, instruction="" clears the role instruction, thinkingLevel={kind:"default"} restores default, and enabled toggles availability. Changes affect future sessions only. On conflict re-read and reconcile the requested change, never blindly overwrite. Only kind=saved is success; report other outcomes accurately. Recover an unknown outcome from the original operation receipt without submitting another edit.',
    ],
    [
      'deletePreset',
      'SubagentPresetDelete',
      'Delete the explicitly requested shared preset by stable ID and its observed expectedRevision. Follow the ordinary operation flow without extra mandatory confirmation rounds. Existing sessions retain their applied role. Only kind=deleted is success; on conflict re-read and reconcile, and recover unknown outcomes using the original operation receipt rather than resubmitting.',
    ],
    [
      'list',
      'SessionList',
      'Find conversations by task title, workspace/project or status. Use scope=children with your sessionId to enumerate workers you created. Child conversations remain discoverable here even though the human sidebar hides them.',
    ],
    [
      'observe',
      'SessionRead',
      'Inspect a conversation before controlling it: current revision, parent, sandbox policy, selected backend and active Run. Use its actual state and Run IDs rather than assuming an earlier send has completed.',
    ],
    [
      'history',
      'SessionHistory',
      'Read a conversation transcript to inspect actual delegated results and failures. Page with returned cursors; tool metadata alone is not the full tool output. Use the indicated result reader when evidence is archived.',
    ],
    [
      'create',
      'SessionCreate',
      'Create a child conversation for a distinct delegated task. Choose a concise, specific task title that a person can recognize later (for example, "Fix queued-message cancellation", not "worker 1"). The child inherits your current sandbox policy, not your one-off approvals. Select a workspace by directory path (absolute, ~ allowed, within the configured workspace locations) or reuse a conversation\'s with kind=session, then use SessionSend to provide the objective, relevant context, constraints and expected deliverable. To apply a reusable role, pass presetId from SubagentPresetList and omit backend; creation rechecks the latest preset and captures its instruction and model. Do not copy its instruction into the task. If an explicitly requested preset is unavailable, report the specific reason without substituting another role or model. With no explicit role, choose an appropriate available preset or delegate normally. Recover uncertain creation using its original operation receipt, not another SessionCreate.',
    ],
    [
      'fork',
      'SessionFork',
      'Create a child conversation seeded with a selected history prefix when the worker needs that context. Choose a specific task title and a complete turn boundary; use SessionCreate instead for an independent task.',
    ],
    [
      'metadata',
      'SessionUpdate',
      'Update a conversation title, labels or pin using its current revision. Use a concise task-oriented title that identifies the work. Agent calls cannot change sandbox permissions; permission changes require a human action.',
    ],
    [
      'changeSession',
      'SessionChange',
      'Archive, restore or delete a conversation using its current revision. Deletion removes history; do not use it merely to hide workers, which are already kept out of the human sidebar.',
    ],
    [
      'send',
      'SessionSend',
      'Send a task or follow-up to a conversation. For additional context, corrections, progress updates or guidance for ongoing work, omit delivery or use delivery=steer (the default). Use delivery=queue only when the message should wait until the current turn ends. Give the objective, necessary context, constraints and expected result; the child does not automatically share your conversation history. Your source conversation is attributed automatically. Active native model, Codex and Claude turns accept steering; Antigravity uses soft interrupt/resume where supported. Other executors queue follow-ups. For a preset conversation, omit backend to preserve its selected model; only supply backend for an explicit model override. Other new conversations may use a backend selection from ModelList; omission requires a saved target backend preference. A started/queued receipt confirms admission, not completion; queued may also mean pending steering. For native model callers, set onComplete=notify_caller to request a best-effort Host notification when that message finishes, fails or is cancelled, and once per pending interaction or authority blocker that needs attention. An attention notification does not finish the task or remove its completion watch; inspect the referenced interaction or SessionWork, address it within your existing authority or ask the user, and do not redispatch the task. Check completion in the receipt: registered means the watch was saved with task admission, so do other work or finish your turn instead of polling for completion. Progress queries remain available. Use SessionWork/SessionHistory to read actual results before reporting success.',
    ],
    [
      'stop',
      'SessionStop',
      'Request Stop for the exact active Run read from SessionRead. Cancellation may still be settling; inspect SessionWork before reporting that the work has stopped or starting a replacement.',
    ],
    [
      'continueRun',
      'SessionContinueRun',
      'Continue from an eligible terminal native-model Run (completed, failed or cancelled) using its exact sourceRunId and sourceHighWater returned by SessionExecution. Supply model: { connectionId, modelId } from a ModelList kind=model choice and its native thinkingLevel, not a tagged backend/executor selection. This admits a new continuation Run, never replays the original request or resumes an old process. First reconcile all original effects and cleanup with SessionExecution/SessionWork.',
    ],
    [
      'pendingInteractions',
      'SessionPendingInteractions',
      'List pending approvals and questions for a direct child you created. If the child is waiting for input, read the selected request with SessionInteraction before deciding with SessionRespond. This does not answer or approve anything.',
    ],
    [
      'interaction',
      'SessionInteraction',
      'Read one direct child interaction, its exact request and any committed outcome. Inspect the requested action, permission scope and context before responding; never infer approval requirements from a child message alone.',
    ],
    [
      'respond',
      'SessionRespond',
      'Answer or approve an interaction belonging to a direct child you created. Use the original requestId and a matching answer. You may approve within your current effective authority; broader permissions or a grant lasting longer than your authority pause this call and ask the human in your conversation. Prefer a once grant when the original request supports it. Do not retry a waiting call. You cannot self-approve, approve siblings, or answer human-only escalations. The returned record contains the winning outcome, which may have been answered concurrently.',
    ],
    [
      'queue',
      'SessionQueue',
      'Read queued messages and the queue revision before editing or retracting a follow-up. A queued message has not necessarily reached the worker yet.',
    ],
    [
      'editQueue',
      'SessionEditQueue',
      'Update, retract, promote or reorder only messages sent by your own conversation, using the observed queue revision and original message IDs. Human messages and other conversations’ messages cannot be edited, even in a child you manage. Keep the existing admission rather than resending an uncertain message.',
    ],
    [
      'work',
      'SessionWork',
      'Observe progress or completion for an original message or Run. Continue with the returned cursor; running or admitted is not a completed result. Read final output before reporting success.',
    ],
    [
      'execution',
      'SessionExecution',
      'Resolve the original Run by runId, including its state, waits/blockers and highWater fence. Reconcile this record after uncertainty instead of blindly repeating the delegated task.',
    ],
  ] as const satisfies readonly (readonly [keyof ServiceMethods['agent'], string, string])[])
    tools.push({
      target: { kind: 'export', name: 'agent' },
      method,
      name,
      description,
      result: 'json',
      confirmation: 'preapproved',
      nestable: true,
    });
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
    // Registers SendUser for the Bot Session only; nothing runs until the user opens the Bot.
    bot: true,
    goals: true,
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
    decisions_api: { network: 'allowed' },
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
