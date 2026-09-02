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

// Independent page-oracle merge for the Chromium harness.
// Evidence is kept per page and per event. The latest POST must not erase
// earlier page-A input/Enter facts when page B later reports empty fields.

export function emptyOracleState() {
  return { events: [], eventLog: [], pages: {} };
}

export function applyOracleEvent(prior, event) {
  const state = prior ?? emptyOracleState();
  const pageKey = typeof event.page === 'string' && event.page.length > 0 ? event.page : 'unknown';
  const pagePrior = state.pages[pageKey] ?? { events: [], eventLog: [] };
  const pageEventLog = [...pagePrior.eventLog, event].slice(-100);
  const pages = {
    ...state.pages,
    [pageKey]: {
      ...pagePrior,
      ...event,
      events: [...pagePrior.events, event.event].slice(-100),
      eventLog: pageEventLog,
    },
  };
  return {
    events: [...state.events, event.event].slice(-100),
    eventLog: [...(state.eventLog ?? []), event].slice(-100),
    pages,
    lastEvent: event,
  };
}

export function createOracleStore() {
  const states = new Map();
  return {
    states,
    ingest(event) {
      if (typeof event?.run !== 'string') return false;
      const prior = states.get(event.run) ?? emptyOracleState();
      states.set(event.run, applyOracleEvent(prior, event));
      return true;
    },
    get(run) {
      return states.get(run) ?? emptyOracleState();
    },
  };
}

function pageLog(state, page) {
  return state.pages?.[page]?.eventLog ?? [];
}

function lastMatching(log, predicate) {
  for (let index = log.length - 1; index >= 0; index--) {
    if (predicate(log[index])) return log[index];
  }
  return null;
}

export function applicationEvidence(state) {
  const pageA = state.pages?.A ?? { events: [], eventLog: [] };
  const pageB = state.pages?.B ?? { events: [], eventLog: [] };
  const enterOnA = (pageA.eventLog ?? []).filter((item) => item.event === 'enter');
  const lastEnterA = enterOnA.at(-1);
  const lastInputA = lastMatching(pageA.eventLog ?? [], (item) => item.event === 'input');
  const lastCompatA = lastMatching(
    pageA.eventLog ?? [],
    (item) => item.event === 'compat-input' || item.event === 'enter',
  );
  const lastClickA = lastMatching(pageA.eventLog ?? [], (item) => item.event === 'click');
  const lastScrollA = lastMatching(pageA.eventLog ?? [], (item) => item.event === 'scroll');
  return {
    pageAReady: (pageA.events ?? []).includes('ready'),
    pageBLoaded:
      (pageB.events ?? []).includes('pageB-load') || (state.events ?? []).includes('pageB-load'),
    pageBReady: (pageB.events ?? []).includes('ready'),
    enterOnPageA: enterOnA.length > 0,
    enterCountOnPageA: Number(lastEnterA?.enterCount ?? 0),
    compatValueOnPageAEnter: lastEnterA?.compatValue ?? null,
    valueOnPageA: lastInputA?.value ?? null,
    compatValueOnPageA: lastCompatA?.compatValue ?? null,
    clickCountOnPageA: Number(lastClickA?.clickCount ?? 0),
    scrolledOnPageA: (pageA.events ?? []).includes('scroll'),
    scrollTopOnPageA: Number(lastScrollA?.scrollTop ?? pageA.scrollTop ?? 0),
  };
}

export function pageAHasValue(state, value) {
  return pageLog(state, 'A').some((item) => item.event === 'input' && item.value === value);
}

export function pageAHasCompatValue(state, value) {
  return pageLog(state, 'A').some(
    (item) =>
      (item.event === 'compat-input' || item.event === 'enter') && item.compatValue === value,
  );
}

export function pageAClicked(state, beforeClickCount = 0) {
  const clicks = pageLog(state, 'A').filter((item) => item.event === 'click');
  const counts = clicks.map((item) => item.clickCount);
  return (
    Number.isSafeInteger(beforeClickCount) &&
    counts.length > 0 &&
    counts.every(Number.isSafeInteger) &&
    Math.max(...counts) === beforeClickCount + 1
  );
}

export function pageAScrolled(state, beforeScrollTop = 0) {
  const evidence = applicationEvidence(state);
  return (
    Number.isFinite(beforeScrollTop) &&
    evidence.scrolledOnPageA &&
    Number.isFinite(evidence.scrollTopOnPageA) &&
    evidence.scrollTopOnPageA > beforeScrollTop
  );
}

export function navigationCompleted(state, expectedCompatValue) {
  const evidence = applicationEvidence(state);
  const enters = pageLog(state, 'A').filter((item) => item.event === 'enter');
  return (
    evidence.enterOnPageA &&
    enters.length === 1 &&
    enters[0].enterCount === 1 &&
    evidence.compatValueOnPageAEnter === expectedCompatValue &&
    evidence.pageBLoaded &&
    evidence.pageBReady
  );
}

// Local fixture evidence only, not a production browser URL/permission verifier.
export function boundNavigationCompleted(state, { run, value, sourceUrl, destinationUrl }) {
  if (!navigationCompleted(state, value)) return false;
  const source = pageLog(state, 'A');
  const destination = pageLog(state, 'B');
  const input = (item) =>
    item.run === run &&
    item.sourceId === 'compat-input' &&
    item.url === sourceUrl &&
    item.compatValue === value;
  return (
    source.some((item) => item.event === 'compat-input' && input(item)) &&
    source.some((item) => item.event === 'enter' && input(item)) &&
    ['pageB-load', 'ready'].every((kind) =>
      destination.some(
        (item) => item.event === kind && item.run === run && item.url === destinationUrl,
      ),
    )
  );
}

// Helper outcome stays as reported. Independent page completion is recorded
// separately and never upgrades unknown/refused into verified or pass.
export function classifyDispatchedTask({ helperResponse, applicationCompleted }) {
  if (helperResponse?.error) {
    return {
      executionState: 'blocked',
      contractConformance: 'not_tested',
      dispatched: false,
      helperOutcome: helperResponse.result?.outcome ?? null,
      rpcError: helperResponse.error,
      applicationCompleted: !!applicationCompleted,
    };
  }
  const outcome = helperResponse?.result?.outcome;
  if (!outcome || !['verified', 'unknown', 'refused'].includes(outcome.status)) {
    throw new Error(
      `invalid_or_missing_helper_outcome=${JSON.stringify(helperResponse?.error ?? outcome)}`,
    );
  }
  let executionState = 'unknown';
  if (outcome.status === 'refused') executionState = 'blocked';
  else if (outcome.status === 'verified' && applicationCompleted) executionState = 'pass';
  else if (outcome.status === 'verified') executionState = 'unknown';
  return {
    executionState,
    contractConformance: 'pass',
    dispatched: true,
    helperOutcome: outcome,
    applicationCompleted: !!applicationCompleted,
  };
}
