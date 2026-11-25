/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import type { Output } from './host';
import { fileURLToPath } from 'url';

export type DossiersSnapshot = Output<'agent', 'watchDossiers'>;
export type DossierSummary = DossiersSnapshot['dossiers'][number];
export type DossierDetail = NonNullable<Output<'agent', 'dossier'>>;
export type DossierSortMode = 'recent' | 'priority';

export type DossierChoiceItem = {
  key: string;
  label: string;
  detail?: string;
  recommended?: boolean;
  resolves?: boolean;
  instruction: string;
};

export type DossierRevisionItem = {
  revision: number;
  at: number;
  title: string;
  signal: DossierSummary['signal'];
  summaryMd: string;
  changeNote?: string | null;
  artifacts?: DossierDetail['artifacts'];
  choices?: DossierChoiceItem[];
  chosenKey?: string | null;
};

export type DossierThreadTurn = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at?: number;
  live?: boolean;
};

export type DossierStreamEntry =
  | {
      kind: 'revision';
      key: string;
      revision: DossierRevisionItem;
      index: number;
      totalRevisions: number;
      isLatest: boolean;
      isHistorical: boolean;
      choices: DossierChoiceItem[];
    }
  | {
      kind: 'turn';
      key: string;
      turn: DossierThreadTurn;
      isHistorical: boolean;
    };

const CJK_RE = /[\u4e00-\u9fff]/;
const RESOLVES_RE = /(?:关掉|关闭|放弃|忽略|不再提|归档|结案|close|dismiss|archive|resolve)/i;
const CHOICE_BULLET_RE = /^(?:[-*•]\s+)(?:\*\*)?([A-D])(?:\*\*)?(?:[\s.:：·）)]+)(.+)$/;

export function sortDossiers(
  rows: readonly DossierSummary[],
  mode: DossierSortMode = 'recent',
): DossierSummary[] {
  if (mode === 'priority') return [...rows];
  return [...rows].sort((a, b) => {
    const aDone = a.signal === 'done' ? 1 : 0;
    const bDone = b.signal === 'done' ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    return b.lastMaterialChangeAt - a.lastMaterialChangeAt;
  });
}

export function extractFallbackChoices(summaryMd: string): DossierChoiceItem[] {
  const found: DossierChoiceItem[] = [];
  const expectedKeys = ['A', 'B', 'C', 'D'];
  for (const rawLine of summaryMd.split('\n')) {
    const match = CHOICE_BULLET_RE.exec(rawLine.trim());
    if (!match) {
      if (found.length >= 2) break;
      continue;
    }
    const key = match[1]!;
    if (key !== expectedKeys[found.length]) {
      if (found.length >= 2) break;
      found.length = 0;
      if (key !== 'A') continue;
    }
    const content = match[2]!.replace(/\*\*/g, '').trim();
    const colon = content.search(/[：:]\s*/);
    let label = content;
    let detail = '';
    if (colon > 0 && colon <= 48) {
      label = content.slice(0, colon).trim();
      detail = content
        .slice(colon + 1)
        .replace(/^\s+/, '')
        .trim();
    } else if (content.length > 48) {
      label = content.slice(0, 44).trim() + '…';
      detail = content;
    }
    const isCjk = CJK_RE.test(content);
    const resolves = RESOLVES_RE.test(content);
    found.push({
      key,
      label,
      detail,
      recommended: false,
      resolves,
      instruction: isCjk
        ? resolves
          ? `选 ${key}（${label}）：关闭此档案，后续不再提醒。`
          : `选 ${key}（${label}）：按这个方案执行。`
        : resolves
          ? `Choose ${key} (${label}): close this dossier and do not raise it again.`
          : `Choose ${key} (${label}): proceed with this option.`,
    });
  }
  return found.length >= 2 ? found : [];
}

export function formatChoiceDispatch(choice: DossierChoiceItem): string {
  const base = choice.instruction.trim();
  if (!choice.resolves) return base;
  const isCjk = CJK_RE.test(base) || CJK_RE.test(choice.label);
  return isCjk
    ? `${base}\n\n（说明：该档案已由用户一键关闭并标记为已解决。只需调用 UpdateDiscoveryPreferences 记下这条偏好并一句话确认，不要扫描仓库、运行脚本或查找档案数据库。）`
    : `${base}\n\n(Note: This dossier has already been closed and marked resolved by the user. Just record the preference with UpdateDiscoveryPreferences and reply with a one-line confirmation—do not scan the workspace, run scripts, or look up dossier storage.)`;
}

export function buildDossierStream(
  detail: DossierDetail & { revisions?: readonly DossierRevisionItem[] },
  turns: readonly DossierThreadTurn[],
): { entries: DossierStreamEntry[]; latestRevisionIndex: number; hasHistory: boolean } {
  const rawRevisions: readonly DossierRevisionItem[] =
    detail.revisions && detail.revisions.length > 0
      ? detail.revisions
      : [
          {
            revision: detail.revision,
            at: detail.lastMaterialChangeAt,
            title: detail.title,
            signal: detail.signal,
            summaryMd: detail.summaryMd,
            changeNote: null,
            artifacts: detail.artifacts,
            choices: [],
            chosenKey: null,
          },
        ];
  const revisions = [...rawRevisions].sort((a, b) => a.revision - b.revision);
  const items: DossierStreamEntry[] = [];
  let turnIdx = 0;
  let latestRevisionIndex = 0;

  for (let i = 0; i < revisions.length; i += 1) {
    const rev = revisions[i]!;
    const isLatest = i === revisions.length - 1;
    // Place any timestamped turns that occurred strictly before this revision ahead of it.
    if (i > 0) {
      while (turnIdx < turns.length) {
        const turn = turns[turnIdx]!;
        if (turn.at === undefined || turn.at >= rev.at) break;
        items.push({ kind: 'turn', key: `turn:${turn.id}`, turn, isHistorical: true });
        turnIdx += 1;
      }
    }
    if (isLatest) latestRevisionIndex = items.length;
    const choices =
      rev.choices && rev.choices.length > 0
        ? rev.choices
        : isLatest
          ? extractFallbackChoices(rev.summaryMd)
          : [];
    items.push({
      kind: 'revision',
      key: `rev:${rev.revision}`,
      revision: rev,
      index: i,
      totalRevisions: revisions.length,
      isLatest,
      isHistorical: !isLatest,
      choices,
    });
  }
  while (turnIdx < turns.length) {
    const turn = turns[turnIdx]!;
    items.push({ kind: 'turn', key: `turn:${turn.id}`, turn, isHistorical: false });
    turnIdx += 1;
  }
  return { entries: items, latestRevisionIndex, hasHistory: latestRevisionIndex > 0 };
}

type RelativeTimeKey =
  | 'Dossier just now'
  | 'Dossier minutes ago'
  | 'Dossier hours ago'
  | 'Dossier yesterday';

const FALLBACK_RELATIVE_TIME: Record<RelativeTimeKey, readonly [string, string, string]> = {
  'Dossier just now': ['Just now', '刚刚', '剛剛'],
  'Dossier minutes ago': ['{count}m', '{count} 分钟前', '{count} 分鐘前'],
  'Dossier hours ago': ['{count}h', '{count} 小时前', '{count} 小時前'],
  'Dossier yesterday': ['Yesterday', '昨天', '昨天'],
};

function fallbackRelativeTime(locale: string, key: RelativeTimeKey, count?: number): string {
  const lower = locale.toLowerCase();
  const idx =
    lower.startsWith('zh') &&
    (lower.includes('tw') || lower.includes('hk') || lower.includes('hant'))
      ? 2
      : lower.startsWith('zh')
        ? 1
        : 0;
  const template = FALLBACK_RELATIVE_TIME[key][idx];
  return count === undefined ? template : template.replace('{count}', String(count));
}

export function formatRelativeTime(
  at: number,
  now: number,
  locale: string,
  translate?: (key: RelativeTimeKey, values?: Readonly<Record<string, string | number>>) => string,
): string {
  const label = (key: RelativeTimeKey, count?: number) =>
    translate
      ? translate(key, count === undefined ? undefined : { count })
      : fallbackRelativeTime(locale, key, count);
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return label('Dossier just now');
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (at >= today.getTime()) {
    const hours = Math.floor(minutes / 60);
    return hours ? label('Dossier hours ago', hours) : label('Dossier minutes ago', minutes);
  }
  const date = new Date(at);
  const sameYear = date.getFullYear() === today.getFullYear();
  today.setDate(today.getDate() - 1);
  if (at >= today.getTime()) return label('Dossier yesterday');
  return date.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

export function splitArtifactPath(path: string): { name: string; dir: string } {
  const start = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
  return { name: path.slice(start), dir: path.slice(0, start) };
}

export function leadFilePaths(uris: readonly string[], previous: readonly string[] = []): string[] {
  return [...new Set([...previous, ...uris.map((uri) => fileURLToPath(uri))])];
}

export type DossierSelection = { topicId: string; requested?: true } | null;

export function pinDossier(
  dossiers: readonly DossierSummary[],
  selection: DossierSelection,
): DossierSelection {
  if (selection && dossiers.some((row) => row.topicId === selection.topicId))
    return selection.requested ? { topicId: selection.topicId } : selection;
  // A lead receipt or notification can arrive before the corresponding list snapshot.
  if (selection?.requested) return selection;
  return dossiers.length ? { topicId: dossiers[0]!.topicId } : null;
}

export const discoveryTag = (topicId: string) => `discovery:${topicId}`;
export function notificationTarget(tag: unknown) {
  if (typeof tag !== 'string' || !tag) return null;
  if (!tag.startsWith('discovery:')) return { kind: 'session' as const, id: tag };
  const id = tag.slice('discovery:'.length);
  return id ? { kind: 'discovery' as const, id } : null;
}

export type DossierNotification = { tag: string; title: string; body: string };

export function dossierInterrupt(
  seen: ReadonlyMap<string, number> | null,
  snapshot: DossiersSnapshot,
) {
  const next = new Map(seen);
  const notifications: DossierNotification[] = [];
  for (const row of snapshot.dossiers) {
    if (row.lastNotifiedRevision <= (next.get(row.topicId) ?? 0)) continue;
    next.set(row.topicId, row.lastNotifiedRevision);
    if (seen && snapshot.notificationsEnabled && !row.muted && row.lastInterruptAt != null) {
      notifications.push({
        tag: discoveryTag(row.topicId),
        title: row.title,
        body: row.lastInterruptReason ?? '',
      });
    }
  }
  return { seen: next, notifications };
}

type PendingAction = DossierDetail['pendingActions'][number];

export function pendingActionControls(
  action: Pick<PendingAction, 'status' | 'receipt'>,
  busy = false,
) {
  const awaiting = action.status === 'awaiting_confirm';
  const stale = action.status === 'stale';
  const showButtons = awaiting || stale;
  const receipt = action.receipt;
  const reason =
    receipt && typeof receipt === 'object' && 'reason' in receipt ? receipt.reason : null;
  const notice = stale
    ? reason === 'expired'
      ? 'Dossier action expired'
      : reason === 'watch' || reason === 'authorization_unavailable'
        ? 'Dossier action stale'
        : 'Dossier source changed'
    : action.status === 'unknown_pending_receipt'
      ? 'Dossier check receipt'
      : null;
  return {
    showButtons,
    confirm: awaiting && !busy,
    dismiss: showButtons && !busy,
    notice,
  } as const;
}
