import type { IpcMain } from 'electron';
import type { UsageRange } from '@maka/core';
import { tryResult } from '@maka/core/result';
import {
  normalizePricingConfig,
  normalizePricingModelKey,
} from '@maka/core/usage-stats/pricing';
import type { UsageGroupBy, UsageQuery } from '@maka/core/usage-stats/types';
import { resolveUsageRange } from '@maka/core/model-call-usage-projection';
import {
  mergeUsageBuckets,
  mergeUsageLogs,
  mergeUsageSummary,
  type CanonicalUsageSource,
} from '@maka/core/usage-ledger-merge';
import type { createSettingsStore, createSqliteModelCallLedger, TelemetryRepo } from '@maka/storage';
import type { createMainWindowController } from './main-window.js';

type SettingsStore = ReturnType<typeof createSettingsStore>;
type ModelCallLedger = ReturnType<typeof createSqliteModelCallLedger>;
type MainWindowController = ReturnType<typeof createMainWindowController>;

export interface UsageIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  settingsStore: SettingsStore;
  telemetryRepo: TelemetryRepo;
  modelCallLedger: ModelCallLedger;
  ensureUsageReady: () => Promise<void>;
  refreshPricingLookup: () => void;
  sendToRenderer: MainWindowController['send'];
}

export function registerUsageIpc(deps: UsageIpcDeps): void {
  /**
   * Usage answers sum two sources (#1679): the canonical model-call ledger and
   * the frozen `LlmCallRecord` table, which still receives the compaction calls
   * that have not been routed through the canonical seam yet. Every merged
   * result carries the provenance that qualifies it.
   */
  const canonicalUsage = (query: UsageQuery, now: number): CanonicalUsageSource => {
    const page = deps.modelCallLedger.read(resolveUsageRange(query.range, now));
    return { attempts: page.attempts, unreadableRecords: page.unreadableRecords };
  };
  let pricingMutationQueue: Promise<void> = Promise.resolve();
  const enqueuePricingMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pricingMutationQueue.then(operation);
    pricingMutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  deps.ipcMain.handle('settings:usageStats', (_event, range?: UsageRange) =>
    deps.settingsStore.usageStats(range),
  );
  deps.ipcMain.handle('usage:summary', (_event, query: UsageQuery) =>
    tryResult(async () => {
      await deps.ensureUsageReady();
      const now = Date.now();
      return mergeUsageSummary(deps.telemetryRepo.summary(query), canonicalUsage(query, now), query, now);
    }, 'USAGE_SUMMARY_FAILED'),
  );
  deps.ipcMain.handle('usage:buckets', (_event, query: UsageQuery & { groupBy: UsageGroupBy }) =>
    tryResult(async () => {
      await deps.ensureUsageReady();
      const now = Date.now();
      // Tool buckets group tool invocations, which the model-call ledger does
      // not describe. The per-key breakdown returns the bare array it always
      // has; the provenance qualifying it comes from `usage:summary` for the
      // same query.
      if (query.groupBy === 'tool') return deps.telemetryRepo.buckets(query, 'tool');
      return mergeUsageBuckets(
        deps.telemetryRepo.buckets(query, query.groupBy),
        canonicalUsage(query, now),
        query,
        query.groupBy,
        now,
      ).buckets;
    }, 'USAGE_BUCKETS_FAILED'),
  );
  deps.ipcMain.handle(
    'usage:logs',
    (_event, query: UsageQuery & { offset?: number; limit?: number }) =>
      tryResult(async () => {
        await deps.ensureUsageReady();
        const now = Date.now();
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 100;
        // Both sources are newest-first, so the merged page can only be drawn
        // from each source's own first `offset + limit` rows.
        return mergeUsageLogs(
          deps.telemetryRepo.logs(query, 0, offset + limit),
          canonicalUsage(query, now),
          query,
          now,
          offset,
          limit,
        );
      }, 'USAGE_LOGS_FAILED'),
  );
  deps.ipcMain.handle('usage:pricing:list', () =>
    tryResult(async () => {
      await deps.ensureUsageReady();
      return deps.telemetryRepo.listPricingOverrides();
    }, 'USAGE_PRICING_LIST_FAILED'),
  );
  deps.ipcMain.handle('usage:pricing:put', (_event, pricing: unknown) =>
    tryResult(
      () =>
        enqueuePricingMutation(async () => {
          await deps.ensureUsageReady();
          const normalized = normalizePricingConfig(pricing);
          if (!normalized.ok) throw new Error(normalized.error);
          await deps.telemetryRepo.upsertPricing(normalized.value);
          deps.refreshPricingLookup();
          deps.sendToRenderer('usage:pricing:changed');
          return normalized.value;
        }),
      'USAGE_PRICING_PUT_FAILED',
    ),
  );
  deps.ipcMain.handle('usage:pricing:reset', (_event, modelKey: unknown) =>
    tryResult(
      () =>
        enqueuePricingMutation(async () => {
          await deps.ensureUsageReady();
          const keyResult = normalizePricingModelKey(modelKey);
          if (!keyResult.ok) throw new Error(keyResult.error);
          await deps.telemetryRepo.deletePricing(keyResult.value);
          deps.refreshPricingLookup();
          deps.sendToRenderer('usage:pricing:changed');
        }),
      'USAGE_PRICING_RESET_FAILED',
    ),
  );
}
