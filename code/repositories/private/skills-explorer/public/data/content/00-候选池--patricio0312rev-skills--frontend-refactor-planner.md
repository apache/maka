---
name: frontend-refactor-planner
description: Creates safe refactor plans for messy UI code including component splitting strategies, state simplification, performance optimizations, and accessibility improvements. Provides phased approach, risk assessment, and "done" criteria. Use when refactoring "legacy code", "messy components", "performance issues", or "large files".
---

# Frontend Refactor Planner

Create safe, phased refactor plans for complex frontend code.

## Refactor Assessment

**Identify Issues**: Large components (>300 lines), prop drilling, duplicate logic, poor performance, accessibility gaps, tight coupling, untested code
**Prioritize**: By risk (high-traffic pages first) and impact (user-facing bugs prioritized)
**Plan Phases**: Break into small, testable increments

## Common Refactor Patterns

**Component Splitting**: Extract sub-components, create compound components, separate logic from presentation
**State Management**: Lift state up, move to Context/Zustand, remove unnecessary state
**Performance**: Memoization (useMemo/useCallback), code splitting, lazy loading, virtualization
**Accessibility**: Add ARIA labels, keyboard navigation, focus management, semantic HTML
**Testing**: Add tests before refactoring, test after each change

## Phased Approach

**Phase 1 - Stabilize**: Add tests, fix critical bugs, document current behavior
**Phase 2 - Extract**: Pull out utilities, create smaller components, reduce complexity
**Phase 3 - Simplify**: Remove dead code, consolidate duplicates, optimize state
**Phase 4 - Polish**: Performance optimization, accessibility audit, documentation

## Risk Mitigation

Feature flags for gradual rollout, A/B testing refactored vs original, monitor error rates, have rollback plan, peer review all changes, incremental deployment.

## Done Criteria

Code coverage >80%, performance metrics improved, accessibility score 95+, no regressions in tests, code review approved, documentation updated.
