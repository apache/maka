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

import type {
  WorkHubSessionFacts,
  WorkHubSessionTarget,
} from './workhub-controller.js';

export type WorkHubRouteEvidence =
  | 'explicit_target'
  | 'exact_session_name'
  | 'route_correction'
  | 'core_entity'
  | 'recent_focus';

export type WorkHubRouteDecision =
  | {
      kind: 'target';
      target: WorkHubSessionTarget;
      evidence: WorkHubRouteEvidence;
    }
  | {
      kind: 'clarification';
      options: WorkHubSessionFacts[];
    }
  | { kind: 'discussion' }
  | { kind: 'new_session' };

export interface WorkHubRoutePolicy {
  resolve(input: {
    text: string;
    sessions: WorkHubSessionFacts[];
    originPromptBySessionId: ReadonlyMap<string, string | undefined>;
    explicitTarget?: WorkHubSessionTarget;
  }): WorkHubRouteDecision;
  rememberTarget(target: WorkHubSessionTarget): void;
  rememberCorrection(text: string, target: WorkHubSessionTarget): void;
}

export function workHubNewSessionName(text: string): string {
  const explicitChinese = text.match(
    /(?:标题|名称|名字)(?:为|叫|是|：|:)\s*[“”"']?([^,，。；;\n“”"']{2,48})/u,
  )?.[1]?.trim();
  const explicitEnglish = text.match(
    /\b(?:called|named|titled)\s+[“”"']?([^,，。；;.!?\n“”"']{2,48})/iu,
  )?.[1]?.trim();
  const explicit = explicitChinese ?? explicitEnglish;
  if (explicit) return explicit;
  const withoutCreationPrefix = text.trim().replace(
    /^(?:(?:请|帮我|麻烦)?(?:创建|新建|开一个|新开)(?:一个)?(?:全新的?|新的?)?(?:普通)?\s*(?:Session|会话|工作|任务)?|(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:create|start|open)\s+(?:a\s+)?(?:(?:brand[- ]new|new)\s+)?(?:ordinary\s+)?(?:session|work|task))(?:\s+(?:called|named|titled))?[，,:：\s-]*/iu,
    '',
  );
  const firstClause = withoutCreationPrefix.split(/[，。；;\n]/u)[0]?.trim();
  return firstClause?.slice(0, 48) || '新工作';
}

interface RouteCorrection {
  text: string;
  target: WorkHubSessionTarget;
  sequence: number;
}

const MAX_ROUTE_CORRECTIONS = 32;
const MIN_EXACT_SESSION_NAME_LENGTH = 2;
const MIN_CORRECTION_TERM_LENGTH = 3;
// One four-character Han phrase is usually a meaningful entity rather than
// grammar; Latin needs either two whole-word matches or one distinctive word.
const MIN_STRONG_HAN_MATCH_LENGTH = 4;
const MIN_STRONG_LATIN_MATCH_COUNT = 2;
const MIN_STRONG_SINGLE_LATIN_LENGTH = 8;
const MAX_UNCERTAINTY_OPTIONS = 5;
const MAX_RELATED_CLARIFICATION_OPTIONS = 4;

/**
 * Deep routing module for R2.3.
 *
 * It owns only transient inference context. Session identity, transcript,
 * execution state, and recovery continue to come from the Session port.
 */
export function createWorkHubRoutePolicy(): WorkHubRoutePolicy {
  let currentFocus: WorkHubSessionTarget | undefined;
  let previousFocus: WorkHubSessionTarget | undefined;
  const corrections: RouteCorrection[] = [];
  let correctionSequence = 0;

  return {
    resolve({ text, sessions, originPromptBySessionId, explicitTarget }) {
      if (explicitTarget) {
        return { kind: 'target', target: explicitTarget, evidence: 'explicit_target' };
      }

      if (looksLikeExplicitNewSession(text)) {
        return { kind: 'new_session' };
      }

      const normalizedInput = normalizeIdentityText(text);
      const exact = sessions.map((session) => {
        const sessionName = normalizeIdentityText(session.sessionName);
        const qualifiedName = normalizeIdentityText(
          `${session.projectName}/${session.sessionName}`,
        );
        return {
          session,
          matchLength: normalizedInput.includes(qualifiedName)
            ? qualifiedName.length
            : normalizedInput.includes(sessionName)
              ? sessionName.length
              : 0,
        };
      }).filter(({ matchLength }) => matchLength >= MIN_EXACT_SESSION_NAME_LENGTH)
        .sort((left, right) => right.matchLength - left.matchLength);
      if (exact[0] && exact[0].matchLength > (exact[1]?.matchLength ?? 0)) {
        return {
          kind: 'target',
          target: exact[0].session.target,
          evidence: 'exact_session_name',
        };
      }

      const related = rankRelatedSessions(text, sessions, originPromptBySessionId);
      if (looksLikeTargetUncertainty(text) && sessions.length > 0) {
        const relatedIds = new Set(related.map(({ session }) => session.target.sessionId));
        const options = [
          ...related.map(({ session }) => session),
          ...sessions
            .filter((session) => !relatedIds.has(session.target.sessionId))
            .sort((left, right) => right.updatedAt - left.updatedAt),
        ];
        return { kind: 'clarification', options: options.slice(0, MAX_UNCERTAINTY_OPTIONS) };
      }

      const corrected = correctedTarget(text, sessions, corrections);
      if (corrected) {
        return { kind: 'target', target: corrected, evidence: 'route_correction' };
      }

      const previousReference = looksLikePreviousFocus(text);
      const currentReference = !previousReference && looksLikeRecentFocus(text);
      const focused = previousReference
        ? previousFocus
        : currentReference
          ? currentFocus
          : undefined;
      const strongEvidenceElsewhere = focused
        ? related.some(({ session, strongEvidence }) =>
          session.target.sessionId !== focused.sessionId && strongEvidence)
        : false;
      const ambiguousEvidence = related.length > 1;
      if (
        focused &&
        (previousReference || (!strongEvidenceElsewhere && !ambiguousEvidence))
      ) {
        return { kind: 'target', target: focused, evidence: 'recent_focus' };
      }

      if (
        related[0] &&
        related[0].strongEvidence &&
        !related[1]?.strongEvidence
      ) {
        return {
          kind: 'target',
          target: related[0].session.target,
          evidence: 'core_entity',
        };
      }

      const weakNewTopic = related.length === 1 &&
        !related[0]!.strongEvidence &&
        looksExecutable(text) &&
        !currentReference;
      if (related.length > 0 && !weakNewTopic) {
        return {
          kind: 'clarification',
          options: related.slice(0, MAX_RELATED_CLARIFICATION_OPTIONS)
            .map(({ session }) => session),
        };
      }
      return looksExecutable(text) ? { kind: 'new_session' } : { kind: 'discussion' };
    },
    rememberTarget(target) {
      if (currentFocus?.sessionId === target.sessionId) return;
      previousFocus = currentFocus;
      currentFocus = target;
    },
    rememberCorrection(text, target) {
      correctionSequence += 1;
      corrections.unshift({ text, target, sequence: correctionSequence });
      corrections.splice(MAX_ROUTE_CORRECTIONS);
    },
  };
}

function correctedTarget(
  text: string,
  sessions: WorkHubSessionFacts[],
  corrections: readonly RouteCorrection[],
): WorkHubSessionTarget | undefined {
  const queryTerms = new Set(routingTerms(text));
  if (queryTerms.size === 0) return undefined;
  const available = new Set(sessions.map((session) => session.target.sessionId));
  const ranked = corrections
    .filter((correction) => available.has(correction.target.sessionId))
    .map((correction) => {
      const matches = routingTerms(correction.text).filter((term) => queryTerms.has(term));
      return {
        correction,
        score: matches.reduce((total, term) => total + term.length, 0),
        longestMatch: matches.reduce((longest, term) => Math.max(longest, term.length), 0),
      };
    })
    .filter(({ longestMatch }) => longestMatch >= MIN_CORRECTION_TERM_LENGTH)
    .sort((left, right) =>
      right.score - left.score || right.correction.sequence - left.correction.sequence);
  return ranked[0]?.correction.target;
}

function normalizeIdentityText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function looksLikeRecentFocus(value: string): boolean {
  return /(?:它|这个(?:问题|工作|任务)?|这项(?:工作|任务)|刚才(?:那个|的)?|继续|接着|\bit\b|continue)/iu.test(
    value,
  );
}

function looksLikePreviousFocus(value: string): boolean {
  return /(?:上一个|前一个|之前那个|回到.{0,6}(?:之前|上一个|前一个)|previous\s+(?:one|work)|go\s+back)/iu.test(
    value,
  );
}

function looksLikeTargetUncertainty(value: string): boolean {
  return /(?:不确定(?:具体)?(?:是)?哪(?:一)?个|不知道(?:应该)?(?:选|继续|处理)哪(?:一)?个|可能是多个|哪个都可能|\b(?:i(?:'m| am)\s+)?not\s+sure\s+(?:which|where)|\b(?:i\s+)?(?:do\s+not|don't)\s+know\s+(?:which|where)|\b(?:could|might|may)\s+(?:be|belong\s+to)\s+(?:more\s+than\s+one|multiple)|\bwhich\s+(?:one|session|work|task)\b)/iu.test(
    value,
  );
}

function looksLikeExplicitNewSession(value: string): boolean {
  if (looksLikeCreationDeliberation(value)) return false;
  return /(?:创建|新建|开一个|新开)(?:一个)?(?:全新的?|新的?)?(?:普通)?\s*(?:Session|会话|工作|任务)|(?:create|start|open)\s+(?:a\s+)?(?:brand[- ]new|new)\s+(?:session|work|task)/iu.test(
    value,
  );
}

function looksExecutable(value: string): boolean {
  if (looksLikeCreationDeliberation(value)) return false;
  const action = /(?:修复|修改|更新|实现|创建|新增|删除|移除|处理|完成|运行|测试|提交|推送|检查|优化|补充|整理|fix|implement|update|create|add|remove|delete|handle|finish|run|test|commit|push|check|optimize)/iu;
  if (!action.test(value)) return false;
  const directRequest = /(?:请|帮我|麻烦|现在(?:就)?|开始|can you|could you|would you|please)/iu.test(value);
  if (directRequest) return true;
  const designQuestion = /(?:[?？]\s*$|怎么|如何|为什么|是否|该不该|值不值得|^\s*(?:how|why|whether|what\s+(?:is|are|was|were|should|would|could|do|does|did|can))\b)/iu.test(
    value,
  );
  return !designQuestion;
}

function looksLikeCreationDeliberation(value: string): boolean {
  const creation = /(?:创建|新建|新开|开一个)(?:.{0,8})(?:Session|会话|工作|任务)|(?:create|start|open)(?:.{0,12})(?:session|work|task)/iu;
  if (!creation.test(value)) return false;
  return /(?:不要|别|无需|不用|不需要|先不|暂不|是否|要不要|该不该|应不应该|能不能|可不可以|为什么|如何|怎么|(?:do\s+not|don't|should\s+(?:we|i)|whether|why|how|can\s+(?:we|i)))/iu.test(
    value,
  ) || /[?？]\s*$/u.test(value);
}

const ROUTING_STOP_TERMS = new Set([
  '一下', '一个', '这个', '那个', '问题', '工作', '任务', '继续', '接着', '处理',
  '检查', '修改', '更新', '实现', '完成', '分析', '风险', '测试', '测试点', '文件',
  'a', 'an', 'and', 'any', 'but', 'check', 'code', 'continue', 'file', 'files',
  'fix', 'for', 'handle', 'in', 'issue', 'just', 'modify', 'on', 'only', 'please',
  'risk', 'risks', 'task', 'test', 'tests', 'the', 'this', 'to', 'update', 'user',
  'with', 'work',
]);

interface RelatedSession {
  session: WorkHubSessionFacts;
  score: number;
  longestMatch: number;
  strongEvidence: boolean;
}

function rankRelatedSessions(
  value: string,
  sessions: WorkHubSessionFacts[],
  originPromptBySessionId: ReadonlyMap<string, string | undefined>,
): RelatedSession[] {
  const terms = routingTerms(value);
  return sessions
    .map((session) => {
      const identityText = [
        session.sessionName,
        originPromptBySessionId.get(session.target.sessionId) ?? '',
        session.latestResult ?? '',
      ].join(' ');
      const compactIdentity = normalizeIdentityText(identityText);
      const latinIdentity = new Set(latinTokens(identityText));
      const matches = terms.filter((term) => isLatinTerm(term)
        ? latinIdentity.has(term)
        : compactIdentity.includes(term));
      const latinMatches = matches.filter(isLatinTerm);
      const hanMatches = matches.filter((term) => !isLatinTerm(term));
      return {
        session,
        score: matches.reduce((total, term) => total + term.length, 0),
        longestMatch: matches.reduce((longest, term) => Math.max(longest, term.length), 0),
        strongEvidence: hanMatches.some((term) =>
          term.length >= MIN_STRONG_HAN_MATCH_LENGTH) ||
          latinMatches.length >= MIN_STRONG_LATIN_MATCH_COUNT ||
          latinMatches.some((term) => term.length >= MIN_STRONG_SINGLE_LATIN_LENGTH),
      };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) =>
      right.score - left.score || right.session.updatedAt - left.session.updatedAt);
}

function routingTerms(value: string): string[] {
  const withoutBoilerplate = value.replace(
    /(?:先|仍然|还是)?只(?:需要|要)?分析(?:风险(?:和|及|、)?测试点?)?|不(?:要|用|需要|需)?修改(?:任何)?文件|先不动代码|测试点|风险点|(?:但)?我?不确定(?:具体)?(?:是)?哪(?:一)?个|\b(?:just|only)\s+analy[sz]e\s+(?:the\s+)?risks?(?:\s+(?:and|with)\s+test\s+(?:points?|cases?))?|\b(?:do\s+not|don't)\s+(?:modify|change)\s+(?:any\s+)?files?|\b(?:do\s+not|don't)\s+touch\s+the\s+code\s+yet|\b(?:test\s+cases?|risk\s+points?)\b/giu,
    ' ',
  );
  const latin = latinTokens(withoutBoilerplate);
  const chineseRuns = withoutBoilerplate.match(/[\p{Script=Han}]{2,20}/gu) ?? [];
  const chinese = chineseRuns.flatMap((run) => {
    const stripped = run.replace(
      /(?:请|帮我|麻烦|现在|开始|继续|接着|处理|检查|修改|更新|实现|完成|分析)/gu,
      ' ',
    );
    return stripped.split(/\s+/u).flatMap((part) => {
      const characters = [...part];
      const terms: string[] = [];
      for (let size = 2; size <= Math.min(6, characters.length); size += 1) {
        for (let start = 0; start + size <= characters.length; start += 1) {
          terms.push(characters.slice(start, start + size).join(''));
        }
      }
      return terms;
    });
  });
  return [...new Set([...latin, ...chinese]
    .map(normalizeIdentityText)
    .filter((term) => term.length >= 2 && !ROUTING_STOP_TERMS.has(term)))];
}

function latinTokens(value: string): string[] {
  return value.toLocaleLowerCase().match(/[a-z0-9]{2,}/giu) ?? [];
}

function isLatinTerm(value: string): boolean {
  return /^[a-z0-9]+$/u.test(value);
}
