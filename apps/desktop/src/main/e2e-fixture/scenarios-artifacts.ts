import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ArtifactRecord, SessionHeader, StoredMessage, E2eFixtureScenario } from '@maka/core';
import { createSqliteArtifactMetadataRepository } from '@maka/storage';
import { ARTIFACT_SESSION_ID, header } from './seed-helpers.js';

export function artifactSession(now: number): SessionHeader {
  return header({
    id: ARTIFACT_SESSION_ID,
    name: '生成文件验收',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 6 * 60_000,
  });
}

export function artifactMessages(now: number): StoredMessage[] {
  const turnId = 'turn-artifact';
  return [
    {
      type: 'user',
      id: 'artifact-user',
      turnId,
      ts: now - 7 * 60_000,
      text: '生成一个 HTML 报告、一个 diff 和一份 Markdown 说明，放到右侧生成文件面板里检查。',
    },
    {
      type: 'tool_call',
      id: 'artifact-tool',
      turnId,
      ts: now - 7 * 60_000 + 1_000,
      toolName: 'Write',
      displayName: '写入生成文件',
      intent: '生成 report.html / patch.diff / notes.md 三个生成文件',
      args: { path: 'artifacts/e2e-fixture' },
    },
    {
      type: 'assistant',
      id: 'artifact-assistant',
      turnId,
      ts: now - 6 * 60_000,
      text: '已生成 3 个生成文件：HTML 报告、补丁 diff 和 Markdown 说明。请在右侧生成文件面板验证预览、大小限制与 HTML 沙箱边界。',
      modelId: 'glm-5.1',
    },
  ];
}

export async function writeArtifacts(workspaceRoot: string, now: number, scenario: E2eFixtureScenario): Promise<void> {
  const root = join(workspaceRoot, 'artifacts');
  // PR-UI-RENDER-3a-smoke: dedicated preview scenarios get their
  // own short artifact list (single artifact each) so the
  // ArtifactPane default selection deterministically picks the one
  // the fixture is meant to render. The `sizeBytesOverride`
  // field bypasses the post-write `stat().size` overwrite so we
  // can claim 3MB in metadata without writing 3MB to disk.
  type ArtifactSpec = {
    id: string;
    name: string;
    kind: ArtifactRecord['kind'];
    mimeType?: string;
    content: string | Uint8Array;
    status?: ArtifactRecord['status'];
    skipFile?: boolean;
    /**
     * @kenji review @msg fc9753b9 oversize fixture: when this is
     * set, the post-write `stat().size` is NOT used to overwrite
     * the recorded `sizeBytes`. Lets us seed a 3MB-claim artifact
     * without consuming 3MB of disk in the test workspace.
     * Only valid alongside `skipFile: true` to avoid metadata/file
     * drift.
     */
    sizeBytesOverride?: number;
  };
  // 1x1 transparent PNG (67 bytes). Smallest valid PNG that
  // `readBinary` will sniff back as `image/png`. Used by
  // `artifact-preview-image` to exercise the registry's happy path.
  const tinyPngBytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);

  // PR-UI-RENDER-3a-smoke: dedicated single-artifact specs per
  // scenario. Returning early keeps these scenarios from inheriting
  // the standard html/diff/notes list (which would shuffle the
  // default selection).
  if (scenario === 'artifact-preview-image') {
    await writeArtifactSpecs(root, now, [
      {
        id: 'artifact-preview-image',
        name: 'screenshot.png',
        kind: 'image',
        mimeType: 'image/png',
        content: tinyPngBytes,
      },
    ]);
    return;
  }
  if (scenario === 'artifact-preview-unsupported') {
    await writeArtifactSpecs(root, now, [
      {
        id: 'artifact-preview-unsupported',
        name: 'portrait.heic',
        // kind: 'image' makes the resolver enter the image branch;
        // image/heic is NOT in the allowlist so L1 returns
        // `unsupported(mime_disallowed)`. readBinary is NEVER called
        // for this scenario.
        kind: 'image',
        mimeType: 'image/heic',
        content: Uint8Array.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]),
      },
    ]);
    return;
  }
  if (scenario === 'artifact-preview-oversize') {
    await writeArtifactSpecs(root, now, [
      {
        id: 'artifact-preview-oversize',
        name: 'huge.png',
        kind: 'image',
        mimeType: 'image/png',
        // 3MB claim — past the 2MB cap. L1 resolver rejects via
        // sizeBytes before readBinary is even attempted; the
        // <UnsupportedArtifactPreview reason="oversize"> is what
        // renders. We skip the file so the test workspace stays
        // small (and so a stat overwrite doesn't undo our claim).
        content: Uint8Array.from([]),
        skipFile: true,
        sizeBytesOverride: 3 * 1024 * 1024,
      },
    ]);
    return;
  }
  const specs: Array<ArtifactSpec> = [
    {
      id: 'artifact-report',
      name: 'report.html',
      kind: 'html' as const,
      mimeType: 'text/html',
      content: [
        '<!doctype html>',
        '<html lang="zh-CN">',
        '<meta charset="utf-8">',
        '<title>Maka 生成文件自检报告</title>',
        '<style>body{font-family:system-ui;margin:24px;line-height:1.5}code{background:#eee;padding:2px 4px}</style>',
        '<h1>生成文件面板自检报告</h1>',
        '<p>这个 HTML 生成文件用于验证 sandboxed iframe view-only 预览。</p>',
        '<p><a href="https://example.com">外部链接应被禁用</a></p>',
        '<script>document.body.dataset.scriptRan = "true";</script>',
        '</html>',
      ].join('\n'),
    },
    {
      id: 'artifact-patch',
      name: 'patch.diff',
      kind: 'diff' as const,
      mimeType: 'text/x-diff',
      content: [
        'diff --git a/apps/desktop/src/renderer/ArtifactPane.tsx b/apps/desktop/src/renderer/ArtifactPane.tsx',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/apps/desktop/src/renderer/ArtifactPane.tsx',
        '@@ -0,0 +1,4 @@',
        '+export function ArtifactPane() {',
        '+  return <aside className="maka-artifact-pane" />;',
        '+}',
      ].join('\n'),
    },
    {
      id: 'artifact-notes',
      name: 'notes.md',
      kind: 'file' as const,
      mimeType: 'text/markdown',
      content: [
        '# 生成文件面板说明',
        '',
        '- HTML preview is view-only.',
        '- Deleted tombstones must block reads.',
        '- Binary preview requires MIME sniff allow-list.',
      ].join('\n'),
    },
  ];
  if (scenario === 'artifact-errors') {
    specs.push(
      {
        id: 'artifact-deleted',
        name: 'deleted.md',
        kind: 'file',
        mimeType: 'text/markdown',
        content: '# Deleted artifact\n\nThis file remains on disk but reads must be blocked by tombstone.',
        status: 'deleted',
      },
      {
        id: 'artifact-unsupported',
        name: 'unsupported.bin',
        kind: 'image',
        mimeType: 'image/png',
        content: Uint8Array.from([0x00, 0x01, 0x02, 0x03]),
      },
      {
        id: 'artifact-missing',
        name: 'missing.md',
        kind: 'file',
        mimeType: 'text/markdown',
        content: '# Missing artifact',
        skipFile: true,
      },
    );
  }

  await writeArtifactSpecs(root, now, specs);
}

/**
 * Shared writer for an arbitrary artifact spec list. Writes each
 * spec to disk (unless `skipFile`), captures the real `sizeBytes`
 * via `stat` (unless `sizeBytesOverride`), and persists metadata in
 * runtime.sqlite. Used by both the canonical
 * `artifact-pane` / `artifact-errors` scenarios and the
 * PR-UI-RENDER-3a-smoke preview scenarios.
 */
async function writeArtifactSpecs(
  root: string,
  now: number,
  specs: Array<{
    id: string;
    name: string;
    kind: ArtifactRecord['kind'];
    mimeType?: string;
    content: string | Uint8Array;
    status?: ArtifactRecord['status'];
    skipFile?: boolean;
    sizeBytesOverride?: number;
  }>,
): Promise<void> {
  const records: ArtifactRecord[] = [];
  for (const spec of specs) {
    const relativePath = `${ARTIFACT_SESSION_ID}/${spec.id}-${spec.name}`;
    const path = join(root, relativePath);
    let sizeBytes = spec.content instanceof Uint8Array ? spec.content.byteLength : Buffer.byteLength(spec.content);
    if (!spec.skipFile) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, spec.content);
      sizeBytes = (await stat(path)).size;
    }
    // PR-UI-RENDER-3a-smoke: oversize fixture passes
    // `sizeBytesOverride` so the metadata can claim 3MB without
    // writing 3MB. The override must come AFTER the stat overwrite
    // above so it isn't undone.
    if (spec.sizeBytesOverride !== undefined) {
      sizeBytes = spec.sizeBytesOverride;
    }
    records.push({
      id: spec.id,
      sessionId: ARTIFACT_SESSION_ID,
      turnId: 'turn-artifact',
      createdAt: now - 6 * 60_000 + records.length * 1_000,
      name: spec.name,
      kind: spec.kind,
      relativePath,
      sizeBytes,
      ...(spec.mimeType ? { mimeType: spec.mimeType } : {}),
      source: 'fixture',
      status: spec.status ?? 'live',
    });
  }

  const metadata = createSqliteArtifactMetadataRepository(dirname(root));
  try {
    metadata.replaceAll(records);
  } finally {
    metadata.close();
  }
}
