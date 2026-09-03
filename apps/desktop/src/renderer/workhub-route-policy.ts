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

import {
  createExactNameSessionResolver,
  readWorkHubRequestIntent,
  workHubCorrectionAdmitsReference,
  type WorkHubRequestIntent,
  type WorkHubResolverSession,
  type WorkHubSessionResolver,
} from './application/contracts/workhub-request-intent.js';

interface WorkHubRouteTarget {
  sessionId: string;
}

interface WorkHubRoutableSession {
  target: WorkHubRouteTarget;
  projectName: string;
  sessionName: string;
  latestResult?: string;
  updatedAt: number;
}

export type WorkHubRouteEvidence =
  | 'explicit_target'
  | 'exact_session_name'
  | 'route_correction'
  | 'core_entity'
  | 'recent_focus';

export type WorkHubRouteDecision =
  | {
      kind: 'target';
      target: WorkHubRouteTarget;
      evidence: WorkHubRouteEvidence;
      correctedFrom?: WorkHubRouteTarget;
    }
  | {
      kind: 'clarification';
      options: WorkHubRoutableSession[];
      reason?: 'ambiguous_command';
      correctedFrom?: WorkHubRouteTarget;
    }
  | { kind: 'discussion' }
  | { kind: 'new_session'; title: string; correctedFrom?: WorkHubRouteTarget };


/**
 * Both reasons are about the reference itself — what the user's words name —
 * which is the only question this policy can answer on its own.
 *
 * Whether the named Session still owns work a stop can reach is not asked
 * here. Only the Host knows that, it proves it under the admission lease
 * anyway, and a renderer that answered from its own view would contradict the
 * Host in exactly the windows where its view is empty: a second window, a
 * reload, a reconnect. So a resolved reference submits, and a Session with
 * nothing to stop is refused by the Gate.
 */
export type WorkHubStopClarificationReason =
  /** The stop names no safe target of its own — a pronoun or a bare noun. */
  | 'stop_target_required'
  /** The stop names more than one existing Session. */
  | 'stop_target_ambiguous'
  /** The Host refused the stop; its conflict is the whole answer. */
  | 'stop_target_unavailable';

/**
 * A stop clarification never offers route options. Choosing one re-sends the
 * original text as work, and stop-shaped text is exactly what must not be
 * delivered to a Session that way, so the reason carries the whole answer.
 */
export type WorkHubStopRouteDecision =
  | { kind: 'not_requested' }
  | { kind: 'clarification'; reason: WorkHubStopClarificationReason }
  | { kind: 'target'; target: WorkHubRouteTarget };

export interface WorkHubRoutePolicy {
  resolveStop(input: {
    text: string;
    sessions: WorkHubRoutableSession[];
  }): WorkHubStopRouteDecision;
  resolve(input: {
    text: string;
    sessions: WorkHubRoutableSession[];
    originPromptBySessionId: ReadonlyMap<string, string | undefined>;
    explicitTarget?: WorkHubRouteTarget;
  }): WorkHubRouteDecision;
  initializeFocus(targets: readonly WorkHubRouteTarget[]): void;
  newVisit(): WorkHubRoutePolicy;
  rememberTarget(target: WorkHubRouteTarget): void;
}

export function workHubNewSessionName(
  text: string,
  parsedIntent?: WorkHubRequestIntent,
): string {
  const intent = typeof parsedIntent === 'object'
    ? parsedIntent
    : readWorkHubRequestIntent(text);
  if (intent.creation.naming.kind === 'named') return intent.creation.naming.title;
  const withoutCreationPrefix = text.trim().replace(
    /^(?:(?:请|帮我|麻烦)?(?:创建|新建|开一个|新开)(?:一个)?(?:全新的?|新的?)?(?:普通)?\s*(?:Session|会话|工作|任务)?|(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:create|start|open)\s+(?:a\s+)?(?:(?:brand[- ]new|new)\s+)?(?:ordinary\s+)?(?:session|work|task))(?:\s+(?:叫做?|名为|命名为|标题为|名称为|名字为|called|named|titled))?[，,:：\s-]*/iu,
    '',
  );
  const firstClause = withoutCreationPrefix.split(/[，。；;\n]/u)[0]?.trim();
  return firstClause?.slice(0, 48) || '新工作';
}

const MIN_EXACT_SESSION_NAME_LENGTH = 2;
// One four-character Han phrase is usually a meaningful entity rather than
// grammar; Latin needs either two whole-word matches or one distinctive word.
const MIN_STRONG_HAN_MATCH_LENGTH = 4;
const MIN_STRONG_LATIN_MATCH_COUNT = 2;
const MIN_STRONG_SINGLE_LATIN_LENGTH = 8;
const MAX_UNCERTAINTY_OPTIONS = 5;
const MAX_RELATED_CLARIFICATION_OPTIONS = 4;

/**
 * Deep routing module for R2.4.
 *
 * It owns only transient inference context. Session identity, transcript,
 * execution state, and recovery continue to come from the Session port.
 */
export function createWorkHubRoutePolicy(
  sessionResolver: WorkHubSessionResolver = createExactNameSessionResolver(),
): WorkHubRoutePolicy {
  return createWorkHubRoutePolicyVisit(sessionResolver);
}

function createWorkHubRoutePolicyVisit(
  sessionResolver: WorkHubSessionResolver,
): WorkHubRoutePolicy {
  let currentFocus: WorkHubRouteTarget | undefined;
  let previousFocus: WorkHubRouteTarget | undefined;

  return {
    // The stop Action Policy. Action Intent says only that the user issued a
    // stop imperative and what work it refers to; the shared Session Resolver
    // recalls which visible Sessions that reference names; this policy decides
    // whether the resolution is sufficient for a destructive action.
    //
    // Direct stop is a narrow claim over WorkHub's own active delegations, not
    // a filter over every sentence that begins with "stop". A reference that
    // recalls no WorkHub identity — "Stop using the deprecated API" — is
    // ordinary work and falls through to routing; an unsafe or anaphoric
    // reference still fails closed, and a resolved Session that is not uniquely
    // stoppable says why.
    resolveStop({ text, sessions }) {
      const intent = readWorkHubRequestIntent(text);
      if (!intent.stop.cue) return { kind: 'not_requested' };
      const reference = intent.stop.imperative ? intent.stop.target : undefined;
      if (!reference) {
        return { kind: 'clarification', reason: 'stop_target_required' };
      }
      const sessionByRef = new Map(
        sessions.map((session) => [session.target.sessionId, session]),
      );
      const resolution = sessionResolver.resolve({
        reference: { text: reference },
        sessions: sessions.map(resolverSession),
      });
      if (resolution.kind === 'none') return { kind: 'not_requested' };
      // Stop's own tail rule. The Resolver reports what the reference said
      // after the name; a destructive command may add punctuation and nothing
      // else, so `Stop Payments and Login` names no stoppable target here even
      // though `Payments` matched.
      const admissible = resolution.candidates.filter(
        ({ evidence }) =>
          evidence.kind === 'elided_name_punctuation' ||
          /^[.!?。！？]*$/u.test(evidence.remainder),
      );
      if (admissible.length === 0) return { kind: 'not_requested' };
      // Stop admits one candidate only. A ranked resolver may return several;
      // this action never picks a winner from a ranking it cannot justify.
      if (resolution.kind === 'ambiguous' || admissible.length > 1) {
        return { kind: 'clarification', reason: 'stop_target_ambiguous' };
      }
      const resolved = sessionByRef.get(admissible[0]!.ref);
      if (!resolved) return { kind: 'not_requested' };
      // The reference resolved, which is everything this policy can prove.
      // Which delegation to end, and whether there is one at all, is the
      // Host's answer and is made under the lease that performs the stop.
      return { kind: 'target', target: resolved.target };
    },
    resolve({ text, sessions, originPromptBySessionId, explicitTarget }) {
      const intent = readWorkHubRequestIntent(text);
      if (intent.execution === 'ambiguous') {
        return { kind: 'clarification', options: [], reason: 'ambiguous_command' };
      }
      if (explicitTarget) {
        return { kind: 'target', target: explicitTarget, evidence: 'explicit_target' };
      }

      if (intent.correction.cue && !isAffirmativeCorrection(intent)) {
        return { kind: 'discussion' };
      }

      const correctionText = naturalCorrectionTargetText(text, intent);
      const correctedFrom = currentFocus && sessions.some((session) =>
        session.target.sessionId === currentFocus?.sessionId)
        ? currentFocus
        : undefined;
      if (
        !correctionText &&
        correctedFrom &&
        looksLikeRecentFocus(text) &&
        looksLikeContentReplacement(text)
      ) {
        return { kind: 'target', target: correctedFrom, evidence: 'recent_focus' };
      }
      if (correctionText && correctedFrom) {
        if (looksLikeCorrectionCreation(intent)) {
          return { kind: 'new_session', title: workHubNewSessionName(text, intent), correctedFrom };
        }
        const alternatives = sessions.filter((session) =>
          session.target.sessionId !== correctedFrom.sessionId);
        // Correction recalls its target through the same shared port as stop,
        // then applies its own tail rule: a correction may name the Session and
        // go on to say what to do with it.
        const correctionResolution = sessionResolver.resolve({
          reference: { text: correctionText },
          sessions: alternatives.map(resolverSession),
        });
        const affirmed = new Set(
          (correctionResolution.kind === 'none' ? [] : correctionResolution.candidates)
            .filter(({ evidence }) => workHubCorrectionAdmitsReference(correctionText, evidence))
            .map(({ ref }) => ref),
        );
        const affirmedCorrections = alternatives.filter((session) =>
          affirmed.has(session.target.sessionId));
        if (affirmedCorrections.length === 1) {
          return {
            kind: 'target',
            target: affirmedCorrections[0]!.target,
            evidence: 'route_correction',
            correctedFrom,
          };
        }
        const options = affirmedCorrections.length > 1
          ? affirmedCorrections
          : alternatives.sort((left, right) => right.updatedAt - left.updatedAt);
        return {
          kind: 'clarification',
          options: options.slice(0, MAX_UNCERTAINTY_OPTIONS),
          correctedFrom,
        };
      }

      if (looksLikeExplicitNewSession(intent)) {
        return { kind: 'new_session', title: workHubNewSessionName(text, intent) };
      }

      const exact = rankExactSessions(text, sessions);
      if (exact[0] && exact[0].matchLength > (exact[1]?.matchLength ?? 0)) {
        return {
          kind: 'target',
          target: exact[0].session.target,
          evidence: 'exact_session_name',
        };
      }

      const relatedSessions = sessions.filter((session) => {
        const qualifiedName = `${session.projectName}/${session.sessionName}`;
        return !hasConflictingLatinIdentity(text, session.sessionName) &&
          !hasConflictingLatinIdentity(text, qualifiedName);
      });
      const related = rankRelatedSessions(text, relatedSessions, originPromptBySessionId);
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

      const previousReference = looksLikePreviousFocus(text);
      const currentReference = !previousReference && looksLikeRecentFocus(text);
      const focusCandidate = previousReference
        ? previousFocus
        : currentReference
          ? currentFocus
          : undefined;
      const focused = focusCandidate && sessions.some((session) =>
        session.target.sessionId === focusCandidate.sessionId)
        ? focusCandidate
        : undefined;
      const strongEvidenceElsewhere = focused
        ? related.some(({ session, strongEvidence }) =>
          session.target.sessionId !== focused.sessionId && strongEvidence)
        : false;
      const weakEvidenceElsewhere = focused
        ? related.some(({ session }) => session.target.sessionId !== focused.sessionId)
        : false;
      const ambiguousEvidence = related.length > 1;
      if (
        focused &&
        (previousReference || (
          !strongEvidenceElsewhere && !weakEvidenceElsewhere && !ambiguousEvidence
        ))
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
        looksExecutable(intent) &&
        !currentReference;
      if (related.length > 0 && !weakNewTopic) {
        return {
          kind: 'clarification',
          options: related.slice(0, MAX_RELATED_CLARIFICATION_OPTIONS)
            .map(({ session }) => session),
        };
      }
      return looksExecutable(intent)
        ? { kind: 'new_session', title: workHubNewSessionName(text, intent) }
        : { kind: 'discussion' };
    },
    initializeFocus(targets) {
      const ordered = targets.filter((target, index) =>
        targets.findIndex((candidate) => candidate.sessionId === target.sessionId) === index);
      const first = ordered[0];
      if (!first) return;
      const available = new Set(ordered.map((target) => target.sessionId));
      if (currentFocus && !available.has(currentFocus.sessionId)) {
        currentFocus = first;
        previousFocus = ordered[1];
        return;
      }
      if (!currentFocus) {
        currentFocus = first;
        previousFocus = ordered[1];
        return;
      }
      if (!previousFocus || !available.has(previousFocus.sessionId)) {
        previousFocus = ordered.find((target) => target.sessionId !== currentFocus?.sessionId);
      }
    },
    newVisit() {
      return createWorkHubRoutePolicyVisit(sessionResolver);
    },
    rememberTarget(target) {
      if (currentFocus?.sessionId === target.sessionId) return;
      previousFocus = currentFocus;
      currentFocus = target;
    },
  };
}

/** Presents one routable Session to the Resolver as a bounded opaque candidate. */
function resolverSession(session: WorkHubRoutableSession): WorkHubResolverSession {
  return {
    ref: session.target.sessionId,
    sessionName: session.sessionName,
    projectName: session.projectName,
    updatedAt: session.updatedAt,
  };
}

function rankExactSessions(
  text: string,
  sessions: WorkHubRoutableSession[],
): Array<{ session: WorkHubRoutableSession; matchLength: number }> {
  return sessions.map((session) => {
    const qualifiedName = `${session.projectName}/${session.sessionName}`;
    return {
      session,
      matchLength: Math.max(
        exactIdentityMatchLength(text, qualifiedName),
        exactIdentityMatchLength(text, session.sessionName),
      ),
    };
  }).filter(({ matchLength }) => matchLength >= MIN_EXACT_SESSION_NAME_LENGTH)
    .sort((left, right) => right.matchLength - left.matchLength);
}

function normalizeIdentityText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function exactIdentityMatchLength(input: string, identity: string): number {
  const normalizedIdentity = normalizeIdentityText(identity);
  if (normalizedIdentity.length < MIN_EXACT_SESSION_NAME_LENGTH) return 0;

  // Latin Session names are matched as complete token sequences. Compacting
  // punctuation is useful for Han names, but it must never make a short name
  // such as "AI" match inside an unrelated word such as "repair".
  if (/^[a-z0-9\s\p{P}\p{S}]+$/iu.test(identity)) {
    const inputTokens = exactLatinTokens(input);
    const identityTokens = exactLatinTokens(identity);
    if (
      identityTokens.length === 0 ||
      identityTokens.length > inputTokens.length
    ) return 0;
    const matches = inputTokens.some((_, start) =>
      identityTokens.every((token, offset) => inputTokens[start + offset] === token)
    );
    return matches ? normalizedIdentity.length : 0;
  }

  return normalizeIdentityText(input).includes(normalizedIdentity)
    ? normalizedIdentity.length
    : 0;
}

function hasConflictingLatinIdentity(input: string, identity: string): boolean {
  if (!/^[a-z0-9\s\p{P}\p{S}]+$/iu.test(identity)) return false;

  const inputTokens = exactLatinTokens(input);
  const identityTokens = exactLatinTokens(identity);
  if (
    !identityTokens.some((token) => token.length === 1) ||
    identityTokens.length > inputTokens.length
  ) return false;

  return inputTokens.some((_, start) => {
    let hasConflict = false;
    const sameIdentityExceptDiscriminator = identityTokens.every((token, offset) => {
      const inputToken = inputTokens[start + offset];
      if (inputToken === token) return true;
      if (token.length === 1 && inputToken?.length === 1) {
        hasConflict = true;
        return true;
      }
      return false;
    });
    return sameIdentityExceptDiscriminator && hasConflict;
  });
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

function isAffirmativeCorrection(intent: WorkHubRequestIntent): boolean {
  return intent.correction.cue && Boolean(
    intent.correction.existingTarget ||
      (intent.creation.explicit && intent.execution === 'imperative'),
  );
}

function naturalCorrectionTargetText(
  value: string,
  intent: WorkHubRequestIntent,
): string | undefined {
  if (!isAffirmativeCorrection(intent)) return undefined;
  const chineseCreation = value.match(
    /^\s*(?:(?:不是|不要再继续)\s*(?:这个|那个|当前这个|刚才那个)(?:工作|任务|Session|会话)?|不对|错了|搞错了|弄错了)(?:[\s\p{P}\p{S}]+|$)(?:(?:请|麻烦|帮我)\s*)?(?:(?:创建|新建|新开)(?:一个)?|开一个)(?:全新的?|新的?)?(?:普通)?\s*(?:Session|会话|工作|任务)(?:叫|名为|命名为)?\s*(.{2,})$/iu,
  )?.[1]?.trim();
  if (chineseCreation) return chineseCreation;
  const englishCreation = value.match(
    /^\s*(?:no|not\s+(?:(?:this|that|the\s+current)(?:\s+(?:one|session|work|task))?)|wrong\s+(?:one|session|work|task))\b(?:[\s\p{P}\p{S}]+|$)(?:(?:please|kindly)\s+)?(?:create|start|open)\s+(?:a\s+)?(?:brand[- ]new|new)\s+(?:session|work|task)(?:\s+(?:called|named))?\s+(.{2,}?)(?:\s+instead)?[.!]?$/iu,
  )?.[1]?.trim();
  if (englishCreation) return englishCreation;
  return intent.correction.existingTarget;
}

function looksLikeCorrectionCreation(intent: WorkHubRequestIntent): boolean {
  return intent.creation.explicit && intent.execution === 'imperative';
}

function looksLikeContentReplacement(value: string): boolean {
  return /(?:不要(?:再)?用|别用|[^，,。；;\n]{1,32}(?:配置|实现|方案|字段|参数)?(?:不对|错了))[^\n]{0,64}[，,。；;]\s*(?:改成|改为|换成|换用|用)\s*\S{2,}/iu.test(value);
}

function looksLikeTargetUncertainty(value: string): boolean {
  return /(?:不确定(?:具体)?(?:是)?哪(?:一)?个|不知道(?:应该)?(?:选|继续|处理)哪(?:一)?个|可能是多个|哪个都可能|\b(?:i(?:'m| am)\s+)?not\s+sure\s+(?:which|where)|\b(?:i\s+)?(?:do\s+not|don't)\s+know\s+(?:which|where)|\b(?:could|might|may)\s+(?:be|belong\s+to)\s+(?:more\s+than\s+one|multiple)|\bwhich\s+(?:one|session|work|task)\b)/iu.test(
    value,
  );
}

function looksLikeExplicitNewSession(intent: WorkHubRequestIntent): boolean {
  return intent.creation.explicit && intent.execution === 'imperative';
}

function looksExecutable(intent: WorkHubRequestIntent): boolean {
  return intent.execution === 'imperative';
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
  session: WorkHubRoutableSession;
  score: number;
  longestMatch: number;
  strongEvidence: boolean;
}

function rankRelatedSessions(
  value: string,
  sessions: WorkHubRoutableSession[],
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

function exactLatinTokens(value: string): string[] {
  return value.toLocaleLowerCase().match(/[a-z0-9]+/giu) ?? [];
}

function isLatinTerm(value: string): boolean {
  return /^[a-z0-9]+$/u.test(value);
}
