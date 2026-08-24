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

import assert from 'node:assert/strict';

export function expect(actual: unknown) {
  return {
    not: {
      toBeNull() {
        assert.notStrictEqual(actual, null);
      },
      toContain(expected: string) {
        assert.ok(
          !String(actual).includes(expected),
          `expected ${String(actual)} not to contain ${expected}`,
        );
      },
    },
    toBe(expected: unknown) {
      assert.strictEqual(actual, expected);
    },
    toEqual(expected: unknown) {
      assert.deepStrictEqual(actual, expected);
    },
    toBeCloseTo(expected: number, precision = 2) {
      assert.ok(Math.abs(Number(actual) - expected) < 10 ** -precision);
    },
    toBeDefined() {
      assert.notStrictEqual(actual, undefined);
    },
    toBeNull() {
      assert.strictEqual(actual, null);
    },
    toBeUndefined() {
      assert.strictEqual(actual, undefined);
    },
    toContain(expected: string) {
      assert.ok(String(actual).includes(expected));
    },
    toHaveLength(expected: number) {
      assert.strictEqual((actual as { length: number }).length, expected);
    },
    toMatch(expected: RegExp) {
      assert.match(String(actual), expected);
    },
    toMatchObject(expected: Record<string, unknown>) {
      assert.deepStrictEqual(
        Object.fromEntries(
          Object.keys(expected).map((key) => [key, (actual as Record<string, unknown>)[key]]),
        ),
        expected,
      );
    },
  };
}
