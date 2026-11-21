/**
 * 归一化比较:JSON.stringify → 逐行去首尾空白 → 严格相等。
 *
 * 用于判题时比对用户函数返回值与测试用例期望值。
 * 忽略由序列化/格式带来的首尾空白差异;数值不做浮点容差(MVP 题目均为整数)。
 *
 * @param actual - 用户函数实际返回值。
 * @param expected - 测试用例期望值。
 * @returns 归一化后是否相等。
 */
export function normalizeCompare(actual: unknown, expected: unknown): boolean {
  const norm = (v: unknown) => {
    // JSON.stringify(undefined) 返回 undefined(非字符串),需特判避免 .split 崩溃
    const s = v === undefined ? 'undefined' : JSON.stringify(v);
    return s
      .split('\n')
      .map((l) => l.trim())
      .join('\n')
      .trim();
  };
  return norm(actual) === norm(expected);
}
