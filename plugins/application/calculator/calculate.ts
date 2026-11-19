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

const MAX_LENGTH = 256;

const UNITS: Record<string, readonly [dimension: string, factor: number]> = {
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

/** NaN stands for malformed input and carries through every operator. */
function evaluate(source: string): number {
  const tokens = source.match(/\d+(?:\.\d*)?|\.\d+|\S/g) ?? [];
  let at = 0;
  const primary = (): number => {
    const token = tokens[at++];
    let value = NaN;
    if (token === '(') {
      value = sum();
      if (tokens[at++] !== ')') return NaN;
    } else if (token !== undefined && /^[\d.]/.test(token)) {
      value = Number(token);
    }
    while (tokens[at] === '%') {
      at++;
      value /= 100;
    }
    return value;
  };
  const power = (): number => {
    const base = primary();
    if (tokens[at] !== '^') return base;
    at++;
    return base ** unary();
  };
  const unary = (): number => {
    const sign = tokens[at];
    if (sign !== '-' && sign !== '+') return power();
    at++;
    return sign === '-' ? -unary() : unary();
  };
  const product = (): number => {
    let value = unary();
    while (tokens[at] === '*' || tokens[at] === '/') {
      const operator = tokens[at++];
      const right = unary();
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (tokens[at] === '+' || tokens[at] === '-') {
      const operator = tokens[at++];
      const right = product();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  };
  const value = sum();
  return at === tokens.length ? value : NaN;
}

/** The result of arithmetic or a unit conversion; null for anything else, including a bare number. */
export function calculate(input: string): string | null {
  if (input.length > MAX_LENGTH) return null;
  let source = input
    .trim()
    .toLowerCase()
    .replaceAll('×', '*')
    .replaceAll('÷', '/')
    .replaceAll('（', '(')
    .replaceAll('）', ')');
  let factor = 1;
  let suffix = '';
  const conversion = source.match(/^(.+?)\s*([a-z]+)(?:\s+(?:to|in)\s+|\s*转\s*)([a-z]+)$/);
  if (conversion) {
    const from = UNITS[conversion[2]!];
    const to = UNITS[conversion[3]!];
    if (!from || !to || from[0] !== to[0]) return null;
    source = conversion[1]!;
    factor = from[1] / to[1];
    suffix = ` ${conversion[3]}`;
  } else if (!/[+\-*/^%]/.test(source.replace(/^[+-]+/, ''))) {
    return null;
  }
  if (!/^[\d\s.+*/()%^-]+$/.test(source)) return null;
  const value = evaluate(source) * factor;
  return Number.isFinite(value) ? `${Number(value.toPrecision(12))}${suffix}` : null;
}
