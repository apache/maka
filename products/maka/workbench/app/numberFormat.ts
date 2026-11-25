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

import { formatNumber } from '../../../../packages/plugin-sdk/src/index.js';
import { currentLocale } from './locale';

const MAX_FORMATTER_CACHE = 64;
const compactCache = new Map<string, Intl.NumberFormat>();
const decimalCache = new Map<string, Intl.NumberFormat>();

function getFormatter(
  cache: Map<string, Intl.NumberFormat>,
  key: string,
  locale: string,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  let formatter = cache.get(key);
  if (!formatter) {
    if (cache.size >= MAX_FORMATTER_CACHE) cache.clear();
    formatter = new Intl.NumberFormat(locale, options);
    cache.set(key, formatter);
  }
  return formatter;
}

function normalizeNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return value === 0 ? 0 : value;
}

export function formatCount(value: number): string {
  return formatNumber(value, currentLocale());
}

export function formatCompactCount(value: number): string {
  const normalized = normalizeNumber(value);
  if (normalized === null) return String(value);
  const locale = currentLocale();
  return getFormatter(compactCache, locale, locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  })
    .format(normalized)
    .replace(/([KMBT])$/, (unit) => unit.toLowerCase());
}

export function formatDecimal(value: number, maxFractionDigits = 2, minFractionDigits = 0): string {
  const normalized = normalizeNumber(value);
  if (normalized === null) return String(value);
  const max = Math.max(0, Math.min(20, Math.trunc(maxFractionDigits)));
  const min = Math.max(0, Math.min(max, Math.trunc(minFractionDigits)));
  const locale = currentLocale();
  return getFormatter(decimalCache, `${locale}:${min}:${max}`, locale, {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  }).format(normalized);
}
