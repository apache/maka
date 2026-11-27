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
  add(
    'files',
    'read',
    'Read',
    'Read UTF-8 workspace files, PNG/JPEG/GIF/WebP images, or Maka resources (maka://session/<id>, maka://session/<id>/tool-results/<event-id>, attachment:<id>, archive:<event-id>). Line offset is 0-based; relative paths cannot contain ".." or cross symlinks. In Code Mode, pass an image result to image() to show it to the model.',
    'image',
  );
  add(
    'files',
    'write',
    'Write',
    'Create or overwrite a UTF-8 file in the selected workspace. Parent directories must already exist; paths cannot contain ".." or cross symlinks.',
  );
  add(
    'files',
    'edit',
    'Edit',
    'Replace an exact, unique old_string with new_string in an existing workspace file. Read the file first; paths cannot contain ".." or cross symlinks.',
  );
  add(
    'files',
    'applyPatch',
    'ApplyPatch',
    'Apply a patch to create, update, or delete one or more files in the selected workspace. Pass `patch` wrapped in `*** Begin Patch` and `*** End Patch`, using sections `*** Add File: <path>` (every line prefixed with `+`), `*** Update File: <path>` (contextual `@@` hunks with ` `, `-`, `+` line prefixes; optional `*** End of File`), and `*** Delete File: <path>`. Parent directories must exist when adding files; paths cannot contain ".." or cross symlinks; moves are unsupported.',
  );
  add('processes', 'execute', 'Shell', 'Run a command under the selected workspace permissions.');
  add(
    'processes',
    'read',
    'ProcessRead',
    'Read recent stdout/stderr and status from a background Shell process using its ref.',
  );
  add(
    'processes',
    'health',
    'BackgroundTaskHealth',
    'Check a Shell process and optionally an HTTP(S) endpoint. Process state and endpoint health are independent; endpoint success does not prove listener ownership or browser readiness. Uses HEAD, falling back to GET for 405/501, without redirects or response bodies. Set include_logs for logs. Endpoint access requires network permission; elapsed time includes approval.',
  );
  add(
    'processes',
    'writeStdin',
    'ProcessInput',
    'Send stdin text, keystrokes, mouse events, or terminal resize to a background Shell process using its ref.',
  );
  add('processes', 'stop', 'ProcessStop', 'Stop a background Shell process.');
  add('web', 'fetch', 'WebFetch', 'Read a web page. Network destinations require permission.');
  add(
    'web',
    'search',
    'WebSearch',
    'Search using the selected model or a configured search service.',
  );
  add(
    'computer',
    'evaluate',
    'cua_repl',
    'Execute JavaScript in a persistent, session-owned Computer Use REPL, independent of Code Mode. Start with await cua.getState() or const app = await cua.getApp(...); discovery and observation methods emit state and API docs automatically. Emit custom values with nodeRepl.write(value) or nodeRepl.emitImage(image) (exec helpers like text() are not defined here). Variables and targets persist within this Host process; no Node, filesystem, or arbitrary network APIs. Cancellation, timeout, or heap exhaustion requires cua_reset and target rebinding.',
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
        ' Consult the maka-plugin-authoring skill for the shared UI contract; if a mutation outcome is uncertain, re-read the current state before retrying.',
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
      'Persist a shared subagent preset only when the user explicitly asks to create a reusable role; never save one-off task requirements or store roles in workspace files. Clarify an ambiguous name or missing description/model choice before saving. Pass a native ModelList kind=model choice as model: {connectionId, modelId} with optional thinkingLevel (executor runtimes are unsupported). Report success only for kind=saved; if an outcome is uncertain, check SubagentPresetList before retrying.',
    ],
    [
      'updatePreset',
      'SubagentPresetUpdate',
      'Modify a shared preset only at the user\'s explicit request, supplying expectedRevision from SubagentPresetRead. Send only fields to change: omitted fields stay untouched, instruction="" clears the instruction, thinkingLevel={kind:"default"} restores default, and enabled toggles availability. Changes apply to future sessions only; on revision conflict, re-read and reconcile instead of overwriting.',
    ],
    [
      'deletePreset',
      'SubagentPresetDelete',
      'Delete an explicitly requested shared preset by stable ID and expectedRevision. Existing sessions keep their applied role; on revision conflict, re-read before retrying.',
    ],
    [
      'sessionList',
      'SessionList',
      'List or search Agent conversations and Rooms. Filter by kind ("agent" | "room"), scope ("all" | "children" | "archived"), query (matches title or workspace path), workspacePath, or activity ("idle" | "working" | "waiting"). With scope="children", parentSessionId defaults to your own Session. Pass nextCursor as cursor to paginate.',
    ],
    [
      'sessionRead',
      'SessionRead',
      'Inspect an Agent conversation or Room in one call: metadata, active/latest Run state and blockers, pending questions/approvals, queued messages, Room roster/topic/pins, and transcript. Omit sessionId to inspect your own Session. Links like [#Room](maka://session/<id>), [@Conversation](maka://session/<id>), or Room attachment URIs maka://session/<id>/attachments/<attachment-id> can be read with Read({ path }) or SessionRead({ sessionId: "<id>" }). For Agent sessions, view defaults to "turns" (conversation digest with resultPath URIs you can pass to Read for full tool outputs); use "raw" for raw chunks or "status_only" to skip transcript rows. Paginate with beforeCursor/afterCursor as cursor, navigate Rooms with messageId + anchor ("at" | "before" | "after" | "around"), search Rooms with searchQuery, or pass row for exact Recall/Cell lookups. Reading a finished worker's untruncated tail (view != "status_only", default/tail position) automatically retracts its pending completion notice.',
    ],
    [
      'sessionCreate',
      'SessionCreate',
      'Create a new Agent conversation or shared Room (kind="room"), or branch from an existing conversation via forkFrom (when using forkFrom, omit workspace, kind, presetId, backend, tools, and automaticTitle, which are cloned from the source). Choose a specific, recognizable task title (e.g. "Fix queued-message cancellation"). Workspace defaults to { kind: "same" } (reuses your workspace); pass { kind: "worktree" } for an isolated Git worktree or { kind: "directory", path } for another allowed root. For a reusable role, pass presetId from SubagentPresetList and omit backend (report an unavailable requested preset without substituting); otherwise omit backend to inherit defaults or pass a ModelList selection. Follow up with SessionSend to dispatch the task.',
    ],
    [
      'sessionSend',
      'SessionSend',
      'Send a message to an Agent conversation (a worker you created or an existing conversation when requested) or post to a Room. For Room posts, replyTo threads your reply, inline [@Name](maka://session/<id>) tokens or mentions wake listed Agent sessions (with automatic Room context, co-mentions, and hop-limit safety), and attachments may reference uploads in the Room or your own Session. Delivery defaults to "steer" (injected cleanly at the next step boundary so long-running teammates stay responsive); pass "queue" to wait until their active turn finishes. For Agent workers, state the objective, context, constraints, and expected deliverable (workers do not share your chat history unless forked); onComplete defaults to "notify_caller" when messaging a worker, waking you automatically with an inline <worker_result> summary (end your turn to wait asynchronously; if you read the finished tail with SessionRead first, the pending completion notice is retracted automatically).',
    ],
    [
      'respond',
      'SessionRespond',
      'Answer a pending question or permission approval for a direct worker Session you created, using requestId from SessionRead. You may approve within your own effective permissions (prefer scope="once" when supported); broader grants pause and escalate to the human user. Do not retry a call that is waiting on human escalation.',
    ],
    [
      'sessionStop',
      'SessionStop',
      'Stop the active Run in a worker Session you created. Omit runId to stop whichever Run is currently active, or pass a specific runId to avoid stopping a newer Run.',
    ],
    [
      'sessionManage',
      'SessionManage',
      'Manage Session metadata, lifecycle, queued messages, native-model Run continuation, or Room collaboration state via action: update (title, labels, pinned), archive, restore, remove (deletes history permanently; not needed to hide workers, which are already hidden from the main sidebar), edit_queue (retract, promote, update, or reorder messages sent by your Session), continue_run (continue an eligible terminal native-model Run), or for Rooms: room_topic, room_members, room_react (lightweight acknowledgement like ✅ or 👀), room_pin, room_edit, and room_delete. Omit expectedRevision to apply against current state, or pass it for optimistic concurrency.',
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
