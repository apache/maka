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
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { hasHanProse, MarkdownBody } from '../markdown-body.js';

describe('markdown Han-script marker', () => {
  it('reads the prose, not the code', () => {
    assert.equal(hasHanProse('按 `lastActiveAt` 排序。'), true);
    assert.equal(hasHanProse('Sort by `lastActiveAt`.'), false);
    assert.equal(hasHanProse('Sort by `排序键`.'), false);
    assert.equal(hasHanProse('Example:\n\n```ts\n// 返回值为空时抛错\nreturn null;\n```\n'), false);
    assert.equal(hasHanProse('说明：\n\n```ts\nreturn null;\n```\n'), true);
  });

  it('marks the markdown root so the emphasis rule can key on the script of the text', () => {
    const han = renderToStaticMarkup(<MarkdownBody text="扁平化*只作用于按时间视图*。" density="compact" />);
    assert.match(han, /<div[^>]*data-maka-contract="markdown"[^>]*data-maka-script="han"/);

    const latin = renderToStaticMarkup(<MarkdownBody text="Flattening *only* applies to the time view." density="compact" />);
    assert.doesNotMatch(latin, /data-maka-script/);
  });
});
