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

export async function probe(format: 'esm' | 'cjs', mode: 'semantics' | 'gc') {
  const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
  const { createRequire } = await import('node:module');
  const { getEventListeners } = await import('node:events');
  const { setImmediate: immediate } = await import('node:timers/promises');
  const sdk: typeof import('@modelcontextprotocol/client') =
    format === 'esm'
      ? await import('@modelcontextprotocol/client')
      : createRequire(`${process.cwd()}/package.json`)('@modelcontextprotocol/client');
  type Message = import('@modelcontextprotocol/client').JSONRPCMessage;
  type SendOptions = import('@modelcontextprotocol/client').TransportSendOptions;
  type Transport = import('@modelcontextprotocol/client').Transport;
  type Client = import('@modelcontextprotocol/client').Client;
  const unhandled: unknown[] = [];
  process.on('unhandledRejection', (error) => unhandled.push(error));
  function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }
  async function fixture(modern: boolean, stream = false) {
    const sends: ReturnType<typeof deferred>[] = [];
    const wires: string[] = [];
    const errors: Error[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    let id = 0;
    let failure: 'sync' | 'early' | undefined;
    const fault = new Error('send failed');
    const transport: Transport = {
      hasPerRequestStream: stream,
      async start() {},
      async close() {
        transport.onclose?.();
      },
      send(message: Message, options?: SendOptions) {
        if ('method' in message && 'id' in message) {
          if (message.method === 'initialize' || message.method === 'server/discover') {
            const result =
              message.method === 'initialize'
                ? {
                    protocolVersion: '2025-11-25',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'fixture', version: '1' },
                  }
                : {
                    resultType: 'complete',
                    supportedVersions: ['2026-07-28'],
                    capabilities: { tools: {} },
                  };
            queueMicrotask(() => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result }));
            return Promise.resolve();
          }
          id = Number(message.id);
        } else if ('method' in message && message.method === 'notifications/initialized') {
          return Promise.resolve();
        }
        // Serialized frames may remain queued. Never retain the original message or options.
        wires.push(JSON.stringify(message));
        signals.push(options?.requestSignal);
        if (failure === 'sync') throw fault;
        if (failure === 'early') return Promise.reject(fault);
        const send = deferred();
        sends.push(send);
        return send.promise;
      },
    };
    const client = new sdk.Client(
      { name: 'send-lifetime', version: '1' },
      {
        versionNegotiation: { mode: modern ? { pin: '2026-07-28' } : 'legacy' },
      },
    );
    client.onerror = (error) => errors.push(error);
    await client.connect(transport);
    return {
      client,
      transport,
      sends,
      wires,
      errors,
      signals,
      fault,
      fail(value: typeof failure) {
        failure = value;
      },
      get id() {
        return id;
      },
      respond() {
        transport.onmessage?.({
          jsonrpc: '2.0',
          id,
          result: {
            ...(modern ? { resultType: 'complete' } : {}),
            content: [{ type: 'text', text: 'ok' }],
          },
        });
      },
      progress() {
        transport.onmessage?.({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken: id, progress: 1 },
        });
      },
    };
  }
  function registries(client: Client) {
    // Only inspect cleanup that has no public observation (including late progress removal).
    return client as unknown as {
      _responseHandlers: Map<number, unknown>;
      _timeoutInfo: Map<number, unknown>;
      _progressHandlers: Map<number, () => void>;
    };
  }
  function empty(client: Client, signal: AbortSignal) {
    assert.equal(registries(client)._responseHandlers.size, 0);
    assert.equal(registries(client)._timeoutInfo.size, 0);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
  }
  const request = (args: Record<string, unknown>) => ({
    method: 'tools/call' as const,
    params: { name: 'echo', arguments: args },
  });
  if (mode === 'semantics') {
    for (const modern of [false, true])
      for (const stream of [false, true]) {
        for (const scenario of [
          'sync',
          'early',
          'delayed',
          'success',
          'abort',
          'timeout',
          'close',
          'pre-abort',
        ] as const) {
          const f = await fixture(modern, stream);
          const controller = new AbortController();
          const reason = new sdk.SdkError(sdk.SdkErrorCode.RequestTimeout, 'cancel requested');
          if (scenario === 'pre-abort') controller.abort(reason);
          if (scenario === 'sync' || scenario === 'early') f.fail(scenario);
          let progress = 0;
          const pending = f.client.request(request({ exact: 'wire payload' }), {
            signal: controller.signal,
            timeout: scenario === 'timeout' ? 5 : 5000,
            onprogress() {
              progress++;
            },
          });
          const outcome = pending.then(
            (result) => ({ result, error: undefined }),
            (error: unknown) => ({ result: undefined, error }),
          );
          if (f.sends.length) {
            f.progress();
            await immediate();
            assert.equal(progress, 1);
          }
          if (scenario === 'delayed') f.sends[0].reject(f.fault);
          if (scenario === 'success') f.respond();
          if (scenario === 'abort') controller.abort(reason);
          if (scenario === 'close') await f.client.close();
          const value = await outcome;
          empty(f.client, controller.signal);
          if (scenario === 'success') {
            assert.deepEqual(value.result?.content, [{ type: 'text', text: 'ok' }]);
            controller.abort(reason);
            assert.equal(f.wires.length, 1);
            assert.equal(f.signals[0]?.aborted, modern && stream ? false : undefined);
          } else {
            assert.ok(value.error instanceof Error);
            if (['sync', 'early', 'delayed'].includes(scenario)) assert.equal(value.error, f.fault);
            if (scenario === 'abort' || scenario === 'pre-abort') assert.equal(value.error, reason);
            if (scenario === 'timeout')
              assert.equal(
                (value.error as InstanceType<typeof sdk.SdkError>).code,
                sdk.SdkErrorCode.RequestTimeout,
              );
          }
          if (scenario === 'abort' || scenario === 'timeout') {
            if (modern && stream) {
              assert.equal(f.signals[0]?.aborted, true);
              assert.equal(f.wires.length, 1);
            } else {
              assert.equal(f.wires.length, 2);
              const cancelled = JSON.parse(f.wires[1]);
              assert.equal(cancelled.method, 'notifications/cancelled');
              assert.equal(cancelled.params.requestId, f.id);
              assert.match(
                cancelled.params.reason,
                scenario === 'abort' ? /cancel requested/ : /Request timed out/,
              );
              f.sends[1].reject(new Error('late cancellation failure'));
              await immediate();
              assert.deepEqual(
                f.errors.map((error) => error.message),
                ['Failed to send cancellation: Error: late cancellation failure'],
              );
            }
          }
          if (f.sends.length && scenario !== 'delayed') {
            registries(f.client)._progressHandlers.set(f.id, () => {});
            f.sends[0].reject(new Error('late send failure'));
            await immediate();
            assert.equal(registries(f.client)._progressHandlers.size, 0);
          }
          if (scenario === 'pre-abort') assert.equal(f.wires.length, 0);
          await f.client.close();
        }
      }
  } else {
    assert.ok(global.gc);
    const gc = global.gc;
    const held: Awaited<ReturnType<typeof fixture>>[] = [];
    const refs: { label: string; weak: WeakRef<object> }[] = [];
    const remember = (label: string, object: object) =>
      refs.push({ label, weak: new WeakRef(object) });
    async function allocate() {
      for (const modern of [false, true])
        for (const scenario of ['success', 'abort', 'timeout', 'close']) {
          const f = await fixture(modern);
          held.push(f);
          const controller = new AbortController();
          const args = { payload: 'retained request payload'.repeat(4096) };
          const options = { signal: controller.signal, timeout: scenario === 'timeout' ? 5 : 5000 };
          remember(`${modern}/${scenario}/arguments`, args);
          remember(`${modern}/${scenario}/options`, options);
          const pending = f.client.request(request(args), options).then(
            (result) => remember(`${modern}/${scenario}/result`, result),
            (error: object) => remember(`${modern}/${scenario}/error`, error),
          );
          if (scenario === 'success') f.respond();
          if (scenario === 'abort') controller.abort('cancel requested');
          if (scenario === 'close') await f.client.close();
          await pending;
          empty(f.client, controller.signal);
        }
    }
    await allocate();
    const active = await fixture(false);
    let activeArgs: Record<string, unknown> | undefined = { payload: 'active' };
    const activeRef = new WeakRef(activeArgs);
    const activeRequest = active.client.request(request(activeArgs), { timeout: 5000 });
    activeArgs = undefined;
    for (let cycle = 0; cycle < 10; cycle++) {
      await immediate();
      gc();
    }
    await immediate();
    assert.ok(activeRef.deref(), 'active request must remain owned until response');
    assert.deepEqual(
      refs.filter((ref) => ref.weak.deref()).map((ref) => ref.label),
      [],
      'settled objects retained by pending sends',
    );
    for (const f of held) {
      assert.equal(
        await Promise.race([
          f.sends[0].promise.then(() => 'settled'),
          immediate().then(() => 'pending'),
        ]),
        'pending',
      );
      for (const send of f.sends) send.resolve();
      await f.client.close();
    }
    active.respond();
    await activeRequest;
    active.sends[0].resolve();
    await active.client.close();
  }
  await immediate();
  assert.deepEqual(unhandled, []);
  console.log('pending sends verified');
}
