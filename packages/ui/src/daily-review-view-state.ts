import type { DailyReviewRange, DailyReviewSummary } from '@maka/core/daily-review';
import { dailyReviewScopeKey } from './daily-review-helpers.js';

export interface DailyReviewScope {
  readonly range: DailyReviewRange;
  readonly offsetDays: number;
}

export interface DailyReviewResolvedView {
  readonly scope: DailyReviewScope;
  readonly scopeKey: string;
  readonly summary: DailyReviewSummary;
}

export interface DailyReviewActivityState {
  readonly selection: DailyReviewScope;
  readonly resolvedView: DailyReviewResolvedView | null;
  readonly pendingScopeKey: string | null;
  readonly error: string | null;
}

export type DailyReviewActivityAction =
  | { readonly type: 'selected'; readonly scope: DailyReviewScope }
  | { readonly type: 'resolved'; readonly scope: DailyReviewScope; readonly summary: DailyReviewSummary }
  | { readonly type: 'rejected'; readonly scope: DailyReviewScope; readonly error: string };

export function createDailyReviewActivityState(scope: DailyReviewScope): DailyReviewActivityState {
  return {
    selection: scope,
    resolvedView: null,
    pendingScopeKey: scopeKey(scope),
    error: null,
  };
}

export function shiftDailyReviewScope(
  scope: DailyReviewScope,
  direction: -1 | 1,
): DailyReviewScope {
  return {
    ...scope,
    offsetDays: Math.min(0, scope.offsetDays + direction),
  };
}

export function dailyReviewActivityReducer(
  state: DailyReviewActivityState,
  action: DailyReviewActivityAction,
): DailyReviewActivityState {
  const actionScopeKey = scopeKey(action.scope);
  if (action.type === 'selected') {
    return {
      ...state,
      selection: action.scope,
      pendingScopeKey: actionScopeKey,
      error: null,
    };
  }
  if (state.pendingScopeKey !== actionScopeKey) return state;
  if (action.type === 'rejected') {
    return { ...state, pendingScopeKey: null, error: action.error };
  }
  return {
    ...state,
    resolvedView: {
      scope: action.scope,
      scopeKey: actionScopeKey,
      summary: action.summary,
    },
    pendingScopeKey: null,
    error: null,
  };
}

function scopeKey(scope: DailyReviewScope): string {
  return dailyReviewScopeKey(scope.offsetDays, scope.range);
}
