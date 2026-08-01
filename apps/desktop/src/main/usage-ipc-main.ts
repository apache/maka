import type { IpcMain } from 'electron';
import type { UsageRange } from '@maka/core';
import { tryResult } from '@maka/core/result';
import {
  normalizePricingConfig,
  normalizePricingModelKey,
} from '@maka/core/usage-stats/pricing';
import type { UsageGroupBy, UsageQuery } from '@maka/core/usage-stats/types';
import type { createSettingsStore, TelemetryRepo } from '@maka/storage';
import type { createMainWindowController } from './main-window.js';

type SettingsStore = ReturnType<typeof createSettingsStore>;
type MainWindowController = ReturnType<typeof createMainWindowController>;

export interface UsageIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  settingsStore: SettingsStore;
  telemetryRepo: TelemetryRepo;
  ensureUsageReady: () => Promise<void>;
  refreshPricingLookup: () => void;
  sendToRenderer: MainWindowController['send'];
}

export function registerUsageIpc(deps: UsageIpcDeps): void {
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
      return deps.telemetryRepo.summary(query);
    }, 'USAGE_SUMMARY_FAILED'),
  );
  deps.ipcMain.handle('usage:buckets', (_event, query: UsageQuery & { groupBy: UsageGroupBy }) =>
    tryResult(async () => {
      await deps.ensureUsageReady();
      return deps.telemetryRepo.buckets(query, query.groupBy);
    }, 'USAGE_BUCKETS_FAILED'),
  );
  deps.ipcMain.handle(
    'usage:logs',
    (_event, query: UsageQuery & { offset?: number; limit?: number }) =>
      tryResult(async () => {
        await deps.ensureUsageReady();
        return deps.telemetryRepo.logs(query, query.offset, query.limit);
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
