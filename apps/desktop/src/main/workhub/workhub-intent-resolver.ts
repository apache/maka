import type {
  WorkHubCandidate,
  WorkHubIntentDisposition,
  WorkHubIntentResolver,
} from './work-orchestrator.js';
import { sameWorkHubWork } from '@maka/core/workhub';
import {
  scoreRouteCorrection,
  scoreWorkMemory,
  workMemoryFor,
} from './workhub-routing-memory.js';
import { fallbackWorkHubTitle } from './workhub-title.js';

export function createWorkHubIntentResolver(deps: {
  defaultWorkspaceId(): string | undefined;
}): WorkHubIntentResolver {
  return async ({ text, candidates, snapshot }) => {
    const ranked = candidates
      .map((candidate) => {
        const lexicalScore = scoreCandidate(text, candidate);
        const memoryScore = scoreWorkMemory(
          text,
          workMemoryFor(snapshot.routingMemory, candidate.work),
        );
        const correctionScore = scoreRouteCorrection(text, candidate.work, snapshot.routingMemory);
        return {
          candidate,
          lexicalScore,
          memoryScore,
          correctionScore,
          score: lexicalScore + memoryScore + correctionScore,
        };
      })
      .sort((left, right) => right.score - left.score);
    const first = ranked[0];
    const second = ranked[1];
    const executable = looksExecutable(text);

    if (
      first &&
      first.correctionScore >= 24 &&
      first.score >= (second?.score ?? 0) + 12
    ) {
      return {
        kind: 'resume_work',
        candidateId: first.candidate.candidateId,
        routing: { confidence: 'high', source: 'correction' },
      };
    }

    if (
      first &&
      first.lexicalScore >= 32 &&
      first.score >= (second?.score ?? 0) + 12
    ) {
      return {
        kind: 'resume_work',
        candidateId: first.candidate.candidateId,
        routing: { confidence: 'high', source: 'name' },
      };
    }
    if (
      first &&
      first.memoryScore >= 18 &&
      first.score >= (second?.score ?? 0) + 8
    ) {
      return {
        kind: 'resume_work',
        candidateId: first.candidate.candidateId,
        routing: { confidence: 'medium', source: 'memory' },
      };
    }

    const focusHistory = snapshot.routingMemory?.recentFocus ?? (
      snapshot.workFocus ? [snapshot.workFocus] : []
    );
    const referencedFocus = looksLikePreviousWorkReference(text)
      ? focusHistory[1]
      : looksLikeCurrentWorkReference(text)
        ? focusHistory[0]
        : undefined;
    const focusedCandidate = referencedFocus
      ? candidates.find((candidate) => sameWorkHubWork(candidate.work, referencedFocus))
      : undefined;
    if (focusedCandidate) {
      return {
        kind: 'resume_work',
        candidateId: focusedCandidate.candidateId,
        routing: { confidence: 'high', source: 'focus' },
      };
    }

    if (!executable && (!first || first.score < 8)) {
      return { kind: 'discussion', routing: { confidence: 'low', source: 'semantic' } };
    }
    if (first && first.score >= 9 && first.score >= (second?.score ?? 0) + 3) {
      return {
        kind: 'resume_work',
        candidateId: first.candidate.candidateId,
        routing: { confidence: 'medium', source: 'semantic' },
      };
    }
    if (first && first.score >= 5 && second && second.score >= first.score - 2) {
      return {
        kind: 'clarify',
        candidateIds: ranked.slice(0, 4).map(({ candidate }) => candidate.candidateId),
        routing: { confidence: 'low', source: 'semantic' },
      };
    }
    if (!executable) return { kind: 'discussion', routing: { confidence: 'low', source: 'semantic' } };
    const workspaceId = deps.defaultWorkspaceId();
    if (!workspaceId) {
      return candidates.length > 0
        ? { kind: 'clarify', routing: { confidence: 'low', source: 'semantic' } }
        : { kind: 'discussion', routing: { confidence: 'low', source: 'semantic' } };
    }
    return {
      kind: 'create_work',
      workspaceId,
      title: fallbackWorkHubTitle(text),
      routing: { confidence: 'high', source: 'new_work' },
    };
  };
}

function scoreCandidate(query: string, candidate: WorkHubCandidate): number {
  const terms = salientTerms(query);
  const workName = candidate.workName.toLocaleLowerCase();
  const projectName = candidate.projectName.toLocaleLowerCase();
  const searchable = candidate.searchableText.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase().replace(/\s+/gu, '');
  const normalizedWorkName = workName.replace(/\s+/gu, '');
  const normalizedProjectName = projectName.replace(/\s+/gu, '');
  const direct = normalizedWorkName.length >= 2 && normalizedQuery.includes(normalizedWorkName)
    ? 40
    : normalizedProjectName.length >= 2 && normalizedQuery.includes(normalizedProjectName)
      ? 20
      : 0;
  return direct + terms.reduce((score, term) => {
    const normalized = term.toLocaleLowerCase();
    return score + (workName.includes(normalized) ? 8 : 0) +
      (projectName.includes(normalized) ? 4 : 0) +
      (searchable.includes(normalized) ? 1 : 0);
  }, 0);
}

function looksLikeCurrentWorkReference(text: string): boolean {
  return /(?:它|这个(?:问题|工作|任务)?|这项(?:工作|任务)|刚才(?:那个|的)?|继续|接着|再处理|that\s+(?:one|work)|\bit\b|continue|carry\s+on)/iu.test(text);
}

function looksLikePreviousWorkReference(text: string): boolean {
  return /(?:上一个|前一个|之前那个|回到.{0,6}(?:之前|上一个|前一个)|previous\s+(?:one|work)|go\s+back)/iu.test(text);
}

function looksExecutable(text: string): boolean {
  if (/[?？]\s*$/u.test(text)) return false;
  return /(?:修复|修改|更新|实现|创建|删除|检查并|处理|完成|继续|接着|运行|测试|提交|推送|fix|implement|update|create|remove|run|test|continue|ship|commit|push)/iu.test(
    text,
  );
}

function salientTerms(text: string): string[] {
  const latin = text.toLocaleLowerCase().match(/[a-z0-9_./-]{3,}/giu) ?? [];
  const chineseRuns = text.match(/[\p{Script=Han}]{2,16}/gu) ?? [];
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
  return [...new Set([...latin, ...chinese])].slice(0, 96);
}
