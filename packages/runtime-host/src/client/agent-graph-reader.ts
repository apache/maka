import type {
  AgentGraphEpochListInput,
  AgentGraphEpochListResult,
  AgentGraphEpochSummary,
} from '../protocol/index.js';

const MAX_EPOCH_PAGES = 64;
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
): Promise<readonly AgentGraphEpochSummary[]> {
  const epochs: AgentGraphEpochSummary[] = [];
  const cursors = new Set<number>();
  let beforeEpoch: number | undefined;
  for (let pageCount = 0; pageCount < MAX_EPOCH_PAGES; pageCount += 1) {
    const page = await connection.request('agent.graph.epochs.query', {
      rootSessionId,
      ...(beforeEpoch === undefined ? {} : { beforeEpoch }),
    });
    epochs.push(...page.epochs);
    if (page.nextBeforeEpoch === null) return epochs;
    if (cursors.has(page.nextBeforeEpoch)) {
      throw new Error('Agent graph epoch query returned a repeated cursor');
    }
    cursors.add(page.nextBeforeEpoch);
    beforeEpoch = page.nextBeforeEpoch;
  }
  throw new Error('Agent graph epoch query exceeded the page limit');
}
