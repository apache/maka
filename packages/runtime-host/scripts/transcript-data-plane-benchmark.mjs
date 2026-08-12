import { performance } from 'node:perf_hooks';
import { ClientSessionSubscription } from '../dist/client/session-subscription.js';
import {
  createSessionTranscriptBootstrap,
  readSessionTranscriptPage,
} from '../dist/server/session-transcript-pager.js';

const BOOTSTRAP_BYTES = 16 * 1024;
const RTT_MS = Number.parseInt(process.env.MAKA_TRANSCRIPT_BENCHMARK_RTT_MS ?? '20', 10);
const cases = [
  { name: '5k-small-messages', messages: 5_000, textBytes: 96 },
  { name: '15MiB-single-message', messages: 1, textBytes: 15 * 1024 * 1024 },
  { name: '17MiB-transcript', totalBytes: 17 * 1024 * 1024, textBytes: 4 * 1024 },
  { name: '64MiB-transcript', totalBytes: 64 * 1024 * 1024, textBytes: 4 * 1024 },
];

const results = [];
for (const fixture of cases) results.push(await runFixture(fixture));
console.table(results);

async function runFixture(fixture) {
  const messages = buildMessages(fixture);
  const reader = inMemoryReader(messages);
  const openedAt = performance.now();
  const { bootstrap, state } = await createSessionTranscriptBootstrap({
    reader,
    sessionId: 'benchmark-session',
    subscriptionId: `benchmark-${fixture.name}`,
    rootTurn: null,
    activeAssistantStreams: [],
    maxBytes: BOOTSTRAP_BYTES,
  });
  const bootstrapCpuMs = performance.now() - openedAt;
  let pageRequests = 0;
  let transferredRawBytes = bootstrap.durable.rawBytes + bootstrap.overlay.rawBytes;
  const subscription = new ClientSessionSubscription(
    {
      hostEpoch: 'benchmark-host',
      subscriptionId: state.subscriptionId,
      nextSequence: 1,
      activeAssistantStreams: [],
      transcript: bootstrap,
      snapshot: {
        schemaVersion: 3,
        session: {
          sessionId: state.sessionId,
          metadataRevision: 1,
          status: 'active',
          createdAt: 1,
          lastUsedAt: 1,
          isArchived: false,
        },
        projectionRevision: 1,
        rootTurn: null,
        goal: null,
        queue: {
          hostEpoch: 'benchmark-host',
          queueRevision: 0,
          steering: [],
          followup: [],
        },
        interactions: { pending: [] },
      },
    },
    async () => undefined,
    async (request) => {
      pageRequests += 1;
      const page = await readSessionTranscriptPage({ reader, state, request });
      transferredRawBytes += page.rawBytes;
      return page;
    },
  );
  const materializeAt = performance.now();
  const materialized = await subscription.loadTranscript((value) => value);
  const materializeCpuMs = performance.now() - materializeAt;
  if (materialized.length !== messages.length) {
    throw new Error(
      `${fixture.name} materialized ${materialized.length}/${messages.length} messages`,
    );
  }
  const wireRequests = 1 + pageRequests;
  return {
    fixture: fixture.name,
    messages: messages.length,
    rawMiB: decimalMiB(transferredRawBytes),
    bootstrapKiB: decimalKiB(bootstrap.durable.rawBytes + bootstrap.overlay.rawBytes),
    wireRequests,
    pageRequests,
    bootstrapCpuMs: bootstrapCpuMs.toFixed(1),
    materializeCpuMs: materializeCpuMs.toFixed(1),
    modeledRttFloorMs: wireRequests * RTT_MS,
  };
}

function buildMessages(fixture) {
  const messages = [];
  let encodedBytes = 0;
  const targetCount = fixture.messages ?? Number.POSITIVE_INFINITY;
  while (
    messages.length < targetCount &&
    (fixture.totalBytes === undefined || encodedBytes < fixture.totalBytes)
  ) {
    const index = messages.length;
    const message = {
      type: 'user',
      id: `message-${index}`,
      turnId: `turn-${index}`,
      ts: index + 1,
      text: 'x'.repeat(fixture.textBytes),
    };
    const data = JSON.stringify(message);
    messages.push({ sequence: index, data, encodedBytes: Buffer.byteLength(data, 'utf8') });
    encodedBytes += messages.at(-1).encodedBytes;
  }
  return messages;
}

function inMemoryReader(messages) {
  return {
    readDurableHighWater: async () => (messages.length === 0 ? null : messages.length - 1),
    readDurablePage: async (_sessionId, request) => {
      const throughSequence = request.throughSequence ?? messages.length - 1;
      if (throughSequence < 0) {
        return { throughSequence: null, messages: [], hasMore: false };
      }
      const selected = [];
      let selectedBytes = 0;
      let sequence =
        request.direction === 'older'
          ? Math.min(throughSequence, (request.cursor ?? throughSequence + 1) - 1)
          : (request.cursor ?? -1) + 1;
      while (
        sequence >= 0 &&
        sequence <= throughSequence &&
        selected.length < request.maxMessages
      ) {
        const message = messages[sequence];
        if (selected.length > 0 && selectedBytes + message.encodedBytes > request.maxBytes) break;
        selected.push(message);
        selectedBytes += message.encodedBytes;
        sequence += request.direction === 'older' ? -1 : 1;
      }
      const hasMore = sequence >= 0 && sequence <= throughSequence;
      if (request.direction === 'older') selected.reverse();
      return { throughSequence, messages: selected, hasMore };
    },
    readActiveOverlay: async () => [],
  };
}

function decimalMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function decimalKiB(bytes) {
  return (bytes / 1024).toFixed(2);
}
