import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  ToolArtifactRecorderInput,
  ToolResultArchiveReaderInput,
  ToolResultArchiveReadResult,
  ToolResultArchiveRecorderInput,
  ToolResultArchiveResourceReadInput,
} from '@maka/runtime';
import type { createArtifactStore, createReadImageSnapshotter } from '@maka/storage';
import {
  persistArchivedToolResultToArtifacts,
  readArchivedToolResultFromArtifacts,
  readArchivedToolResultResourceFromArtifacts,
} from './tool-result-archive-artifacts.js';

type ArtifactStore = ReturnType<typeof createArtifactStore>;
type ReadImageSnapshotter = ReturnType<typeof createReadImageSnapshotter>;

export interface ToolArtifactPersistenceDeps {
  artifactStore: ArtifactStore;
  storeReadImage: ReadImageSnapshotter;
  safeSendToRenderer: (channel: string, ...args: unknown[]) => void;
}

export interface ToolArtifactPersistence {
  persistToolArtifacts(cwd: string, event: ToolArtifactRecorderInput): Promise<void>;
  snapshotReadImage(input: {
    sessionId: string;
    turnId: string;
    name: string;
    bytes: Uint8Array;
    mimeType: string;
  }): Promise<Awaited<ReturnType<ReadImageSnapshotter>>>;
  persistArchivedToolResult(event: ToolResultArchiveRecorderInput): Promise<{ artifactId: string }>;
  readArchivedToolResult(event: ToolResultArchiveReaderInput): Promise<ToolResultArchiveReadResult>;
  readArchivedToolResultResource(
    event: ToolResultArchiveResourceReadInput,
  ): Promise<ToolResultArchiveReadResult>;
}

function isInsideOrSamePath(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && rel !== '..' && !rel.includes(`..${sep}`) && !rel.startsWith(sep);
}

async function resolveToolArtifactSourcePath(cwd: string, sourcePath: string): Promise<string | null> {
  const candidate = isAbsolute(sourcePath) ? sourcePath : resolve(cwd, sourcePath);
  let root: string;
  let target: string;
  try {
    [root, target] = await Promise.all([
      realpath(cwd),
      realpath(candidate),
    ]);
  } catch {
    return null;
  }
  return isInsideOrSamePath(root, target) ? target : null;
}

export function createToolArtifactPersistence(deps: ToolArtifactPersistenceDeps): ToolArtifactPersistence {
  const { artifactStore, storeReadImage, safeSendToRenderer } = deps;

  async function persistToolArtifacts(cwd: string, event: ToolArtifactRecorderInput): Promise<void> {
    for (const candidate of event.candidates) {
      let content = candidate.content;
      if (content === undefined && candidate.sourcePath) {
        const sourcePath = await resolveToolArtifactSourcePath(cwd, candidate.sourcePath);
        if (!sourcePath) continue;
        content = await readFile(sourcePath);
      }
      if (content === undefined) continue;
      const artifact = await artifactStore.create({
        sessionId: event.sessionId,
        turnId: event.turnId,
        name: candidate.name,
        kind: candidate.kind,
        content,
        ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
        source: candidate.source ?? 'tool_result',
        ...(candidate.summary ? { summary: candidate.summary } : {}),
      });
      safeSendToRenderer('artifacts:changed', {
        reason: 'created',
        artifactId: artifact.id,
        sessionId: artifact.sessionId,
        ts: Date.now(),
      });
    }
  }

  async function snapshotReadImage(input: {
    sessionId: string;
    turnId: string;
    name: string;
    bytes: Uint8Array;
    mimeType: string;
  }) {
    const ref = await storeReadImage(input);
    safeSendToRenderer('artifacts:changed', {
      reason: 'created',
      artifactId: ref.relativePath,
      sessionId: ref.sessionId,
      ts: Date.now(),
    });
    return ref;
  }

  async function persistArchivedToolResult(
    event: ToolResultArchiveRecorderInput,
  ): Promise<{ artifactId: string }> {
    const result = await persistArchivedToolResultToArtifacts(artifactStore, event);
    if (result.created) {
      safeSendToRenderer('artifacts:changed', {
        reason: 'created',
        artifactId: result.artifactId,
        sessionId: event.sessionId,
        ts: Date.now(),
      });
    }
    return { artifactId: result.artifactId };
  }

  async function readArchivedToolResult(
    event: ToolResultArchiveReaderInput,
  ): Promise<ToolResultArchiveReadResult> {
    return readArchivedToolResultFromArtifacts(artifactStore, event);
  }

  async function readArchivedToolResultResource(
    event: ToolResultArchiveResourceReadInput,
  ): Promise<ToolResultArchiveReadResult> {
    return readArchivedToolResultResourceFromArtifacts(artifactStore, event);
  }

  return {
    persistToolArtifacts,
    snapshotReadImage,
    persistArchivedToolResult,
    readArchivedToolResult,
    readArchivedToolResultResource,
  };
}
