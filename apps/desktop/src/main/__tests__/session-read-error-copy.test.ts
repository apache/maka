import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { sessionReadMessagesFailureMessage } from '../session-read-error-copy.js';

const MARKER = 'MAKA_SESSION_READ_MESSAGES_ERROR:';

describe('session read error copy', () => {
  it('classifies active in-flight cache read failures without leaking paths', () => {
    const error = Object.assign(new Error('RuntimeEvent active projection cache read failed'), {
      name: 'RuntimeReadModelError',
      diagnostics: [
        {
          message: 'SessionProjectionCache.readMessages failed',
          details: {
            error: 'EPERM: operation not permitted, open C:\\Users\\alice\\AppData\\Roaming\\Maka\\workspaces\\default\\runtime.sqlite',
          },
        },
      ],
    });

    const message = sessionReadMessagesFailureMessage(error);

    assert.equal(message, `${MARKER}读取进行中的对话缓存失败：本地会话文件暂时不可用，请稍后重试。`);
    assert.equal(message.includes('C:\\Users'), false);
    assert.equal(message.includes('runtime.sqlite'), false);
  });

  it('classifies durable runtime ledger read failures', () => {
    const error = Object.assign(new Error('RuntimeEvent ledger read failed'), {
      name: 'RuntimeReadModelError',
      diagnostics: [
        {
          message: 'RuntimeEventStore.readRuntimeEvents failed',
          details: {
            error: 'Invalid SQLite RuntimeEvent at sequence 2 for run run_1',
          },
        },
      ],
    });

    assert.equal(
      sessionReadMessagesFailureMessage(error),
      `${MARKER}读取对话运行记录失败：本地运行记录暂时无法读取，请稍后重试。`,
    );
  });

  it('classifies local file access failures by error code', () => {
    const error = Object.assign(new Error('EPERM: operation not permitted'), {
      code: 'EPERM',
    });

    assert.equal(
      sessionReadMessagesFailureMessage(error),
      `${MARKER}读取对话失败：本地会话文件暂时被占用或不可访问，请稍后重试。`,
    );
  });

  it('does not classify path-shaped text without an explicit code or diagnostic', () => {
    const error = new Error('EPERM: operation not permitted, open C:\\Users\\alice\\runtime.sqlite');

    assert.equal(
      sessionReadMessagesFailureMessage(error),
      `${MARKER}读取对话失败：本地对话状态暂时不可用，请稍后重试。`,
    );
  });
});
