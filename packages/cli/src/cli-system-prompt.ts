import { redactSecrets, type PersonalizationSettings } from '@maka/core';
import {
  buildPersonalizationPromptFragment,
  buildSessionEnvironmentPromptFragment,
  buildSkillsPromptFragmentWithReport,
  buildWorkspaceInstructionsPromptFragment,
  resolveProjectGitInfo,
  resolveSkillDiscoveryPaths,
  type AutomationManager,
  type GoalManager,
  type HostCapabilities,
  type SkillSource,
  type SkillSelectionReport,
} from '@maka/runtime';

/**
 * CLI/TUI system-prompt assembly.
 *
 * The durable system prompt is built from the personalization fragment and the
 * gated workspace-instructions fragment (AGENTS.md / CLAUDE.md / GEMINI.md from
 * ~/.maka and the session cwd). The per-turn tail carries the session
 * environment (cwd / git / platform / date), which must stay volatile to avoid
 * churning the system prefix hash.
 *
 * The fragment builders themselves live in @maka/runtime and are shared with the
 * desktop app. This module owns only the CLI's choice of which fragments to
 * assemble; settings are read by the caller (runtime-bootstrap) and injected
 * here so @maka/runtime does not need to depend on @maka/storage.
 */

export interface BuildCliSystemPromptInput {
  settings: {
    personalization?: Partial<PersonalizationSettings>;
    workspaceInstructions: { enabled: boolean };
  };
  cwd: string;
  /**
   * Workspace root holding the shared `skills/` directory (distinct from the
   * session `cwd` so the project directory is never scanned for skills). The
   * skill catalog fragment is built from `{workspaceRoot}/skills/`.
   */
  workspaceRoot: string;
  /**
   * Host capability surface for the skill-compatibility gate. When omitted,
   * the catalog is built without gating (legacy behavior). The CLI host
   * passes its registered tool names so skills whose `requiredTools` are not
   * available (for example, a skill requiring a desktop-only tool) are hidden.
   */
  host?: HostCapabilities;
  /** Selected model context window used to bound the always-on skill catalog. */
  modelContextWindow?: number;
  /**
   * Home directory for user-level skill discovery (`~/.maka/skills/`,
   * `~/.agents/skills/`). Defaults to `os.homedir()`. Tests pass a temp dir
   * to avoid picking up real installed skills.
   */
  homeDir?: string;
  onSkillSelection?: (report: SkillSelectionReport) => void;
}

export async function buildCliSystemPrompt(
  input: BuildCliSystemPromptInput,
): Promise<string | undefined> {
  const personalization = buildPersonalizationPromptFragment(input.settings.personalization);
  // personalization -> skills -> workspaceInstructions, matching the desktop app.
  const skillSource = resolveSkillDiscoveryPaths(input.cwd, input.workspaceRoot, input.homeDir);
  const skillPrompt = await buildSkillsPromptFragmentWithReport(skillSource, input.host, {
    contextWindow: input.modelContextWindow,
  });
  input.onSkillSelection?.(skillPrompt.report);
  const skills = skillPrompt.text;
  const workspaceInstructions = input.settings.workspaceInstructions.enabled
    ? await buildWorkspaceInstructionsPromptFragment(input.cwd, { homeDir: input.homeDir })
    : undefined;
  const fragments = [personalization.text, skills, workspaceInstructions].filter((v): v is string =>
    Boolean(v),
  );
  return fragments.length > 0 ? fragments.join('\n\n') : undefined;
}

export async function buildCliTurnTailPrompt(input: {
  cwd: string;
  sessionId?: string;
  automationManager?: AutomationManager;
  goalManager?: GoalManager;
}): Promise<string> {
  const projectGit = await resolveProjectGitInfo(input.cwd);
  const fragments = [buildSessionEnvironmentPromptFragment({ cwd: input.cwd, projectGit })];

  if (input.sessionId && input.automationManager) {
    const automationFragment = buildAutomationTailFragment(
      input.sessionId,
      input.automationManager,
    );
    if (automationFragment) fragments.push(automationFragment);
  }
  if (input.sessionId && input.goalManager) {
    const goalFragment = buildGoalTailFragment(input.sessionId, input.goalManager);
    if (goalFragment) fragments.push(goalFragment);
  }

  return fragments.join('\n\n');
}

function buildGoalTailFragment(sessionId: string, manager: GoalManager): string | undefined {
  const goal = manager.get(sessionId);
  if (!goal || (goal.status !== 'active' && goal.status !== 'waiting' && goal.status !== 'paused'))
    return undefined;
  const spent = Math.max(0, goal.tokensNow - goal.tokensAtStart);
  const lines = [
    'Active goal (autonomous execution; system evaluates progress each turn):',
    '<goal-execution>',
    `condition="${redactSecrets(goal.condition)}"`,
    `status=${goal.status} turns=${goal.iterations}/${goal.maxIterations} no_progress=${goal.consecutiveNoProgress}/${goal.blockCap}` +
      `${goal.tokenBudget ? ` tokens=${spent}/${goal.tokenBudget}` : ''}`,
    ...(goal.lastReason ? [`last_reason="${redactSecrets(goal.lastReason)}"`] : []),
    '</goal-execution>',
  ];
  return lines.join('\n');
}

function buildAutomationTailFragment(
  sessionId: string,
  manager: AutomationManager,
): string | undefined {
  const automations = manager
    .listForSession(sessionId)
    .filter((a) => a.status === 'active' || a.status === 'paused');
  if (automations.length === 0) return undefined;
  const lines = [
    'Active automations (use Automation tool with mode "list" for full details):',
    '<automations>',
    ...automations.map((a) => {
      const schedule =
        a.schedule.type === 'cron'
          ? `cron "${a.schedule.expression}"`
          : a.schedule.type === 'interval'
            ? `every ${a.schedule.seconds}s`
            : `once`;
      return `  ${a.status} id="${a.id}" name="${a.name}" kind=${a.kind} schedule=${schedule} fires=${a.fireCount}`;
    }),
    '</automations>',
  ];
  return lines.join('\n');
}
