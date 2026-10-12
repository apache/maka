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

import {
  agent,
  methods,
  RequestError,
  type AgentContext,
  type AgentApp,
  type ClientCapabilities,
} from '@agentclientprotocol/sdk';
import { HOST_OPERATION_SPECS } from '@maka/runtime-host/protocol';
import { goalPlanRouteInput } from './goal-plan-routes.js';
import type { AcpLoadContext, AcpSessionRegistry } from './session-registry.js';

export interface MakaAcpAgentOptions {
  readonly version: string;
  readonly sessionRegistry: Pick<
    AcpSessionRegistry,
    | 'create'
    | 'load'
    | 'resume'
    | 'resumeTurn'
    | 'goalQuery'
    | 'goalArm'
    | 'goalControl'
    | 'planQuery'
    | 'planControl'
    | 'planTurnStart'
    | 'queryCopySource'
    | 'branch'
    | 'createRevision'
    | 'abandonRevision'
    | 'list'
    | 'setConfigOption'
    | 'prompt'
    | 'cancel'
    | 'close'
    | 'artifactQuery'
    | 'artifactIngest'
    | 'artifactDelete'
    | 'memoryQuery'
    | 'memoryMutate'
  >;
}

export function createMakaAcpAgent(options: MakaAcpAgentOptions): AgentApp {
  let clientCapabilities: ClientCapabilities = {};
  return agent({ name: 'maka' })
    .onRequest(methods.agent.initialize, ({ params }) => {
      clientCapabilities = structuredClone(params.clientCapabilities ?? {});
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {}, close: {} },
          _meta: { '_maka/goalPlan': { version: 1 } },
        },
        authMethods: [],
        agentInfo: { name: 'maka', title: 'Maka', version: options.version },
      };
    })
    .onRequest(methods.agent.session.new, ({ params, signal }) =>
      options.sessionRegistry.create(params, signal),
    )
    .onRequest(methods.agent.session.load, ({ params, signal, client }) =>
      options.sessionRegistry.load(
        params,
        sessionContext(client, signal, clientCapabilities, true),
      ),
    )
    .onRequest(methods.agent.session.resume, ({ params, signal, client }) =>
      options.sessionRegistry.resume(
        params,
        sessionContext(client, signal, clientCapabilities, true),
      ),
    )
    .onRequest(
      '_maka/turn/resume',
      (value: unknown) => {
        try {
          return HOST_OPERATION_SPECS['turn.resume.query'].decodeInput(value);
        } catch {
          throw RequestError.invalidParams(
            { reason: 'invalid_resume_query' },
            'Invalid Turn resume request',
          );
        }
      },
      ({ params, signal, client }) =>
        options.sessionRegistry.resumeTurn(
          params,
          sessionContext(client, signal, clientCapabilities, true),
        ),
    )
    .onRequest('_maka/goal/query', goalPlanRouteInput('goal.query'), ({ params, signal, client }) =>
      options.sessionRegistry.goalQuery(
        params,
        sessionContext(client, signal, clientCapabilities, true),
      ),
    )
    .onRequest('_maka/goal/arm', goalPlanRouteInput('goal.arm'), ({ params, signal, client }) =>
      options.sessionRegistry.goalArm(
        params,
        sessionContext(client, signal, clientCapabilities, true),
      ),
    )
    .onRequest(
      '_maka/goal/control',
      goalPlanRouteInput('goal.control'),
      ({ params, signal, client }) =>
        options.sessionRegistry.goalControl(
          params,
          sessionContext(client, signal, clientCapabilities, true),
        ),
    )
    .onRequest('_maka/plan/query', goalPlanRouteInput('plan.query'), ({ params, signal, client }) =>
      options.sessionRegistry.planQuery(
        params,
        sessionContext(client, signal, clientCapabilities, true),
      ),
    )
    .onRequest(
      '_maka/plan/control',
      goalPlanRouteInput('plan.control'),
      ({ params, signal, client }) =>
        options.sessionRegistry.planControl(
          params,
          sessionContext(client, signal, clientCapabilities, true),
        ),
    )
    .onRequest(
      '_maka/plan/turn/start',
      goalPlanRouteInput('plan.turn.start'),
      ({ params, signal, client }) =>
        options.sessionRegistry.planTurnStart(
          params,
          sessionContext(client, signal, clientCapabilities, true),
        ),
    )
    .onRequest(
      '_maka/session/copy-source/query',
      {
        parse: (value: unknown) => {
          try {
            return HOST_OPERATION_SPECS['session.turns.query'].decodeInput(value);
          } catch {
            throw RequestError.invalidParams(
              { reason: 'invalid_copy_source_query' },
              'Invalid Session copy source query',
            );
          }
        },
      },
      ({ params }) => options.sessionRegistry.queryCopySource(params),
    )
    .onRequest(
      '_maka/session/branch/create',
      {
        parse: (value: unknown) => {
          try {
            return HOST_OPERATION_SPECS['session.branch.create'].decodeInput(value);
          } catch {
            throw RequestError.invalidParams(
              { reason: 'invalid_branch_input' },
              'Invalid Session branch request',
            );
          }
        },
      },
      ({ params }) => options.sessionRegistry.branch(params),
    )
    .onRequest(
      '_maka/session/revision/create',
      {
        parse: (value: unknown) => {
          try {
            return HOST_OPERATION_SPECS['session.revision.create'].decodeInput(value);
          } catch {
            throw RequestError.invalidParams(
              { reason: 'invalid_revision_input' },
              'Invalid Session revision request',
            );
          }
        },
      },
      ({ params }) => options.sessionRegistry.createRevision(params),
    )
    .onRequest(
      '_maka/session/revision/abandon',
      {
        parse: (value: unknown) => {
          try {
            return HOST_OPERATION_SPECS['session.revision.abandon'].decodeInput(value);
          } catch {
            throw RequestError.invalidParams(
              { reason: 'invalid_abandon_input' },
              'Invalid Session abandon request',
            );
          }
        },
      },
      ({ params }) => options.sessionRegistry.abandonRevision(params),
    )
    .onRequest(methods.agent.session.list, ({ params }) => options.sessionRegistry.list(params))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) =>
      options.sessionRegistry.setConfigOption(params),
    )
    .onRequest(methods.agent.session.prompt, ({ params, signal, client }) =>
      options.sessionRegistry.prompt(params, sessionContext(client, signal, clientCapabilities)),
    )
    .onNotification(methods.agent.session.cancel, ({ params }) =>
      options.sessionRegistry.cancel(params),
    )
    .onRequest(methods.agent.session.close, ({ params }) => options.sessionRegistry.close(params))
    .onRequest(
      '_maka/artifact/query',
      extensionParams('artifact.query', HOST_OPERATION_SPECS['artifact.query'].decodeInput),
      ({ params }) => options.sessionRegistry.artifactQuery(params),
    )
    .onRequest(
      '_maka/artifact/ingest',
      extensionParams('artifact.ingest', HOST_OPERATION_SPECS['artifact.ingest'].decodeInput),
      ({ params }) => options.sessionRegistry.artifactIngest(params),
    )
    .onRequest(
      '_maka/artifact/delete',
      extensionParams('artifact.delete', HOST_OPERATION_SPECS['artifact.delete'].decodeInput),
      ({ params }) => options.sessionRegistry.artifactDelete(params),
    )
    .onRequest(
      '_maka/memory/query',
      extensionParams('memory.query', HOST_OPERATION_SPECS['memory.query'].decodeInput),
      ({ params }) => options.sessionRegistry.memoryQuery(params),
    )
    .onRequest(
      '_maka/memory/mutate',
      extensionParams('memory.mutate', HOST_OPERATION_SPECS['memory.mutate'].decodeInput),
      ({ params }) => options.sessionRegistry.memoryMutate(params),
    );
}

function extensionParams<Input>(
  operation: string,
  decode: (params: unknown) => Input,
): (params: unknown) => Input {
  return (params) => {
    try {
      if (params && typeof params === 'object' && !Array.isArray(params) && '_meta' in params) {
        const record = params as Record<string, unknown>;
        const meta = record._meta;
        if (
          meta !== undefined &&
          meta !== null &&
          (typeof meta !== 'object' || Array.isArray(meta))
        ) {
          throw new Error('Invalid ACP request metadata');
        }
        const { _meta: _ignored, ...domainParams } = record;
        return decode(domainParams);
      }
      return decode(params);
    } catch {
      throw RequestError.invalidParams(
        { source: 'adapter', operation, code: 'invalid_request' },
        `Invalid ${operation} request`,
      );
    }
  };
}

function sessionContext(
  client: AgentContext,
  signal: AbortSignal,
  capabilities: ClientCapabilities,
  turnStatus = false,
): AcpLoadContext {
  return {
    signal,
    notify: (notification) => client.notify(methods.client.session.update, notification),
    interactions: {
      capabilities,
      requestPermission: (request, cancellationSignal) =>
        client.request(methods.client.session.requestPermission, request, { cancellationSignal }),
      createElicitation: (request, cancellationSignal) =>
        client.request(methods.client.elicitation.create, request, { cancellationSignal }),
    },
    ...(turnStatus && capabilities._meta?.['_maka/turnStatus'] === true
      ? {
          notifyTurnStatus: (
            status: Parameters<NonNullable<AcpLoadContext['notifyTurnStatus']>>[0],
          ) => client.notify('_maka/turn/status', status),
        }
      : {}),
    ...(capabilities._meta?.['_maka/goalPlanStatus'] === true
      ? {
          notifyGoalStatus: (
            status: Parameters<NonNullable<AcpLoadContext['notifyGoalStatus']>>[0],
          ) => client.notify('_maka/goal/status', status),
          notifyPlanChanged: (
            status: Parameters<NonNullable<AcpLoadContext['notifyPlanChanged']>>[0],
          ) => client.notify('_maka/plan/changed', status),
        }
      : {}),
  };
}
