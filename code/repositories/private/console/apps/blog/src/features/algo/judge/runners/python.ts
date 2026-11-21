import type { Runner, RunArgs, RunOutcome } from './types';
import { SITE_CONFIG } from '@/features/algo/config/site';

/**
 * blob module worker 的源码(纯静态字符串,无任何插值 → 无注入风险)。
 * indexURL 通过 postMessage 传入;运行时动态 import CDN 的 pyodide.mjs。
 *
 * 为什么用 blob worker:turbopack 打包 .ts worker 时可能不忠实传递
 * `{ type: 'module' }`,导致 Pyodide 把它当成 classic worker 并报
 * "Classic web workers are not supported"。运行时创建的 blob worker
 * 是真正的 ES module worker,bundler 完全不介入,Pyodide 能正确识别。
 */
const WORKER_SRC = `
let pyodide = null;
function toJs(v) {
  if (v && typeof v === 'object' && typeof v.toJs === 'function') {
    var js = v.toJs();
    if (typeof v.destroy === 'function') v.destroy();
    return js;
  }
  return v;
}
function msgOf(err) {
  return (err && err.message) ? err.message : String(err);
}
self.onmessage = async (e) => {
  const { indexURL, code, entry, inputs } = e.data;
  try {
    if (!pyodide) {
      const m = await import(indexURL + 'pyodide.mjs');
      pyodide = await m.loadPyodide({ indexURL });
    }
    pyodide.runPython(code);
    const fn = pyodide.globals.get(entry);
    if (!fn || typeof fn.call !== 'function') {
      self.postMessage({ error: '找不到入口函数: ' + entry });
      return;
    }
    const results = [];
    for (const input of inputs) {
      try {
        const ret = fn.call(pyodide.globals, ...input);
        results.push({ actual: toJs(ret), stdout: [], error: null });
      } catch (err) {
        results.push({ actual: undefined, stdout: [], error: msgOf(err) });
      }
    }
    self.postMessage({ results });
  } catch (err) {
    self.postMessage({ error: msgOf(err) });
  }
};
`;

/** 创建 blob module worker(运行时构造,bundler 不介入)。 */
function createPyodideWorker(): Worker {
  const blob = new Blob([WORKER_SRC], { type: 'text/javascript' });
  return new Worker(URL.createObjectURL(blob), { type: 'module' });
}

/** 单例 Worker(Pyodide 跨 run 复用)。 */
let pyWorker: Worker | null = null;

function getWorker(): Worker {
  if (!pyWorker) {
    pyWorker = createPyodideWorker();
  }
  return pyWorker;
}

/**
 * Python 执行器:在单例 blob module worker 中运行 Pyodide。
 * 超时则 terminate Worker 并重置单例,下次 run 重新加载 Pyodide。
 */
export const pythonRunner: Runner = {
  async run({ code, entry, inputs, timeoutMs }: RunArgs): Promise<RunOutcome> {
    const worker = getWorker();
    return new Promise<RunOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate();
        pyWorker = null;
        reject(new Error(`执行超时(>${timeoutMs}ms),可能正在加载 Python 运行时或存在死循环`));
      }, timeoutMs);

      const handler = (e: MessageEvent) => {
        const data = e.data as { results?: unknown[]; error?: string };
        if (!data) return;
        worker.removeEventListener('message', handler);
        clearTimeout(timer);
        resolve({ results: (data.results as RunOutcome['results']) ?? [], error: data.error });
      };
      worker.addEventListener('message', handler);

      worker.onerror = (err) => {
        worker.removeEventListener('message', handler);
        clearTimeout(timer);
        pyWorker = null;
        reject(new Error(err.message || 'Python Worker 执行错误'));
      };

      worker.postMessage({
        indexURL: SITE_CONFIG.pyodideIndexURL,
        code,
        entry,
        inputs,
      });
    });
  },
};
