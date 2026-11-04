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
import { serveMcpTools } from '@botiverse/oar';
import { hostToolsRefusal } from './host-tools.mjs';

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
  const refusal = request.tools?.length ? hostToolsRefusal(runtime) : undefined;
  let served;
  let session;
  let unsubscribe = () => {};
  let outputFailure;
  let result;
  try {
    if (request.tools?.length && !refusal) {
      served = await serveMcpTools({
        name: 'maka',
        instructions:
          'Maka Host tools provide conversation orchestration, skills, recall and workbench interactions. Use your native tools for local files, shell and web. Read, when offered here, only reads Maka resources. Observe original execution receipts before retrying mutations.',
        tools: host.tools.definitions(request.tools),
      });
    }
    session = await runtime.withPlacement('isolated').session(installation, {
      cwd: request.cwd,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.resume === undefined ? {} : { resume: request.resume }),
      ...(request.instructions === undefined ? {} : { appendSystemPrompt: request.instructions }),
      ...(served === undefined ? {} : { mcpServers: [served.server] }),
    });
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
    if (refusal) {
      host.publish({ kind: 'host_tools_unavailable', reason: refusal });
      await host.committed();
    }
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
    const message = refusal
      ? `[Maka Host tools are unavailable in this runtime: ${refusal}]\n\n${request.message}`
      : request.message;
    const run = await promptAndWait(session, message, {
      signal: host.signal,
      ...(request.images === undefined ? {} : { images: request.images }),
    });
    if (outputFailure !== undefined) throw outputFailure;
    await host.committed();
    result =
      run.kind === 'rejected'
        ? { kind: 'rejected', code: run.code, message: run.reason }
        : { ...run.outcome, text: run.text };
  } catch (error) {
    result =
      host.signal.aborted && outputFailure === undefined
        ? { kind: 'aborted', text: '' }
        : {
            kind: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          };
  } finally {
    try {
      try {
        await session?.dispose();
      } finally {
        await served?.close();
        await host.tools?.close();
      }
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
  const installation = await observe(() => runtime.installation());
  if (installation.kind !== 'available') return { runtime: runtime.id, installation };
  if (!runtime.listModels)
    return {
      runtime: runtime.id,
      installation,
      models: { kind: 'unsupported', reason: 'Runtime has no model discovery' },
    };
  const models = await observe(() => runtime.listModels(installation, { cwd }));
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

async function observe(read) {
  try {
    return await read();
  } catch (error) {
    return {
      kind: 'error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Fresh status is separate from model search: native auth readers may refresh credentials. */
export async function status(runtime, cwd) {
  const nativeInstallation = await observe(() => runtime.installation());
  let installation;
  switch (nativeInstallation.kind) {
    case 'available':
      installation = {
        kind: 'available',
        ...(nativeInstallation.version === undefined
          ? {}
          : { version: nativeInstallation.version }),
      };
      break;
    case 'not_found':
    case 'error':
      installation = nativeInstallation;
      break;
    case 'unsupported':
      installation = { kind: 'unsupported', detail: nativeInstallation.reason };
      break;
    default:
      installation = {
        kind: 'error',
        detail: `Unknown installation status: ${nativeInstallation.kind}`,
      };
  }
  const available = installation.kind === 'available';
  const authentication = !available
    ? {
        kind: 'unknown',
        detail: 'Authentication was not probed because the runtime is unavailable.',
      }
    : await observe(async () => {
        if (!runtime.authStatus) return { kind: 'unsupported' };
        const auth = await runtime.authStatus(nativeInstallation);
        switch (auth.kind) {
          case 'logged_in':
            return { kind: 'authenticated', source: auth.source };
          case 'logged_out':
            return {
              kind: 'unauthenticated',
              source: auth.source,
              ...(auth.detail === undefined ? {} : { detail: auth.detail }),
            };
          case 'unknown':
            return auth;
          default:
            throw new Error(`Unknown authentication status: ${auth.kind}`);
        }
      });
  const models = !available
    ? { kind: 'unavailable' }
    : await observe(async () => {
        if (!runtime.listModels)
          return {
            kind: 'unsupported',
            detail: 'Runtime has no model discovery',
          };
        const result = await runtime.listModels(nativeInstallation, { cwd });
        switch (result.kind) {
          case 'ok':
            return { kind: 'ready', count: result.models.length };
          case 'unauthenticated':
            return result;
          case 'unsupported':
            return { kind: 'unsupported', detail: result.reason };
          default:
            throw new Error(`Unknown model status: ${result.kind}`);
        }
      });
  return {
    id: runtime.id,
    name: runtime.brand.name,
    installation,
    authentication,
    models,
    canInstall: typeof runtime.install === 'function',
    installLines: runtime.installLines ?? [],
  };
}
