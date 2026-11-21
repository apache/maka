/** diffmap UI 纯逻辑：分割条宽度、tooltip 定位、主题解析——组件只做接线 */

/** diff 面板可拖宽度：夹在 [220, total-220]，窗口过窄保底 220 */
export function clampDiffWidth(w: number, total: number): number {
  const min = 220;
  const max = Math.max(min, total - min);
  return Math.min(Math.max(w, min), max);
}

/** 浮层定位：默认光标右下（右14/下12），放不下就翻到另一侧，越界截到 4px 边距 */
export function tooltipStyle(
  cx: number,
  cy: number,
  tipW: number,
  tipH: number,
  vw: number,
  vh: number,
): { left: number; top: number } {
  let left = cx + 14;
  let top = cy + 12;
  if (left + tipW > vw) left = cx - 14 - tipW;
  if (top + tipH > vh) top = cy - 12 - tipH;
  return { left: Math.max(4, left), top: Math.max(4, top) };
}

export type Theme = 'light' | 'dark';

/** 主题初始值：存储值优先（只认 dark/light，垃圾值当没存），否则跟系统 */
export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === 'dark' || stored === 'light') return stored;
  return prefersDark ? 'dark' : 'light';
}
