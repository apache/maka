/** 站点元信息与全局常量。 */
export const SITE_CONFIG = {
  /** 站点名称。 */
  name: '算法刷题',
  /** 站点描述。 */
  description: '一个支持在线判题的算法刷题网站',
  /** JavaScript 判题超时(毫秒)。 */
  judgeTimeoutMs: 5000,
  /** Python 判题超时(毫秒)—— 首次需加载 Pyodide 运行时,给更长时间。 */
  pythonJudgeTimeoutMs: 30000,
  /** 列表每页大小(预留,本期列表全量返回)。 */
  pageSize: 50,
  /**
   * Pyodide WASM 资源地址(版本须与安装的 pyodide npm 包一致)。
   * npm 包版本 314.0.0 对应 CDN /pyodide/v314.0.0/full/。
   */
  pyodideIndexURL: 'https://cdn.jsdelivr.net/pyodide/v314.0.0/full/',
} as const;
