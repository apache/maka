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

import { FramedByteStreamTransport } from '../transport/framed-byte-stream-transport.js';
import {
  readRuntimeHostPeerAuthentication,
  RUNTIME_HOST_PEER_AUTHENTICATION_TIMEOUT_MS,
  RuntimeHostPeerByteStream,
  writeRuntimeHostPeerAuthenticationResult,
  type RuntimeHostPeerNativeStream,
} from '../transport/peer-native.js';
import type { RuntimeHostPeerClient } from '../client/peer-client.js';
import type { PeerReachabilityPublisher } from '../peer-reachability/index.js';
import type { RuntimeHostAccessAuthority } from './access-authority.js';
import {
  ResumablePeerStream,
  PeerResumeRejectedError,
} from '../transport/resumable-peer-stream.js';
import type { RuntimeHostConnectionAuthority } from './connection-authority.js';
import type {
  RuntimeHostListenerConnection,
  RuntimeHostPeerListener as RuntimeHostPeerListenerContract,
} from './listener-set.js';

const MAX_PENDING_AUTHENTICATIONS = 16;
// A Desktop shares one PeerId across 128 Guest mounts and 32 Host profiles.
// Authentication, not a transport identity, determines the small abuse quota.
const MAX_ACTIVE_STREAMS = 256;
const MAX_ACTIVE_STREAMS_PER_PEER = 160;
const MAX_ACTIVE_STREAMS_PER_PRINCIPAL = 4;

export interface RuntimeHostPeerListenerConfiguration {
  readonly nativePath: string;
  readonly keyPath: string;
  readonly expectedPeerId?: string;
  readonly listenAddresses?: readonly string[];
  readonly coordinationRelays?: readonly string[];
  readonly automaticRelayDiscovery?: boolean;
  readonly webRtcStunUrls?: readonly string[];
}

export interface RuntimeHostPeerListenerEndpointOptions {
  readonly client: RuntimeHostPeerClient;
  readonly reachability: PeerReachabilityPublisher;
}

export type StartRuntimeHostPeerListenerOptions = RuntimeHostPeerListenerEndpointOptions & {
  readonly accessAuthority: RuntimeHostAccessAuthority;
  readonly accept: (connection: RuntimeHostListenerConnection) => void;
};

export function startRuntimeHostPeerListener(
  options: StartRuntimeHostPeerListenerOptions,
): RuntimeHostPeerListenerContract {
  return createRuntimeHostPeerListener(
    options.client,
    options.reachability,
    options.accessAuthority,
    options.accept,
  );
}

export function createRuntimeHostPeerListener(
  client: RuntimeHostPeerClient,
  reachability: PeerReachabilityPublisher,
  accessAuthority: RuntimeHostAccessAuthority,
  accept: (connection: RuntimeHostListenerConnection) => void,
): RuntimeHostPeerListenerContract {
  return new RuntimeHostPeerListener(client, reachability, accessAuthority, accept);
}

class RuntimeHostPeerListener implements RuntimeHostPeerListenerContract {
  readonly kind = 'libp2p_direct' as const;
  readonly endpoint: string;
  readonly #reachability: PeerReachabilityPublisher;
  readonly #accessAuthority: RuntimeHostAccessAuthority;
  readonly #accept: (connection: RuntimeHostListenerConnection) => void;
  readonly #transports = new Set<FramedByteStreamTransport>();
  readonly #streams = new Map<RuntimeHostPeerNativeStream, RuntimeHostConnectionAuthority>();
  readonly #sessions = new Map<
    string,
    { stream: ResumablePeerStream; authority: RuntimeHostConnectionAuthority }
  >();
  readonly #unsubscribeRevocations: () => void;
  readonly #authentications = new Map<RuntimeHostPeerNativeStream, Promise<void>>();
  readonly #serving: Promise<void>;
  readonly #serveLifetime = new AbortController();
  #acceptFailure: unknown;
  #admitting = true;
  #closeAdmissionTask: Promise<void> | undefined;
  #cleanupTask: Promise<void> | undefined;

  constructor(
    client: RuntimeHostPeerClient,
    reachability: PeerReachabilityPublisher,
    accessAuthority: RuntimeHostAccessAuthority,
    accept: (connection: RuntimeHostListenerConnection) => void,
  ) {
    const identity = client.identity();
    this.endpoint = identity.peerId;
    this.#reachability = reachability;
    this.#accessAuthority = accessAuthority;
    this.#accept = accept;
    this.#unsubscribeRevocations = accessAuthority.subscribeRevocations((credentialId) => {
      for (const session of this.#sessions.values()) {
        if (session.authority.credentialId === credentialId) session.stream.abort();
      }
    });
    const captureFailure = (error: unknown) => {
      this.#acceptFailure ??= error;
    };
    this.#serving = client
      .serveApplication((stream) => this.#acceptStream(stream), this.#serveLifetime.signal)
      .catch(captureFailure);
  }

  get reachability() {
    return this.#reachability.current();
  }

  closeAdmission(): Promise<void> {
    this.#closeAdmissionTask ??= (async () => {
      this.#admitting = false;
      for (const stream of this.#authentications.keys()) stream.abort();
      await Promise.allSettled([...this.#authentications.values()]);
    })();
    return this.#closeAdmissionTask;
  }

  cleanup(): Promise<void> {
    this.#cleanupTask ??= (async () => {
      await this.closeAdmission();
      for (const transport of this.#transports) transport.abort();
      for (const session of this.#sessions.values()) session.stream.abort();
      this.#unsubscribeRevocations();
      this.#serveLifetime.abort();
      await this.#serving;
      if (this.#acceptFailure) throw this.#acceptFailure;
    })();
    return this.#cleanupTask;
  }

  #acceptStream(stream: RuntimeHostPeerNativeStream): void {
    if (!this.#admitting || this.#authentications.size >= MAX_PENDING_AUTHENTICATIONS) {
      stream.abort();
      return;
    }
    const task = this.#authenticateAndAccept(stream).finally(() => {
      this.#authentications.delete(stream);
    });
    this.#authentications.set(stream, task);
    void task;
  }

  async #authenticateAndAccept(stream: RuntimeHostPeerNativeStream): Promise<void> {
    let transportOwnsStream = false;
    try {
      const authenticated = await withDeadline(
        readRuntimeHostPeerAuthentication(stream),
        RUNTIME_HOST_PEER_AUTHENTICATION_TIMEOUT_MS,
        () => stream.abort(),
      );
      const authority = this.#accessAuthority.authenticate(authenticated.credential);
      if (!authority) {
        await writeRuntimeHostPeerAuthenticationResult(stream, false);
        await stream.close();
        return;
      }
      if (!this.#admitting) {
        stream.abort();
        return;
      }
      const resume = authenticated.resume;
      const existing = resume ? this.#sessions.get(resume.sessionId) : undefined;
      if (existing) {
        if (
          existing.stream.peerId !== stream.peerId ||
          existing.authority.credentialId !== authority.credentialId ||
          existing.authority.principalKind !== authority.principalKind ||
          existing.authority.principalId !== authority.principalId
        ) {
          await writeRuntimeHostPeerAuthenticationResult(stream, false);
          stream.abort();
          return;
        }
        existing.stream.reserve(resume!);
        await writeRuntimeHostPeerAuthenticationResult(stream, true, {
          received: existing.stream.received,
        });
        if (!this.#admitting || !this.#accessAuthority.authenticate(authenticated.credential)) {
          stream.abort();
          return;
        }
        existing.stream.attach(resume!.generation, {
          stream,
          remainder: authenticated.remainder,
          received: resume!.received,
        });
        return;
      }
      // Recovery must never create a second Host connection after state loss.
      if (resume && (resume.generation !== 1 || resume.received !== 0)) {
        await writeRuntimeHostPeerAuthenticationResult(stream, false);
        stream.abort();
        return;
      }
      let peerStreams = 0;
      let principalStreams = 0;
      for (const [admitted, owner] of this.#streams) {
        if (admitted.peerId === stream.peerId) peerStreams++;
        if (
          owner.principalKind === authority.principalKind &&
          owner.principalId === authority.principalId
        )
          principalStreams++;
      }
      if (
        this.#streams.size >= MAX_ACTIVE_STREAMS ||
        peerStreams >= MAX_ACTIVE_STREAMS_PER_PEER ||
        principalStreams >= MAX_ACTIVE_STREAMS_PER_PRINCIPAL
      ) {
        // Legacy peers cannot distinguish capacity from credential rejection.
        // Keep their previous EOF behavior, but give v2 clients a typed result.
        if (resume) {
          await writeRuntimeHostPeerAuthenticationResult(stream, false, {
            reason: 'capacity_exceeded',
          });
          await stream.close();
        } else stream.abort();
        return;
      }
      const logical = resume
        ? new ResumablePeerStream({ peerId: stream.peerId, sessionId: resume.sessionId })
        : undefined;
      if (logical && resume) {
        logical.reserve(resume);
        this.#sessions.set(resume.sessionId, { stream: logical, authority });
        void logical.closed.then(() => {
          if (this.#sessions.get(resume.sessionId)?.stream === logical)
            this.#sessions.delete(resume.sessionId);
        });
      }
      const admittedStream = logical ?? stream;
      this.#streams.set(admittedStream, authority);
      let accepted = false;
      try {
        await writeRuntimeHostPeerAuthenticationResult(
          stream,
          true,
          logical ? { received: 0 } : undefined,
        );
        if (!this.#admitting) {
          stream.abort();
          return;
        }
        const admittedAuthority = this.#accessAuthority.authenticate(authenticated.credential);
        if (!admittedAuthority) {
          stream.abort();
          return;
        }
        const transport = new FramedByteStreamTransport(
          new RuntimeHostPeerByteStream(
            admittedStream,
            logical ? Buffer.alloc(0) : authenticated.remainder,
          ),
        );
        if (logical && resume)
          logical.attach(resume.generation, {
            stream,
            remainder: authenticated.remainder,
            received: 0,
          });
        this.#transports.add(transport);
        transportOwnsStream = true;
        accepted = true;
        void transport.closed.then(() => {
          this.#transports.delete(transport);
          this.#streams.delete(admittedStream);
        });
        try {
          this.#accept({ transport, authority: admittedAuthority });
        } catch (error) {
          transport.abort(asError(error));
        }
      } finally {
        if (!accepted) {
          admittedStream.abort();
          this.#streams.delete(admittedStream);
        }
      }
    } catch (error) {
      if (error instanceof PeerResumeRejectedError) {
        await writeRuntimeHostPeerAuthenticationResult(stream, false).catch(() => undefined);
      }
      stream.abort();
    } finally {
      if (!transportOwnsStream) this.#streams.delete(stream);
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error('Peer authentication timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
