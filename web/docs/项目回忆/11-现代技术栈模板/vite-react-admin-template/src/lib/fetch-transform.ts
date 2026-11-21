/**
 * 数据属性名格式转换（下划线 ↔ 小驼峰）
 *
 * 这是从你希音时期 SCWF/SSAP 请求层原样迁移过来的签名代码：
 * 后端接口用 snake_case、前端 state 用 camelCase，转换收敛在这一层。
 */

type PlainObject = Record<string, unknown>;

const isString = (val: unknown): val is string => typeof val === 'string';
const isArray = Array.isArray;
const isObject = (val: unknown): val is PlainObject =>
  val !== null && typeof val === 'object';
const isPlainObject = (val: unknown): val is PlainObject =>
  Object.prototype.toString.call(val) === '[object Object]';

/** 下划线转小驼峰：字符串 / 数组 / 普通对象三类递归，其余原样返回 */
export function under2Camel<T>(target: T): T {
  if (isString(target)) {
    return target.replace(/_(.)/g, (_, letter: string) =>
      letter.toUpperCase(),
    ) as T;
  }

  if (isArray(target)) {
    return target.map((item) => under2Camel(item)) as T;
  }

  if (isPlainObject(target)) {
    return Object.entries(target).reduce((result, [nativeKey, nativeVal]) => {
      const resultKey = under2Camel(nativeKey);
      result[resultKey] = isObject(nativeVal) ? under2Camel(nativeVal) : nativeVal;
      return result;
    }, {} as PlainObject) as T;
  }

  return target;
}

/** 小驼峰转下划线（仅处理首字母小写的 key，避开常量与特殊标记） */
export function camel2Under<T>(target: T): T {
  if (isString(target)) {
    return target.replace(
      /^([a-z])(.*)/,
      (_, first: string, rest: string) =>
        first + rest.replace(/([A-Z])/g, (_, letter: string) => `_${letter.toLowerCase()}`),
    ) as T;
  }

  if (isArray(target)) {
    return target.map((item) =>
      isObject(item) ? camel2Under(item) : item,
    ) as T;
  }

  if (isPlainObject(target)) {
    return Object.entries(target).reduce((result, [nativeKey, nativeVal]) => {
      const resultKey = camel2Under(nativeKey);
      result[resultKey] = isObject(nativeVal) ? camel2Under(nativeVal) : nativeVal;
      return result;
    }, {} as PlainObject) as T;
  }

  return target;
}
