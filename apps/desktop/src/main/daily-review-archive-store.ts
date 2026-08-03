import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DEFAULT_DAILY_REVIEW_CONFIG,
  dailyReviewArchiveToSummary,
  normalizeDailyReviewArchive,
  normalizeDailyReviewConfig,
  type DailyReviewArchive,
  type DailyReviewArchiveSummary,
  type DailyReviewConfig,
} from '@maka/core';

const ARCHIVE_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-(1d|7d|30d)$/;
const READABLE_ARCHIVE_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-(1d|7d|30d|daily|deep)$/;

export interface DailyReviewArchiveStore {
  getConfig(): Promise<DailyReviewConfig>;
  setConfig(patch: Partial<DailyReviewConfig>): Promise<DailyReviewConfig>;
  putArchive(archive: DailyReviewArchive): Promise<DailyReviewArchive>;
  listArchives(): Promise<DailyReviewArchiveSummary[]>;
  getArchive(id: string): Promise<DailyReviewArchive | null>;
  deleteArchive(id: string): Promise<void>;
  prune(maxArchives: number): Promise<void>;
}

export function createDailyReviewArchiveStore(workspaceRoot: string): DailyReviewArchiveStore {
  return new FileDailyReviewArchiveStore(workspaceRoot);
}

class FileDailyReviewArchiveStore implements DailyReviewArchiveStore {
  private readonly root: string;
  private readonly archiveRoot: string;
  private readonly configPath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.root = join(workspaceRoot, 'daily-reviews');
    this.archiveRoot = join(this.root, 'archive');
    this.configPath = join(this.root, 'config.json');
  }

  async getConfig(): Promise<DailyReviewConfig> {
    try {
      const raw = await readFile(this.configPath, 'utf8');
      return normalizeDailyReviewConfig(JSON.parse(raw) as Partial<DailyReviewConfig>);
    } catch (error) {
      if (isNotFound(error)) return DEFAULT_DAILY_REVIEW_CONFIG;
      throw error;
    }
  }

  async setConfig(patch: Partial<DailyReviewConfig>): Promise<DailyReviewConfig> {
    let next = DEFAULT_DAILY_REVIEW_CONFIG;
    await this.withQueue(async () => {
      const current = await this.getConfig();
      next = normalizeDailyReviewConfig({
        ...current,
        ...patch,
      });
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await writeJsonAtomically(this.configPath, next);
    });
    return next;
  }

  async putArchive(archive: DailyReviewArchive): Promise<DailyReviewArchive> {
    assertArchiveId(archive.id);
    await this.withQueue(async () => {
      await mkdir(this.archiveRoot, { recursive: true, mode: 0o700 });
      await writeJsonAtomically(this.archivePath(archive.id), archive);
    });
    return archive;
  }

  async listArchives(): Promise<DailyReviewArchiveSummary[]> {
    const archives: DailyReviewArchiveSummary[] = [];
    for (const id of await this.listArchiveIds()) {
      const archive = await this.getArchive(id);
      if (archive) archives.push(dailyReviewArchiveToSummary(archive));
    }
    archives.sort((a, b) => b.generatedAt - a.generatedAt || b.day.fromMs - a.day.fromMs || a.id.localeCompare(b.id));
    return archives;
  }

  async getArchive(id: string): Promise<DailyReviewArchive | null> {
    assertReadableArchiveId(id);
    let raw: string;
    try {
      raw = await readFile(this.archivePath(id), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    try {
      const archive = normalizeDailyReviewArchive(JSON.parse(raw));
      if (archive.id !== id) throw new Error(`Daily Review archive id mismatch: ${id}`);
      return archive;
    } catch {
      return null;
    }
  }

  async deleteArchive(id: string): Promise<void> {
    assertReadableArchiveId(id);
    await rm(this.archivePath(id), { force: true });
  }

  async prune(maxArchives: number): Promise<void> {
    const limit = Math.max(0, Math.trunc(maxArchives));
    if (limit === 0) return;
    const archives = await this.listArchives();
    for (const archive of archives.slice(limit)) {
      await this.deleteArchive(archive.id);
    }
  }

  private async listArchiveIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.archiveRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -'.json'.length))
        .filter((id) => READABLE_ARCHIVE_ID_PATTERN.test(id));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private archivePath(id: string): string {
    assertReadableArchiveId(id);
    return join(this.archiveRoot, `${id}.json`);
  }

  private async withQueue<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporaryPath, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await file?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function assertReadableArchiveId(id: string): void {
  if (!READABLE_ARCHIVE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid Daily Review archive id: ${id}`);
  }
}

function assertArchiveId(id: string): void {
  if (!ARCHIVE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid Daily Review archive id: ${id}`);
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
