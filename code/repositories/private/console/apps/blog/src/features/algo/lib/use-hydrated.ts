'use client';

import { useEffect, useState } from 'react';

/**
 * 标记客户端是否已完成水合。
 *
 * 用于规避 zustand persist 在 SSR/CSR 之间的值不一致导致的闪烁:
 * 水合完成前显示默认值/骨架,完成后才读取 store 真值。
 *
 * @returns 是否已完成客户端水合。
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
