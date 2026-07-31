import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { getBuiltinAgentDefinition } from '../agent-catalog.js';
import {
  BUILTIN_EXPERT_TEAMS,
  buildExpertAgentId,
  buildExpertTeamLeadSystemPromptFragment,
  buildExpertTeamMemberRoster,
  getExpertAgentDefinition,
  getExpertTeam,
  isExpertAgentId,
  materializeExpertAgentDefinition,
  parseExpertAgentId,
  requireResolvedAgentDefinition,
  resolveAgentDefinition,
  type ExpertTeamDefinition,
} from '../expert-catalog.js';
import { AGENT_TEAM_CHILD_TOOL_NAMES } from '../agent-team-tool-names.js';

const CODE_REVIEW = getExpertTeam('code-review');

describe('expert agent id encoding', () => {
  test('round-trips team + member ids', () => {
    const id = buildExpertAgentId('code-review', 'correctness-reviewer');
    assert.equal(id, 'expert:code-review:correctness-reviewer');
    assert.deepEqual(parseExpertAgentId(id), {
      teamId: 'code-review',
      memberId: 'correctness-reviewer',
    });
    assert.equal(isExpertAgentId(id), true);
  });

  test('rejects non-expert ids', () => {
    assert.equal(parseExpertAgentId('local-read'), undefined);
    assert.equal(parseExpertAgentId('expert:only-two'), undefined);
    assert.equal(parseExpertAgentId('expert::empty'), undefined);
    assert.equal(isExpertAgentId('web-research'), false);
  });
});

describe('built-in expert teams', () => {
  test('ships the code-review team with three read-only members', () => {
    assert.ok(CODE_REVIEW, 'code-review team exists');
    assert.equal(CODE_REVIEW!.members.length, 3);
    for (const member of CODE_REVIEW!.members) {
      assert.equal(member.archetype, 'local_read');
    }
  });

  test('every built-in team member materializes cleanly', () => {
    for (const team of BUILTIN_EXPERT_TEAMS) {
      for (const member of team.members) {
        const def = materializeExpertAgentDefinition(team, member);
        assert.equal(def.id, buildExpertAgentId(team.id, member.id));
        assert.equal(def.name, member.name);
        assert.ok(def.systemPrompt.length > 0);
      }
    }
  });
});

describe('materialization inherits + narrows the archetype', () => {
  test('inherits tools and permission mode from the archetype', () => {
    const archetype = getBuiltinAgentDefinition('local-read')!;
    const member = CODE_REVIEW!.members[0]!;
    const def = materializeExpertAgentDefinition(CODE_REVIEW!, member);
    assert.deepEqual(def.tools, [...archetype.tools, ...AGENT_TEAM_CHILD_TOOL_NAMES]);
    assert.equal(def.permissionMode, archetype.permissionMode);
    assert.equal(def.profile, archetype.profile);
  });

  test('composes the archetype guardrails ahead of the member persona', () => {
    const archetype = getBuiltinAgentDefinition('local-read')!;
    const member = CODE_REVIEW!.members[0]!;
    const def = materializeExpertAgentDefinition(CODE_REVIEW!, member);
    assert.ok(def.systemPrompt.startsWith(archetype.systemPrompt));
    assert.match(def.systemPrompt, /member of the "Code Review Team"/);
    assert.match(def.systemPrompt, /team_task_list/);
    assert.match(def.systemPrompt, /team_message/);
  });

  test('allows narrowing tools to a subset of the archetype', () => {
    const team: ExpertTeamDefinition = {
      id: 'narrow-team',
      name: 'Narrow Team',
      description: 'test',
      lead: { persona: 'lead' },
      members: [
        {
          id: 'reader',
          name: 'Reader',
          description: 'reads only',
          archetype: 'local_read',
          tools: ['Read'],
          persona: 'read',
        },
      ],
    };
    const def = materializeExpertAgentDefinition(team, team.members[0]!);
    assert.deepEqual(def.tools, ['Read', ...AGENT_TEAM_CHILD_TOOL_NAMES]);
  });

  test('rejects widening tools beyond the archetype', () => {
    const team: ExpertTeamDefinition = {
      id: 'bad-team',
      name: 'Bad Team',
      description: 'test',
      lead: { persona: 'lead' },
      members: [
        {
          id: 'writer',
          name: 'Writer',
          description: 'wants to write',
          archetype: 'local_read',
          tools: ['Read', 'Write'],
          persona: 'write',
        },
      ],
    };
    assert.throws(() => materializeExpertAgentDefinition(team, team.members[0]!), /Write/);
  });
});

describe('resolver', () => {
  test('resolves built-in agents', () => {
    assert.equal(resolveAgentDefinition('local-read')?.id, 'local-read');
    assert.equal(requireResolvedAgentDefinition('web-research').id, 'web-research');
  });

  test('resolves expert members by id', () => {
    const id = buildExpertAgentId('code-review', 'test-coverage-reviewer');
    const def = resolveAgentDefinition(id);
    assert.equal(def?.id, id);
    assert.equal(def?.name, 'Test Coverage Reviewer');
    assert.equal(getExpertAgentDefinition(id)?.id, id);
  });

  test('returns undefined for unknown expert members', () => {
    assert.equal(resolveAgentDefinition('expert:code-review:nope'), undefined);
    assert.equal(resolveAgentDefinition('expert:no-team:member'), undefined);
  });

  test('preserves the built-in error shape for unknown non-expert ids', () => {
    assert.throws(() => requireResolvedAgentDefinition('mystery'), /Unknown agent "mystery"/);
  });

  test('throws an expert-specific error for unknown expert ids', () => {
    assert.throws(
      () => requireResolvedAgentDefinition('expert:code-review:nope'),
      /Unknown expert "expert:code-review:nope"/,
    );
  });
});

describe('roster + lead fragment', () => {
  test('roster lists every member with its tools', () => {
    const roster = buildExpertTeamMemberRoster(CODE_REVIEW!);
    for (const member of CODE_REVIEW!.members) {
      assert.match(roster, new RegExp(member.id));
    }
    assert.match(roster, /tools: Read, Glob, Grep/);
  });

  test('lead fragment names the team, roster, and dispatch protocol', () => {
    const fragment = buildExpertTeamLeadSystemPromptFragment('code-review')!;
    assert.match(fragment, /lead of the "Code Review Team"/);
    assert.match(fragment, /expert_dispatch/);
    assert.match(fragment, /correctness-reviewer/);
    assert.match(fragment, /single turn/);
  });

  test('lead fragment is undefined for an unknown team', () => {
    assert.equal(buildExpertTeamLeadSystemPromptFragment('no-such-team'), undefined);
  });
});
