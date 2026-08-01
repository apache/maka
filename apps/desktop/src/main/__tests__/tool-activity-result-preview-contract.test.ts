import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolResultContent } from '@maka/core';
import { LocaleProvider, ToolActivity } from '@maka/ui';

const SECRET = 'sk-1234567890abcdefghi';

describe('ToolActivity result preview contract', () => {
  it('renders structured result kinds as cards before the generic JSON fallback', () => {
    const cases: ReadonlyArray<{ kind: ToolResultContent['kind']; content: ToolResultContent; expected: RegExp[] }> = [
      {
        kind: 'file_diff',
        content: {
          kind: 'file_diff',
          paths: ['packages/ui/src/tool-activity.tsx'],
          diff: ['diff --git a/a b/a', '@@ -1 +1 @@', `-${SECRET}`, '+visible line'].join('\n'),
        },
        expected: [/data-kind="file_diff"/, /astryx-codeblock/, /data-language="diff"/, /\+visible line/],
      },
      {
        kind: 'web_search',
        content: {
          kind: 'web_search',
          provider: 'tavily',
          query: `maka ${SECRET}`,
          rows: [{
            title: `Search result ${SECRET}`,
            url: `https://example.com/result?api_key=${SECRET}`,
            snippet: `Snippet ${SECRET}`,
            source: 'example',
          }],
        },
        expected: [/data-kind="web_search"/, /tavily · 1 条结果/, /api_key=&lt;redacted&gt;/],
      },
      {
        kind: 'web_search_error',
        content: {
          kind: 'web_search_error',
          ok: false,
          provider: 'tavily',
          query: 'maka',
          reason: 'invalid_credentials',
          message: `provider rejected ${SECRET}`,
          credentialSource: 'saved',
        },
        expected: [/data-kind="web_search_error"/, /搜索失败/, /请在 设置 · 联网搜索 中更新 Tavily key。/],
      },
      {
        kind: 'terminal',
        content: {
          kind: 'terminal',
          cwd: '/tmp/maka',
          cmd: `npm test --api-key=${SECRET}`,
          status: 'failed',
          exitCode: 1,
          output: {
            mode: 'pipes',
            stdout: numberedLines('stdout', 501),
            stderr: `stderr ${SECRET}`,
            stdoutTruncated: false,
            stderrTruncated: false,
            redacted: false,
          },
        },
        expected: [/data-kind="terminal"/, /astryx-codeblock/, /stdout 已隐藏 1 行/, /输出已截断/],
      },
      {
        kind: 'rive_workflow',
        content: {
          kind: 'rive_workflow',
          ok: false,
          action: `run ${SECRET}`,
          command: ['rive', 'run'],
          ids: {
            workflowRunId: 'wf_123',
            schedulerRunId: 'sch_123',
            rootWorkNodeId: 'root_123',
          },
          state: `failed ${SECRET}`,
          summary: `workflow failed ${SECRET}`,
          nodes: [{ title: `node ${SECRET}`, state: 'failed', runner: `runner=${SECRET}` }],
          stderrTail: `tail ${SECRET}`,
          error: { reason: 'rive_failed', message: `failed ${SECRET}` },
        },
        expected: [/data-kind="rive_workflow"/, /workflow_run: wf_123/, /Rive workflow failed/],
      },
      {
        kind: 'explore_agent',
        content: {
          kind: 'explore_agent',
          ok: true,
          mode: 'read_only',
          objective: `Find preview contract ${SECRET}`,
          roots: ['packages/ui/src'],
          queries: ['ToolResultPreview'],
          filesInspected: 2,
          filesSkipped: 0,
          bytesRead: 1024,
          progress: ['scanned previews'],
          candidateFiles: [{ path: 'packages/ui/src/tool-activity.tsx', score: 0.9, reasons: ['content match'] }],
          matches: [{ path: 'packages/ui/src/tool-activity.tsx', line: 12, query: 'ToolResultPreview', snippet: 'routes results' }],
          notes: ['bounded preview'],
          summary: 'structured preview exists',
        },
        expected: [/data-kind="explore_agent"/, /Find preview contract/, /structured preview exists/],
      },
      {
        kind: 'subagent',
        content: {
          kind: 'subagent',
          agentName: `Research Agent ${SECRET}`,
          turnId: 'turn-secret-123',
          status: 'completed',
          permissionMode: 'explore',
          summary: `Mapped preview path ${SECRET}`,
          artifactIds: ['artifact-secret-1'],
        },
        expected: [/data-kind="subagent"/, /Research Agent/, /结果摘要/],
      },
      {
        kind: 'agent_swarm',
        content: {
          kind: 'agent_swarm',
          status: 'partial',
          items: [
            {
              itemId: 'auth',
              index: 0,
              profile: 'local_read',
              started: true,
              agentName: 'Local Read',
              turnId: 'turn-auth',
              runId: 'run-auth',
              status: 'completed',
              summary: `Mapped auth boundaries ${SECRET}`,
              artifactIds: ['artifact-auth'],
              durationMs: 1_250,
            },
            {
              itemId: 'tests',
              index: 1,
              profile: 'local_read',
              started: true,
              turnId: 'turn-tests',
              runId: 'run-tests',
              status: 'failed',
              summary: 'Test inspection failed.',
              artifactIds: [],
              durationMs: 500,
              failureClass: 'ChildFailed',
            },
          ],
          startedAt: 10,
          completedAt: 1_260,
          durationMs: 1_250,
        },
        expected: [
          /data-kind="agent_swarm"/,
          /部分完成/,
          /auth/,
          /run run-auth/,
          /turn turn-tests/,
          /ChildFailed/,
        ],
      },
    ];

    for (const item of cases) {
      const markup = renderPreview(item.content);
      for (const expected of item.expected) {
        assert.match(markup, expected, `${item.kind} should render its structured preview`);
      }
      assert.doesNotMatch(markup, new RegExp(SECRET), `${item.kind} preview must redact runtime secrets`);
      assert.doesNotMatch(markup, /data-kind="json"/, `${item.kind} preview must not fall through to raw JSON`);
    }
  });

  it('keeps bounded text and compact unknown-kind fallbacks', () => {
    const text = renderPreview({ kind: 'text', text: numberedLines('line', 501) });
    assert.match(text, /data-kind="text"/);
    assert.match(text, /已隐藏 1 行/);

    const json = renderPreview({ kind: 'json', value: { token: SECRET, ok: true } });
    assert.match(json, /astryx-codeblock|data-slot="tool-output"|data-kind="json"/);
    // Quiet panel: plain key:value lines, not pretty-printed JSON quotes.
    assert.match(json, /ok:\s*true/);
    assert.doesNotMatch(json, /&quot;ok&quot;:\s*true/);
    assert.doesNotMatch(json, new RegExp(SECRET));

    const fileWrite = renderPreview({ kind: 'file_write', path: 'out.txt', bytes: 12 });
    assert.match(fileWrite, /data-kind="file_write"/);
    assert.match(fileWrite, /\[file_write\]/);
    assert.doesNotMatch(fileWrite, /out\.txt/);
  });

  it('redacts ExploreAgent copy payloads before they reach the clipboard', async () => {
    const uiModuleUrl = pathToFileURL(join(process.cwd(), '../../packages/ui/dist/tool-activity/agent-preview.js')).href;
    const { buildExploreAgentCopyPayloads } = await import(uiModuleUrl) as {
      buildExploreAgentCopyPayloads(result: Extract<ToolResultContent, { kind: 'explore_agent' }>): Record<string, string>;
    };
    const payloads = buildExploreAgentCopyPayloads({
      kind: 'explore_agent',
      ok: true,
      partial: true,
      terminalStatus: 'completed_empty',
      mode: 'read_only',
      objective: `Find ${SECRET}`,
      roots: [`packages/${SECRET}`],
      queries: [`query ${SECRET}`],
      ignoredPaths: [`ignored/${SECRET}`],
      stoppingCondition: `stop ${SECRET}`,
      limitReasons: ['file_budget'],
      filesDiscovered: 4,
      filesInspected: 3,
      filesSkipped: 1,
      bytesRead: 4096,
      durationMs: 1250,
      progress: [`progress ${SECRET}`],
      recentEvents: [{ type: 'read', at: 1250, message: `read ${SECRET}` }],
      evidence: [{ type: 'match', path: `src/${SECRET}.ts`, line: 7, label: `label ${SECRET}` }],
      summary: `summary ${SECRET}`,
      report: `report ${SECRET}`,
      candidateFiles: [{ path: `src/candidate-${SECRET}.ts`, score: 0.8, reasons: [`path contains "${SECRET}"`] }],
      matches: [{ path: `src/match-${SECRET}.ts`, line: 9, query: `query ${SECRET}`, snippet: `snippet ${SECRET}` }],
      notes: [`note ${SECRET}`],
    });

    for (const key of ['summary', 'process', 'evidence', 'report', 'candidate', 'matches', 'continuation'] as const) {
      assert.equal(typeof payloads[key], 'string', `${key} payload must exist`);
      assert.doesNotMatch(payloads[key], new RegExp(SECRET), `${key} payload must redact runtime secrets`);
    }
    assert.match(payloads.summary, /<redacted>/);
    assert.match(payloads.matches, /<redacted>/);
    assert.match(payloads.continuation, /<redacted>/);
  });
});

function renderPreview(content: ToolResultContent): string {
  const item: Parameters<typeof ToolActivity>[0]['items'][number] = {
    toolUseId: 'preview',
    toolName: 'Preview',
    status: 'completed',
    args: {},
    result: content,
  };
  return renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh',
    children: createElement(ToolActivity, { items: [item], open: true }),
  }));
}

function numberedLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n');
}
