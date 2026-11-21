import type { Runner, RunArgs, RunOutcome } from './types';

/**
 * JavaScript 执行器:在 Web Worker 中用 Function 构造器运行用户代码。
 *
 * 超时由主线程 setTimeout + worker.terminate 实现
 * (无法中断同步 JS 执行,只能整体销毁 worker;下次运行重建)。
 */
export const javascriptRunner: Runner = {
  async run({ code, entry, inputs, timeoutMs }: RunArgs): Promise<RunOutcome> {
    const worker = new Worker(new URL('./javascript-worker.ts', import.meta.url));
    try {
      return await new Promise<RunOutcome>((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error(`执行超时(>${timeoutMs}ms),可能存在死循环`));
        }, timeoutMs);

        worker.onmessage = (e: MessageEvent<RunOutcome>) => {
          clearTimeout(timer);
          resolve(e.data);
        };
        worker.onerror = (err) => {
          clearTimeout(timer);
          reject(new Error(err.message || 'Worker 执行错误'));
        };
        worker.postMessage({ code, entry, inputs });
      });
    } finally {
      // 正常完成或超时后,销毁 worker 释放资源
      worker.terminate();
    }
  },
};
