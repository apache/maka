import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import type { ToolResultContent } from '@maka/core';

const SECRET = 'sk-1234567890abcdefghi';

describe('ToolActivity result preview contract', () => {
  it('redacts ExploreAgent copy payloads before they reach the clipboard', async () => {
    const uiModuleUrl = pathToFileURL(
      join(process.cwd(), '../../packages/ui/dist/tool-activity/agent-preview.js'),
    ).href;
    const { buildExploreAgentCopyPayloads } = (await import(uiModuleUrl)) as {
      buildExploreAgentCopyPayloads(
        result: Extract<ToolResultContent, { kind: 'explore_agent' }>,
      ): Record<string, string>;
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
      evidence: [
        { type: 'match', path: `src/${SECRET}.ts`, line: 7, label: `label ${SECRET}` },
      ],
      summary: `summary ${SECRET}`,
      report: `report ${SECRET}`,
      candidateFiles: [
        {
          path: `src/candidate-${SECRET}.ts`,
          score: 0.8,
          reasons: [`path contains "${SECRET}"`],
        },
      ],
      matches: [
        {
          path: `src/match-${SECRET}.ts`,
          line: 9,
          query: `query ${SECRET}`,
          snippet: `snippet ${SECRET}`,
        },
      ],
      notes: [`note ${SECRET}`],
    });

    for (const key of [
      'summary',
      'process',
      'evidence',
      'report',
      'candidate',
      'matches',
      'continuation',
    ] as const) {
      assert.equal(typeof payloads[key], 'string', `${key} payload must exist`);
      assert.doesNotMatch(
        payloads[key],
        new RegExp(SECRET),
        `${key} payload must redact runtime secrets`,
      );
    }
    assert.match(payloads.summary, /<redacted>/);
    assert.match(payloads.matches, /<redacted>/);
    assert.match(payloads.continuation, /<redacted>/);
  });
});
