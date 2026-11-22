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

export function sameValue(a: unknown, b: unknown): boolean {
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object')
      return (
        '{' +
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => JSON.stringify(key) + ':' + canonical(value))
          .join(',') +
        '}'
      );
    return JSON.stringify(value);
  }
  return canonical(a) === canonical(b);
}
