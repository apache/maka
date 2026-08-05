import { app } from 'electron';
import {
  buildAskUserQuestionTool,
  buildRequestSandboxBoundaryTool,
  buildChildAgentTools,
  buildParentAgentTools,
  assertProductBindingCatalogClean,
  createBuiltinSandboxManager,
  isBuiltinFilesystemWorkerSandboxAvailable,
  createSandboxDiagnosticsProvider,
  createFilesystemWorkerLaunchSpecProvider,
  FilesystemWorkerClient,
  projectEffectiveProductToolSurface,
  resolveSkillDiscoveryPaths,
  ShellRunProcessManager,
} from '@maka/runtime';
import type { HostCapabilitiesResolver, MakaTool } from '@maka/runtime';
import type { AppSettings, UpdateAppSettingsInput } from '@maka/core';
import type { WorkspacePrivacyContext } from '@maka/core/incognito';
import {
  createArtifactAttachmentResourceReader,
  createSettingsStore,
  type ArtifactStore,
} from '@maka/storage';
import { buildWebSearchAgentTool } from './web-search/agent-tool.js';
import { buildAgentSettingsTools } from './agent-settings-tools.js';
import { buildRiveWorkflowTool } from './rive-workflow-tool.js';
import { buildExploreAgentTool } from './explore-agent-tool.js';
import { assembleDesktopNativeCapabilities } from './desktop-native-capability-assembly.js';
import {
  buildSkillAgentTool,
  buildSkillSearchAgentTool,
  SkillShadowSelectionTracker,
} from './skills.js';
import type { createMainTaskLedgerWiring } from './task-ledger-wiring.js';
import type { createMainAutomationWiring } from './automation-wiring.js';
import type { createMainGoalWiring } from './goal-wiring.js';
import type { ToolArtifactPersistence } from './tool-artifact-persistence.js';
import { buildDesktopBuiltinTools } from './desktop-builtin-tools.js';

type TaskLedgerWiring = ReturnType<typeof createMainTaskLedgerWiring>;
type AutomationWiring = ReturnType<typeof createMainAutomationWiring>;
type GoalWiring = ReturnType<typeof createMainGoalWiring>;
type SettingsStore = ReturnType<typeof createSettingsStore>;

export interface DesktopToolAssemblyDeps {
  /** E2E computer-use flag: routes the ai-sdk backend through the raw
   *  computer-use tools and disables the economy, matching the legacy path. */
  isComputerUseRealModelE2e: boolean;
  workspaceRoot: string;
  taskLedgerStore: TaskLedgerWiring['store'];
  taskLedgerWiring: TaskLedgerWiring;
  automationWiring: AutomationWiring;
  goalWiring: GoalWiring;
  settingsStore: SettingsStore;
  updateAgentSettings: (patch: UpdateAppSettingsInput) => Promise<AppSettings>;
  shellRuns: ShellRunProcessManager;
  artifactStore: ArtifactStore;
  snapshotReadImage: ToolArtifactPersistence['snapshotReadImage'];
  readArchivedToolResultResource: ToolArtifactPersistence['readArchivedToolResultResource'];
  getWorkspacePrivacyContext: () => Promise<WorkspacePrivacyContext>;
  /**
   * The power-assertion controller, so a Computer Use run holds the machine
   * awake for as long as it is driving something. Optional: the tool surface
   * is assembled in contexts that have no Electron power management.
   */
  keepSystemAwake?: { hold(reason: string): void; release(reason: string): void };
  resolveDesktopSkillHost: HostCapabilitiesResolver;
  /**
   * The app's own window, so the mirror can be its child.
   *
   * A panel that moves itself chases the window it belongs to and trails
   * behind every drag. Made a child window it sits below everything else,
   * belongs to the app, and is carried along by the app's own moves instead of
   * following them. Optional: the tool surface is assembled in contexts that
   * have no window at all.
   */
  mainWindow?: {
    windowBounds(): { x: number; y: number; width: number; height: number } | undefined;
    onWindowGeometryChanged(cb: () => void): () => void;
    browserWindow(): { isDestroyed(): boolean } | undefined;
  };
}

/**
 * Assemble the desktop process's tool surface (issue #37 economy split).
 * Pure move of main.ts's module-scope tool-assembly cluster: the sandbox /
 * filesystem worker, the deferred capability groups (Rive, browser,
 * computer-use, agent orchestration), the WebSearch tool, the builtin + skill
 * host surface, the deferred-group tool-availability config, and the child
 * agent tool surface. Declaration order inside the function preserves the
 * original module-init order. The cursor-overlay `onMainWindowClose` teardown
 * hook stays in main.ts (it assigns a module-scoped `let`); the overlay
 * controller is returned so main.ts can wire it.
 */
export function assembleDesktopTools(deps: DesktopToolAssemblyDeps) {
  const {
    mainWindow,
    keepSystemAwake,
    isComputerUseRealModelE2e,
    workspaceRoot,
    taskLedgerStore,
    taskLedgerWiring,
    automationWiring,
    goalWiring,
    settingsStore,
    updateAgentSettings,
    shellRuns,
    artifactStore,
    snapshotReadImage,
    readArchivedToolResultResource,
    getWorkspacePrivacyContext,
    resolveDesktopSkillHost,
  } = deps;

  const attachmentResources = createArtifactAttachmentResourceReader({ artifactStore });
  const sandboxManager = createBuiltinSandboxManager();
  const filesystemWorkerLaunchSpecProvider =
    sandboxManager && isBuiltinFilesystemWorkerSandboxAvailable()
      ? createFilesystemWorkerLaunchSpecProvider({
          runtime: 'electron',
          platform: process.platform,
          executable: process.execPath,
          resourceLocation: app.isPackaged
            ? { kind: 'desktop-packaged', resourcesPath: process.resourcesPath }
            : { kind: 'runtime' },
        })
      : undefined;
  const filesystemWorker = sandboxManager && filesystemWorkerLaunchSpecProvider
    ? new FilesystemWorkerClient({
        sandboxManager,
        getLaunchSpec: filesystemWorkerLaunchSpecProvider,
      })
    : undefined;
  const sandboxDiagnosticsProvider = createSandboxDiagnosticsProvider({
    ...(sandboxManager ? { sandboxManager } : {}),
    ...(filesystemWorkerLaunchSpecProvider
      ? { getFilesystemWorkerLaunchSpec: filesystemWorkerLaunchSpecProvider }
      : {}),
  });
  // Unified tool availability (issue #37). Deferred capability groups (Rive,
  // Browser and agent orchestration tools are withheld from the
  // per-turn prompt and loaded on demand via `load_tools`, keeping their schemas
  // off the wire until needed. Everything else (ungrouped) stays always-on.
  // Kill-switch: set MAKA_DISABLE_DEFERRED_TOOLS to any value to turn economy off
  // and advertise every tool every turn (legacy behavior).
  const economyEnabled = !process.env.MAKA_DISABLE_DEFERRED_TOOLS;
  const riveTools: MakaTool[] = [buildRiveWorkflowTool()];
  const {
    browserTools,
    computerUse,
    computerUseOverlay,
    computerUsePip,
    computerUseStatusItem,
    computerUseScreenLock,
    computerUseTools,
  } = assembleDesktopNativeCapabilities({
    isComputerUseRealModelE2e,
    settings: settingsStore,
    ...(keepSystemAwake ? { keepSystemAwake } : {}),
    ...(mainWindow ? { mainWindow } : {}),
  });
  const agentTools: MakaTool[] = buildParentAgentTools({
    taskLedger: taskLedgerStore,
  });
  const deferredTools: MakaTool[] = [
    ...riveTools,
    ...browserTools,
    ...computerUseTools,
    ...agentTools,
  ];
  const webSearchTool = buildWebSearchAgentTool({
    settingsStore,
    getPrivacyContext: getWorkspacePrivacyContext,
  });
  const agentSettingsTools = buildAgentSettingsTools({
    settingsStore,
    updateSettings: updateAgentSettings,
  });
  // Assemble product tools first, then derive skill host + deferred groups from
  // the shared catalog ∩ this binding (#1099 S2). Skill listing uses the same host.
  const toolsBeforeSkill: MakaTool[] = [
    buildAskUserQuestionTool(),
    buildRequestSandboxBoundaryTool(),
    ...buildDesktopBuiltinTools({
      shellRuns,
      runtimeResources: shellRuns,
      attachmentResources,
      archiveResources: { readArchivedToolResultResource },
      backgroundTasks: shellRuns,
      ptyControls: shellRuns,
      snapshotImage: snapshotReadImage,
      ...(sandboxManager ? { sandboxManager } : {}),
      ...(filesystemWorker ? {
        filesystemWorker,
      } : {}),
    }),
  ];
  const toolsAfterSkill: MakaTool[] = [
    // External reference plan-mode borrow: a bounded read-only local worker for
    // self-contained code/repo investigations. The tool advertises the
    // `subagent` category; explore mode allows it, but the implementation
    // itself only reads filenames/text snippets under the session cwd.
    buildExploreAgentTool(),
    // PR-AGENT-WEB-SEARCH-TOOL-0: Tavily-backed WebSearch tool. Closed
    // over settingsStore so the renderer never sees the API key; the
    // permission engine routes it through the `web_read` policy which
    // prompts the user in explore / ask modes.
    webSearchTool,
    // Safe self-configuration surface: read a redacted projection and update
    // only an explicit non-secret allowlist after an in-app confirmation.
    ...agentSettingsTools,
    // Session task ledger: model manages a flat task list; the current list is
    // re-injected each turn tail. Pure local state, so no permission gate.
    ...taskLedgerWiring.tools,
    // Unified Automation: heartbeat (session-internal polling) + cron (standalone scheduled runs).
    ...automationWiring.tools,
    // Goal execution: GoalSet/Clear/Status/Pause/Resume — autonomous turn-boundary continuation.
    ...goalWiring.tools,
    // The `load_tools` connector is built by ToolAvailabilityRuntime; deferred
    // group tools just need to be present so they are dispatchable once loaded.
    ...deferredTools,
  ];
  // External reference lazy-skill pattern: the prompt lists available skills,
  // and this read-only tool loads the full SKILL.md only when the task matches.
  // Resolve per-call from the session cwd so skills at all 5 standard paths
  // (cwd/.maka, cwd/.agents, workspaceRoot/skills, ~/.maka, ~/.agents) are
  // discovered — matching the CLI and the Agent Skills spec (#1068).
  const skillShadowTracker = new SkillShadowSelectionTracker();
  const skillTool = buildSkillAgentTool(
    ({ cwd }) => resolveSkillDiscoveryPaths(cwd, workspaceRoot),
    resolveDesktopSkillHost,
    { shadowTracker: skillShadowTracker },
  );
  const skillSearchTool = buildSkillSearchAgentTool(
    ({ cwd }) => resolveSkillDiscoveryPaths(cwd, workspaceRoot),
    resolveDesktopSkillHost,
    { shadowTracker: skillShadowTracker },
  );
  const builtinTools: MakaTool[] = [
    ...toolsBeforeSkill,
    skillTool,
    skillSearchTool,
    ...toolsAfterSkill,
  ];
  assertProductBindingCatalogClean(
    'desktop',
    builtinTools.map((tool) => tool.name),
  );
  const desktopProductToolSurface = projectEffectiveProductToolSurface({
    host: 'desktop',
    tools: builtinTools,
    policy: { economy: economyEnabled },
  });
  // Build the union needed by catalog child profiles. SessionManager applies
  // each profile's narrower allowlist; parent-facing runtime refs are omitted.
  const childAgentTools = buildChildAgentTools([
    ...buildDesktopBuiltinTools({
      attachmentResources,
      archiveResources: { readArchivedToolResultResource },
      snapshotImage: snapshotReadImage,
      ...(sandboxManager ? { sandboxManager } : {}),
      ...(filesystemWorker ? {
        filesystemWorker,
      } : {}),
    }),
    webSearchTool,
  ]);

  return {
    riveTools,
    browserTools,
    computerUse,
    computerUseOverlay,
    computerUsePip,
    computerUseStatusItem,
    computerUseScreenLock,
    computerUseTools,
    desktopProductToolSurface,
    builtinTools: [...desktopProductToolSurface.tools],
    childAgentTools,
    sandboxDiagnosticsProvider,
  };
}
