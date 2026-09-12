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
import {
  MERMAID_EXPORT_MAX_EDGE_PX,
  MERMAID_EXPORT_MAX_PIXELS,
  MERMAID_EXPORT_PIXEL_RATIO,
  mermaidExportScale,
  mermaidSvgToDataUrl,
} from '../mermaid-diagram.js';

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

describe('mermaidExportScale', () => {
  function bitmap(width: number, height: number) {
    const scale = mermaidExportScale(width, height);
    return { width: Math.floor(width * scale), height: Math.floor(height * scale) };
  }
  function withinBudget({ width, height }: { width: number; height: number }) {
    assert.ok(width <= MERMAID_EXPORT_MAX_EDGE_PX, `${width} exceeds the edge budget`);
    assert.ok(height <= MERMAID_EXPORT_MAX_EDGE_PX, `${height} exceeds the edge budget`);
    assert.ok(width * height <= MERMAID_EXPORT_MAX_PIXELS, `${width}x${height} exceeds the pixel budget`);
  }

  test('keeps the full pixel ratio for diagrams that fit the budget', () => {
    assert.equal(mermaidExportScale(123, 45), MERMAID_EXPORT_PIXEL_RATIO);
    assert.deepEqual(bitmap(123, 45), {
      width: 123 * MERMAID_EXPORT_PIXEL_RATIO,
      height: 45 * MERMAID_EXPORT_PIXEL_RATIO,
    });
  });

  test('clamps the report case below the ratio that would exceed the canvas limits', () => {
    // 30_000x4_000 at 2x used to become a 60_000x8_000 canvas.
    assert.ok(mermaidExportScale(30_000, 4_000) < MERMAID_EXPORT_PIXEL_RATIO);
    withinBudget(bitmap(30_000, 4_000));
  });

  test('clamps a near-square viewBox by area before the edge budget applies', () => {
    const size = bitmap(10_000, 10_000);
    withinBudget(size);
    assert.ok(size.width < MERMAID_EXPORT_MAX_EDGE_PX);
  });

  test('scales below 1x for elongated diagrams rather than rejecting them', () => {
    // Wider than the edge budget, so only the edge clamp can resolve it.
    const scale = mermaidExportScale(40_000, 100);
    assert.ok(scale > 0 && scale < 1);
    assert.ok(Math.abs(40_000 * scale - MERMAID_EXPORT_MAX_EDGE_PX) <= 1);
    withinBudget(bitmap(40_000, 100));
  });
});
