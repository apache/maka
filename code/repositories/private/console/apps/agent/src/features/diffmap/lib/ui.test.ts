import { describe, expect, it } from 'vitest';
import { clampDiffWidth, resolveTheme, tooltipStyle } from './ui';

describe('clampDiffWidth（分割条宽度契约）', () => {
  it('正常范围内原样返回', () => {
    expect(clampDiffWidth(500, 1600)).toBe(500);
  });
  it('小于最小宽度 220 夹到 220', () => {
    expect(clampDiffWidth(50, 1600)).toBe(220);
  });
  it('挤掉 treemap 侧：不超过 total-220', () => {
    expect(clampDiffWidth(1500, 1600)).toBe(1380);
  });
  it('窗口过窄时保底 220', () => {
    expect(clampDiffWidth(300, 400)).toBe(220);
  });
});

describe('tooltipStyle（浮层贴边翻转契约）', () => {
  it('默认出现在光标右下（右 14 / 下 12）', () => {
    expect(tooltipStyle(100, 100, 200, 80, 1600, 900)).toEqual({ left: 114, top: 112 });
  });
  it('右侧放不下翻到光标左边', () => {
    expect(tooltipStyle(1500, 100, 200, 80, 1600, 900)).toEqual({ left: 1286, top: 112 });
  });
  it('下侧放不下翻到光标上边', () => {
    expect(tooltipStyle(100, 860, 200, 80, 1600, 900)).toEqual({ left: 114, top: 768 });
  });
  it('角落后仍越界时截到 4px 边距', () => {
    expect(tooltipStyle(10, 880, 200, 80, 1600, 900)).toEqual({ left: 24, top: 788 });
    expect(tooltipStyle(4, 4, 400, 900, 400, 900)).toEqual({ left: 4, top: 4 });
  });
});

describe('resolveTheme（主题初始解析契约）', () => {
  it('存储值优先：dark / light 都尊重', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
  it('没存过跟系统：prefers dark 则 dark，否则 light', () => {
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme(null, false)).toBe('light');
  });
  it('存储的垃圾值当没存处理', () => {
    expect(resolveTheme('xxx', false)).toBe('light');
    expect(resolveTheme('xxx', true)).toBe('dark');
  });
});
