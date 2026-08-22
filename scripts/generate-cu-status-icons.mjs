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

import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputDir = join(scriptDir, '..', 'apps', 'desktop', 'resources', 'status');

const path = {
  start: [0, 0],
  curve1: {
    controls: [
      [0.03, 0.23],
      [0.11, 0.51],
    ],
    end: [0.2, 0.83],
  },
  line1: [0.43, 0.63],
  curve2: {
    controls: [
      [0.49, 0.57],
      [0.57, 0.6],
    ],
    end: [0.63, 0.69],
  },
  line2: [0.8, 1.0],
  line3: [1.0, 0.89],
  curve3: {
    controls: [
      [0.86, 0.63],
      [0.69, 0.4],
    ],
    end: [0, 0],
  },
};

const gradientStops = [
  [0, [144, 182, 255]],
  [0.55, [73, 126, 247]],
  [1, [71, 97, 228]],
];

function cubicPoint(start, control1, control2, end, t) {
  const u = 1 - t;
  return [
    u ** 3 * start[0] + 3 * u * u * t * control1[0] + 3 * u * t * t * control2[0] + t ** 3 * end[0],
    u ** 3 * start[1] + 3 * u * u * t * control1[1] + 3 * u * t * t * control2[1] + t ** 3 * end[1],
  ];
}

function appendCurve(points, start, curve) {
  for (let step = 1; step <= 32; step++) {
    points.push(cubicPoint(start, curve.controls[0], curve.controls[1], curve.end, step / 32));
  }
}

function flattenedPath() {
  const points = [path.start];
  appendCurve(points, path.start, path.curve1);
  points.push(path.line1);
  appendCurve(points, path.line1, path.curve2);
  points.push(path.line2, path.line3);
  appendCurve(points, path.line3, path.curve3);
  return points;
}

function contains(points, x, y) {
  let inside = false;
  for (
    let current = 0, previous = points.length - 1;
    current < points.length;
    previous = current++
  ) {
    const [x1, y1] = points[current];
    const [x2, y2] = points[previous];
    const crosses = y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1;
    if (crosses) inside = !inside;
  }
  return inside;
}

function gradientColor(tIn) {
  const t = Math.min(1, Math.max(0, tIn));
  const upperIndex = gradientStops.findIndex(([position]) => position >= t);
  if (upperIndex <= 0) return gradientStops[0][1];
  const [startPosition, startColor] = gradientStops[upperIndex - 1];
  const [endPosition, endColor] = gradientStops[upperIndex];
  const weight = (t - startPosition) / (endPosition - startPosition);
  return startColor.map((channel, index) => channel + (endColor[index] - channel) * weight);
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    scanlines[rowStart] = 0;
    rgba.copy(scanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderStatusIcon(scale) {
  const dimension = 16 * scale;
  const margin = 2 * scale;
  const glyphSize = 12 * scale;
  const supersampling = 8;
  const polygon = flattenedPath().map(([x, y]) => [margin + x * glyphSize, margin + y * glyphSize]);
  const pixels = Buffer.alloc(dimension * dimension * 4);

  for (let y = 0; y < dimension; y++) {
    for (let x = 0; x < dimension; x++) {
      const channels = [0, 0, 0];
      let coverage = 0;
      for (let sampleY = 0; sampleY < supersampling; sampleY++) {
        for (let sampleX = 0; sampleX < supersampling; sampleX++) {
          const sx = x + (sampleX + 0.5) / supersampling;
          const sy = y + (sampleY + 0.5) / supersampling;
          if (!contains(polygon, sx, sy)) continue;
          const color = gradientColor((sx - margin + (sy - margin)) / (2 * glyphSize));
          for (let channel = 0; channel < 3; channel++) channels[channel] += color[channel];
          coverage++;
        }
      }
      const offset = (y * dimension + x) * 4;
      if (coverage > 0) {
        for (let channel = 0; channel < 3; channel++) {
          pixels[offset + channel] = Math.round(channels[channel] / coverage);
        }
        pixels[offset + 3] = Math.round((255 * coverage) / supersampling ** 2);
      }
    }
  }
  return encodePng(dimension, dimension, pixels);
}

writeFileSync(join(outputDir, 'cu-status.png'), renderStatusIcon(1));
writeFileSync(join(outputDir, 'cu-status@2x.png'), renderStatusIcon(2));
