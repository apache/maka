import type { DiffReport } from '@ggbdpq/diffmap-core/web';

export type ReviewStatus = 'unseen' | 'seen' | 'pass' | 'question';

const PREFIX = 'diffmap:v2:';

/** SHA 变化时整个变更集失效；同一变更集内按文件 diff 判定。 */
export function storageKey(r: DiffReport): string {
  return PREFIX + [r.repoRoot, r.mode, r.baseSha, r.headSha].join('|');
}

export function loadStatuses(report: DiffReport): Record<string, ReviewStatus> {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(report)) ?? '{}');
    const entries: [string, ReviewStatus][] = [];
    for (const file of report.files) {
      const entry = saved[file.path];
      if (file.fingerprint && entry?.fingerprint === file.fingerprint &&
          ['unseen', 'seen', 'pass', 'question'].includes(entry.status)) {
        entries.push([file.path, entry.status]);
      }
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function saveStatuses(report: DiffReport, statuses: Record<string, ReviewStatus>): void {
  try {
    const entries = report.files.filter((f) => f.fingerprint && statuses[f.path]).map((file) => [file.path, {
      status: statuses[file.path], fingerprint: file.fingerprint,
    }]);
    localStorage.setItem(storageKey(report), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 配额满等写失败不致命 */
  }
}
