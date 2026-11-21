/**
 * JavaScript 判题 Worker:接收用户代码,委托 executeCases 执行,回传结果。
 *
 * 仅做消息桥接;执行逻辑见 execute.ts(便于在 Node 单测)。
 * 在 DedicatedWorkerGlobalScope 中运行,与主线程隔离;主线程超时可 terminate。
 */

import { executeCases } from './execute';

interface WorkerRequest {
  code: string;
  entry: string;
  inputs: unknown[][];
}

/** Worker 作用域的结构化类型(避免依赖 DedicatedWorkerGlobalScope 具名类型)。 */
interface WorkerScope {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (data: unknown) => void;
}

const ctx = self as unknown as WorkerScope;

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { code, entry, inputs } = e.data;
  ctx.postMessage(executeCases(code, entry, inputs));
};
