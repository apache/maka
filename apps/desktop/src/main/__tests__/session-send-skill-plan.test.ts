import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { prepareSessionSendSkillPlan } from '../session-send-skill-plan.js';

describe('Desktop Skill send gate', () => {
  it('does not consume attachments when every explicit invocation fails', async () => {
    let attachmentResolutionCalls = 0;
    const result = await prepareSessionSendSkillPlan({
      prepare: async () => ({
        disposition: 'blocked',
        skillInvocation: {
          loaded: [],
          failed: [{ request: 'missing', reason: 'not_found' }],
          receipts: [
            {
              invocation: 'explicit',
              request: 'missing',
              success: false,
              reason: 'not_found',
            },
          ],
        },
      }),
      resolveSend: async () => {
        attachmentResolutionCalls += 1;
        return { turnId: 'turn-1', attachments: ['artifact'] };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(attachmentResolutionCalls, 0);
  });

  it('resolves attachments only after passthrough or ready preparation', async () => {
    const order: string[] = [];
    const result = await prepareSessionSendSkillPlan({
      prepare: async () => {
        order.push('prepare');
        return {
          disposition: 'ready',
          sendText: 'expanded',
          skillInvocation: {
            loaded: [{ id: 'alpha', name: 'Alpha' }],
            failed: [],
            receipts: [],
          },
        };
      },
      resolveSend: async () => {
        order.push('attachments');
        return { turnId: 'turn-1' };
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(order, ['prepare', 'attachments']);
  });
});
