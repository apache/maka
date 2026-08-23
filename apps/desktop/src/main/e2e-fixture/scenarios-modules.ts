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

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MCP_CONFIG_VERSION } from '@maka/core/mcp';
import { writeJson } from './seed-helpers.js';

/**
 * MCP module fixture: seeds an mcp.json with a couple of installed servers so
 * the configured tab and its server rows render for the alignment auditor.
 * Both are `enabled: false` so no real `npx` / HTTP connection is
 * attempted in e2e-fixture mode — the rows render deterministically in the
 * neutral 已停用 state (exception-only status: no color unless a real failure).
 * The 市场 tab is the default surface and is driven by the static MCP_CATALOG,
 * so it renders without any on-disk seed.
 */
export async function seedMcpFixture(workspaceRoot: string): Promise<void> {
  const config = {
    version: MCP_CONFIG_VERSION,
    mcpServers: {
      filesystem: {
        enabled: false,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace/maka'],
      },
      'linear-remote': {
        enabled: false,
        url: 'https://mcp.linear.app/sse',
        transport: 'sse',
      },
    },
  };
  await writeJson(join(workspaceRoot, 'mcp.json'), config);
}

/**
 * Marketplace fixture: seeds a managed-source catalog (≥6 entries across
 * categories with varied recency) plus a couple of workspace skills so the
 * 市场 grid, category filter, sort, and the 内置/已安装 rows all render
 * meaningfully in the CDP capture. Managed sources normally live in
 * ~/.maka/skill-sources; the dev-gated MAKA_SKILL_SOURCES_ROOT override
 * (resolveManagedSkillSourcesRoot) points both the seeder and the runtime
 * IPC at a fixture-local dir so nothing touches the real home catalog.
 */
export async function seedSkillsMarketFixture(workspaceRoot: string): Promise<void> {
  const sourcesRoot = join(workspaceRoot, '.maka', 'skill-sources');
  process.env.MAKA_SKILL_SOURCES_ROOT = sourcesRoot;
  await mkdir(sourcesRoot, { recursive: true });

  const sources: ReadonlyArray<{ id: string; name: string; description: string; category: string }> = [
    { id: 'research-brief', name: '研究简报', category: '研究与分析', description: '把网页资料、引用和结论整理成结构化 brief，适合快速进入陌生领域。' },
    { id: 'doc-review', name: '文档审阅', category: '文档与写作', description: '检查 DOCX / Markdown 的结构、语气和遗漏项，并输出可执行修改建议。' },
    { id: 'meeting-followup', name: '会议跟进', category: '效率工具', description: '从会议记录里抽取决定、风险和 owner，生成下一步任务清单。' },
    { id: 'release-checklist', name: '发布检查', category: 'DevOps与部署', description: '按发布前 checklist 扫描 diff、测试和文档，减少临门一脚的遗漏。' },
    { id: 'data-analyst', name: '数据分析助手', category: '数据与AI', description: '读取 CSV / 表格，做透视、异常检测和趋势总结，产出可复述的结论。' },
    { id: 'ui-audit', name: 'UI 走查', category: '设计与UI', description: '对照设计规范逐项走查间距、层级和状态色，列出需要修的细节。' },
    { id: 'blog-outline', name: '博客提纲', category: '内容创作', description: '把零散想法整理成有节奏的文章提纲，附上每段的论据方向。' },
  ];

  // Stagger mtimes so 排序：最近 has a meaningful order (the last-written
  // source is the most recent). Written newest-last on purpose.
  for (const source of sources) {
    const dir = join(sourcesRoot, source.id);
    await mkdir(dir, { recursive: true });
    const content = [
      '---',
      `name: ${source.name}`,
      `description: ${source.description}`,
      `category: ${source.category}`,
      '---',
      '',
      `# ${source.name}`,
      '',
      source.description,
      '',
    ].join('\n');
    await writeFile(join(dir, 'SKILL.md'), content, { encoding: 'utf8', mode: 0o600 });
  }

  // A couple of workspace skills so 已安装 is not empty and one managed
  // source shows as installed in the grid.
  const workspaceSkills: ReadonlyArray<{ id: string; name: string; description: string }> = [
    { id: 'meeting-followup', name: '会议跟进', description: '从会议记录里抽取决定、风险和 owner，生成下一步任务清单。' },
    { id: 'daily-standup', name: '每日站会', description: '汇总昨日进展、今日计划和阻塞，生成简短的站会同步。' },
  ];
  for (const skill of workspaceSkills) {
    const dir = join(workspaceRoot, 'skills', skill.id);
    await mkdir(dir, { recursive: true });
    const content = [
      '---',
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      '---',
      '',
      `# ${skill.name}`,
      '',
      skill.description,
      '',
    ].join('\n');
    await writeFile(join(dir, 'SKILL.md'), content, { encoding: 'utf8', mode: 0o600 });
  }
}
