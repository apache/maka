import type { StoredMessage } from '@maka/core/session';
import type { DecodedSessionTranscriptPage } from '@maka/runtime-host/client';
import type {
  SessionAssistantStreamIdentity,
  SessionContinuitySnapshot,
  SessionTranscriptPage,
  SubscriptionFrame,
} from '@maka/runtime-host/protocol';
import type { DesktopRuntimeHostSession } from '../runtime-host-client.js';

export function runtimeHostSessionFixture(input: {
  readonly snapshot: SessionContinuitySnapshot;
  readonly activeAssistantStreams?: readonly SessionAssistantStreamIdentity[];
  readonly transcript?: Promise<StoredMessage[]>;
  readonly events: AsyncIterable<SubscriptionFrame>;
  readonly transcriptBootstrap?: DesktopRuntimeHostSession['transcriptBootstrap'];
  loadTranscript?: DesktopRuntimeHostSession['loadTranscript'];
  loadTranscriptOverlay?: DesktopRuntimeHostSession['loadTranscriptOverlay'];
  decodeTranscriptPage?: DesktopRuntimeHostSession['decodeTranscriptPage'];
  loadTranscriptPage?: DesktopRuntimeHostSession['loadTranscriptPage'];
  close(): Promise<void>;
}): DesktopRuntimeHostSession {
  const sessionId = input.snapshot.session.sessionId;
  const transcript = input.transcript ?? Promise.resolve([]);
  return {
    hostEpoch: 'host-1',
    subscriptionId: `subscription-${sessionId}`,
    snapshot: input.snapshot,
    activeAssistantStreams: input.activeAssistantStreams ?? [],
    transcriptBootstrap: input.transcriptBootstrap ?? {
      throughSequence: null,
      overlayMessageCount: 0,
      durable: emptyPage(sessionId, 'durable'),
      overlay: emptyPage(sessionId, 'overlay'),
    },
    events: input.events,
    loadTranscript: input.loadTranscript ?? (() => transcript),
    loadTranscriptOverlay: input.loadTranscriptOverlay ?? (() => transcript),
    decodeTranscriptPage: input.decodeTranscriptPage ??
      (async (): Promise<DecodedSessionTranscriptPage<StoredMessage>> => ({
        messages: [],
        nextCursor: null,
      })),
    loadTranscriptPage: input.loadTranscriptPage ??
      (async () => emptyPage(sessionId, 'durable')),
    close: input.close,
  };
}

function emptyPage(sessionId: string, source: 'durable' | 'overlay'): SessionTranscriptPage {
  return {
    kind: 'page',
    sessionId,
    source,
    direction: 'older',
    throughSequence: null,
    rawBytes: 0,
    fragments: [],
    nextCursor: null,
  };
}
