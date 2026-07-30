/**
 * Expert teams — data-driven lead/member personas with bounded collaboration.
 *
 * An expert team is a lead persona (runs as the main session) plus a set of
 * member "experts" the lead dispatches as read/tool-scoped child agents. This
 * keeps the lead responsible for fan-out, final synthesis, and task completion.
 * Members may exchange bounded, durable messages and atomically self-claim one
 * eligible shared task, but they cannot widen their capabilities or complete
 * shared work without lead review.
 *
 * Experts do not invent new tool scopes. Every expert declares a capability
 * `archetype` — one of the built-in {@link AgentProfile}s — and inherits that
 * archetype's tool set, permission mode, category policy, and workspace
 * contract. An expert may narrow (never widen) its tools to a subset of the
 * archetype's tools. This keeps the permission-safety invariant: a member can
 * never exceed the policy of the archetype it runs under.
 *
 * Member definitions are materialized into ordinary {@link AgentDefinition}s
 * with a deterministic id (`expert:<teamId>:<memberId>`) so the existing child
 * agent machinery (tool scoping, permission gating, worktree fail-closed) runs
 * them unchanged, and so a spawn can be resolved statelessly from the id alone.
 */

import {
  type AgentDefinition,
  type AgentProfile,
  getBuiltinAgentDefinition,
  requireBuiltinAgentDefinition,
  requireBuiltinAgentDefinitionByProfile,
} from './agent-catalog.js';
import { AGENT_TEAM_CHILD_TOOL_NAMES } from './agent-team-tool-names.js';

export const EXPERT_AGENT_ID_PREFIX = 'expert';

/** A single member expert: a persona that runs under a capability archetype. */
export interface ExpertDefinition {
  /** Member id, unique within its team (kebab-case). */
  id: string;
  /** Display name shown to the lead and in child-run metadata. */
  name: string;
  /** Routing text: what this expert reviews / does. The lead dispatches by it. */
  description: string;
  /** Capability archetype whose tool scope + permission mode this expert inherits. */
  archetype: AgentProfile;
  /**
   * Optional narrowing of the archetype's tools to a subset. Every entry MUST be
   * one of the archetype's tools; widening is rejected at materialization time.
   * Omit to inherit the archetype's full tool set.
   */
  tools?: readonly string[];
  /** The member's system-prompt body: identity, lens, and method. */
  persona: string;
  /** Optional short hint the lead can use to decide when to dispatch this member. */
  whenToUse?: string;
}

/** The team lead: an orchestrator persona that runs as the main session. */
export interface ExpertTeamLead {
  /** The lead's orchestrator identity, method, and synthesis contract. */
  persona: string;
}

/** A complete expert team: one lead + N dispatchable members. */
export interface ExpertTeamDefinition {
  /** Team id (kebab-case); the `<teamId>` in `mode:expert-team:<teamId>`. */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description of what the team does. */
  description: string;
  /** The lead orchestrator. */
  lead: ExpertTeamLead;
  /** Dispatchable member experts (at least one). */
  members: readonly ExpertDefinition[];
}

// ============================================================================
// Id encoding — deterministic, stateless resolution from id alone
// ============================================================================

export function buildExpertAgentId(teamId: string, memberId: string): string {
  return `${EXPERT_AGENT_ID_PREFIX}:${teamId}:${memberId}`;
}

export function parseExpertAgentId(id: string): { teamId: string; memberId: string } | undefined {
  const parts = id.split(':');
  if (parts.length !== 3) return undefined;
  const [prefix, teamId, memberId] = parts;
  if (prefix !== EXPERT_AGENT_ID_PREFIX || !teamId || !memberId) return undefined;
  return { teamId, memberId };
}

export function isExpertAgentId(id: string): boolean {
  return parseExpertAgentId(id) !== undefined;
}

// ============================================================================
// Materialization — ExpertDefinition → AgentDefinition
// ============================================================================

/**
 * Compose a member's full system prompt: the archetype's base guardrails
 * (e.g. read-only discipline) followed by the expert's identity, lens, and the
 * shared worker protocol (bounded mailbox + shared task ownership + pointer fan-in).
 */
function composeExpertSystemPrompt(
  archetype: AgentDefinition,
  team: ExpertTeamDefinition,
  expert: ExpertDefinition,
): string {
  return [
    archetype.systemPrompt,
    '',
    `You are ${expert.name}, a member of the "${team.name}" expert team.`,
    expert.persona,
    '',
    'Worker protocol:',
    '- You are a spawned member of one expert-team run. Your context and tool permissions remain isolated from every other member.',
    '- Use team_task_list and atomically claim at most one eligible shared task when it matches your assignment. A claim grants ownership, never completion authority.',
    '- Use team_message for a concrete cross-lens finding or blocker and team_inbox to poll for replies before your final answer. Keep messages bounded and evidence-backed; do not create acknowledgement loops.',
    '- Do exactly the task the lead assigned and stay within your lens. Do not expand scope.',
    '- Persist any large output as an artifact and return a concise, structured summary the lead can merge. The lead alone decides whether a shared task is complete.',
    '- Ground every finding in concrete evidence: name files, symbols, and line references.',
  ].join('\n');
}

/**
 * Materialize a member expert into an {@link AgentDefinition} runnable by the
 * existing child-agent machinery. Throws if the expert narrows to a tool that
 * its archetype does not grant (widening is not allowed).
 */
export function materializeExpertAgentDefinition(
  team: ExpertTeamDefinition,
  expert: ExpertDefinition,
): AgentDefinition {
  const archetype = requireBuiltinAgentDefinitionByProfile(expert.archetype);
  const archetypeTools = new Set(archetype.tools);
  const capabilityTools = expert.tools ?? archetype.tools;
  const widened = capabilityTools.filter((name) => !archetypeTools.has(name));
  if (widened.length > 0) {
    throw new Error(
      `Expert "${team.id}:${expert.id}" cannot use tools outside its "${expert.archetype}" archetype: ${widened.join(', ')}. ` +
        `Archetype tools: ${archetype.tools.join(', ')}.`,
    );
  }
  return {
    definitionVersion: archetype.definitionVersion,
    id: buildExpertAgentId(team.id, expert.id),
    profile: archetype.profile,
    name: expert.name,
    description: expert.description,
    contract: archetype.contract,
    permissionMode: archetype.permissionMode,
    // Collaboration controls do not widen filesystem/network capability. They
    // are runtime-owned, session/team-scoped tools whose trusted identity is
    // injected by RuntimeKernel and whose durable stores enforce ownership.
    tools: [...capabilityTools, ...AGENT_TEAM_CHILD_TOOL_NAMES],
    systemPrompt: composeExpertSystemPrompt(archetype, team, expert),
  };
}

// ============================================================================
// Validation
// ============================================================================

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Assert a team is internally consistent. Called on the built-in registry at load. */
export function assertExpertTeamDefinition(team: ExpertTeamDefinition): void {
  if (!KEBAB.test(team.id)) {
    throw new Error(`Expert team id "${team.id}" must be kebab-case.`);
  }
  if (team.members.length === 0) {
    throw new Error(`Expert team "${team.id}" must have at least one member.`);
  }
  const seen = new Set<string>();
  for (const member of team.members) {
    if (!KEBAB.test(member.id)) {
      throw new Error(`Expert "${team.id}:${member.id}" id must be kebab-case.`);
    }
    if (seen.has(member.id)) {
      throw new Error(`Expert team "${team.id}" has duplicate member id "${member.id}".`);
    }
    seen.add(member.id);
    // Materialize eagerly to surface archetype/tool errors at load time.
    materializeExpertAgentDefinition(team, member);
  }
}

// ============================================================================
// Built-in expert teams
// ============================================================================

const CODE_REVIEW_TEAM: ExpertTeamDefinition = {
  id: 'code-review',
  name: 'Code Review Team',
  description:
    'A lead orchestrator dispatches read-only reviewer members — correctness, simplification, and test coverage — over the same change, then merges their findings into one ranked review.',
  lead: {
    persona: [
      'You lead a code-review team. Your job is to split the review across specialist members, dispatch them, and synthesize one ranked review — you do not review line-by-line yourself.',
      '',
      'Method:',
      '- First scope the change: identify the diff / files / area under review and read enough to brief members precisely.',
      '- Dispatch members with expert_dispatch, one bounded task each. Send independent members in a single turn (multiple expert_dispatch calls) so they run concurrently.',
      '- Give each member the exact files/scope and what to look for. Never ask a member to work outside its lens.',
      '- Merge results: dedupe overlapping findings, drop anything a member could not ground in evidence, and rank by severity (correctness > security > maintainability > style).',
      '- Present one review: each finding with file:line, why it matters, and a concrete fix. Attribute nothing to "the members" — speak as the reviewer.',
    ].join('\n'),
  },
  members: [
    {
      id: 'correctness-reviewer',
      name: 'Correctness Reviewer',
      description:
        'Hunts logic errors, edge cases, race conditions, and broken invariants in the change.',
      archetype: 'local_read',
      persona: [
        'Your lens is correctness. Find defects that make the code produce wrong results or crash: off-by-one, null/undefined, unhandled errors, async races, broken invariants, incorrect conditionals, and mishandled edge cases.',
        'For each issue give a concrete failure scenario (inputs → wrong outcome). Ignore style and naming.',
      ].join('\n'),
      whenToUse: 'Always, for any code change.',
    },
    {
      id: 'simplification-reviewer',
      name: 'Simplification Reviewer',
      description:
        'Finds duplication, dead code, and needlessly complex constructs that could reuse existing code.',
      archetype: 'local_read',
      persona: [
        'Your lens is simplification and reuse. Find duplicated logic, dead code, over-abstraction, and places that reinvent something the codebase already provides.',
        'Only flag a simplification when it clearly preserves behavior; note the existing helper or pattern to reuse. Do not report correctness bugs — that is another member.',
      ].join('\n'),
      whenToUse: 'When the change adds nontrivial new code.',
    },
    {
      id: 'test-coverage-reviewer',
      name: 'Test Coverage Reviewer',
      description: 'Assesses whether the change is adequately tested and identifies missing cases.',
      archetype: 'local_read',
      persona: [
        'Your lens is test coverage. Check whether new or changed behavior has tests, and identify untested paths that matter: error handling, edge cases, and regressions the change could introduce.',
        'Point to the specific test files that should cover each gap. Do not restate correctness bugs; focus on what is unverified.',
      ].join('\n'),
      whenToUse: 'When the change alters runtime behavior.',
    },
  ],
};

export const BUILTIN_EXPERT_TEAMS: readonly ExpertTeamDefinition[] = [CODE_REVIEW_TEAM];

for (const team of BUILTIN_EXPERT_TEAMS) {
  assertExpertTeamDefinition(team);
}

// ============================================================================
// Registry + resolver
// ============================================================================

export function listExpertTeams(): readonly ExpertTeamDefinition[] {
  return BUILTIN_EXPERT_TEAMS;
}

export function getExpertTeam(teamId: string): ExpertTeamDefinition | undefined {
  return BUILTIN_EXPERT_TEAMS.find((team) => team.id === teamId);
}

/** Resolve a materialized member {@link AgentDefinition} from an `expert:<teamId>:<memberId>` id. */
export function getExpertAgentDefinition(id: string): AgentDefinition | undefined {
  const parsed = parseExpertAgentId(id);
  if (!parsed) return undefined;
  const team = getExpertTeam(parsed.teamId);
  if (!team) return undefined;
  const member = team.members.find((entry) => entry.id === parsed.memberId);
  if (!member) return undefined;
  try {
    return materializeExpertAgentDefinition(team, member);
  } catch {
    // A malformed member (e.g. one that widens tools past its archetype) is not
    // a resolvable agent. Built-in teams can't reach this — assertExpertTeamDefinition
    // rejects them at load — but honor the `| undefined` contract for any other team.
    return undefined;
  }
}

/**
 * Definition resolver over the builtin agent catalog *and* the expert registry.
 * This is the value wired into the runtime kernel / session manager so a child
 * spawn spec id can be either a builtin agent or an expert member.
 */
export function resolveAgentDefinition(id: string): AgentDefinition | undefined {
  return getBuiltinAgentDefinition(id) ?? getExpertAgentDefinition(id);
}

export function requireResolvedAgentDefinition(id: string): AgentDefinition {
  const definition = resolveAgentDefinition(id);
  if (definition) return definition;
  if (isExpertAgentId(id)) {
    throw new Error(`Unknown expert "${id}".`);
  }
  // Preserve the built-in catalog's error message shape for non-expert ids.
  return requireBuiltinAgentDefinition(id);
}

// ============================================================================
// Roster + lead system-prompt fragment
// ============================================================================

/** A one-line-per-member roster for the dispatch tool description and the lead fragment. */
export function buildExpertTeamMemberRoster(team: ExpertTeamDefinition): string {
  return team.members
    .map((member) => {
      const tools = (
        member.tools ?? requireBuiltinAgentDefinitionByProfile(member.archetype).tools
      ).join(', ');
      const when = member.whenToUse ? ` — dispatch when: ${member.whenToUse}` : '';
      return `- ${member.id}: ${member.description} (tools: ${tools})${when}`;
    })
    .join('\n');
}

/**
 * The team lead's orchestrator system-prompt fragment, gated by the
 * `mode:expert-team:<teamId>` session label. Returns `undefined` for an unknown
 * team id so the caller can no-op.
 */
export function buildExpertTeamLeadSystemPromptFragment(teamId: string): string | undefined {
  const team = getExpertTeam(teamId);
  if (!team) return undefined;
  return [
    `Expert team mode is active: you are the lead of the "${team.name}".`,
    team.description,
    '',
    team.lead.persona,
    '',
    'Members you can dispatch (with the expert_dispatch tool):',
    buildExpertTeamMemberRoster(team),
    '',
    'Dispatch protocol:',
    '- Dispatch a member with expert_dispatch({ member, task }). Give one bounded, self-contained task per call — the member starts fresh and sees only the task you send, so include the exact files/scope and what to look for.',
    '- To run members concurrently, emit several expert_dispatch calls in a single turn. Independent members should always be dispatched together, not one after another.',
    '- Never ask a member to work outside its lens, and never dispatch the same task to two members.',
    '',
    'Shared work + fan-in discipline:',
    '- For work that benefits from shared ownership, create bounded Task Ledger items before dispatch and tell members to inspect team_task_list. Claims are atomic; child success remains evidence until you review and complete the task.',
    '- Each member returns a concise summary (and artifact ids for anything large). Members may exchange bounded, durable messages; use team_inbox after fan-in to inspect messages addressed to the lead.',
    '- After members return, synthesize a single result: dedupe overlapping points, drop anything a member could not ground in evidence, and rank by importance. Speak as the lead — do not attribute output to "the members".',
    '- If a member fails or returns nothing useful, say so plainly rather than inventing its result.',
  ].join('\n');
}
