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

import { promptAndWait } from '@botiverse/oar/observe';

/** One native session per admitted execution; the Host retains its durable identity. */
export async function execute(runtime, request, host) {
  const installation = await runtime.installation();
  if (installation.kind !== 'available')
    return {
      kind: 'rejected',
      code: 'unavailable',
      message: `${runtime.id}: ${installation.kind}`,
    };
  if (runtime.execution !== 'process')
    throw new Error(`${runtime.id} does not declare process ownership`);
  const session = await runtime.withPlacement('isolated').session(installation, {
    cwd: request.cwd,
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    ...(request.resume === undefined ? {} : { resume: request.resume }),
    ...(request.instructions === undefined ? {} : { appendSystemPrompt: request.instructions }),
  });
  let unsubscribe = () => {};
  let outputFailure;
  let result;
  try {
    if (session.placement !== 'isolated')
      throw new Error(`${runtime.id} did not open an isolated process`);
    host.publish({
      kind: 'opened',
      sessionId: session.id,
      model: session.model().value,
      effort: session.effort().value,
      capabilities: {
        images: session.capabilities.images,
      },
    });
    // A native identity must be durable before the first prompt can have effects.
    await host.committed();
    if (host.signal.aborted) return { kind: 'aborted', text: '' };
    unsubscribe = session.events(
      (event) => {
        if (host.signal.aborted || outputFailure !== undefined) return;
        try {
          host.publish({ kind: 'event', event });
        } catch (error) {
          outputFailure = error;
          host.abort(error);
        }
      },
      { cursor: { sessionId: session.id, afterSeq: -1 } },
    );
    const run = await promptAndWait(session, request.message, {
      signal: host.signal,
      ...(request.images === undefined ? {} : { images: request.images }),
    });
    if (outputFailure !== undefined) throw outputFailure;
    await host.committed();
    result =
      run.kind === 'rejected'
        ? { kind: 'rejected', code: run.code, message: run.reason }
        : { ...run.outcome, text: run.text };
  } finally {
    try {
      await session.dispose();
      await host.committed();
    } catch (cause) {
      throw new Error('OAR session cleanup or output settlement is unconfirmed', { cause });
    } finally {
      unsubscribe();
    }
  }
  return result;
}

export async function catalog(runtime, cwd) {
  const installation = await runtime.installation();
  if (installation.kind !== 'available') return { runtime: runtime.id, installation };
  if (!runtime.listModels)
    return {
      runtime: runtime.id,
      installation,
      models: { kind: 'unsupported', reason: 'Runtime has no model discovery' },
    };
  const models = await runtime.listModels(installation, { cwd });
  return { runtime: runtime.id, installation, models };
}

export async function setup(runtime, request) {
  switch (request.action) {
    case 'probe':
      return {
        installation: await runtime.installation(),
        canInstall: typeof runtime.install === 'function',
        lines: runtime.installLines ?? [],
      };
    case 'plan':
      if (runtime.installPlan) return await runtime.installPlan(request.options);
      break;
    case 'install':
      if (runtime.install) return await runtime.install(request.options);
      break;
    default:
      throw new Error(`Unknown OAR setup action: ${request.action}`);
  }
  return {
    kind: 'unsupported',
    detail: `OAR does not provide ${request.action} for ${runtime.id}`,
  };
}
