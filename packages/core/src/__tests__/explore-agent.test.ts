import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DEEP_RESEARCH_EVIDENCE_CHECKLIST,
  DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_CHARS,
  DEEP_RESEARCH_PROGRESS_CHECKPOINTS,
  DEEP_RESEARCH_REPORT_SECTIONS,
  DEEP_RESEARCH_SCOPE_OPTIONS,
  DEEP_RESEARCH_SESSION_LABEL,
  DEEP_RESEARCH_STARTER_PROMPTS,
  DEEP_RESEARCH_WORKFLOW_STEPS,
  buildDeepResearchSystemPromptFragment,
  buildDeepResearchImplementationPrompt,
  isDeepResearchSession,
} from '../explore-agent.js';
import type { DeepResearchRun } from '../deep-research-run.js';
import { PERMISSION_POLICY } from '../permission.js';

describe('deep research session profile', () => {
  it('detects the stable session label', () => {
    assert.equal(isDeepResearchSession([DEEP_RESEARCH_SESSION_LABEL]), true);
    assert.equal(isDeepResearchSession(['research']), false);
    assert.equal(isDeepResearchSession(undefined), false);
  });

  it('builds a bounded, explicit read-only-to-implementation handoff prompt', () => {
    const run = {
      schemaVersion: 1,
      sessionId: 'session-research',
      objective: 'Improve Deep Research.',
      scopeLevel: 'standard',
      status: 'completed',
      stage: 'completed',
      round: 2,
      createdAt: 1,
      updatedAt: 2,
      artifacts: [],
      checklist: [],
      steps: [],
      reportSections: [],
      checkpoints: [],
      reportArtifactId: 'report-1',
      handoff: {
        artifactId: 'handoff-1',
        implementationTasks: ['Add an explicit transition.'],
        recommendedIssues: ['Track visual verification.'],
        recommendedPullRequests: [],
        verificationCommands: ['npm test'],
      },
      completedAt: 2,
    } satisfies DeepResearchRun;

    const prompt = buildDeepResearchImplementationPrompt(run);
    assert.match(prompt, /original research session remains read-only/i);
    assert.match(prompt, /present an implementation plan before changing project files/i);
    assert.match(prompt, /Add an explicit transition/);
    assert.match(prompt, /Final report artifact: report-1/);
    assert.ok(Array.from(prompt).length <= DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_CHARS);
    assert.throws(
      () =>
        buildDeepResearchImplementationPrompt({
          ...run,
          status: 'active',
          stage: 'knowledge_base',
        }),
      /requires a completed run/,
    );
  });

  it('explore policy remains read-only for writes and destructive actions', () => {
    assert.equal(PERMISSION_POLICY.explore.read, 'allow');
    assert.equal(PERMISSION_POLICY.explore.shell_safe, 'block');
    assert.equal(PERMISSION_POLICY.explore.file_write, 'block');
    assert.equal(PERMISSION_POLICY.explore.fs_destructive, 'block');
    assert.equal(PERMISSION_POLICY.explore.shell_unsafe, 'block');
    assert.equal(PERMISSION_POLICY.explore.network_send, 'block');
    assert.equal(PERMISSION_POLICY.explore.subagent, 'allow');
  });

  it('system prompt names source-grounded research and no-write boundaries', () => {
    const prompt = buildDeepResearchSystemPromptFragment();
    assert.match(prompt, /Read, Glob, Grep/);
    assert.match(prompt, /ExploreAgent/);
    assert.match(prompt, /Do not use ExploreAgent just because it is available/);
    assert.match(
      prompt,
      /known file, a specific symbol, package scripts, test setup, config, or 1-3 obvious files/,
    );
    assert.match(prompt, /goal, relevant paths or keywords, what to ignore, a stopping condition/);
    assert.match(prompt, /Do not write/);
    assert.match(prompt, /deep_research_\* tools are the one write exception/);
    assert.match(prompt, /deep_research_start once/);
    assert.match(prompt, /deep_research_status, then deep_research_read_artifact/);
    assert.match(prompt, /archive each important raw source first/);
    assert.match(prompt, /deep_research_record_step/);
    assert.match(prompt, /deep_research_update_checklist/);
    assert.match(prompt, /deep_research_checkpoint/);
    assert.match(prompt, /all five report sections are completed/);
    assert.match(prompt, /role=handoff artifact/);
    assert.match(prompt, /borrow \/ diverge \/ risk \/ gate/);
    for (const step of DEEP_RESEARCH_WORKFLOW_STEPS) {
      assert.match(prompt, new RegExp(step.title));
      assert.match(prompt, new RegExp(step.body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    for (const section of DEEP_RESEARCH_REPORT_SECTIONS) {
      assert.match(prompt, new RegExp(section.title));
      assert.match(prompt, new RegExp(section.body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    for (const option of DEEP_RESEARCH_SCOPE_OPTIONS) {
      assert.match(prompt, new RegExp(option.label));
      assert.match(prompt, new RegExp(option.body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    for (const item of DEEP_RESEARCH_EVIDENCE_CHECKLIST) {
      assert.match(prompt, new RegExp(item.title));
      assert.match(prompt, new RegExp(item.body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    for (const item of DEEP_RESEARCH_PROGRESS_CHECKPOINTS) {
      assert.match(prompt, new RegExp(item.title));
      assert.match(prompt, new RegExp(item.body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(prompt, /If the user does not specify a scope, use 标准/);
    assert.match(prompt, /Use 深挖 only when the user explicitly asks/);
    assert.match(prompt, /call that out explicitly instead of guessing/);
    assert.match(prompt, /Progress checkpoints/);
    assert.match(prompt, /control loop/);
    assert.match(prompt, /not as a hidden task system/);
  });

  it('keeps the visible workflow compact and implementation-oriented', () => {
    assert.equal(DEEP_RESEARCH_WORKFLOW_STEPS.length, 4);
    assert.deepEqual(
      DEEP_RESEARCH_WORKFLOW_STEPS.map((step) => step.title),
      ['先定位入口', '再追数据流', '然后对照参考', '最后给可合入方案'],
    );
    assert.match(DEEP_RESEARCH_WORKFLOW_STEPS.at(-1)?.body ?? '', /不在只读模式里动手改/);
  });

  it('keeps the final report contract evidence-backed and PR-oriented', () => {
    assert.equal(DEEP_RESEARCH_REPORT_SECTIONS.length, 4);
    assert.deepEqual(
      DEEP_RESEARCH_REPORT_SECTIONS.map((section) => section.title),
      ['结论先行', '源码证据', '借鉴拆解', '落地改进'],
    );
    assert.match(DEEP_RESEARCH_REPORT_SECTIONS[1]?.body ?? '', /文件、函数、配置、测试/);
    assert.match(DEEP_RESEARCH_REPORT_SECTIONS[2]?.body ?? '', /borrow \/ diverge \/ risk \/ gate/);
    assert.match(DEEP_RESEARCH_REPORT_SECTIONS[3]?.body ?? '', /验证命令/);
  });

  it('keeps the research scope budget explicit', () => {
    assert.deepEqual(
      DEEP_RESEARCH_SCOPE_OPTIONS.map((option) => option.label),
      ['快速', '标准', '深挖'],
    );
    assert.match(DEEP_RESEARCH_SCOPE_OPTIONS[0]?.body ?? '', /小问题/);
    assert.match(DEEP_RESEARCH_SCOPE_OPTIONS[1]?.body ?? '', /默认深度/);
    assert.match(DEEP_RESEARCH_SCOPE_OPTIONS[2]?.body ?? '', /明确要求/);
  });

  it('keeps the deep research evidence checklist source-grounded', () => {
    assert.equal(DEEP_RESEARCH_EVIDENCE_CHECKLIST.length, 4);
    assert.deepEqual(
      DEEP_RESEARCH_EVIDENCE_CHECKLIST.map((item) => item.title),
      ['项目入口', '核心链路', '边界条件', '验证证据'],
    );
    assert.match(DEEP_RESEARCH_EVIDENCE_CHECKLIST[0]?.body ?? '', /README、package\/config/);
    assert.match(DEEP_RESEARCH_EVIDENCE_CHECKLIST[1]?.body ?? '', /IPC\/服务、存储、运行时/);
    assert.match(DEEP_RESEARCH_EVIDENCE_CHECKLIST[2]?.body ?? '', /权限、隐身模式/);
    assert.match(DEEP_RESEARCH_EVIDENCE_CHECKLIST[3]?.body ?? '', /测试、fixture、smoke/);
  });

  it('keeps the progress checkpoints visible and non-autonomous', () => {
    assert.equal(DEEP_RESEARCH_PROGRESS_CHECKPOINTS.length, 4);
    assert.deepEqual(
      DEEP_RESEARCH_PROGRESS_CHECKPOINTS.map((item) => item.title),
      ['先建清单', '标当前项', '记阻塞点', '收敛方案'],
    );
    assert.match(DEEP_RESEARCH_PROGRESS_CHECKPOINTS[0]?.body ?? '', /相互关联/);
    assert.match(DEEP_RESEARCH_PROGRESS_CHECKPOINTS[1]?.body ?? '', /当前正在验证/);
    assert.match(DEEP_RESEARCH_PROGRESS_CHECKPOINTS[2]?.body ?? '', /blocked/);
    assert.match(
      DEEP_RESEARCH_PROGRESS_CHECKPOINTS[3]?.body ?? '',
      /borrow \/ diverge \/ risk \/ gate/,
    );
  });

  it('keeps starter prompts read-only and implementation-oriented', () => {
    assert.deepEqual(
      DEEP_RESEARCH_STARTER_PROMPTS.map((prompt) => prompt.label),
      ['研究一个参考项目', '完整读一遍参考项目', '对比一个功能实现', '做一次安全边界审计'],
    );
    for (const starter of DEEP_RESEARCH_STARTER_PROMPTS) {
      assert.match(starter.prompt, /只读/);
      assert.doesNotMatch(starter.prompt, /PR/);
    }
    assert.match(DEEP_RESEARCH_STARTER_PROMPTS[1]?.prompt ?? '', /深挖范围/);
    assert.match(
      DEEP_RESEARCH_STARTER_PROMPTS[1]?.prompt ?? '',
      /核心功能、运行时、存储、权限、UI、测试和文档/,
    );
    assert.match(
      DEEP_RESEARCH_STARTER_PROMPTS[1]?.prompt ?? '',
      /borrow \/ diverge \/ risk \/ gate/,
    );
  });
});
