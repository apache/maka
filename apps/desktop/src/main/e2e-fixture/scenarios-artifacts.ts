import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ArtifactRecord } from '@maka/core/artifacts';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
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
      text: '已生成 3 个生成文件：HTML 报告、补丁 diff 和 Markdown 说明。请在右侧生成文件面板验证预览。',
      modelId: 'glm-5.1',
    },
  ];
}

export async function writeArtifacts(workspaceRoot: string, now: number): Promise<void> {
  const root = join(workspaceRoot, 'artifacts');
  const specs: Array<{
    id: string;
    name: string;
    kind: ArtifactRecord['kind'];
    mimeType: string;
    content: string;
  }> = [
    {
      id: 'artifact-report',
      name: 'report.html',
      kind: 'html',
      mimeType: 'text/html',
      content: '<!doctype html>\n<html lang="zh-CN"><meta charset="utf-8"><title>Maka 生成文件自检报告</title><h1>生成文件面板自检报告</h1></html>',
    },
    {
      id: 'artifact-patch',
      name: 'patch.diff',
      kind: 'diff',
      mimeType: 'text/x-diff',
      content: 'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new',
    },
    {
      id: 'artifact-notes',
      name: 'notes.md',
      kind: 'file',
      mimeType: 'text/markdown',
      content: '# 生成文件面板说明\n\n- HTML preview is view-only.\n- Binary preview requires MIME sniff allow-list.',
    },
  ];
  const records: ArtifactRecord[] = [];
  for (const spec of specs) {
    const relativePath = `${ARTIFACT_SESSION_ID}/${spec.id}-${spec.name}`;
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, spec.content);
    records.push({
      id: spec.id,
      sessionId: ARTIFACT_SESSION_ID,
      turnId: 'turn-artifact',
      createdAt: now - 6 * 60_000 + records.length * 1_000,
      name: spec.name,
      kind: spec.kind,
      relativePath,
      sizeBytes: (await stat(path)).size,
      mimeType: spec.mimeType,
      source: 'fixture',
      status: 'live',
    });
  }
  const metadata = createSqliteArtifactMetadataRepository(workspaceRoot);
  try {
    metadata.replaceAll(records);
  } finally {
    metadata.close();
  }
}
