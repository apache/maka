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

export type SortableDomain =
  | 'number'
  | 'percent'
  | 'duration'
  | 'bytes'
  | `currency:${'$' | '€' | '£' | '¥'}`;

export interface SortableNumber {
  readonly domain: SortableDomain;
  readonly value: number;
}

const NUMBER_BODY = String.raw`(?:\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)`;
const CURRENCY_NUMBER_RE = new RegExp(String.raw`^\s*([+-])?\s*([$€£¥])\s*(${NUMBER_BODY})\s*$`);
const UNIT_NUMBER_RE = new RegExp(
  String.raw`^\s*([+-])?(${NUMBER_BODY})(?:\s*(%|ns|us|µs|μs|ms|s|b|kb|mb|gb|tb|pb|kib|mib|gib|tib|pib))?\s*$`,
  'i',
);

const DURATION_TO_MS: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1000,
};

const BYTES_TO_B: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
  pb: 1024 ** 5,
  pib: 1024 ** 5,
};

export function parseSortableNumber(raw: string): SortableNumber | null {
  const currencyMatch = CURRENCY_NUMBER_RE.exec(raw);
  if (currencyMatch) {
    const sign = currencyMatch[1] === '-' ? -1 : 1;
    const symbol = currencyMatch[2] as '$' | '€' | '£' | '¥';
    const num = Number(currencyMatch[3]!.replace(/,/g, ''));
    if (!Number.isFinite(num)) return null;
    const value = sign * num;
    return { domain: `currency:${symbol}`, value: value === 0 ? 0 : value };
  }

  const unitMatch = UNIT_NUMBER_RE.exec(raw);
  if (!unitMatch) return null;

  const sign = unitMatch[1] === '-' ? -1 : 1;
  const num = Number(unitMatch[2]!.replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  const base = sign * num;

  const rawUnit = unitMatch[3];
  if (!rawUnit) {
    return { domain: 'number', value: base === 0 ? 0 : base };
  }
  if (rawUnit === '%') {
    return { domain: 'percent', value: base === 0 ? 0 : base };
  }

  const unit = rawUnit.toLowerCase();
  const durationScale = DURATION_TO_MS[unit];
  if (durationScale !== undefined) {
    const scaled = base * durationScale;
    return Number.isFinite(scaled)
      ? { domain: 'duration', value: scaled === 0 ? 0 : scaled }
      : null;
  }

  const byteScale = BYTES_TO_B[unit];
  if (byteScale !== undefined) {
    const scaled = base * byteScale;
    return Number.isFinite(scaled) ? { domain: 'bytes', value: scaled === 0 ? 0 : scaled } : null;
  }

  return null;
}

export function compareNaturalText(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const aParts = a.match(re) ?? [];
  const bParts = b.match(re) ?? [];
  const len = Math.min(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i]!;
    const bp = bParts[i]!;
    const aDigits = ap.charCodeAt(0) >= 48 && ap.charCodeAt(0) <= 57;
    const bDigits = bp.charCodeAt(0) >= 48 && bp.charCodeAt(0) <= 57;
    if (aDigits && bDigits) {
      const diff = Number(ap) - Number(bp);
      if (diff !== 0) return diff;
      if (ap.length !== bp.length) return ap.length - bp.length;
    } else {
      const al = ap.toLowerCase();
      const bl = bp.toLowerCase();
      if (al !== bl) return al < bl ? -1 : 1;
    }
  }
  if (aParts.length !== bParts.length) return aParts.length - bParts.length;
  return a === b ? 0 : a < b ? -1 : 1;
}

export function compareTableCells(a: string, b: string, asc = true): number {
  const dir = asc ? 1 : -1;
  const an = parseSortableNumber(a);
  const bn = parseSortableNumber(b);
  if (an !== null && bn !== null && an.domain === bn.domain) {
    const diff = an.value - bn.value;
    return diff === 0 ? 0 : diff * dir;
  }
  const textDiff = compareNaturalText(a, b);
  return textDiff === 0 ? 0 : textDiff * dir;
}
