import { describe, it, expect } from 'vitest';
import { executeCases } from './execute';

describe('executeCases', () => {
  it('正确实现两数之和,返回各用例结果且无错误', () => {
    const code = `function twoSum(nums, target) {
      const m = new Map();
      for (let i = 0; i < nums.length; i++) {
        const need = target - nums[i];
        if (m.has(need)) return [m.get(need), i];
        m.set(nums[i], i);
      }
    }`;
    const r = executeCases(code, 'twoSum', [
      [[2, 7, 11, 15], 9],
      [[3, 2, 4], 6],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.results).toHaveLength(2);
    expect(r.results[0].actual).toEqual([0, 1]);
    expect(r.results[1].actual).toEqual([1, 2]);
    expect(r.results.every((x) => x.error === null)).toBe(true);
  });

  it('错误实现执行无异常,但返回错误结果', () => {
    const code = `function twoSum() { return [9, 9]; }`;
    const r = executeCases(code, 'twoSum', [[[2, 7, 11, 15], 9]]);
    expect(r.results[0].error).toBeNull();
    expect(r.results[0].actual).toEqual([9, 9]);
  });

  it('找不到入口函数时返回 error', () => {
    const r = executeCases('function foo() {}', 'twoSum', [[]]);
    expect(r.error).toBe('找不到入口函数: twoSum');
  });

  it('运行时异常被捕获并记录到用例 error', () => {
    const code = `function boom() { throw new Error('炸了'); }`;
    const r = executeCases(code, 'boom', [[]]);
    expect(r.results[0].error).toBe('炸了');
  });

  it('语法错误返回整体 error', () => {
    const r = executeCases('function (', 'x', [[]]);
    expect(r.error).toBeTruthy();
  });

  it('捕获 console.log 到 stdout', () => {
    const code = `function logTest(n) { console.log('hi', n); return n; }`;
    const r = executeCases(code, 'logTest', [[42]]);
    expect(r.results[0].stdout).toEqual(['hi 42']);
    expect(r.results[0].actual).toBe(42);
  });

  it('每个用例独立捕获 stdout,互不污染', () => {
    const code = `function f(x) { console.log('x=' + x); return x; }`;
    const r = executeCases(code, 'f', [[1], [2]]);
    expect(r.results[0].stdout).toEqual(['x=1']);
    expect(r.results[1].stdout).toEqual(['x=2']);
  });
});
