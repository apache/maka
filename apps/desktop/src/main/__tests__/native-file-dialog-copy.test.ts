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
import test from 'node:test';
import { nativeFileDialogCopy } from '../native-file-dialog-copy.js';

test('every native file dialog string is translated in each locale', () => {
  const en = nativeFileDialogCopy('en');
  for (const locale of ['zh-CN', 'zh-TW'] as const) {
    const copy = nativeFileDialogCopy(locale);
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      assert.notEqual(copy[key], en[key], `${locale}: ${key} is still the English string`);
      assert.match(copy[key], /[一-鿿]/u, `${locale}: ${key} carries no Han text`);
    }
  }
});
