import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildExploreAgentTool, runReadOnlyExplore } from '../explore-agent-tool.js';

describe('ExploreAgent read-only worker', () => {
  it('returns source-grounded matches without absolute paths', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(join(workspaceRoot, 'src'), { recursive: true });
      await writeFile(
        join(workspaceRoot, 'src', 'permission.ts'),
        ['export const policy = {', "  explore: 'read-only subagent',", '};'].join('\n'),
      );
      await writeFile(join(workspaceRoot, 'README.md'), '# Demo\npermission model overview');

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'study permission policy',
        roots: ['.'],
        queries: ['permission', 'subagent'],
        maxFiles: 10,
        maxMatches: 10,
      });

      assert.equal(result.ok, true);
      assert.equal(result.kind, 'explore_agent');
      assert.equal(result.mode, 'read_only');
      assert.equal(result.terminalStatus, 'completed');
      assert.deepEqual(result.roots, ['.']);
      assert.deepEqual(result.ignoredPaths, []);
      assert.equal(result.stoppingCondition, '');
      assert.deepEqual(result.limitReasons, []);
      assert.equal(typeof result.startedAt, 'number');
      assert.equal(typeof result.completedAt, 'number');
      assert.equal(typeof result.durationMs, 'number');
      assert.ok(result.completedAt >= result.startedAt);
      assert.ok(result.durationMs >= 0);
      assert.ok(result.filesInspected >= 2);
      assert.ok(result.filesDiscovered >= result.filesInspected);
      assert.ok(
        result.matches.some(
          (match) => match.path === 'src/permission.ts' && match.query === 'subagent',
        ),
      );
      assert.ok(result.candidateFiles.some((file) => file.path === 'src/permission.ts'));
      assert.equal(result.sensitiveFilesSkipped, 0);
      assert.ok(
        result.evidence.some(
          (item) => item.type === 'match' && item.path === 'src/permission.ts' && item.line === 2,
        ),
      );
      assert.match(
        result.summary,
        /发现 \d+ 个候选 · 读取 \d+ 个文件 · 命中 \d+ 处 · 证据 \d+ 个 · 候选 \d+ 个 · 耗时 /,
      );
      assert.ok(
        result.recentEvents.some(
          (event) => event.type === 'started' && /准备范围/.test(event.message),
        ),
      );
      assert.ok(
        result.recentEvents.some(
          (event) => event.type === 'completed' && /完成/.test(event.message),
        ),
      );
      assert.ok(
        result.recentEvents.every(
          (event) => typeof event.at === 'number' && !JSON.stringify(event).includes(workspaceRoot),
        ),
      );
      assert.match(result.report, /目标：study permission policy/);
      assert.match(result.report, /状态：完成，已找到可交接证据。/);
      assert.match(result.report, /发现\/读取：\d+ \/ \d+ 个文件/);
      assert.match(result.report, /证据锚点：/);
      assert.match(result.report, /src\/permission\.ts:2/);
      assert.match(result.report, /命中片段：/);
      assert.match(result.report, /耗时 \d+(?:\.\d)?(?: ms|s|m \d+s)/);
      assert.equal(JSON.stringify(result).includes(workspaceRoot), false);
      assert.ok(result.notes.some((note) => /不写文件、不联网、不启动进程/.test(note)));
      assert.equal(
        result.notes.some((note) => /Read-only worker|Search budget/.test(note)),
        false,
      );
    });
  });

  it('rejects roots outside cwd and skips symlinked content', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-explore-outside-'));
      try {
        await writeFile(join(outside, 'secret.ts'), 'subscription_token = "secret"');
        await symlink(outside, join(workspaceRoot, 'linked-outside'));

        const invalid = await runReadOnlyExplore({
          cwd: workspaceRoot,
          objective: 'inspect secret',
          roots: ['../'],
          queries: ['secret'],
        });
        assert.equal(invalid.ok, false);
        assert.equal(invalid.reason, 'invalid_root');

        const result = await runReadOnlyExplore({
          cwd: workspaceRoot,
          objective: 'inspect secret',
          roots: ['.'],
          queries: ['secret'],
        });
        assert.equal(result.ok, true);
        assert.equal(result.matches.length, 0);
        assert.equal(JSON.stringify(result).includes('subscription_token'), false);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('returns a structured failure when the session cwd is unreadable', async () => {
    const missingRoot = join(
      tmpdir(),
      `maka-explore-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const result = await runReadOnlyExplore({
      cwd: missingRoot,
      objective: 'inspect missing workspace',
      roots: ['.'],
      queries: ['workspace'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_root');
    assert.equal(result.terminalStatus, 'failed');
    assert.equal(result.filesDiscovered, 0);
    assert.equal(result.message, '会话工作目录不可读取。');
    assert.equal(result.summary, '未完成：会话工作目录不可读取。');
    assert.ok(
      result.recentEvents.some(
        (event) => event.type === 'failed' && /工作目录不可读取/.test(event.message),
      ),
    );
    assert.equal(result.filesInspected, 0);
    assert.equal(result.matches.length, 0);
    assert.equal(JSON.stringify(result).includes(missingRoot), false);
    assert.equal(typeof result.durationMs, 'number');
  });

  it('skips sensitive local credential files even when they match the query', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(join(workspaceRoot, 'src'), { recursive: true });
      await writeFile(join(workspaceRoot, '.env'), 'ANTHROPIC_API_KEY=sk-ant-secret');
      await writeFile(join(workspaceRoot, '.npmrc'), '//registry.example/:_authToken=npm_secret');
      await writeFile(
        join(workspaceRoot, 'credentials.json'),
        '{"refresh_token":"secret-refresh"}',
      );
      await writeFile(
        join(workspaceRoot, 'src', 'config.ts'),
        'export const secretBoundary = "redacted in docs";',
      );

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'study secret boundary',
        roots: ['.'],
        queries: ['secret'],
        maxFiles: 20,
        maxMatches: 20,
      });

      assert.equal(result.ok, true);
      assert.ok(result.matches.some((match) => match.path === 'src/config.ts'));
      assert.equal(result.sensitiveFilesSkipped, 3);
      assert.ok(result.notes.some((note) => /已跳过 3 个疑似本地凭据\/密钥文件/.test(note)));
      assert.match(result.report, /跳过 \d+ 个（含敏感 3 个）/);
      assert.equal(JSON.stringify(result).includes('sk-ant-secret'), false);
      assert.equal(JSON.stringify(result).includes('npm_secret'), false);
      assert.equal(JSON.stringify(result).includes('secret-refresh'), false);
      assert.equal(
        result.candidateFiles.some(
          (file) =>
            file.path === '.env' || file.path === '.npmrc' || file.path === 'credentials.json',
        ),
        false,
      );
      assert.equal(
        result.evidence.some(
          (item) =>
            item.path === '.env' || item.path === '.npmrc' || item.path === 'credentials.json',
        ),
        false,
      );
    });
  });

  it('honors explicit ignore paths during scoped research', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(join(workspaceRoot, 'src'), { recursive: true });
      await mkdir(join(workspaceRoot, 'vendor'), { recursive: true });
      await mkdir(join(workspaceRoot, 'generated', 'nested'), { recursive: true });
      await writeFile(join(workspaceRoot, 'src', 'alpha.ts'), 'export const alpha = "source";');
      await writeFile(join(workspaceRoot, 'vendor', 'alpha.ts'), 'export const alpha = "vendor";');
      await writeFile(
        join(workspaceRoot, 'generated', 'nested', 'alpha.ts'),
        'export const alpha = "generated";',
      );

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'study alpha source implementation',
        roots: ['.'],
        queries: ['alpha'],
        ignorePaths: ['vendor', './generated/', '../outside', '/tmp/outside', 'src/../escape'],
        maxFiles: 20,
        maxMatches: 20,
      });

      assert.equal(result.ok, true);
      assert.deepEqual(result.ignoredPaths, ['vendor', 'generated']);
      assert.ok(result.matches.some((match) => match.path === 'src/alpha.ts'));
      assert.equal(
        result.matches.some((match) => match.path.startsWith('vendor/')),
        false,
      );
      assert.equal(
        result.matches.some((match) => match.path.startsWith('generated/')),
        false,
      );
      assert.equal(
        result.candidateFiles.some(
          (file) => file.path.startsWith('vendor/') || file.path.startsWith('generated/'),
        ),
        false,
      );
      assert.ok(result.notes.some((note) => /已按请求忽略：vendor, generated/.test(note)));
      assert.equal(JSON.stringify(result).includes(workspaceRoot), false);
    });
  });

  it('preserves the caller stopping condition in results and reports', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(join(workspaceRoot, 'src'), { recursive: true });
      await writeFile(join(workspaceRoot, 'src', 'alpha.ts'), 'export const alpha = "source";');

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'study alpha source implementation',
        roots: ['.'],
        queries: ['alpha'],
        stoppingCondition: 'stop after finding the implementation entry and one evidence line',
        maxFiles: 10,
        maxMatches: 10,
      });

      assert.equal(result.ok, true);
      assert.equal(
        result.stoppingCondition,
        'stop after finding the implementation entry and one evidence line',
      );
      assert.match(
        result.report,
        /停止条件：stop after finding the implementation entry and one evidence line/,
      );
      assert.ok(
        result.notes.some((note) =>
          /停止条件：stop after finding the implementation entry and one evidence line/.test(note),
        ),
      );
      assert.equal(JSON.stringify(result).includes(workspaceRoot), false);
    });
  });

  it('surfaces budget boundaries as structured result metadata', async () => {
    await withWorkspace(async (workspaceRoot) => {
      for (let index = 0; index < 8; index++) {
        await writeFile(join(workspaceRoot, `alpha-${index}.md`), `alpha evidence ${index}`);
      }

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'find alpha evidence',
        roots: ['.'],
        queries: ['alpha'],
        maxFiles: 2,
        maxMatches: 2,
      });

      assert.equal(result.ok, true);
      assert.deepEqual(result.limitReasons, ['file_budget', 'match_budget']);
      assert.ok(result.notes.some((note) => /按查询命中和项目结构分读取前 2 个/.test(note)));
      assert.ok(result.notes.some((note) => /命中预算已用尽；只返回前 2 处内容命中/.test(note)));
      assert.match(result.report, /预算边界：读取文件预算已满、命中预算已满/);
      assert.equal(JSON.stringify(result).includes(workspaceRoot), false);
    });
  });

  it('runs through the tool impl with the session cwd only', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(workspaceRoot, 'notes.md'), 'reference explore worker notes');
      const tool = buildExploreAgentTool();
      const output: string[] = [];
      const result = await tool.impl(
        { objective: 'find reference notes', queries: ['reference'] },
        {
          sessionId: 's1',
          turnId: 't1',
          cwd: workspaceRoot,
          toolCallId: 'tool-1',
          abortSignal: new AbortController().signal,
          emitOutput: (_stream, chunk) => output.push(chunk),
        },
      );
      assert.equal(result.kind, 'explore_agent');
      assert.equal(result.ok, true);
      assert.ok(result.matches.some((match) => match.path === 'notes.md'));
      assert.ok(result.progress.some((message) => /准备范围/.test(message)));
      assert.ok(result.progress.some((message) => /完成/.test(message)));
      assert.equal(result.progress.join('').includes(workspaceRoot), false);
      assert.ok(output.some((chunk) => /准备范围/.test(chunk)));
      assert.ok(output.some((chunk) => /完成/.test(chunk)));
      assert.equal(output.join('').includes(workspaceRoot), false);
    });
  });

  it('honors runtime abort signals before scanning files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(workspaceRoot, 'notes.md'), 'reference explore worker notes');
      const abort = new AbortController();
      abort.abort();

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'find reference notes',
        queries: ['reference'],
        abortSignal: abort.signal,
      });

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'aborted');
      assert.equal(result.terminalStatus, 'canceled');
      assert.equal(result.filesDiscovered, 0);
      assert.equal(result.message, '只读探索已取消。');
      assert.ok(
        result.recentEvents.some(
          (event) => event.type === 'aborted' && /已取消/.test(event.message),
        ),
      );
      assert.equal(result.filesInspected, 0);
      assert.equal(result.partial, false);
      assert.deepEqual(result.matches, []);
      assert.deepEqual(result.evidence, []);
      assert.equal(result.report, '');
      assert.equal(JSON.stringify(result).includes('reference explore worker notes'), false);
    });
  });

  it('keeps bounded partial findings when canceled after reading files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      for (let index = 0; index < 20; index++) {
        await writeFile(join(workspaceRoot, `partial-${index}.md`), `alpha evidence ${index}`);
      }
      const abort = new AbortController();

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'find partial alpha evidence',
        roots: ['.'],
        queries: ['alpha'],
        maxFiles: 20,
        maxMatches: 20,
        abortSignal: abort.signal,
        onProgress: (message) => {
          if (/已读取 10 个文件/.test(message)) abort.abort();
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'aborted');
      assert.equal(result.partial, true);
      assert.equal(result.terminalStatus, 'canceled_partial');
      assert.equal(result.message, '只读探索已取消，已保留取消前的部分结果。');
      assert.equal(result.filesInspected, 10);
      assert.ok(result.filesDiscovered >= result.filesInspected);
      assert.ok(result.matches.length > 0);
      assert.ok(result.evidence.length > 0);
      assert.match(result.summary, /^已取消：发现 \d+ 个候选 · 读取 10 个文件/);
      assert.match(result.report, /状态：已取消，以下为取消前部分结果。/);
      assert.match(result.report, /命中片段：/);
      assert.ok(result.notes.some((note) => /取消前已读取的部分结果/.test(note)));
      assert.ok(
        result.recentEvents.some(
          (event) => event.type === 'aborted' && /部分结果/.test(event.message),
        ),
      );
      assert.equal(JSON.stringify(result).includes(workspaceRoot), false);
    });
  });

  it('forwards the runtime abort signal through the tool impl', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(workspaceRoot, 'notes.md'), 'reference explore worker notes');
      const tool = buildExploreAgentTool();
      const abort = new AbortController();
      abort.abort();

      const result = await tool.impl(
        { objective: 'find reference notes', queries: ['reference'] },
        {
          sessionId: 's1',
          turnId: 't1',
          cwd: workspaceRoot,
          toolCallId: 'tool-1',
          abortSignal: abort.signal,
          emitOutput: () => undefined,
        },
      );

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'aborted');
      assert.equal(result.message, '只读探索已取消。');
      assert.equal(result.filesInspected, 0);
      assert.equal(result.partial, false);
    });
  });

  it('emits bounded progress checkpoints for long scans', async () => {
    await withWorkspace(async (workspaceRoot) => {
      for (let index = 0; index < 25; index++) {
        await writeFile(join(workspaceRoot, `file-${index}.md`), `alpha reference ${index}`);
      }
      const progress: string[] = [];
      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'find alpha references',
        queries: ['alpha'],
        maxFiles: 25,
        maxMatches: 25,
        onProgress: (message) => progress.push(message),
      });

      assert.equal(result.ok, true);
      assert.deepEqual(result.progress, progress);
      assert.ok(result.recentEvents.length >= result.progress.length);
      assert.ok(result.recentEvents.length <= 20);
      assert.ok(
        result.recentEvents.some(
          (event) => event.type === 'checkpoint' && /已读取 10 个文件/.test(event.message),
        ),
      );
      assert.ok(progress.length >= 5);
      assert.ok(progress.length <= 12);
      assert.ok(progress.some((message) => /已读取 10 个文件/.test(message)));
      assert.ok(progress.some((message) => /完成，读取/.test(message)));
      assert.equal(progress.join('\n').includes(workspaceRoot), false);
    });
  });

  it('prioritizes project landmarks during broad research scans', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(join(workspaceRoot, 'src'), { recursive: true });
      await mkdir(join(workspaceRoot, 'tests'), { recursive: true });
      for (let index = 0; index < 20; index++) {
        await writeFile(join(workspaceRoot, `aaa-filler-${index}.md`), `filler ${index}`);
      }
      await writeFile(join(workspaceRoot, 'package.json'), '{"scripts":{"test":"node --test"}}');
      await writeFile(join(workspaceRoot, 'README.md'), '# Landmark project');
      await writeFile(join(workspaceRoot, 'src', 'main.ts'), 'export function boot() {}');
      await writeFile(
        join(workspaceRoot, 'tests', 'boot.test.ts'),
        'test("boot", () => undefined)',
      );

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'map this project architecture',
        roots: ['.'],
        queries: ['unlikely-query'],
        maxFiles: 6,
        maxMatches: 6,
      });

      assert.equal(result.ok, true);
      assert.ok(
        result.candidateFiles.some(
          (file) => file.path === 'package.json' && file.reasons.includes('project manifest'),
        ),
      );
      assert.ok(
        result.candidateFiles.some(
          (file) => file.path === 'README.md' && file.reasons.includes('project documentation'),
        ),
      );
      assert.ok(
        result.candidateFiles.some(
          (file) => file.path === 'src/main.ts' && file.reasons.includes('project entrypoint'),
        ),
      );
      assert.ok(
        result.candidateFiles.some(
          (file) =>
            file.path === 'tests/boot.test.ts' && file.reasons.includes('project test surface'),
        ),
      );
      assert.ok(
        result.evidence.some(
          (item) =>
            item.type === 'candidate' &&
            item.path === 'package.json' &&
            item.label === '项目配置锚点',
        ),
      );
      assert.ok(
        result.evidence.some(
          (item) =>
            item.type === 'candidate' && item.path === 'README.md' && item.label === '项目文档锚点',
        ),
      );
      assert.ok(result.notes.some((note) => /优先读取项目配置、文档、入口和测试线索/.test(note)));
      assert.ok(result.notes.some((note) => /按查询命中和项目结构分/.test(note)));
      assert.equal(JSON.stringify(result).includes(workspaceRoot), false);
    });
  });

  it('keeps the generated research report bounded and source-grounded', async () => {
    await withWorkspace(async (workspaceRoot) => {
      for (let index = 0; index < 20; index++) {
        await writeFile(
          join(workspaceRoot, `report-${index}.md`),
          `alpha line ${index}\nalpha detail ${index}`,
        );
      }

      const result = await runReadOnlyExplore({
        cwd: workspaceRoot,
        objective: 'summarize alpha report evidence',
        roots: ['.'],
        queries: ['alpha'],
        maxFiles: 20,
        maxMatches: 60,
      });

      assert.equal(result.ok, true);
      assert.ok(result.report.length <= 6000);
      assert.match(result.report, /目标：summarize alpha report evidence/);
      assert.match(result.report, /下一步阅读：/);
      assert.equal(result.report.includes(workspaceRoot), false);
    });
  });
});

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-explore-agent-'));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
