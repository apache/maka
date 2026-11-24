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

import { currentLocale } from './locale';

const compactCache = new Map<string, Intl.NumberFormat>();
const groupedCache = new Map<string, Intl.NumberFormat>();

function getFormatter(
  cache: Map<string, Intl.NumberFormat>,
  locale: string,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  let formatter = cache.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    cache.set(locale, formatter);
  }
  return formatter;
}

export function formatCount(value: number): string {
  return getFormatter(groupedCache, currentLocale(), { maximumFractionDigits: 20 }).format(value);
}

export function formatCompactCount(value: number): string {
  return getFormatter(compactCache, currentLocale(), {
    notation: 'compact',
    maximumFractionDigits: 1,
  })
    .format(value)
    .replace(/([KMBT])$/, (unit) => unit.toLowerCase());
}
