import { cleanup, signal } from 'nsh';
import { randomUUID } from 'crypto';
import { host } from 'maka/host';
import type { OperationReply } from '../../../../packages/plugin-sdk/src/index';
import type { OriginalMutation } from './host';
import { qt } from '../../../../plugins/application/quick-tools/shared/i18n';

function returned(reply: OperationReply) {
  const receipt = reply.receipt;
  if (receipt.kind === 'recorded' && receipt.outcome.kind === 'returned')
    return receipt.outcome.value;
  const failure = receipt.kind === 'recorded' ? receipt.outcome : receipt;
  if ('diagnostic' in failure) {
    throw Error(
      failure.diagnostic === 'quick_question_model_required'
        ? qt('请先为个人助手选择模型')
        : failure.diagnostic,
    );
  }
  throw Error(qt('提问失败'));
}

export async function personalAssistantId() {
  const response = (await host.mutation('agent', 'openBot', {})) as { reply: OperationReply };
  const value = returned(response.reply) as { kind: string; sessionId?: string } | null;
  if (value?.kind !== 'opened' || !value.sessionId) throw Error(qt('无法打开个人助手'));
  return value.sessionId;
}

export function createQuickQuestion() {
  const turns = signal<{ question: string; answer: string }[]>([]);
  const running = signal(false),
    error = signal('');
  let previous: string | null = null;
  let active: OriginalMutation | undefined;
  let stopped = false,
    alive = true;
  const stop = () => {
    stopped = true;
    active?.cancel();
  };
  cleanup(() => {
    alive = false;
    stop();
  });
  const ask = async (question: string, follow: boolean) => {
    question = question.trim();
    if (!question || running()) return;
    const requestId = randomUUID();
    const continueFrom = follow ? previous : null;
    const history = continueFrom ? turns() : [];
    running.set(true);
    error.set('');
    stopped = false;
    previous = null;
    turns.set([...history, { question, answer: '' }]);
    try {
      const sessionId = await personalAssistantId();
      if (stopped) return;
      const operation = (await host.beginMutation('agent', 'askQuickQuestion', {
        sessionId,
        question,
        requestId,
        continueFrom,
      })) as OriginalMutation;
      active = operation;
      if (stopped) operation.cancel();
      for (;;) {
        const event = await operation.next();
        if (!event || event.kind === 'not_dispatched') throw Error(qt('提问失败'));
        if (event.kind === 'progress' && alive && typeof event.value === 'string') {
          previous = requestId;
          turns.set([...history, { question, answer: event.value }]);
        }
        if (event.kind === 'finished') {
          returned(event.reply);
          if (event.cleanupError) throw Error(event.cleanupError);
          break;
        }
      }
    } catch (cause) {
      if (alive && !stopped) error.set(String(cause));
    } finally {
      active = undefined;
      if (alive) running.set(false);
    }
  };
  return { turns, running, error, ask, stop };
}
