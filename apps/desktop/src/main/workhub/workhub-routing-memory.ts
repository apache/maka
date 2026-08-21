import {
  sameWorkHubWork,
  type WorkHubRoutingMemory,
  type WorkHubRouteCorrection,
  type WorkHubWorkMemory,
  type WorkHubWorkRef,
} from '@maka/core/workhub';

const RECENT_FOCUS_LIMIT = 8;
const WORK_MEMORY_LIMIT = 128;
const ALIAS_LIMIT = 12;
const ENTITY_LIMIT = 96;
const RECENT_TEXT_LIMIT = 6;
const TEXT_LENGTH_LIMIT = 1_000;
const CORRECTION_LIMIT = 32;

const STOP_ENTITIES = new Set([
  '一下', '一个', '这个', '那个', '问题', '工作', '任务', '继续', '接着', '处理',
  '检查', '修改', '更新', '实现', '完成', '逻辑', '相关', '进行', '然后', '还是',
  'the', 'this', 'that', 'work', 'task', 'continue', 'check', 'update', 'fix',
]);

export function rememberWorkRequest(
  memory: WorkHubRoutingMemory | undefined,
  identity: {
    work: WorkHubWorkRef;
    projectName: string;
    workName: string;
  },
  requestText: string,
  focusedAt: number,
): WorkHubRoutingMemory {
  const current = memory?.works.find((entry) => sameWorkHubWork(entry.work, identity.work));
  const next: WorkHubWorkMemory = {
    work: structuredClone(identity.work),
    projectName: identity.projectName,
    workName: identity.workName,
    aliases: boundedUnique([
      identity.workName,
      `${identity.projectName} / ${identity.workName}`,
      ...(current?.aliases ?? []),
    ], ALIAS_LIMIT),
    entities: boundedUnique([
      ...extractRoutingEntities(requestText),
      ...(current?.entities ?? []),
    ], ENTITY_LIMIT),
    recentRequests: rememberText(current?.recentRequests ?? [], requestText),
    recentOutcomes: current?.recentOutcomes ?? [],
    lastFocusedAt: focusedAt,
    focusCount: (current?.focusCount ?? 0) + 1,
  };
  return {
    recentFocus: rememberRecentFocus(memory?.recentFocus ?? [], identity.work),
    works: [
      next,
      ...(memory?.works ?? []).filter((entry) => !sameWorkHubWork(entry.work, identity.work)),
    ].slice(0, WORK_MEMORY_LIMIT),
    corrections: memory?.corrections ?? [],
  };
}

export function rememberWorkOutcome(
  memory: WorkHubRoutingMemory | undefined,
  work: WorkHubWorkRef,
  detail: string | undefined,
): WorkHubRoutingMemory | undefined {
  const text = detail?.trim();
  if (!memory || !text) return memory;
  return {
    ...memory,
    works: memory.works.map((entry) => sameWorkHubWork(entry.work, work)
      ? {
          ...entry,
          entities: boundedUnique([
            ...extractRoutingEntities(text),
            ...entry.entities,
          ], ENTITY_LIMIT),
          recentOutcomes: rememberText(entry.recentOutcomes, text),
        }
      : entry),
  };
}

export function workMemoryFor(
  memory: WorkHubRoutingMemory | undefined,
  work: WorkHubWorkRef,
): WorkHubWorkMemory | undefined {
  return memory?.works.find((entry) => sameWorkHubWork(entry.work, work));
}

export function scoreWorkMemory(query: string, memory: WorkHubWorkMemory | undefined): number {
  if (!memory) return 0;
  const normalized = normalizeText(query);
  const aliasScore = memory.aliases.some((alias) => {
    const candidate = normalizeText(alias);
    return candidate.length >= 2 && normalized.includes(candidate);
  }) ? 44 : 0;
  const remembered = new Set(memory.entities.map(normalizeText));
  const entityScore = extractRoutingEntities(query).reduce((score, entity) => {
    if (!remembered.has(normalizeText(entity))) return score;
    return score + ([...entity].length >= 4 ? 8 : 3);
  }, 0);
  return aliasScore + Math.min(entityScore, 56);
}

export function rememberRouteCorrection(
  memory: WorkHubRoutingMemory | undefined,
  correction: WorkHubRouteCorrection,
): WorkHubRoutingMemory {
  const duplicate = (candidate: WorkHubRouteCorrection) =>
    normalizeText(candidate.query) === normalizeText(correction.query) &&
    sameWorkHubWork(candidate.from, correction.from) &&
    sameWorkHubWork(candidate.to, correction.to);
  return {
    recentFocus: memory?.recentFocus ?? [],
    works: memory?.works ?? [],
    corrections: [
      structuredClone(correction),
      ...(memory?.corrections ?? []).filter((candidate) => !duplicate(candidate)),
    ].slice(0, CORRECTION_LIMIT),
  };
}

/** Positive means learned target; negative means a previously rejected target. */
export function scoreRouteCorrection(
  query: string,
  work: WorkHubWorkRef,
  memory: WorkHubRoutingMemory | undefined,
): number {
  const queryEntities = new Set(extractRoutingEntities(query).map(normalizeText));
  let strongest = 0;
  for (const correction of memory?.corrections ?? []) {
    const exact = normalizeText(correction.query) === normalizeText(query);
    const overlap = extractRoutingEntities(correction.query)
      .map(normalizeText)
      .filter((entity) => queryEntities.has(entity)).length;
    if (!exact && overlap < 2) continue;
    const strength = exact ? 80 : Math.min(64, 24 + overlap * 4);
    if (sameWorkHubWork(correction.to, work)) strongest = Math.max(strongest, strength);
    if (sameWorkHubWork(correction.from, work)) strongest = Math.min(strongest, -strength);
  }
  return strongest;
}

export function extractRoutingEntities(text: string): string[] {
  const latin = text.toLocaleLowerCase().match(/[a-z0-9_./-]{2,}/giu) ?? [];
  const chineseRuns = text.match(/[\p{Script=Han}]{2,20}/gu) ?? [];
  const chinese = chineseRuns.flatMap((run) => {
    const characters = [...run];
    const terms: string[] = characters.length <= 8 ? [run] : [];
    for (let size = 2; size <= Math.min(6, characters.length); size += 1) {
      for (let start = 0; start + size <= characters.length; start += 1) {
        terms.push(characters.slice(start, start + size).join(''));
      }
    }
    return terms;
  });
  return boundedUnique([...latin, ...chinese]
    .map(normalizeText)
    .filter((term) => term.length >= 2 && !STOP_ENTITIES.has(term)), ENTITY_LIMIT);
}

function rememberRecentFocus(
  current: readonly WorkHubWorkRef[],
  work: WorkHubWorkRef,
): WorkHubWorkRef[] {
  return [
    structuredClone(work),
    ...current
      .filter((candidate) => !sameWorkHubWork(candidate, work))
      .map((candidate) => structuredClone(candidate)),
  ].slice(0, RECENT_FOCUS_LIMIT);
}

function rememberText(current: readonly string[], text: string): string[] {
  const normalized = text.trim().slice(0, TEXT_LENGTH_LIMIT);
  if (!normalized) return [...current];
  return [normalized, ...current.filter((candidate) => candidate !== normalized)]
    .slice(0, RECENT_TEXT_LIMIT);
}

function boundedUnique(values: readonly string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
