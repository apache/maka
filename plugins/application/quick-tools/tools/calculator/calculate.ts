/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { qt } from '../../shared/i18n.js';
// Deliberately parsed arithmetic: never evaluate JavaScript or invoke a shell.
const units: Record<string, [string, number]> = {
  mm: ['length', 0.001],
  cm: ['length', 0.01],
  m: ['length', 1],
  km: ['length', 1000],
  in: ['length', 0.0254],
  ft: ['length', 0.3048],
  mi: ['length', 1609.344],
  mg: ['mass', 0.000001],
  g: ['mass', 0.001],
  kg: ['mass', 1],
  lb: ['mass', 0.45359237],
  ms: ['time', 0.001],
  s: ['time', 1],
  min: ['time', 60],
  h: ['time', 3600],
  day: ['time', 86400],
  b: ['data', 1],
  kb: ['data', 1000],
  mb: ['data', 1e6],
  gb: ['data', 1e9],
  kib: ['data', 1024],
  mib: ['data', 1048576],
  gib: ['data', 1073741824],
};
export function calculate(input: string): { value?: string; error?: string } | null {
  let source = input.trim().toLowerCase().replaceAll('×', '*').replaceAll('÷', '/');
  if (!/^[+\-.(\d]/.test(source) || source.length > 256) return null;
  const conversion = source.match(/^(.+?)\s+([a-z]+)\s+(?:to|in|转)\s+([a-z]+)$/);
  let factor = 1;
  let suffix = '';
  if (conversion) {
    const a = units[conversion[2]],
      b = units[conversion[3]];
    if (!a || !b || a[0] !== b[0]) return { error: qt('单位不兼容或暂不支持') };
    source = conversion[1];
    factor = a[1] / b[1];
    suffix = ` ${conversion[3]}`;
  }
  if (!/^[\d\s.+*/()%^-]+$/.test(source)) return null;
  try {
    const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)|[^\s]/g) ?? [];
    let i = 0;
    function primary(): number {
      const t = tokens[i++];
      let n: number;
      if (t === '(') {
        n = sum();
        if (tokens[i++] !== ')') throw Error();
      } else {
        if (!t || !/^(?:\d|\.)/.test(t)) throw Error();
        n = Number(t);
      }
      while (tokens[i] === '%') {
        i++;
        n /= 100;
      }
      return n;
    }
    function power(): number {
      const a = primary();
      if (tokens[i] === '^') {
        i++;
        return a ** unary();
      }
      return a;
    }
    function unary(): number {
      if (tokens[i] === '+' || tokens[i] === '-') {
        const sign = tokens[i++];
        return (sign === '-' ? -1 : 1) * unary();
      }
      return power();
    }
    function product(): number {
      let a = unary();
      while (tokens[i] === '*' || tokens[i] === '/') {
        const op = tokens[i++];
        const b = unary();
        a = op === '*' ? a * b : a / b;
      }
      return a;
    }
    function sum(): number {
      let a = product();
      while (tokens[i] === '+' || tokens[i] === '-') {
        const op = tokens[i++];
        const b = product();
        a = op === '+' ? a + b : a - b;
      }
      return a;
    }
    const value = sum() * factor;
    if (i !== tokens.length || !Number.isFinite(value)) throw Error();
    return { value: `${Number(value.toPrecision(12))}${suffix}` };
  } catch {
    return { error: qt('请检查表达式，除数不能为零') };
  }
}
