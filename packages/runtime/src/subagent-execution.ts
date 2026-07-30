/**
 * Stable compatibility handle for subagent work during the child-session migration.
 *
 * New work is addressed by its durable child Session. Historical child AgentRuns
 * remain readable in the parent Session without rewriting their ledgers.
 */
export type SubagentExecutionRef =
  | {
      kind: 'child_session';
      sessionId: string;
      currentRunId?: string;
    }
  | {
      kind: 'legacy_child_run';
      sessionId: string;
      runId: string;
    };
