import type {
  AgentGraphEpochListInput,
  AgentGraphEpochListResult,
  AgentGraphEpochSummary,
} from '../protocol/index.js';

const MAX_EPOCH_PAGES = 64;

/** One bounded, newest-first directory of Graph epochs read from the Host. */
export interface AgentGraphEpochDirectory {
  readonly epochs: readonly AgentGraphEpochSummary[];
  /**
   * True when the read hit its page bound while more valid pages remained.
   * Consumers must surface this instead of presenting the directory as
   * complete.
   */
  readonly truncated: boolean;
}

export interface AgentGraphReadConnection {
  request(
    operation: 'agent.graph.epochs.query',
    input: AgentGraphEpochListInput,
  ): Promise<AgentGraphEpochListResult>;
}

/** Collect one bounded, newest-first directory of Graph epochs from the Host. */
export async function readRuntimeHostAgentGraphEpochs(
  connection: AgentGraphReadConnection,
  rootSessionId: string,
): Promise<AgentGraphEpochDirectory> {
  const epochs: AgentGraphEpochSummary[] = [];
  const cursors = new Set<number>();
  let beforeEpoch: number | undefined;
  for (let pageCount = 0; pageCount < MAX_EPOCH_PAGES; pageCount += 1) {
    const page = await connection.request('agent.graph.epochs.query', {
      rootSessionId,
      ...(beforeEpoch === undefined ? {} : { beforeEpoch }),
    });
    epochs.push(...page.epochs);
    if (page.nextBeforeEpoch === null) return { epochs, truncated: false };
    if (cursors.has(page.nextBeforeEpoch)) {
      throw new Error('Agent graph epoch query returned a repeated cursor');
    }
    cursors.add(page.nextBeforeEpoch);
    beforeEpoch = page.nextBeforeEpoch;
  }
  return { epochs, truncated: true };
}
