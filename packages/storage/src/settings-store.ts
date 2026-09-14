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

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppSettings, UpdateAppSettingsInput } from '@maka/core/settings';
import type { OnboardingMilestone, OnboardingMilestoneId } from '@maka/core/onboarding';
import { createDefaultSettings, mergeSettings, normalizeSettings } from '@maka/core/settings';
import { sanitizeOnboardingMilestones } from '@maka/core/onboarding';
import { AtomicFileWriteCommitUnknownError, writeAtomicFile } from './atomic-file-write.js';
import { syncDirectory } from './stable-storage.js';

export interface CorruptSettingsRecovery {
  readonly settingsPath: string;
  readonly backupPath: string;
  readonly outcome: 'recovered' | 'commit-unknown';
}

export interface SettingsStoreOptions {
  /** Observes publication, not delivery of a notification. Never awaited while
   * holding the store queue; callback failures cannot change the write result. */
  onCorruptRecovery?: (recovery: CorruptSettingsRecovery) => void | Promise<void>;
}

export class SettingsRecoveryError extends Error {
  readonly settingsPath: string;
  readonly phase: 'backup' | 'reset';
  /** Present only when a complete backup passed its synchronization steps. */
  readonly backupPath?: string;
  /** A file this attempt created but could not finish or remove. */
  readonly incompleteBackupPath?: string;

  constructor(options: {
    settingsPath: string;
    phase: 'backup' | 'reset';
    backupPath?: string;
    incompleteBackupPath?: string;
    cause: unknown;
  }) {
    const detail = options.backupPath
      ? `Original bytes are backed up at ${options.backupPath}.`
      : 'No complete backup was confirmed.';
    super(
      `Cannot recover invalid JSON settings at ${options.settingsPath}: ${options.phase} failed. ` +
        `The original settings file was not replaced. ${detail}` +
        (options.incompleteBackupPath
          ? ` An incomplete backup may remain at ${options.incompleteBackupPath}.`
          : '') +
        ' Close the app and check file access and disk space before retrying.',
      { cause: options.cause },
    );
    this.name = 'SettingsRecoveryError';
    this.settingsPath = options.settingsPath;
    this.phase = options.phase;
    this.backupPath = options.backupPath;
    this.incompleteBackupPath = options.incompleteBackupPath;
  }
}

export class SettingsRecoveryCommitUnknownError extends AtomicFileWriteCommitUnknownError {
  constructor(
    readonly settingsPath: string,
    readonly backupPath: string,
    cause: AtomicFileWriteCommitUnknownError,
  ) {
    super({ cause });
    this.name = 'SettingsRecoveryCommitUnknownError';
    this.message =
      `Default settings were published at ${settingsPath}, but durability is unconfirmed. ` +
      `Original bytes are backed up at ${backupPath}. Reload before retrying; do not replay the update automatically.`;
  }
}

/**
 * A conditional write's patch, either fixed or derived from the state the
 * predicate just accepted.
 *
 * The function form exists so a caller that has to touch several fields, but
 * only the ones that actually matched, can still do it in ONE queued write.
 * Splitting that into two conditional updates makes a failure of the second
 * leave the first committed — a partial write that the caller then reports as
 * an error, with the persisted state and the live state disagreeing.
 */
export type ConditionalSettingsPatch =
  | UpdateAppSettingsInput
  | ((current: AppSettings) => UpdateAppSettingsInput);

export interface SettingsStore {
  get(): Promise<AppSettings>;
  update(patch: UpdateAppSettingsInput): Promise<AppSettings>;
  updateIf(
    predicate: (current: AppSettings) => boolean,
    patch: ConditionalSettingsPatch,
  ): Promise<{ applied: boolean; settings: AppSettings }>;
  /**
   * PR110b: upsert a single onboarding milestone. Caller passes the
   * desired terminal status; the store stamps `Date.now()` so the
   * renderer cannot tamper with timestamps. Returns the freshly
   * sanitized milestone list. Last-valid-entry-wins dedup applies.
   *
   * @throws if `id` is not in `OnboardingMilestoneId` or status is
   *         not 'completed' | 'skipped'.
   */
  upsertOnboardingMilestone(
    id: OnboardingMilestoneId,
    status: 'completed' | 'skipped',
  ): Promise<OnboardingMilestone[]>;
  /**
   * Remove one milestone entry without disturbing the rest. Used for
   * reversible first-run suggestion dismissal; it still flows through
   * the closed enum so arbitrary renderer strings cannot reshape the
   * onboarding settings section.
   */
  clearOnboardingMilestone(id: OnboardingMilestoneId): Promise<OnboardingMilestone[]>;
}

export function createSettingsStore(
  workspaceRoot: string,
  options: SettingsStoreOptions = {},
): SettingsStore {
  return new FileSettingsStore(workspaceRoot, options);
}

class FileSettingsStore implements SettingsStore {
  private readonly settingsPath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    workspaceRoot: string,
    private readonly options: SettingsStoreOptions,
  ) {
    this.settingsPath = join(workspaceRoot, 'settings.json');
  }

  async get(): Promise<AppSettings> {
    let settings: AppSettings | undefined;
    await this.withQueue(async () => {
      settings = await this.readOrCreate();
    });
    if (!settings) throw new Error('Failed to read settings');
    return settings;
  }

  private async readOrCreate(): Promise<AppSettings> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.settingsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const settings = createDefaultSettings();
      await this.write(settings);
      return settings;
    }

    let persisted: unknown;
    try {
      persisted = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Never attach the parse error: its message can quote stored secrets.
      return this.recoverCorruptSettings(bytes);
    }
    const settings = normalizeSettings(persisted);
    if (hasLegacyProxyCredentialFields(persisted)) {
      await this.write(settings);
    }
    return settings;
  }

  private async recoverCorruptSettings(bytes: Buffer): Promise<AppSettings> {
    const backupPath = await this.backupCorruptSettings(bytes);
    const settings = createDefaultSettings();
    try {
      await this.write(settings);
    } catch (error) {
      if (error instanceof AtomicFileWriteCommitUnknownError) {
        this.reportRecovery(backupPath, 'commit-unknown');
        throw new SettingsRecoveryCommitUnknownError(this.settingsPath, backupPath, error);
      }
      throw new SettingsRecoveryError({
        settingsPath: this.settingsPath,
        phase: 'reset',
        backupPath,
        cause: error,
      });
    }
    this.reportRecovery(backupPath, 'recovered');
    return settings;
  }

  /** An exclusive byte-for-byte backup, completed before replacing settings.
   * Keeping the source in place avoids turning a failed recovery into ENOENT.
   * This has the same platform fsync limits as the shared atomic writer. */
  private async backupCorruptSettings(bytes: Buffer): Promise<string> {
    const backupPath = `${this.settingsPath}.corrupt-${Date.now()}-${randomUUID()}`;
    let created = false;
    try {
      const handle = await open(backupPath, 'wx', 0o600);
      created = true;
      try {
        await handle.writeFile(bytes);
        if (process.platform !== 'win32') await handle.chmod(0o600);
        await handle.sync();
        await handle.close();
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
      await syncDirectory(dirname(this.settingsPath));
      return backupPath;
    } catch (error) {
      let incompleteBackupPath: string | undefined;
      if (created) {
        await rm(backupPath, { force: true }).catch(() => {
          incompleteBackupPath = backupPath;
        });
      }
      throw new SettingsRecoveryError({
        settingsPath: this.settingsPath,
        phase: 'backup',
        incompleteBackupPath,
        cause: error,
      });
    }
  }

  private reportRecovery(backupPath: string, outcome: CorruptSettingsRecovery['outcome']): void {
    try {
      void Promise.resolve(
        this.options.onCorruptRecovery?.({
          settingsPath: this.settingsPath,
          backupPath,
          outcome,
        }),
      ).catch(() => {});
    } catch {
      // Notification failure must not undo or misclassify a published reset.
    }
  }

  async update(patch: UpdateAppSettingsInput): Promise<AppSettings> {
    let next: AppSettings | undefined;
    await this.withQueue(async () => {
      const current = await this.readOrCreate();
      next = mergeSettings(current, patch);
      await this.write(next);
    });
    if (!next) throw new Error('Failed to update settings');
    return next;
  }

  async updateIf(
    predicate: (current: AppSettings) => boolean,
    patch: ConditionalSettingsPatch,
  ): Promise<{ applied: boolean; settings: AppSettings }> {
    let result: { applied: boolean; settings: AppSettings } | undefined;
    await this.withQueue(async () => {
      const current = await this.readOrCreate();
      if (!predicate(current)) {
        result = { applied: false, settings: current };
        return;
      }
      const next = mergeSettings(current, typeof patch === 'function' ? patch(current) : patch);
      await this.write(next);
      result = { applied: true, settings: next };
    });
    if (!result) throw new Error('Failed to conditionally update settings');
    return result;
  }

  async upsertOnboardingMilestone(
    id: OnboardingMilestoneId,
    status: 'completed' | 'skipped',
  ): Promise<OnboardingMilestone[]> {
    if (status !== 'completed' && status !== 'skipped') {
      throw new Error(`invalid onboarding milestone status: ${String(status)}`);
    }
    const timestamp = Date.now();
    const next: OnboardingMilestone =
      status === 'completed' ? { id, completedAt: timestamp } : { id, skippedAt: timestamp };
    let result: OnboardingMilestone[] | undefined;
    await this.withQueue(async () => {
      const current = await this.readOrCreate();
      // Append the new entry; sanitize() applies last-valid-entry-wins
      // dedup with stable first-seen position. ID validity is enforced
      // by the sanitizer (closed enum).
      const sanitized = sanitizeOnboardingMilestones([...current.onboarding.milestones, next]);
      if (!sanitized.some((entry) => entry.id === id)) {
        // ID was rejected by the validator — propagate so the IPC
        // handler can reject the caller's input.
        throw new Error(`invalid onboarding milestone id: ${String(id)}`);
      }
      const merged: AppSettings = {
        ...current,
        onboarding: { milestones: sanitized },
      };
      await this.write(merged);
      result = sanitized;
    });
    if (!result) throw new Error('Failed to upsert onboarding milestone');
    return result;
  }

  async clearOnboardingMilestone(id: OnboardingMilestoneId): Promise<OnboardingMilestone[]> {
    let result: OnboardingMilestone[] | undefined;
    await this.withQueue(async () => {
      const current = await this.readOrCreate();
      const knownId = sanitizeOnboardingMilestones([{ id }]).some((entry) => entry.id === id);
      if (!knownId) {
        throw new Error(`invalid onboarding milestone id: ${String(id)}`);
      }
      const milestones = current.onboarding.milestones.filter((entry) => entry.id !== id);
      const merged: AppSettings = {
        ...current,
        onboarding: { milestones },
      };
      await this.write(merged);
      result = milestones;
    });
    if (!result) throw new Error('Failed to clear onboarding milestone');
    return result;
  }

  private async write(settings: AppSettings): Promise<void> {
    // SettingsStore does not own the workspace directory's permission policy:
    // sibling stores such as MCP config may independently harden the same root.
    // Keep both directory creation and the historical umask-derived file mode.
    await mkdir(dirname(this.settingsPath), { recursive: true });
    await writeAtomicFile(this.settingsPath, JSON.stringify(settings, null, 2) + '\n', {
      fileMode: 0o666 & ~process.umask(),
    });
  }

  private withQueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
}

function hasLegacyProxyCredentialFields(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.network) || !isRecord(value.network.proxy)) {
    return false;
  }
  const proxy = value.network.proxy;
  return ['password', 'passwordConfigured', 'credential'].some((key) =>
    Object.prototype.hasOwnProperty.call(proxy, key),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
