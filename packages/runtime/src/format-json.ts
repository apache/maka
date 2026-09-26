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

// Supported Node versions provide rawJSON; the ES2022 type library does not.
const sourceJson = JSON as typeof JSON & { rawJSON(source: string): unknown };

/** Format JSON without converting its numeric literals through binary64. */
export function formatJsonText(source: string, sortKeys: boolean): string {
  const value: unknown = JSON.parse(
    source,
    (_key: string, value: unknown, context?: { source?: string }): unknown => {
      if (typeof value === 'number') {
        if (context?.source === undefined) throw new Error('JSON number source is unavailable');
        return sourceJson.rawJSON(context.source);
      }
      // Revivers visit children first, so sorting here handles nested objects
      // without traversing (and accidentally expanding) raw numeric values.
      if (sortKeys && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, (value as Record<string, unknown>)[key]]),
        );
      }
      return value;
    },
  );
  return JSON.stringify(value, null, 2);
}
