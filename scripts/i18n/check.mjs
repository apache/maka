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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(join(repo, 'locales.manifest.json'), 'utf8'));
const tags = manifest.locales.map((l) => l.tag);
const overlays = new Map(manifest.locales.filter((l) => l.overlay).map((l) => [l.tag, l.overlay]));

const CATALOG_DIRS = [
  'products/maka/workbench/locales',
  'plugins/shared/manifest-locales',
  'plugins/agent/facts/locales',
  'platform/computer-use/locales',
];

const DOC_SETS = [
  {
    dir: 'platform/computer-use/locales/docs',
    prefix: 'api',
    requiredMarkers: ['<!-- named-browser-documents -->'],
  },
];

function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (typeof v === 'string') {
      if (out.has(key)) throw new Error('Duplicate flattened key: ' + key);
      out.set(key, v);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v, key, out);
    } else {
      throw new Error('Invalid value at key ' + key);
    }
  }
  return out;
}

/** Parse ICU MessageFormat subset and extract parameter types (text vs count). */
function parseIcuParams(input) {
  let pos = 0;
  const params = new Map();
  const skipWs = () => {
    while (pos < input.length && /\s/.test(input[pos])) pos++;
  };
  const readIdent = () => {
    skipWs();
    const start = pos;
    while (pos < input.length && /[a-zA-Z0-9_=-]/.test(input[pos])) pos++;
    if (pos === start) throw new Error('Expected identifier at ' + pos);
    return input.slice(start, pos);
  };
  const parseNodes = (stopOnClose, inPlural) => {
    while (pos < input.length) {
      const ch = input[pos];
      if (ch === '}') {
        if (stopOnClose) return;
        pos += 1;
        continue;
      }
      if (ch === "'") {
        const next = input[pos + 1];
        if (next === "'") {
          pos += 2;
          continue;
        }
        if (next === '{' || next === '}' || next === '#') {
          pos += 1;
          while (pos < input.length) {
            if (input[pos] === "'") {
              if (input[pos + 1] === "'") pos += 2;
              else {
                pos += 1;
                break;
              }
            } else pos += 1;
          }
          continue;
        }
        pos += 1;
        continue;
      }
      if (ch === '{') {
        if (pos + 1 >= input.length || !/[a-zA-Z_]/.test(input[pos + 1])) {
          pos += 1;
          continue;
        }
        pos += 1;
        const name = readIdent();
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          throw new Error('Invalid placeholder name: ' + name);
        }
        skipWs();
        if (input[pos] === '}') {
          pos += 1;
          if (!params.has(name)) params.set(name, 'text');
        } else if (input[pos] === ',') {
          pos += 1;
          const kind = readIdent();
          skipWs();
          if (input[pos] !== ',') throw new Error('Expected comma after ' + kind);
          pos += 1;
          if (kind === 'plural') {
            params.set(name, 'count');
            let hasOther = false;
            while (pos < input.length) {
              skipWs();
              if (input[pos] === '}') {
                pos += 1;
                break;
              }
              const sel = readIdent();
              if (sel === 'other') hasOther = true;
              else if (!/^(=-?\d+|zero|one|two|few|many)$/.test(sel)) {
                throw new Error('Unknown plural selector: ' + sel);
              }
              skipWs();
              if (input[pos] !== '{') throw new Error('Expected { for plural branch ' + sel);
              pos += 1;
              parseNodes(true, true);
              if (input[pos] !== '}') throw new Error('Expected } for plural branch ' + sel);
              pos += 1;
            }
            if (!hasOther) throw new Error('Plural on ' + name + ' missing other branch');
          } else if (kind === 'select') {
            if (params.get(name) === 'count') {
              throw new Error('Variable ' + name + ' used as both count and select');
            }
            params.set(name, 'text');
            let hasOther = false;
            while (pos < input.length) {
              skipWs();
              if (input[pos] === '}') {
                pos += 1;
                break;
              }
              const sel = readIdent();
              if (sel === 'other') hasOther = true;
              skipWs();
              if (input[pos] !== '{') throw new Error('Expected { for select branch ' + sel);
              pos += 1;
              parseNodes(true, false);
              if (input[pos] !== '}') throw new Error('Expected } for select branch ' + sel);
              pos += 1;
            }
            if (!hasOther) throw new Error('Select on ' + name + ' missing other branch');
          } else {
            throw new Error('Unsupported ICU type: ' + kind);
          }
        } else {
          throw new Error('Expected } or , after ' + name);
        }
        continue;
      }
      pos += 1;
    }
    if (stopOnClose) throw new Error('Unclosed { in ICU message');
  };
  parseNodes(false, false);
  return [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function extractMarkers(doc) {
  const markers = new Set();
  for (const m of doc.matchAll(/<!--[^]*?-->/g)) {
    const trimmed = m[0].trim();
    if (
      trimmed.startsWith('<!-- browser-document:') ||
      trimmed === '<!-- /browser-document -->' ||
      trimmed === '<!-- named-browser-documents -->'
    ) {
      markers.add(trimmed);
    }
  }
  return [...markers].sort();
}

const errors = [];
const fail = (msg) => errors.push(msg);

// 1. Check SDK SUPPORTED_LOCALES matches locales.manifest.json
const sdkSrc = readFileSync(join(repo, 'packages/plugin-sdk/src/i18n.ts'), 'utf8');
for (const entry of manifest.locales) {
  if (!sdkSrc.includes("tag: '" + entry.tag + "'")) {
    fail('packages/plugin-sdk/src/i18n.ts is missing locale tag ' + entry.tag);
  }
  if (!sdkSrc.includes("autonym: '" + entry.autonym + "'")) {
    fail('packages/plugin-sdk/src/i18n.ts autonym mismatch for ' + entry.tag);
  }
}

// 2. Check all JSON catalogs
for (const relDir of CATALOG_DIRS) {
  const dir = join(repo, relDir);
  if (!existsSync(dir)) {
    fail('Missing catalog directory: ' + relDir);
    continue;
  }
  const enPath = join(dir, manifest.defaultLocale + '.json');
  if (!existsSync(enPath)) {
    fail('Missing default locale file: ' + enPath);
    continue;
  }
  const enMap = flatten(JSON.parse(readFileSync(enPath, 'utf8')));
  const enSchema = new Map();
  for (const [k, v] of enMap) {
    try {
      enSchema.set(k, JSON.stringify(parseIcuParams(v)));
    } catch (e) {
      fail(relDir + '/en.json [' + k + ']: ' + e.message);
    }
  }

  for (const tag of tags) {
    if (tag === manifest.defaultLocale) continue;
    const p = join(dir, tag + '.json');
    const isOverlay = overlays.has(tag);
    if (!existsSync(p)) {
      if (!isOverlay) fail('Missing locale file: ' + relDir + '/' + tag + '.json');
      continue;
    }
    let map;
    try {
      map = flatten(JSON.parse(readFileSync(p, 'utf8')));
    } catch (e) {
      fail(relDir + '/' + tag + '.json: ' + e.message);
      continue;
    }
    if (!isOverlay) {
      for (const k of enMap.keys()) {
        if (!map.has(k)) fail(relDir + '/' + tag + '.json missing key: ' + k);
      }
    }
    for (const [k, v] of map) {
      if (!enMap.has(k)) {
        fail(relDir + '/' + tag + '.json defines unknown key: ' + k);
        continue;
      }
      try {
        const actual = new Map(parseIcuParams(v));
        const expected = new Map(JSON.parse(enSchema.get(k)));
        for (const [name, ty] of actual) {
          const expTy = expected.get(name);
          if (!expTy || (expTy !== ty && !(expTy === 'count' && ty === 'text'))) {
            fail(
              relDir +
                '/' +
                tag +
                '.json [' +
                k +
                '] placeholder ' +
                name +
                ' mismatch: expected ' +
                (expTy ?? 'none') +
                ', got ' +
                ty,
            );
          }
        }
        for (const [name, expTy] of expected) {
          if (!actual.has(name) && expTy !== 'count') {
            fail(relDir + '/' + tag + '.json [' + k + '] missing placeholder: ' + name);
          }
        }
      } catch (e) {
        fail(relDir + '/' + tag + '.json [' + k + ']: ' + e.message);
      }
    }
  }
}

// 3. Check localized Markdown docs
for (const docSet of DOC_SETS) {
  const dir = join(repo, docSet.dir);
  const enPath = existsSync(join(dir, docSet.prefix + '.en.md'))
    ? join(dir, docSet.prefix + '.en.md')
    : join(dir, docSet.prefix + '.md');
  if (!existsSync(enPath)) {
    fail('Missing base doc: ' + enPath);
    continue;
  }
  const enDoc = readFileSync(enPath, 'utf8');
  const enMarkers = JSON.stringify(extractMarkers(enDoc));
  for (const tag of tags) {
    if (tag === manifest.defaultLocale) continue;
    const p = join(dir, docSet.prefix + '.' + tag + '.md');
    if (!existsSync(p)) {
      if (!overlays.has(tag))
        fail('Missing localized doc: ' + docSet.dir + '/' + docSet.prefix + '.' + tag + '.md');
      continue;
    }
    const text = readFileSync(p, 'utf8');
    for (const m of docSet.requiredMarkers) {
      if (!text.includes(m)) fail(p + ' missing required marker ' + m);
    }
    const markers = JSON.stringify(extractMarkers(text));
    if (markers !== enMarkers) {
      fail(p + ' protocol HTML comment markers differ from en');
    }
  }
}

if (errors.length > 0) {
  console.error('i18n check failed with ' + errors.length + ' error(s):');
  for (const e of errors.slice(0, 50)) console.error('  - ' + e);
  process.exit(1);
}
console.log(
  'i18n check passed (' +
    tags.length +
    ' locales, ' +
    CATALOG_DIRS.length +
    ' catalogs, ' +
    DOC_SETS.length +
    ' doc sets).',
);
