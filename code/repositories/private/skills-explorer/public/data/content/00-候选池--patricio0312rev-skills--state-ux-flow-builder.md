---
name: state-ux-flow-builder
description: Standardizes UX states for data fetching flows (loading, error, empty, success) and complex multi-view UI patterns. Provides state machine approach recommendations, loading skeletons, error boundaries, and empty state components. Use when implementing "loading states", "error handling", "empty states", or "state machines".
---

# State & UX Flow Builder

Create consistent UX flows for all application states: loading, error, empty, and success.

## Output Components

Every implementation includes: (1) Loading skeletons, (2) Error state with retry, (3) Empty state with action, (4) Success view, (5) Error boundary, (6) State management pattern (useState/XState/server).

## Key Patterns

**Data Fetching Flow**: Check loading → Handle error → Show empty → Display data
**State Machine**: XState for complex flows with multiple states and transitions
**Optimistic Updates**: Instant UI feedback with rollback on error
**Progressive Loading**: Show content incrementally as it loads

## Best Practices

Always handle all states, prefer skeletons over spinners, provide retry mechanisms, use consistent error/empty UI, add ARIA live regions, implement error boundaries.
