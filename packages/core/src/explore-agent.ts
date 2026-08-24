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

/**
 * Read-only deep research mode (external reference design).
 *
 * Deep research is visible and bounded. The session profile pins
 * permissionMode=explore and may use the read-only ExploreAgent tool for
 * scoped local investigation; it is not a hidden autonomous writer.
 */

import type { DeepResearchRun } from './deep-research-run.js';
import type { PermissionMode } from './permission.js';

/**
 * A product intent a caller can open a new session at, distinct from the
 * ordinary chat that needs no intent at all. Absence is spelled `undefined`,
 * not a `'chat'` member: a second spelling of "no mode" is a second thing to
 * keep in agreement.
 */
export interface SessionStartModeSpec {
  readonly name: string;
  readonly labels: readonly string[];
  readonly permissionMode: PermissionMode;
}

export const SESSION_START_MODE_SPECS = {
  deep_research: {
    name: 'Deep Research',
    labels: ['mode:deep_research'],
    permissionMode: 'explore',
  },
} as const satisfies Record<string, SessionStartModeSpec>;

export type SessionStartMode = keyof typeof SESSION_START_MODE_SPECS;
export const SESSION_START_MODES: readonly SessionStartMode[] = Object.keys(
  SESSION_START_MODE_SPECS,
) as SessionStartMode[];
export const SESSION_START_MODE_LABELS: readonly string[] = [
  ...new Set(Object.values(SESSION_START_MODE_SPECS).flatMap((spec) => spec.labels)),
];

export function isSessionStartMode(value: unknown): value is SessionStartMode {
  return typeof value === 'string' && Object.hasOwn(SESSION_START_MODE_SPECS, value);
}

export function sessionStartModeSpec(mode: SessionStartMode): SessionStartModeSpec {
  return SESSION_START_MODE_SPECS[mode];
}

export function isSessionStartModeLabel(value: unknown): value is string {
  return typeof value === 'string' && SESSION_START_MODE_LABELS.includes(value);
}

export const DEEP_RESEARCH_SESSION_NAME = SESSION_START_MODE_SPECS.deep_research.name;
export const DEEP_RESEARCH_SESSION_LABEL = SESSION_START_MODE_SPECS.deep_research.labels[0];

export const DEEP_RESEARCH_WORKFLOW_STEPS = [
  {
    title: '先定位入口',
    body: '读目录、配置、启动链路和测试入口，建立项目地图。',
  },
  {
    title: '再追数据流',
    body: '沿关键模块、IPC、存储、权限和运行时边界追到真实实现。',
  },
  {
    title: '然后对照参考',
    body: '把可借鉴点拆成 borrow / diverge / risk / gate。',
  },
  {
    title: '最后给可合入方案',
    body: '输出文件清单、风险边界和验证命令，不在只读模式里动手改。',
  },
] as const;

export const DEEP_RESEARCH_REPORT_SECTIONS = [
  {
    title: '结论先行',
    body: '用 3-5 条讲清楚真实现状、主要差距和优先建议。',
  },
  {
    title: '源码证据',
    body: '列出文件、函数、配置、测试和运行时路径，避免只给印象判断。',
  },
  {
    title: '借鉴拆解',
    body: '每个可借鉴点都写 borrow / diverge / risk / gate。',
  },
  {
    title: '落地改进',
    body: '给出按小步改进拆分的文件清单、边界和验证命令。',
  },
] as const;

export const DEEP_RESEARCH_SCOPE_OPTIONS = [
  {
    label: '快速',
    body: '只扫入口、关键文件和最可能的数据流，适合已知范围的小问题。',
  },
  {
    label: '标准',
    body: '默认深度：梳理核心链路、相关测试和主要风险，再给落地建议。',
  },
  {
    label: '深挖',
    body: '跨模块、参考项目和边界条件多轮追踪；只在用户明确要求时使用。',
  },
] as const;

export const DEEP_RESEARCH_EVIDENCE_CHECKLIST = [
  {
    title: '项目入口',
    body: '先看 README、package/config、启动脚本和目录分层，确认真实运行方式。',
  },
  {
    title: '核心链路',
    body: '追 UI 入口、IPC/服务、存储、运行时调用和错误处理，不只看表面组件。',
  },
  {
    title: '边界条件',
    body: '检查权限、隐身模式、token/路径暴露、失败重试和用户可见反馈。',
  },
  {
    title: '验证证据',
    body: '找对应测试、fixture、smoke 文档和可复现命令；缺口要明确标出来。',
  },
] as const;

export const DEEP_RESEARCH_PROGRESS_CHECKPOINTS = [
  {
    title: '先建清单',
    body: '研究范围超过三个相互关联的点时，先列出可核验的检查项再开始追代码。',
  },
  {
    title: '标当前项',
    body: '推进时明确当前正在验证哪一项，拿到证据后再进入下一项。',
  },
  {
    title: '记阻塞点',
    body: '找不到源码、运行时或测试证据时标成 blocked，不用猜测补空白。',
  },
  {
    title: '收敛方案',
    body: '完成项必须汇总到 borrow / diverge / risk / gate 和可落地改进里。',
  },
] as const;

export const DEEP_RESEARCH_STARTER_PROMPTS = [
  {
    label: '研究一个参考项目',
    prompt:
      '请只读研究这个项目：先梳理目录结构、核心模块、启动链路、数据流和测试入口，然后列出我们可以借鉴的功能设计、需要规避的风险，以及可落地到 Maka 的改进顺序。',
  },
  {
    label: '完整读一遍参考项目',
    prompt:
      '请按深挖范围只读研究这个参考项目：先建立目录和模块地图，再逐层读核心功能、运行时、存储、权限、UI、测试和文档；每个可借鉴点都按 borrow / diverge / risk / gate 输出，并给出 Maka 的落地改进顺序。',
  },
  {
    label: '对比一个功能实现',
    prompt:
      '请只读对比这个功能在参考项目和 Maka 里的实现差异：指出关键文件、运行时边界、UI 入口、持久化方式、测试覆盖，以及最小可合入的改进方案。',
  },
  {
    label: '做一次安全边界审计',
    prompt:
      '请只读审计这个功能的安全边界：权限、token/密钥流、IPC/renderer 暴露、文件路径、隐私模式、日志与 telemetry。输出 blocking 风险和对应 contract test。',
  },
] as const;

export function isDeepResearchSession(labels: readonly string[] | undefined): boolean {
  return Array.isArray(labels) && labels.includes(DEEP_RESEARCH_SESSION_LABEL);
}

export const DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_CHARS = 12_000;

export function buildDeepResearchImplementationPrompt(run: DeepResearchRun): string {
  if (run.status !== 'completed' || !run.handoff || !run.reportArtifactId) {
    throw new Error('Deep Research implementation handoff requires a completed run');
  }
  const lines: string[] = [
    'This is a new implementation task created from a completed read-only Deep Research session.',
    'The original research session remains read-only. Inspect the current code and present an implementation plan before changing project files.',
    '',
    `Research objective: ${run.objective}`,
    `Source session: ${run.sessionId}`,
    `Final report artifact: ${run.reportArtifactId}`,
    `Handoff artifact: ${run.handoff.artifactId}`,
    '',
    'Implementation tasks:',
    ...run.handoff.implementationTasks.map((item) => `- ${item}`),
    '',
    'Recommended issues:',
    ...(run.handoff.recommendedIssues.length > 0
      ? run.handoff.recommendedIssues.map((item) => `- ${item}`)
      : ['- None specified.']),
    '',
    'Recommended pull requests:',
    ...(run.handoff.recommendedPullRequests.length > 0
      ? run.handoff.recommendedPullRequests.map((item) => `- ${item}`)
      : ['- None specified.']),
    '',
    'Verification commands:',
    ...run.handoff.verificationCommands.map((item) => `- ${item}`),
  ];
  const content = lines.join('\n');
  const characters = Array.from(content);
  if (characters.length <= DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_CHARS) return content;
  const marker = '\n[Handoff truncated to the safe composer limit.]';
  return (
    characters
      .slice(0, DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_CHARS - Array.from(marker).length)
      .join('') + marker
  );
}

export function buildDeepResearchSystemPromptFragment(
  options: { readonly exploreAgentAvailable?: boolean } = {},
): string {
  const exploreAgentAvailable = options.exploreAgentAvailable ?? true;
  return [
    'Deep research mode is active for this session.',
    '',
    'Mode contract:',
    exploreAgentAvailable
      ? '- Inspect first. Prefer Read, Glob, Grep, WebSearch, and ExploreAgent.'
      : '- Inspect first. Prefer Read, Glob, Grep, and WebSearch.',
    ...(exploreAgentAvailable
      ? [
          '- Use ExploreAgent only for a separate, self-contained local investigation that benefits from a bounded read-only worker. Keep synthesis and final judgment in the main thread.',
          '- Do not use ExploreAgent just because it is available. If the next step is a known file, a specific symbol, package scripts, test setup, config, or 1-3 obvious files, inspect directly in the main thread.',
          '- When using ExploreAgent, bound the prompt with a goal, relevant paths or keywords, what to ignore, a stopping condition, and exactly what evidence the worker should return.',
        ]
      : []),
    '- Do not write, edit, delete, move, or rename user project files; do not install, run migrations, start services, or send network requests unless the user explicitly leaves research mode.',
    '- The deep_research_* tools are the one write exception: they only update Maka-owned research artifacts and an append-only workspace ledger, never the user project.',
    '- If implementation is needed, produce a concrete plan with files, risks, and verification commands instead of modifying files.',
    '- Keep findings source-grounded: name files, functions, configs, tests, and observed behavior.',
    '- Summarize borrow / diverge / risk / gate when comparing a reference project to Maka.',
    '',
    'Durable workspace protocol:',
    '- Call deep_research_start once with the concrete objective and scope level. After interruption or context compaction, call deep_research_status, then deep_research_read_artifact for the exact saved evidence needed to continue.',
    '- Knowledge-base stage: archive each important raw source first with deep_research_save_artifact role=source, then save evidence notes that cite those source artifact ids.',
    '- After each bounded local exploration or web-research substep, call deep_research_record_step with roots or query terms, ignored paths, a stopping condition, expected evidence, inspected files/symbols/URLs, worker run ids, persisted evidence ids, and any blocker.',
    '- Keep the four durable checklist items current with deep_research_update_checklist. Completed items require evidence artifacts; blocked items require an explicit reason.',
    '- Checkpoint every meaningful research round with deep_research_checkpoint, including open questions, next steps, related task ids, and the artifacts needed to resume.',
    '- Report-writing stage: save an outline, then source-backed report_section artifacts for conclusion, source_evidence, borrow_diverge_risk_gate, implementation_recommendations, and verification. Mark each section completed only when it is ready.',
    '- Save one final role=report artifact and one role=handoff artifact. The handoff must turn findings into implementation tasks, recommended issues and/or PRs, and verification commands without performing project writes.',
    '- Call deep_research_complete only after every checklist item is completed or explicitly skipped, all five report sections are completed, and both report and handoff artifacts are persisted.',
    '',
    'Research workflow:',
    ...DEEP_RESEARCH_WORKFLOW_STEPS.map((step) => `- ${step.title}: ${step.body}`),
    '',
    'Research scope budget:',
    ...DEEP_RESEARCH_SCOPE_OPTIONS.map((option) => `- ${option.label}: ${option.body}`),
    '- If the user does not specify a scope, use 标准. Use 深挖 only when the user explicitly asks for deep / exhaustive / full-project research.',
    '',
    'Evidence checklist:',
    ...DEEP_RESEARCH_EVIDENCE_CHECKLIST.map((item) => `- ${item.title}: ${item.body}`),
    '- If any checklist area cannot be verified from available files or runtime context, call that out explicitly instead of guessing.',
    '',
    'Progress checkpoints:',
    ...DEEP_RESEARCH_PROGRESS_CHECKPOINTS.map((item) => `- ${item.title}: ${item.body}`),
    '- Treat the checklist as a control loop for multi-step research, not as a hidden task system. Keep it visible in the answer or status update when the research spans multiple modules.',
    '',
    'Final report contract:',
    ...DEEP_RESEARCH_REPORT_SECTIONS.map((section) => `- ${section.title}: ${section.body}`),
  ].join('\n');
}
