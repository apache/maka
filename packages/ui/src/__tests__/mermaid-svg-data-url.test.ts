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
import { describe, test } from 'node:test';
import { mermaidSvgToDataUrl } from '../mermaid-diagram.js';

describe('mermaidSvgToDataUrl', () => {
  test('injects explicit pixel dimensions and strips responsive sizing from the root tag', () => {
    const svg = '<svg viewBox="0 0 1200 675" width="100%" style="max-width: 1200px;"><g/></svg>';
    const url = mermaidSvgToDataUrl(svg, 1200, 675);
    assert.match(url, /^data:image\/svg\+xml;charset=utf-8,/);
    const decoded = decodeURIComponent(url.slice(url.indexOf(',') + 1));
    assert.match(decoded, /^<svg width="1200" height="675"/);
    assert.doesNotMatch(decoded, /width="100%"/);
    assert.doesNotMatch(decoded, /style="/);
    assert.ok(decoded.includes('<g/>'));
  });

  test('does not touch width/height attributes inside the svg body', () => {
    const svg = '<svg viewBox="0 0 10 10"><rect x="1" y="1" width="2" height="2"/></svg>';
    const decoded = decodeURIComponent(mermaidSvgToDataUrl(svg, 10, 10).split(',')[1]);
    assert.ok(decoded.includes('<rect x="1" y="1" width="2" height="2"/>'));
    assert.match(decoded, /^<svg width="10" height="10"/);
  });
});
