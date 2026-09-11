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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ActivationEnvironmentSecretSink,
  ActivationSecretInjector,
  type ActivationSecretInjectionLease,
  type ActivationSecretSink,
} from '../activation-secret-injector.js';
import {
  InMemoryManagedSecretStore,
  ManagedSecretError,
  type ManagedSecretMaterial,
  type ManagedSecretMetadata,
  type ResolveManagedSecretsForActivationInput,
} from '../managed-secret-store.js';

const PRINCIPAL = 'user-1';
const SESSION = 'cloud-session-1';
const CONTEXT = {
  principalId: PRINCIPAL,
  cloudSessionId: SESSION,
  activationId: 'activation-1',
};

describe('ActivationSecretInjector', () => {
  test('injects into an isolated launch environment and restores its prior state', async () => {
    const { store, first, second } = await preparedStore();
    const environment: NodeJS.ProcessEnv = { FIRST_TOKEN: 'previous', UNRELATED: 'kept' };
    const handle = await new ActivationSecretInjector(store).prepare({
      context: CONTEXT,
      bindings: [binding(first, 'FIRST_TOKEN'), binding(second, 'SECOND_TOKEN')],
      sink: new ActivationEnvironmentSecretSink(environment),
    });
    assert.deepEqual(environment, {
      FIRST_TOKEN: 'first-value',
      SECOND_TOKEN: 'second-value',
      UNRELATED: 'kept',
    });

    await handle.release();
    assert.deepEqual(environment, { FIRST_TOKEN: 'previous', UNRELATED: 'kept' });
  });

  test('literal redaction cannot rewrite its own replacement marker', async () => {
    const ids = ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012'];
    const store = new InMemoryManagedSecretStore({ newSecretId: () => ids.shift()! });
    const longer = await store.createSecret({ principalId: PRINCIPAL, value: 'long-value' });
    const markerSubstring = await store.createSecret({ principalId: PRINCIPAL, value: 'red' });
    for (const secret of [longer, markerSubstring]) {
      await store.authorizeSession({
        principalId: PRINCIPAL,
        reference: secret.reference,
        cloudSessionId: SESSION,
      });
    }
    const handle = await new ActivationSecretInjector(store).prepare({
      context: CONTEXT,
      bindings: [binding(longer, 'LONGER'), binding(markerSubstring, 'SHORTER')],
      sink: recordingSink([]),
    });
    assert.equal(handle.redact('long-value then red'), '[redacted] then [redacted]');
    await handle.release();
  });

  test('resolves before injection and gives the sink one complete batch effect', async () => {
    const { store, first, second } = await preparedStore();
    const events: string[] = [];
    const sink = recordingSink(events);
    const handle = await new ActivationSecretInjector(store).prepare({
      context: CONTEXT,
      bindings: [binding(first, 'FIRST_TOKEN'), binding(second, 'SECOND_TOKEN')],
      sink,
    });

    assert.deepEqual(events, [
      'inject:FIRST_TOKEN:first-value',
      'inject:SECOND_TOKEN:second-value',
    ]);
    assert.equal(JSON.stringify(handle).includes('first-value'), false);
    assert.deepEqual(handle.references, [first.reference, second.reference]);
    assert.equal(
      handle.redact('tool printed first-value and second-value'),
      'tool printed [redacted] and [redacted]',
    );
    assert.equal(handle.redact('the red value is first-value'), 'the red value is [redacted]');

    await handle.release();
    await handle.release();
    assert.equal(handle.redact('first-value'), 'first-value');
    assert.deepEqual(events, [
      'inject:FIRST_TOKEN:first-value',
      'inject:SECOND_TOKEN:second-value',
      'release:batch',
    ]);
  });

  test('the environment sink restores the complete batch if applying an entry fails', async () => {
    const target = { FIRST_TOKEN: 'previous', UNRELATED: 'kept' } as NodeJS.ProcessEnv;
    const environment = new Proxy(target, {
      set(object, property, value) {
        if (property === 'SECOND_TOKEN') throw new Error('setter failed');
        return Reflect.set(object, property, value);
      },
    });

    await assert.rejects(
      new ActivationEnvironmentSecretSink(environment).injectEnvironmentVariables({
        entries: [
          { name: 'FIRST_TOKEN', value: 'first-value' },
          { name: 'SECOND_TOKEN', value: 'second-value' },
        ],
      }),
      /setter failed/u,
    );
    assert.deepEqual(target, { FIRST_TOKEN: 'previous', UNRELATED: 'kept' });
  });

  test('injects nothing when any reference is missing authorization', async () => {
    const { store, first, second } = await preparedStore();
    await store.revokeSessionAuthorization({
      principalId: PRINCIPAL,
      reference: second.reference,
      cloudSessionId: SESSION,
    });
    const events: string[] = [];
    await assert.rejects(
      new ActivationSecretInjector(store).prepare({
        context: CONTEXT,
        bindings: [binding(first, 'FIRST_TOKEN'), binding(second, 'SECOND_TOKEN')],
        sink: recordingSink(events),
      }),
      (error: unknown) => error instanceof ManagedSecretError && error.code === 'unauthorized',
    );
    assert.deepEqual(events, []);
  });

  test('rejects reordered material references before the first sink effect', async () => {
    const ids = ['00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000022'];
    const store = new ReorderingManagedSecretStore({ newSecretId: () => ids.shift()! });
    const first = await store.createSecret({ principalId: PRINCIPAL, value: 'first-value' });
    const second = await store.createSecret({ principalId: PRINCIPAL, value: 'second-value' });
    for (const secret of [first, second]) {
      await store.authorizeSession({
        principalId: PRINCIPAL,
        reference: secret.reference,
        cloudSessionId: SESSION,
      });
    }
    const events: string[] = [];

    await assert.rejects(
      new ActivationSecretInjector(store).prepare({
        context: CONTEXT,
        bindings: [binding(first, 'FIRST_TOKEN'), binding(second, 'SECOND_TOKEN')],
        sink: recordingSink(events),
      }),
      (error: unknown) => error instanceof ManagedSecretError && error.code === 'integrity_failure',
    );
    assert.deepEqual(events, []);
  });

  test('uses a private material snapshot across asynchronous sink effects', async () => {
    const ids = ['00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000032'];
    const store = new MutableMaterialManagedSecretStore({ newSecretId: () => ids.shift()! });
    const first = await store.createSecret({ principalId: PRINCIPAL, value: 'first-value' });
    const second = await store.createSecret({ principalId: PRINCIPAL, value: 'second-value' });
    for (const secret of [first, second]) {
      await store.authorizeSession({
        principalId: PRINCIPAL,
        reference: secret.reference,
        cloudSessionId: SESSION,
      });
    }
    const events: string[] = [];

    const handle = await new ActivationSecretInjector(store).prepare({
      context: CONTEXT,
      bindings: [binding(first, 'FIRST_TOKEN'), binding(second, 'SECOND_TOKEN')],
      sink: {
        async injectEnvironmentVariables({ entries }) {
          store.replaceSecondMaterialWithFirst();
          events.push(...entries.map(({ name, value }) => `inject:${name}:${value}`));
          return oneShotLease(() => events.push('release:batch'));
        },
      },
    });

    assert.deepEqual(events, [
      'inject:FIRST_TOKEN:first-value',
      'inject:SECOND_TOKEN:second-value',
    ]);
    await handle.release();
  });

  test('wraps a batch sink failure without exposing resolved material', async () => {
    const { store, first, second } = await preparedStore();
    const events: string[] = [];
    const leaked = 'second-value';
    const sink: ActivationSecretSink = {
      async injectEnvironmentVariables({ entries }) {
        events.push(...entries.map(({ name, value }) => `inject:${name}:${value}`));
        throw new Error(`sink exposed ${leaked}`);
      },
    };

    await assert.rejects(
      new ActivationSecretInjector(store).prepare({
        context: CONTEXT,
        bindings: [binding(first, 'FIRST_TOKEN'), binding(second, 'SECOND_TOKEN')],
        sink,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedSecretError);
        assert.equal(error.code, 'injection_failed');
        assert.equal(error.message.includes(leaked), false);
        assert.equal(JSON.stringify(error).includes(leaked), false);
        return true;
      },
    );
    assert.deepEqual(events, [
      'inject:FIRST_TOKEN:first-value',
      'inject:SECOND_TOKEN:second-value',
    ]);
  });

  test('keeps successful-handle cleanup failures retryable', async () => {
    const { store, first } = await preparedStore();
    let attempts = 0;
    const handle = await new ActivationSecretInjector(store).prepare({
      context: CONTEXT,
      bindings: [binding(first, 'FIRST_TOKEN')],
      sink: {
        async injectEnvironmentVariables() {
          return {
            async release() {
              attempts += 1;
              if (attempts === 1) throw new Error('transient');
            },
          };
        },
      },
    });
    await assert.rejects(
      handle.release(),
      (error: unknown) => error instanceof ManagedSecretError && error.code === 'cleanup_failed',
    );
    await handle.release();
    assert.equal(attempts, 2);
  });

  test('rejects duplicate and malformed environment targets before resolution', async () => {
    const { store, first, second } = await preparedStore();
    const injector = new ActivationSecretInjector(store);
    await assert.rejects(
      injector.prepare({
        context: CONTEXT,
        bindings: [binding(first, 'TOKEN'), binding(second, 'token')],
        sink: recordingSink([]),
      }),
      (error: unknown) => error instanceof ManagedSecretError && error.code === 'invalid_input',
    );
    await assert.rejects(
      injector.prepare({
        context: CONTEXT,
        bindings: [binding(first, 'NOT-AN-ENV-NAME')],
        sink: recordingSink([]),
      }),
      (error: unknown) => error instanceof ManagedSecretError && error.code === 'invalid_input',
    );
  });
});

class ReorderingManagedSecretStore extends InMemoryManagedSecretStore {
  override async resolveForActivation(
    input: ResolveManagedSecretsForActivationInput,
  ): Promise<readonly ManagedSecretMaterial[]> {
    return [...(await super.resolveForActivation(input))].reverse();
  }
}

class MutableMaterialManagedSecretStore extends InMemoryManagedSecretStore {
  #material: ManagedSecretMaterial[] = [];

  override async resolveForActivation(
    input: ResolveManagedSecretsForActivationInput,
  ): Promise<readonly ManagedSecretMaterial[]> {
    this.#material = (await super.resolveForActivation(input)).map((item) => ({
      ...item,
      reference: { ...item.reference },
    }));
    return this.#material;
  }

  replaceSecondMaterialWithFirst(): void {
    const first = this.#material[0];
    if (first) this.#material[1] = first;
  }
}

async function preparedStore() {
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  const store = new InMemoryManagedSecretStore({
    newSecretId: () => {
      const id = ids.shift();
      if (!id) throw new Error('ids exhausted');
      return id;
    },
  });
  const first = await store.createSecret({ principalId: PRINCIPAL, value: 'first-value' });
  const second = await store.createSecret({ principalId: PRINCIPAL, value: 'second-value' });
  for (const secret of [first, second]) {
    await store.authorizeSession({
      principalId: PRINCIPAL,
      reference: secret.reference,
      cloudSessionId: SESSION,
    });
  }
  return { store, first, second };
}

function binding(secret: ManagedSecretMetadata, name: string) {
  return { reference: secret.reference, target: { kind: 'environment' as const, name } };
}

function recordingSink(events: string[]): ActivationSecretSink {
  return {
    async injectEnvironmentVariables({ entries }) {
      events.push(...entries.map(({ name, value }) => `inject:${name}:${value}`));
      return oneShotLease(() => events.push('release:batch'));
    },
  };
}

function oneShotLease(release: () => void): ActivationSecretInjectionLease {
  let released = false;
  return {
    async release() {
      if (released) return;
      release();
      released = true;
    },
  };
}
