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
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { describe, test } from 'node:test';
import { methods, RequestError } from '@agentclientprotocol/sdk';
import { waitFor } from '@maka/core/test-only/async-primitives';
import { connectRuntimeHost } from '@maka/runtime-host/client';
import {
  RUNTIME_HOST_PROTOCOL_VERSION,
  type PlanTurnStartResult,
} from '@maka/runtime-host/protocol';
import { withAcpChildProcessHarness } from './acp-child-process-harness.js';

describe('ACP Goal/Plan real Host routes', () => {
  for (const restoreMethod of [undefined, 'load', 'resume'] as const) {
    test(restoreMethod
      ? `${restoreMethod} reuses an active Plan observer across retries, cancellation and close`
      : 'cancel stops the exact Plan Turn and close/EOF release its attachment', {
      timeout: 30_000,
    }, async () => {
      let submitted = false;
      let executionCalls = 0;
      let executionResponse: ServerResponse | undefined;
      let executionStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        executionStarted = resolve;
      });
      const model = createServer((request, response) => {
        void readRequest(request)
          .then((body) => {
            const input = JSON.parse(body) as {
              stream?: boolean;
              tools?: Array<{ function?: { name?: string } }>;
            };
            if (input.stream !== true) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  id: 'summary',
                  object: 'chat.completion',
                  created: 1,
                  model: 'cancel-plan-fixture',
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: 'Summary' },
                      finish_reason: 'stop',
                    },
                  ],
                }),
              );
              return;
            }
            const names = (input.tools ?? []).flatMap((tool) =>
              tool.function?.name ? [tool.function.name] : [],
            );
            if (!submitted && names.includes('SubmitPlan')) {
              submitted = true;
              respondTool(response, 'SubmitPlan', {
                title: 'Cancellable plan',
                steps: [{ id: 'step-1', title: 'Wait', description: 'Wait for cancellation' }],
              });
            } else if (!submitted) respondTool(response, 'tool_search', { query: 'SubmitPlan' });
            else {
              executionCalls += 1;
              executionResponse = response;
              response.writeHead(200, { 'content-type': 'text/event-stream' });
              response.write(
                `data: ${JSON.stringify(modelChunk({ role: 'assistant', content: 'Working.' }, null))}\n\n`,
              );
              executionStarted();
            }
          })
          .catch((error: unknown) => response.destroy(error as Error));
      });
      await new Promise<void>((resolve, reject) => {
        model.once('error', reject);
        model.listen(0, '127.0.0.1', resolve);
      });
      const address = model.address();
      assert.ok(address && typeof address !== 'string');
      try {
        await withAcpChildProcessHarness(
          async (harness) => {
            const statuses: unknown[] = [];
            await harness.withClient(
              async ({ context }) => {
                await context.request(methods.agent.initialize, {
                  protocolVersion: 1,
                  clientCapabilities: { _meta: { '_maka/turnStatus': true } },
                });
                const { sessionId } = await context.request(methods.agent.session.new, {
                  cwd: harness.workspaceRoot,
                  mcpServers: [],
                });
                await context.request(methods.agent.session.setConfigOption, {
                  sessionId,
                  configId: 'collaboration_mode',
                  value: 'plan',
                });
                await context.request(methods.agent.session.prompt, {
                  sessionId,
                  prompt: [{ type: 'text', text: 'Prepare a cancellable plan' }],
                });
                const page = (await context.request('_maka/plan/query', {
                  kind: 'list_start',
                  sessionId,
                })) as {
                  storeVersion: number;
                  items: Array<{
                    kind: string;
                    proposal?: { proposalId: string; revision: number };
                  }>;
                };
                const proposal = page.items.find((item) => item.kind === 'proposal')?.proposal;
                assert.ok(proposal);
                const approvalInput = {
                  kind: 'approve_proposal' as const,
                  sessionId,
                  proposalId: proposal.proposalId,
                  expectedRevision: proposal.revision,
                  expectedStoreVersion: page.storeVersion,
                  turnId: randomUUID(),
                };
                const admission = (await context.request(
                  '_maka/plan/turn/start',
                  approvalInput,
                )) as PlanTurnStartResult;
                await started;
                if (restoreMethod) {
                  const sibling = await harness.spawnSibling();
                  const restoredStatuses: unknown[] = [];
                  const restoredText: string[] = [];
                  try {
                    await sibling.withClient(
                      async ({ context: restored }) => {
                        await restored.request(methods.agent.initialize, {
                          protocolVersion: 1,
                          clientCapabilities: { _meta: { '_maka/turnStatus': true } },
                        });
                        await restored.request(methods.agent.session[restoreMethod], {
                          sessionId,
                          cwd: harness.workspaceRoot,
                          mcpServers: [],
                        });
                        for (let retry = 0; retry < 2; retry += 1) {
                          const replay = (await restored.request(
                            '_maka/plan/turn/start',
                            approvalInput,
                          )) as PlanTurnStartResult;
                          assert.equal(replay.turn.turnId, admission.turn.turnId);
                          assert.equal(replay.turn.runId, admission.turn.runId);
                          assert.equal(replay.turn.status, 'running');
                          assert.equal(replay.plan.executionId, admission.plan.executionId);
                        }
                        // A rejected replay must not dispose the retained output consumer.
                        await assert.rejects(
                          restored.request('_maka/plan/turn/start', {
                            ...approvalInput,
                            expectedRevision: proposal.revision + 1,
                          }),
                          (error: unknown) =>
                            error instanceof RequestError &&
                            (error.data as { code?: string }).code === 'operation_conflict',
                        );
                        assert.ok(executionResponse);
                        executionResponse.write(
                          `data: ${JSON.stringify(modelChunk({ content: 'After restored replay.' }, null))}\n\n`,
                        );
                        await waitFor(() =>
                          restoredText.join('').includes('After restored replay.'),
                        );
                        await restored.notify(methods.agent.session.cancel, { sessionId });
                        await waitFor(() => restoredStatuses.length > 0);
                        assert.equal(
                          (restoredStatuses[0] as { turnId: string }).turnId,
                          admission.turn.turnId,
                        );
                        await restored.request(methods.agent.session.close, { sessionId });
                      },
                      (app) =>
                        app
                          .onNotification(methods.client.session.update, ({ params }) => {
                            if (
                              params.update.sessionUpdate === 'agent_message_chunk' &&
                              params.update.content.type === 'text'
                            )
                              restoredText.push(params.update.content.text);
                          })
                          .onNotification(
                            '_maka/turn/status',
                            { parse: (value: unknown) => value },
                            ({ params }) => {
                              restoredStatuses.push(params);
                            },
                          ),
                    );
                    await sibling.closeStdin();
                    assert.deepEqual(await sibling.waitForExit(), { code: 0, signal: null });
                    assert.equal(
                      restoredText.join('').split('After restored replay.').length - 1,
                      1,
                    );
                    assert.equal(restoredStatuses.length, 1, 'one terminal notification per Turn');
                    assert.equal(executionCalls, 1, 'retries must not invoke the model again');
                  } finally {
                    await sibling.close();
                  }
                }
                await context.notify(methods.agent.session.cancel, { sessionId });
                await waitFor(() => statuses.length > 0);
                const current = (await context.request('_maka/plan/query', {
                  kind: 'list_start',
                  sessionId,
                })) as {
                  items: Array<{
                    kind: string;
                    execution?: { status: string; executionId: string };
                  }>;
                };
                const execution = current.items.find(
                  (item) => item.kind === 'execution',
                )?.execution;
                assert.equal(execution?.status, 'interrupted');
                await context.request('_maka/plan/control', {
                  kind: 'cancel_execution',
                  sessionId,
                  executionId: execution.executionId,
                  operationId: randomUUID(),
                });
                await context.request(methods.agent.session.close, { sessionId });
              },
              (app) =>
                app.onNotification(
                  '_maka/turn/status',
                  { parse: (value: unknown) => value },
                  ({ params }) => {
                    statuses.push(params);
                  },
                ),
            );
            await harness.closeStdin();
            assert.deepEqual(await harness.waitForExit(), { code: 0, signal: null });
          },
          {
            startRuntimeHost: true,
            model: {
              id: 'cancel-plan-fixture',
              thinkingLevels: [],
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
            },
          },
        );
      } finally {
        await new Promise<void>((resolve) => model.close(() => resolve()));
      }
    });
  }

  test('Plan paging preserves storeVersion and returns revision_changed after an external write', {
    timeout: 45_000,
  }, async () => {
    let call = 0;
    const model = createServer((request, response) => {
      void readRequest(request)
        .then((body) => {
          const input = JSON.parse(body) as {
            stream?: boolean;
            tools?: Array<{ function?: { name?: string } }>;
          };
          if (input.stream !== true) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                id: 'summary',
                object: 'chat.completion',
                created: 1,
                model: 'paging-fixture',
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'Summary' },
                    finish_reason: 'stop',
                  },
                ],
              }),
            );
            return;
          }
          call += 1;
          const names = (input.tools ?? []).flatMap((tool) =>
            tool.function?.name ? [tool.function.name] : [],
          );
          if (names.includes('SubmitPlan'))
            respondTool(response, 'SubmitPlan', {
              title: `Fixture plan ${call}`,
              steps: [
                { id: 'step-1', title: 'Do the work', description: 'Finish the fixture task' },
              ],
            });
          else respondTool(response, 'tool_search', { query: 'SubmitPlan' });
        })
        .catch((error: unknown) => response.destroy(error as Error));
    });
    await new Promise<void>((resolve, reject) => {
      model.once('error', reject);
      model.listen(0, '127.0.0.1', resolve);
    });
    const address = model.address();
    assert.ok(address && typeof address !== 'string');
    try {
      await withAcpChildProcessHarness(
        async (harness) => {
          await harness.withClient(async ({ context }) => {
            await context.request(methods.agent.initialize, { protocolVersion: 1 });
            const { sessionId } = await context.request(methods.agent.session.new, {
              cwd: harness.workspaceRoot,
              mcpServers: [],
            });
            await context.request(methods.agent.session.setConfigOption, {
              sessionId,
              configId: 'collaboration_mode',
              value: 'plan',
            });
            let latestProposalId = '';
            for (let index = 0; index < 17; index += 1) {
              await context.request(methods.agent.session.prompt, {
                sessionId,
                prompt: [{ type: 'text', text: `Prepare fixture plan ${index}` }],
              });
              const latest = (await context.request('_maka/plan/query', {
                kind: 'list_start',
                sessionId,
              })) as {
                kind: string;
                latestProposalId: string;
              };
              assert.equal(latest.kind, 'page');
              latestProposalId = latest.latestProposalId;
              if (index < 16) {
                try {
                  await context.request('_maka/plan/control', {
                    kind: 'request_revision',
                    sessionId,
                    proposalId: latestProposalId,
                    operationId: randomUUID(),
                  });
                } catch (error) {
                  throw new Error(
                    `revision index=${index} proposal=${latestProposalId} modelCalls=${call}`,
                    { cause: error },
                  );
                }
              }
            }
            const first = (await context.request('_maka/plan/query', {
              kind: 'list_start',
              sessionId,
            })) as {
              kind: string;
              storeVersion: number;
              nextCursor: string | null;
              items: unknown[];
            };
            assert.equal(first.kind, 'page');
            assert.equal(first.items.length, 16);
            assert.ok(first.nextCursor);
            const second = (await context.request('_maka/plan/query', {
              kind: 'list_continue',
              sessionId,
              storeVersion: first.storeVersion,
              cursor: first.nextCursor,
            })) as typeof first;
            assert.equal(second.kind, 'page');
            assert.ok(second.items.length > 0);
            const connected = await connectRuntimeHost({
              rootPath: harness.workspaceRoot,
              protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
            });
            if (connected.kind !== 'connected') assert.fail('Second Host client unavailable');
            try {
              await connected.connection.request('plan.control', {
                kind: 'request_revision',
                sessionId,
                proposalId: latestProposalId,
                operationId: randomUUID(),
              });
            } finally {
              await connected.connection.close();
            }
            const changed = (await context.request('_maka/plan/query', {
              kind: 'list_continue',
              sessionId,
              storeVersion: first.storeVersion,
              cursor: first.nextCursor,
            })) as { kind: string; expected: number; actual: number };
            assert.equal(changed.kind, 'revision_changed');
            assert.equal(changed.expected, first.storeVersion);
            assert.ok(changed.actual > first.storeVersion);
            await context.request(methods.agent.session.close, { sessionId });
          });
        },
        {
          startRuntimeHost: true,
          model: {
            id: 'paging-fixture',
            thinkingLevels: [],
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
          },
        },
      );
    } finally {
      await new Promise<void>((resolve) => model.close(() => resolve()));
    }
  });

  test('Goal arm is passive and a prompt enables observable Host continuation', {
    timeout: 30_000,
  }, async () => {
    let streamCalls = 0;
    const model = createServer((request, response) => {
      void readRequest(request)
        .then((body) => {
          const input = JSON.parse(body) as { stream?: boolean };
          if (input.stream !== true) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                id: 'goal-evaluation',
                object: 'chat.completion',
                created: 1,
                model: 'goal-fixture',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: JSON.stringify({
                        met: false,
                        impossible: false,
                        progress: true,
                        waiting: false,
                        reason: 'Continue',
                      }),
                    },
                    finish_reason: 'stop',
                  },
                ],
              }),
            );
            return;
          }
          streamCalls += 1;
          respondEvents(response, [
            modelChunk({ role: 'assistant', content: `Goal turn ${streamCalls}.` }, null),
            modelChunk({}, 'stop'),
          ]);
        })
        .catch((error: unknown) => response.destroy(error as Error));
    });
    await new Promise<void>((resolve, reject) => {
      model.once('error', reject);
      model.listen(0, '127.0.0.1', resolve);
    });
    const address = model.address();
    assert.ok(address && typeof address !== 'string');
    try {
      await withAcpChildProcessHarness(
        async (harness) => {
          const chunks: string[] = [];
          const statuses: unknown[] = [];
          await harness.withClient(
            async ({ context }) => {
              await context.request(methods.agent.initialize, {
                protocolVersion: 1,
                clientCapabilities: {
                  _meta: { '_maka/turnStatus': true, '_maka/goalPlanStatus': true },
                },
              });
              const { sessionId } = await context.request(methods.agent.session.new, {
                cwd: harness.workspaceRoot,
                mcpServers: [],
              });
              await context.request('_maka/goal/arm', {
                sessionId,
                condition: 'Complete both fixture turns',
                maxIterations: 2,
                tokenBudget: null,
              });
              assert.equal(streamCalls, 0, 'arming alone did not dispatch a Turn');
              await context.request(methods.agent.session.prompt, {
                sessionId,
                prompt: [{ type: 'text', text: 'Start the fixture task' }],
              });
              await waitFor(() => streamCalls >= 2 && statuses.length > 0);
              assert.ok(
                chunks.some((chunk) => chunk.includes('Goal turn 2.')),
                `Missing background output: ${JSON.stringify(chunks)}`,
              );
              await context.request(methods.agent.session.close, { sessionId });

              const second = await context.request(methods.agent.session.new, {
                cwd: harness.workspaceRoot,
                mcpServers: [],
              });
              const armed = (await context.request('_maka/goal/arm', {
                sessionId: second.sessionId,
                condition: 'Do one fixture turn',
                maxIterations: 1,
                tokenBudget: null,
              })) as { goal: { goalId: string; revision: number } };
              const paused = (await context.request('_maka/goal/control', {
                sessionId: second.sessionId,
                goalId: armed.goal.goalId,
                expectedRevision: armed.goal.revision,
                action: 'pause',
              })) as typeof armed;
              const callsBeforeResume = streamCalls;
              const statusesBeforeResume = statuses.length;
              await context.request('_maka/goal/control', {
                sessionId: second.sessionId,
                goalId: armed.goal.goalId,
                expectedRevision: paused.goal.revision,
                action: 'resume',
              });
              await waitFor(
                () => streamCalls > callsBeforeResume && statuses.length > statusesBeforeResume,
              );
              assert.ok(chunks.some((chunk) => chunk.includes(`Goal turn ${streamCalls}.`)));
              await context.request(methods.agent.session.close, { sessionId: second.sessionId });
            },
            (app) =>
              app
                .onNotification(methods.client.session.update, ({ params }) => {
                  if (
                    params.update.sessionUpdate === 'agent_message_chunk' &&
                    params.update.content.type === 'text'
                  )
                    chunks.push(params.update.content.text);
                })
                .onNotification(
                  '_maka/turn/status',
                  { parse: (value: unknown) => value },
                  ({ params }) => {
                    statuses.push(params);
                  },
                ),
          );
        },
        {
          startRuntimeHost: true,
          model: {
            id: 'goal-fixture',
            thinkingLevels: [],
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
          },
        },
      );
    } finally {
      await new Promise<void>((resolve) => model.close(() => resolve()));
    }
  });

  test('submits and executes a Plan through the model, ACP, and real Host', {
    timeout: 30_000,
  }, async () => {
    let modelCalls = 0;
    const modelToolNames: string[][] = [];
    let submitted = false;
    let questionAsked = false;
    let updated = false;
    let interruptNextExecution = false;
    const model = createServer((request, response) => {
      void readRequest(request)
        .then((body) => {
          const input = JSON.parse(body) as {
            stream?: boolean;
            tools?: Array<{ function?: { name?: string } }>;
          };
          if (input.stream !== true) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                id: 'summary',
                object: 'chat.completion',
                created: 1,
                model: 'goal-plan-fixture',
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'Summary' },
                    finish_reason: 'stop',
                  },
                ],
              }),
            );
            return;
          }
          const names = (input.tools ?? []).flatMap((tool) =>
            tool.function?.name ? [tool.function.name] : [],
          );
          modelToolNames.push(names);
          modelCalls += 1;
          if (!submitted && names.includes('SubmitPlan')) {
            submitted = true;
            respondTool(response, 'SubmitPlan', {
              title: 'Fixture plan',
              steps: [
                { id: 'step-1', title: 'Do the work', description: 'Finish the fixture task' },
              ],
            });
          } else if (!submitted) {
            respondTool(response, 'tool_search', { query: 'SubmitPlan' });
          } else if (interruptNextExecution) {
            interruptNextExecution = false;
            respondEvents(response, [
              modelChunk({ role: 'assistant', content: 'Work remains.' }, null),
              modelChunk({}, 'stop'),
            ]);
          } else if (!questionAsked && names.includes('AskUserQuestion')) {
            questionAsked = true;
            respondTool(response, 'AskUserQuestion', {
              questions: [
                {
                  question: 'Proceed with the fixture?',
                  options: [{ label: 'Yes' }, { label: 'No' }],
                },
              ],
            });
          } else if (!questionAsked) {
            respondTool(response, 'tool_search', { query: 'AskUserQuestion' });
          } else if (!updated && names.includes('update_plan')) {
            updated = true;
            respondTool(response, 'update_plan', {
              steps: [{ id: 'step-1', status: 'completed', note: 'Done' }],
            });
          } else if (!updated) {
            respondTool(response, 'tool_search', { query: 'update_plan' });
          } else {
            respondEvents(response, [
              modelChunk({ role: 'assistant', content: 'Plan complete.' }, null),
              modelChunk({}, 'stop'),
            ]);
          }
        })
        .catch((error: unknown) => response.destroy(error as Error));
    });
    await new Promise<void>((resolve, reject) => {
      model.once('error', reject);
      model.listen(0, '127.0.0.1', resolve);
    });
    const address = model.address();
    assert.ok(address && typeof address !== 'string');
    try {
      await withAcpChildProcessHarness(
        async (harness) => {
          const updates: unknown[] = [];
          const statuses: unknown[] = [];
          const planChanges: unknown[] = [];
          const deliveryOrder: string[] = [];
          let interactions = 0;
          await harness.withClient(
            async ({ context }) => {
              await context.request(methods.agent.initialize, {
                protocolVersion: 1,
                clientCapabilities: {
                  elicitation: { form: {} },
                  _meta: { '_maka/turnStatus': true, '_maka/goalPlanStatus': true },
                },
              });
              const { sessionId } = await context.request(methods.agent.session.new, {
                cwd: harness.workspaceRoot,
                mcpServers: [],
              });
              await context.request(methods.agent.session.setConfigOption, {
                sessionId,
                configId: 'collaboration_mode',
                value: 'plan',
              });
              assert.deepEqual(
                await context.request(methods.agent.session.prompt, {
                  sessionId,
                  prompt: [{ type: 'text', text: 'Prepare a plan for a fixture task' }],
                }),
                { stopReason: 'end_turn' },
              );
              const page = (await context.request('_maka/plan/query', {
                kind: 'list_start',
                sessionId,
              })) as {
                kind: string;
                storeVersion: number;
                items: Array<{
                  kind: string;
                  proposal?: { proposalId: string; revision: number; status: string };
                }>;
              };
              assert.equal(page.kind, 'page');
              const proposal = page.items.find((item) => item.kind === 'proposal')?.proposal;
              assert.ok(
                proposal,
                `modelCalls=${modelCalls} tools=${JSON.stringify(modelToolNames)} page=${JSON.stringify(page)} updates=${JSON.stringify(updates)}`,
              );
              assert.equal(proposal.status, 'pending_approval');
              const connected = await connectRuntimeHost({
                rootPath: harness.workspaceRoot,
                protocol: {
                  min: RUNTIME_HOST_PROTOCOL_VERSION,
                  max: RUNTIME_HOST_PROTOCOL_VERSION,
                },
              });
              if (connected.kind !== 'connected') assert.fail('Second Host client unavailable');
              let revisedStoreVersion: number;
              try {
                const revised = await connected.connection.request('plan.control', {
                  kind: 'request_revision',
                  sessionId,
                  proposalId: proposal.proposalId,
                  operationId: randomUUID(),
                });
                revisedStoreVersion = revised.storeVersion;
              } finally {
                await connected.connection.close();
              }
              await waitFor(() =>
                planChanges.some(
                  (status) =>
                    (status as { storeVersion?: number }).storeVersion === revisedStoreVersion,
                ),
              );
              const externallyChanged = (await context.request('_maka/plan/query', {
                kind: 'list_start',
                sessionId,
              })) as typeof page;
              assert.equal(externallyChanged.storeVersion, revisedStoreVersion);
              await assert.rejects(
                context.request('_maka/plan/turn/start', {
                  kind: 'approve_proposal',
                  sessionId,
                  proposalId: proposal.proposalId,
                  expectedRevision: proposal.revision,
                  expectedStoreVersion: page.storeVersion,
                  turnId: randomUUID(),
                }),
                (error: unknown) =>
                  error instanceof RequestError &&
                  (error.data as { code?: string } | undefined)?.code === 'operation_conflict',
              );
              submitted = false;
              await context.request(methods.agent.session.prompt, {
                sessionId,
                prompt: [{ type: 'text', text: 'Revise the fixture plan' }],
              });
              const approvalPage = (await context.request('_maka/plan/query', {
                kind: 'list_start',
                sessionId,
              })) as typeof page;
              const approvalProposal = approvalPage.items.find(
                (item) => item.kind === 'proposal' && item.proposal?.status === 'pending_approval',
              )?.proposal;
              assert.ok(approvalProposal);
              const turnId = randomUUID();
              const approvalInput = {
                kind: 'approve_proposal',
                sessionId,
                proposalId: approvalProposal.proposalId,
                expectedRevision: approvalProposal.revision,
                expectedStoreVersion: approvalPage.storeVersion,
                turnId,
              };
              const concurrentResults = await Promise.allSettled([
                context.request('_maka/plan/turn/start', approvalInput),
                context.request('_maka/plan/turn/start', approvalInput),
              ]);
              const successful = concurrentResults.find((result) => result.status === 'fulfilled');
              assert.ok(successful);
              const started = successful.value as {
                plan: { eventType: string; executionId: string };
                turn: { turnId: string };
              };
              for (const result of concurrentResults) {
                if (result.status === 'rejected') {
                  assert.ok(result.reason instanceof RequestError);
                  assert.equal((result.reason.data as { code?: string }).code, 'session_busy');
                }
              }
              assert.equal(started.plan.eventType, 'plan_approved');
              assert.equal(started.turn.turnId, turnId);
              await waitFor(() => statuses.length > 0);
              const completedPage = (await context.request('_maka/plan/query', {
                kind: 'list_start',
                sessionId,
              })) as {
                kind: string;
                items: Array<{
                  kind: string;
                  execution?: { status: string; steps: Array<{ status: string }> };
                }>;
              };
              const execution = completedPage.items.find(
                (item) => item.kind === 'execution',
              )?.execution;
              assert.equal(execution?.status, 'completed');
              assert.deepEqual(
                execution.steps.map((step) => step.status),
                ['completed'],
              );
              const callsBeforeRepeat = modelCalls;
              const statusesBeforeRepeat = statuses.length;
              const repeated = (await context.request('_maka/plan/turn/start', {
                kind: 'approve_proposal',
                sessionId,
                proposalId: approvalProposal.proposalId,
                expectedRevision: approvalProposal.revision,
                expectedStoreVersion: approvalPage.storeVersion,
                turnId,
              })) as typeof started;
              assert.equal(repeated.turn.turnId, turnId);
              assert.equal(
                modelCalls,
                callsBeforeRepeat,
                'same turnId did not run the model again',
              );
              assert.equal(
                statuses.length,
                statusesBeforeRepeat,
                'receipt replay did not start a second output consumer',
              );
              await context.request(methods.agent.session.close, { sessionId });
              assert.ok(updates.length > 0);
              assert.ok(statuses.length > 0);
              assert.ok(planChanges.length > 0);
              assert.equal(interactions, 1);
              assert.ok(deliveryOrder.indexOf('plan-output') >= 0);
              assert.ok(
                deliveryOrder.indexOf('plan-status') > deliveryOrder.indexOf('plan-output'),
              );

              submitted = false;
              questionAsked = false;
              updated = false;
              interruptNextExecution = true;
              const resumedSession = await context.request(methods.agent.session.new, {
                cwd: harness.workspaceRoot,
                mcpServers: [],
              });
              await context.request(methods.agent.session.setConfigOption, {
                sessionId: resumedSession.sessionId,
                configId: 'collaboration_mode',
                value: 'plan',
              });
              await context.request(methods.agent.session.prompt, {
                sessionId: resumedSession.sessionId,
                prompt: [{ type: 'text', text: 'Prepare an interrupted fixture plan' }],
              });
              const interruptedProposalPage = (await context.request('_maka/plan/query', {
                kind: 'list_start',
                sessionId: resumedSession.sessionId,
              })) as typeof page;
              const interruptedProposal = interruptedProposalPage.items.find(
                (item) => item.kind === 'proposal',
              )?.proposal;
              assert.ok(interruptedProposal);
              const statusesBeforeInterrupted = statuses.length;
              const interruptedAdmission = (await context.request('_maka/plan/turn/start', {
                kind: 'approve_proposal',
                sessionId: resumedSession.sessionId,
                proposalId: interruptedProposal.proposalId,
                expectedRevision: interruptedProposal.revision,
                expectedStoreVersion: interruptedProposalPage.storeVersion,
                turnId: randomUUID(),
              })) as typeof started;
              await waitFor(() => statuses.length > statusesBeforeInterrupted);
              const interruptedPage = (await context.request('_maka/plan/query', {
                kind: 'list_start',
                sessionId: resumedSession.sessionId,
              })) as typeof completedPage;
              assert.equal(
                interruptedPage.items.find((item) => item.kind === 'execution')?.execution?.status,
                'interrupted',
              );
              const statusesBeforeResume = statuses.length;
              const resumedAdmission = (await context.request('_maka/plan/turn/start', {
                kind: 'resume_execution',
                sessionId: resumedSession.sessionId,
                executionId: interruptedAdmission.plan.executionId,
                turnId: randomUUID(),
              })) as typeof started;
              assert.equal(resumedAdmission.plan.eventType, 'plan_execution_resumed');
              await waitFor(() => statuses.length > statusesBeforeResume);
              const resumedPage = (await context.request('_maka/plan/query', {
                kind: 'list_start',
                sessionId: resumedSession.sessionId,
              })) as typeof completedPage;
              assert.equal(
                resumedPage.items.find((item) => item.kind === 'execution')?.execution?.status,
                'completed',
              );
              await context.request(methods.agent.session.close, {
                sessionId: resumedSession.sessionId,
              });

              submitted = false;
              questionAsked = false;
              updated = false;
              interruptNextExecution = true;
              const cancelledSession = await context.request(methods.agent.session.new, {
                cwd: harness.workspaceRoot,
                mcpServers: [],
              });
              await context.request(methods.agent.session.setConfigOption, {
                sessionId: cancelledSession.sessionId,
                configId: 'collaboration_mode',
                value: 'plan',
              });
              await context.request(methods.agent.session.prompt, {
                sessionId: cancelledSession.sessionId,
                prompt: [{ type: 'text', text: 'Prepare a cancellable fixture plan' }],
              });
              const cancelProposalPage = (await context.request('_maka/plan/query', {
                kind: 'list_start',
                sessionId: cancelledSession.sessionId,
              })) as typeof page;
              const cancelProposal = cancelProposalPage.items.find(
                (item) => item.kind === 'proposal',
              )?.proposal;
              assert.ok(cancelProposal);
              const statusesBeforeCancelTurn = statuses.length;
              const cancelAdmission = (await context.request('_maka/plan/turn/start', {
                kind: 'approve_proposal',
                sessionId: cancelledSession.sessionId,
                proposalId: cancelProposal.proposalId,
                expectedRevision: cancelProposal.revision,
                expectedStoreVersion: cancelProposalPage.storeVersion,
                turnId: randomUUID(),
              })) as typeof started;
              await waitFor(() => statuses.length > statusesBeforeCancelTurn);
              const cancelled = (await context.request('_maka/plan/control', {
                kind: 'cancel_execution',
                sessionId: cancelledSession.sessionId,
                executionId: cancelAdmission.plan.executionId,
                operationId: randomUUID(),
              })) as { eventType: string };
              assert.equal(cancelled.eventType, 'plan_execution_cancelled');
              const callsBeforeRejectedResume = modelCalls;
              await assert.rejects(
                context.request('_maka/plan/turn/start', {
                  kind: 'resume_execution',
                  sessionId: cancelledSession.sessionId,
                  executionId: cancelAdmission.plan.executionId,
                  turnId: randomUUID(),
                }),
                (error: unknown) => error instanceof RequestError,
              );
              assert.equal(modelCalls, callsBeforeRejectedResume);
              await context.request(methods.agent.session.close, {
                sessionId: cancelledSession.sessionId,
              });
            },
            (app) =>
              app
                .onNotification(methods.client.session.update, ({ params }) => {
                  updates.push(params);
                  if (
                    params.update.sessionUpdate === 'agent_message_chunk' &&
                    params.update.content.type === 'text' &&
                    params.update.content.text.includes('Plan complete.')
                  )
                    deliveryOrder.push('plan-output');
                })
                .onNotification(
                  '_maka/turn/status',
                  { parse: (value: unknown) => value },
                  ({ params }) => {
                    statuses.push(params);
                    deliveryOrder.push('plan-status');
                  },
                )
                .onNotification(
                  '_maka/plan/changed',
                  { parse: (value: unknown) => value },
                  ({ params }) => {
                    planChanges.push(params);
                  },
                )
                .onRequest(methods.client.elicitation.create, () => {
                  interactions += 1;
                  return { action: 'accept', content: { q0: 'Yes' } };
                }),
          );
        },
        {
          startRuntimeHost: true,
          model: {
            id: 'goal-plan-fixture',
            thinkingLevels: [],
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
          },
        },
      );
    } finally {
      await new Promise<void>((resolve) => model.close(() => resolve()));
    }
  });

  test('owns, arms, queries and controls a Goal while observing domain state', {
    timeout: 30_000,
  }, async () => {
    await withAcpChildProcessHarness(
      async (harness) => {
        const goalStatuses: unknown[] = [];
        const planChanges: unknown[] = [];
        await harness.withClient(
          async ({ context }) => {
            const initialized = await context.request(methods.agent.initialize, {
              protocolVersion: 1,
              clientCapabilities: { _meta: { '_maka/goalPlanStatus': true } },
            });
            assert.deepEqual(initialized.agentCapabilities?._meta?.['_maka/goalPlan'], {
              version: 1,
            });
            await assert.rejects(
              context.request('_maka/goal/query', { sessionId: 'unowned-session' }),
              (error: unknown) =>
                error instanceof RequestError &&
                (error.data as { reason?: string } | undefined)?.reason === 'unknown_session',
            );
            const { sessionId } = await context.request(methods.agent.session.new, {
              cwd: harness.workspaceRoot,
              mcpServers: [],
            });
            assert.deepEqual(await context.request('_maka/goal/query', { sessionId }), {
              sessionId,
              goal: null,
            });
            const initialPlan = (await context.request('_maka/plan/query', {
              kind: 'list_start',
              sessionId,
            })) as {
              kind: string;
              storeVersion: number;
              items: unknown[];
            };
            assert.equal(initialPlan.kind, 'page');
            assert.deepEqual(initialPlan.items, []);
            const armed = (await context.request('_maka/goal/arm', {
              sessionId,
              condition: 'Write a short summary',
              maxIterations: 2,
              tokenBudget: null,
            })) as {
              goal: {
                goalId: string;
                revision: number;
                maxIterations: number;
                tokenBudget: number | null;
              };
            };
            assert.equal(armed.goal.maxIterations, 2);
            assert.equal(armed.goal.tokenBudget, null);
            const queried = (await context.request('_maka/goal/query', {
              sessionId,
            })) as typeof armed;
            assert.equal(queried.goal.goalId, armed.goal.goalId);
            await assert.rejects(
              context.request('_maka/goal/control', {
                sessionId,
                goalId: armed.goal.goalId,
                expectedRevision: armed.goal.revision + 1,
                action: 'pause',
              }),
              (error: unknown) =>
                error instanceof RequestError &&
                (error.data as { code?: string } | undefined)?.code === 'operation_conflict',
            );
            const connected = await connectRuntimeHost({
              rootPath: harness.workspaceRoot,
              protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
            });
            if (connected.kind !== 'connected') assert.fail('Second Host client unavailable');
            let paused: typeof armed;
            try {
              paused = await connected.connection.request('goal.control', {
                sessionId,
                goalId: armed.goal.goalId,
                expectedRevision: armed.goal.revision,
                action: 'pause',
              });
            } finally {
              await connected.connection.close();
            }
            assert.equal(paused.goal.goalId, armed.goal.goalId);
            assert.ok(paused.goal.revision > armed.goal.revision);
            await waitFor(() =>
              goalStatuses.some(
                (status) =>
                  (status as { goal?: { revision?: number } }).goal?.revision ===
                  paused.goal.revision,
              ),
            );
            const externalQuery = (await context.request('_maka/goal/query', {
              sessionId,
            })) as typeof armed;
            assert.equal(externalQuery.goal.revision, paused.goal.revision);
            await context.request('_maka/goal/control', {
              sessionId,
              goalId: armed.goal.goalId,
              expectedRevision: paused.goal.revision,
              action: 'clear',
            });
            assert.ok(goalStatuses.length > 0);
            assert.ok(planChanges.length > 0);
            await context.request(methods.agent.session.close, { sessionId });
          },
          (app) =>
            app
              .onNotification(
                '_maka/goal/status',
                { parse: (value: unknown) => value },
                ({ params }) => {
                  goalStatuses.push(params);
                },
              )
              .onNotification(
                '_maka/plan/changed',
                { parse: (value: unknown) => value },
                ({ params }) => {
                  planChanges.push(params);
                },
              ),
        );
      },
      { startRuntimeHost: true, model: { id: 'goal-plan-fixture', thinkingLevels: [] } },
    );
  });
});

function modelChunk(delta: Record<string, unknown>, finishReason: 'tool_calls' | 'stop' | null) {
  return {
    id: 'chatcmpl-goal-plan-fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'goal-plan-fixture',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason
      ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      : {}),
  };
}

function respondEvents(response: ServerResponse, events: readonly unknown[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function respondTool(response: ServerResponse, name: string, args: Record<string, unknown>): void {
  respondEvents(response, [
    modelChunk(
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call-${name}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      null,
    ),
    modelChunk({}, 'tool_calls'),
  ]);
}

async function readRequest(request: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text;
}
