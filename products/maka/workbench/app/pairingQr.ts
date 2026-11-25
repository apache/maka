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

// ISO/IEC 18004 Model 2, byte mode, error correction L. Pairing URIs are ASCII.
const eccSizes = [
  0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30,
  26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
];
const blockCounts = [
  0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
  15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
];

function codewords(version: number) {
  let modules = (16 * version + 128) * version + 64;
  if (version > 1) {
    const n = Math.floor(version / 7) + 2;
    modules -= (25 * n - 10) * n - 55;
    if (version >= 7) modules -= 36;
  }
  return modules >> 3;
}

function multiply(a: number, b: number) {
  let value = 0;
  while (b) {
    if (b & 1) value ^= a;
    a = (a << 1) ^ (a & 128 ? 0x11d : 0);
    b >>= 1;
  }
  return value;
}

function interleave(data: Uint8Array, version: number) {
  const degree = eccSizes[version]!;
  const count = blockCounts[version]!;
  const generator = new Uint8Array(degree);
  generator[degree - 1] = 1;
  for (let root = 1, i = 0; i < degree; i++, root = multiply(root, 2)) {
    for (let j = 0; j < degree; j++) {
      generator[j] = multiply(generator[j]!, root) ^ (generator[j + 1] ?? 0);
    }
  }
  const short = Math.floor(data.length / count);
  const shortBlocks = count - (data.length % count);
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const payload = data.subarray(offset, offset + short + (i < shortBlocks ? 0 : 1));
    offset += payload.length;
    const parity = new Uint8Array(degree);
    for (const byte of payload) {
      const factor = byte ^ parity[0]!;
      parity.copyWithin(0, 1);
      parity[degree - 1] = 0;
      for (let j = 0; j < degree; j++) parity[j] = parity[j]! ^ multiply(generator[j]!, factor);
    }
    blocks.push({ payload, parity });
  }
  const result = new Uint8Array(data.length + degree * count);
  offset = 0;
  for (let i = 0; i <= short; i++) {
    for (const { payload } of blocks) if (i < payload.length) result[offset++] = payload[i]!;
  }
  for (let i = 0; i < degree; i++) {
    for (const { parity } of blocks) result[offset++] = parity[i]!;
  }
  return result;
}

function payload(text: string, version: number, capacity: number) {
  const data = new Uint8Array(capacity);
  let offset = 0;
  const put = (value: number, bits: number) => {
    for (let bit = bits - 1; bit >= 0; bit--, offset++) {
      data[offset >> 3] = data[offset >> 3]! | (((value >> bit) & 1) << (7 - (offset & 7)));
    }
  };
  put(4, 4);
  put(text.length, version < 10 ? 8 : 16);
  for (let i = 0; i < text.length; i++) put(text.charCodeAt(i), 8);
  put(0, Math.min(4, capacity * 8 - offset));
  for (let i = Math.ceil(offset / 8), pad = 0xec; i < capacity; i++, pad ^= 0xfd) data[i] = pad;
  return interleave(data, version);
}

const bit = (value: number, index: number) => (value >> index) & 1;

export function pairingQr(text: string): Uint8Array[] | null {
  if (!/^[\x00-\x7f]*$/.test(text)) return null;
  let version = 1;
  let capacity: number;
  for (;;) {
    capacity = codewords(version) - eccSizes[version]! * blockCounts[version]!;
    if (text.length * 8 + (version < 10 ? 12 : 20) <= capacity * 8) break;
    if (++version > 40) return null;
  }
  const bytes = payload(text, version, capacity);
  const size = 17 + 4 * version;
  // Value 2 marks cells not reserved by the function patterns.
  const grid = Array.from({ length: size }, () => new Uint8Array(size).fill(2));
  const set = (x: number, y: number, value: number) => {
    if (x >= 0 && x < size && y >= 0 && y < size) grid[y]![x] = value;
  };
  for (let i = 0; i < size; i++) {
    set(i, 6, 1 - (i & 1));
    set(6, i, 1 - (i & 1));
  }
  for (const [x, y] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        set(x + dx, y + dy, ring === 2 || ring === 4 ? 0 : 1);
      }
    }
  }
  if (version > 1) {
    const n = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : 2 * Math.floor((4 * version + 2 * n + 1) / (2 * n - 2));
    const positions = [
      6,
      ...Array.from({ length: n - 1 }, (_, i) => size - 7 - (n - 2 - i) * step),
    ];
    for (const x of positions) {
      for (const y of positions) {
        if ((x === 6 && (y === 6 || y === size - 7)) || (y === 6 && x === size - 7)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) === 1 ? 0 : 1);
          }
        }
      }
    }
  }
  // ECC level L, mask 0: format BCH codeword XOR 0x5412.
  const format = 0x77c4;
  for (let i = 0; i < 6; i++) set(8, i, bit(format, i));
  set(8, 7, bit(format, 6));
  set(8, 8, bit(format, 7));
  set(7, 8, bit(format, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(format, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(format, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(format, i));
  set(8, size - 8, 1);
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >> 11) * 0x1f25);
    const code = (version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(code, i));
      set(b, a, bit(code, i));
    }
  }
  let offset = 0;
  let up = true;
  for (let right = size - 1; right > 0; right -= 2, up = !up) {
    if (right === 6) right--;
    for (let i = 0; i < size; i++) {
      const y = up ? size - 1 - i : i;
      for (let x = right; x >= right - 1; x--) {
        if (grid[y]![x] !== 2) continue;
        const data = bit(bytes[offset >> 3] ?? 0, 7 - (offset & 7));
        set(x, y, data ^ (1 - ((x + y) & 1)));
        offset++;
      }
    }
  }
  return grid;
}
