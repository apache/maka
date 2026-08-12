import { randomUUID } from 'node:crypto';
import {
  CLIENT_CAPABILITY_MAX_RESULT_BYTES,
  CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES,
  decodeClientCapabilityReplaceInput,
  decodeClientCapabilityResult,
  type ClientCapabilityCallFrame,
  type ClientCapabilityClientFrame,
  type ClientCapabilityHostFrame,
  type ClientCapabilityReplaceInput,
  type ClientCapabilityReplaceResult,
  type ClientCapabilityServiceCallFrame,
  type ClientCapabilityUnregisterInput,
  type ClientCapabilityUnregisterResult,
} from '../protocol/index.js';
import type { ClientCapabilityProvider } from './client-capability.js';

interface ClientCapabilityRegistration {
  readonly registrationId: string;
  readonly provider: ClientCapabilityProvider;
  readonly offers: ReturnType<ClientCapabilityProvider['offers']>;
  readonly services: NonNullable<ReturnType<NonNullable<ClientCapabilityProvider['services']>>>;
}

interface ClientCapabilityInvocation {
  readonly controller: AbortController;
  admission?: ClientCapabilityAdmission;
  released: boolean;
}

interface ClientCapabilityAdmission {
  readonly promise: Promise<void>;
  resolve(): boolean;
  reject(error: unknown): boolean;
}

export interface ClientCapabilityChannelOptions {
  readonly write: (frame: ClientCapabilityClientFrame) => Promise<void>;
  readonly replace: (
    input: ClientCapabilityReplaceInput,
    timeoutMs: number,
  ) => Promise<ClientCapabilityReplaceResult>;
  readonly unregister: (
    input: ClientCapabilityUnregisterInput,
    timeoutMs: number,
  ) => Promise<ClientCapabilityUnregisterResult>;
  readonly onFailure: (error: Error) => void;
}

/** Client-owned registration, reverse invocation, and teardown lifecycle. */
export class ClientCapabilityChannel {
  readonly #options: ClientCapabilityChannelOptions;
  readonly #registrations = new Map<string, ClientCapabilityRegistration>();
  readonly #invocations = new Map<string, ClientCapabilityInvocation>();
  readonly #releasedRegistrationIds = new Set<string>();
  #currentRegistrationId: string | undefined;
  #mutationPending = false;
  #closedError: Error | undefined;

  constructor(options: ClientCapabilityChannelOptions) {
    this.#options = options;
  }

  async replace(
    provider: ClientCapabilityProvider,
    timeoutMs: number,
  ): Promise<ClientCapabilityReplaceResult> {
    this.#assertOpen();
    if (this.#mutationPending) {
      throw new Error('A Client Capability registration mutation is already pending');
    }
    this.#mutationPending = true;
    const registrationId = randomUUID();
    let registration: ClientCapabilityRegistration | undefined;
    try {
      const services = provider.services?.() ?? [];
      const canonical = decodeClientCapabilityReplaceInput({
        registrationId,
        offers: provider.offers(),
        ...(services.length === 0 ? {} : { services }),
      });
      registration = {
        registrationId,
        provider,
        offers: canonical.offers,
        services: canonical.services ?? [],
      };
      this.#registrations.set(registrationId, registration);
      const result = await this.#options.replace(canonical, timeoutMs);
      if (result.registrationId !== registrationId) {
        throw new Error('Runtime Host replaced a different Client Capability registration');
      }
      this.#currentRegistrationId = registrationId;
      this.#collectReleasedRegistrations();
      return result;
    } catch (error) {
      if (registration && this.#currentRegistrationId !== registrationId) {
        this.#registrations.delete(registrationId);
      }
      throw error;
    } finally {
      this.#mutationPending = false;
    }
  }

  async unregister(timeoutMs: number): Promise<ClientCapabilityUnregisterResult> {
    this.#assertOpen();
    if (this.#mutationPending) {
      throw new Error('A Client Capability registration mutation is already pending');
    }
    const registrationId = this.#currentRegistrationId;
    if (!registrationId) throw new Error('No Client Capability registration is active');
    this.#mutationPending = true;
    try {
      const result = await this.#options.unregister({ registrationId }, timeoutMs);
      if (result.registrationId !== registrationId) {
        throw new Error('Runtime Host unregistered a different Client Capability registration');
      }
      if (this.#currentRegistrationId === registrationId) {
        this.#currentRegistrationId = undefined;
      }
      this.#collectReleasedRegistrations();
      return result;
    } finally {
      this.#mutationPending = false;
    }
  }

  accept(frame: ClientCapabilityHostFrame): void {
    this.#assertOpen();
    switch (frame.kind) {
      case 'client.capability.call':
        this.#acceptCall(frame);
        return;
      case 'client.capability.service_call':
        this.#acceptServiceCall(frame);
        return;
      case 'client.capability.cancel': {
        const invocation = this.#invocations.get(frame.invocationId);
        if (!invocation) return;
        invocation.released = true;
        invocation.controller.abort(
          new DOMException('Client Capability invocation was cancelled', 'AbortError'),
        );
        invocation.admission?.reject(capabilityInvocationAbortReason(invocation));
        return;
      }
      case 'client.capability.release': {
        const invocation = this.#invocations.get(frame.invocationId);
        if (!invocation) return;
        invocation.released = true;
        invocation.controller.abort(
          new DOMException('Client Capability invocation was released', 'AbortError'),
        );
        invocation.admission?.reject(capabilityInvocationAbortReason(invocation));
        this.#invocations.delete(frame.invocationId);
        return;
      }
      case 'client.capability.registration_release':
        this.#releasedRegistrationIds.add(frame.registrationId);
        this.#collectReleasedRegistrations();
        return;
      case 'client.capability.admitted': {
        const invocation = this.#invocations.get(frame.invocationId);
        if (!invocation?.admission || !invocation.admission.resolve()) {
          throw new Error('Runtime Host returned an unmatched capability admission');
        }
        return;
      }
    }
  }

  close(error: Error): void {
    if (this.#closedError) return;
    this.#closedError = error;
    for (const invocation of this.#invocations.values()) {
      invocation.released = true;
      invocation.controller.abort(error);
      invocation.admission?.reject(error);
    }
    this.#invocations.clear();
    const providers = new Set(
      [...this.#registrations.values()].map((registration) => registration.provider),
    );
    this.#registrations.clear();
    this.#releasedRegistrationIds.clear();
    this.#currentRegistrationId = undefined;
    for (const provider of providers) this.#closeProvider(provider);
  }

  #acceptCall(frame: ClientCapabilityCallFrame): void {
    if (this.#invocations.has(frame.invocationId)) {
      throw new Error('Runtime Host repeated a Client Capability invocation identity');
    }
    const registration = this.#registrations.get(frame.registrationId);
    const offer = registration?.offers.find((candidate) => candidate.offerId === frame.offerId);
    const offered = offer?.tools.some(
      (tool) => tool.serverId === frame.serverId && tool.name === frame.toolName,
    );
    if (!registration || !offer || !offered || !registration.provider.call) {
      void this.#options
        .write({
          kind: 'client.capability.rejected',
          invocationId: frame.invocationId,
          message: 'Client Capability registration or tool is unavailable',
        })
        .catch((error: unknown) => this.#options.onFailure(asError(error)));
      return;
    }
    if (offer.hostPathAccess === 'none' && frame.cwd !== undefined) {
      void this.#options
        .write({
          kind: 'client.capability.rejected',
          invocationId: frame.invocationId,
          message: 'Client Capability does not allow Runtime Host paths',
        })
        .catch((error: unknown) => this.#options.onFailure(asError(error)));
      return;
    }
    const invocation: ClientCapabilityInvocation = {
      controller: new AbortController(),
      released: false,
    };
    this.#invocations.set(frame.invocationId, invocation);
    void this.#runInvocation(frame.invocationId, invocation, (options) =>
      registration.provider.call!(frame, options),
    );
  }

  #acceptServiceCall(frame: ClientCapabilityServiceCallFrame): void {
    if (this.#invocations.has(frame.invocationId)) {
      throw new Error('Runtime Host repeated a Client Capability invocation identity');
    }
    const registration = this.#registrations.get(frame.registrationId);
    const offered = registration?.services.some(
      (service) => service.serviceId === frame.serviceId && service.version === frame.version,
    );
    if (!registration || !offered || !registration.provider.callService) {
      void this.#options
        .write({
          kind: 'client.capability.rejected',
          invocationId: frame.invocationId,
          message: 'Client Capability registration or service is unavailable',
        })
        .catch((error: unknown) => this.#options.onFailure(asError(error)));
      return;
    }
    const invocation: ClientCapabilityInvocation = {
      controller: new AbortController(),
      released: false,
    };
    this.#invocations.set(frame.invocationId, invocation);
    void this.#runInvocation(frame.invocationId, invocation, async (options) =>
      decodeClientCapabilityResult({
        content: [],
        structuredContent: await registration.provider.callService!(frame, options),
      }),
    );
  }

  async #runInvocation(
    invocationId: string,
    invocation: ClientCapabilityInvocation,
    execute: (options: {
      readonly signal: AbortSignal;
      accept(): Promise<void>;
    }) => Promise<ReturnType<typeof decodeClientCapabilityResult>>,
  ): Promise<void> {
    let accepted = false;
    let accepting: Promise<void> | undefined;
    const accept = (): Promise<void> => {
      if (invocation.released) {
        return Promise.reject(capabilityInvocationAbortReason(invocation));
      }
      const admission = (invocation.admission ??= createClientCapabilityAdmission());
      accepting ??= Promise.all([
        this.#options.write({
          kind: 'client.capability.accepted',
          invocationId,
        }),
        admission.promise,
      ]).then(() => {
        accepted = true;
        if (invocation.released) throw capabilityInvocationAbortReason(invocation);
      });
      return accepting;
    };
    try {
      const result = decodeClientCapabilityResult(
        await execute({
          signal: invocation.controller.signal,
          accept,
        }),
      );
      if (invocation.released) return;
      await accept();
      await this.#sendResult(invocationId, result, invocation);
    } catch (error) {
      if (invocation.released) return;
      try {
        await this.#options.write({
          kind: accepted ? 'client.capability.failed' : 'client.capability.rejected',
          invocationId,
          message: capabilityFailureMessage(error),
        });
      } catch (writeError) {
        this.#options.onFailure(asError(writeError));
      }
    }
  }

  async #sendResult(
    invocationId: string,
    result: ReturnType<typeof decodeClientCapabilityResult>,
    invocation: ClientCapabilityInvocation,
  ): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(result), 'utf8');
    if (encoded.byteLength > CLIENT_CAPABILITY_MAX_RESULT_BYTES) {
      throw new Error('Client Capability result exceeds the byte limit');
    }
    if (encoded.byteLength <= 32 * 1024) {
      await this.#options.write({
        kind: 'client.capability.result',
        invocationId,
        result,
      });
      return;
    }
    const chunkCount = Math.ceil(encoded.byteLength / CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES);
    await this.#options.write({
      kind: 'client.capability.result_start',
      invocationId,
      byteLength: encoded.byteLength,
      chunkCount,
    });
    for (let index = 0; index < chunkCount; index += 1) {
      if (invocation.released) return;
      const start = index * CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES;
      await this.#options.write({
        kind: 'client.capability.result_chunk',
        invocationId,
        index,
        data: encoded
          .subarray(start, start + CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES)
          .toString('base64'),
      });
    }
  }

  #collectReleasedRegistrations(): void {
    for (const registrationId of this.#releasedRegistrationIds) {
      if (registrationId === this.#currentRegistrationId) continue;
      this.#releasedRegistrationIds.delete(registrationId);
      const registration = this.#registrations.get(registrationId);
      if (!registration) continue;
      this.#registrations.delete(registrationId);
      if (
        ![...this.#registrations.values()].some(
          (candidate) => candidate.provider === registration.provider,
        )
      ) {
        this.#closeProvider(registration.provider);
      }
    }
  }

  #closeProvider(provider: ClientCapabilityProvider): void {
    try {
      void Promise.resolve(provider.close?.()).catch((error: unknown) =>
        this.#options.onFailure(asError(error)),
      );
    } catch (error) {
      this.#options.onFailure(asError(error));
    }
  }

  #assertOpen(): void {
    if (this.#closedError) throw this.#closedError;
  }
}

function createClientCapabilityAdmission(): ClientCapabilityAdmission {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: () => {
      if (state !== 'pending') return false;
      state = 'resolved';
      resolvePromise();
      return true;
    },
    reject: (error) => {
      if (state !== 'pending') return false;
      state = 'rejected';
      rejectPromise(error);
      return true;
    },
  };
}

function capabilityInvocationAbortReason(invocation: ClientCapabilityInvocation): unknown {
  return (
    invocation.controller.signal.reason ??
    new DOMException('Client Capability invocation was released', 'AbortError')
  );
}

function capabilityFailureMessage(value: unknown): string {
  const message = asError(value).message.trim() || 'Client Capability provider failed';
  return message.slice(0, 4_096);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
