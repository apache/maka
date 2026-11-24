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
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const CATALOGS = [
  'products/maka/workbench/locales',
  'plugins/shared/manifest-locales',
  'platform/computer-use/locales',
  'plugins/agent/facts/locales',
];

const DOC_SETS = [
  {
    dir: 'platform/computer-use/locales/docs',
    prefix: 'api',
    requiredMarkers: ['<!-- named-browser-documents -->'],
    protocolMarkerPrefixes: [
      '<!-- named-browser-documents -->',
      '<!-- browser-document:',
      '<!-- /browser-document -->',
    ],
  },
];

function flatten(obj, prefix = '', out = new Map()) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Expected JSON object at ' + (prefix || '<root>'));
  }
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? prefix + '.' + k : k;
    if (typeof v === 'string') {
      out.set(full, v);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v, full, out);
    } else {
      throw new Error('Expected string or object at ' + full);
    }
  }
  return out;
}

export function extractMarkers(doc, prefixes) {
  const markers = [];
  for (const m of doc.matchAll(/<!--[^]*?-->/g)) {
    const trimmed = m[0].trim();
    if (prefixes.some((p) => trimmed.startsWith(p))) {
      markers.push(trimmed);
    }
  }
  return markers;
}

export async function checkRepository(rootDir = repo) {
  const manifest = JSON.parse(readFileSync(join(rootDir, 'locales.manifest.json'), 'utf8'));
  const tags = manifest.locales.map((l) => l.tag);
  const overlays = new Map(
    manifest.locales.filter((l) => l.overlay).map((l) => [l.tag, l.overlay]),
  );

  const errors = [];
  const fail = (msg) => errors.push(msg);

  // 1. Verify SDK SUPPORTED_LOCALES matches locales.manifest.json and reuse its single ICU parser.
  const sdkUrl = pathToFileURL(join(rootDir, 'packages/plugin-sdk/src/i18n.ts')).href;
  const { SUPPORTED_LOCALES, extractIcuParams } = await import(sdkUrl);
  const expectedLocales = manifest.locales.map((entry) => ({
    tag: entry.tag,
    autonym: entry.autonym,
    fallbacks: entry.fallbacks,
  }));
  const actualLocales = SUPPORTED_LOCALES.map((entry) => ({
    tag: entry.tag,
    autonym: entry.autonym,
    fallbacks: [...entry.fallbacks],
  }));
  if (JSON.stringify(actualLocales) !== JSON.stringify(expectedLocales)) {
    fail('packages/plugin-sdk/src/i18n.ts SUPPORTED_LOCALES does not match locales.manifest.json');
  }

  // 2. Check all JSON catalogs under one uniform strict ICU parser
  for (const relDir of CATALOGS) {
    const dir = join(rootDir, relDir);
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
        enSchema.set(k, JSON.stringify(extractIcuParams(v)));
      } catch (e) {
        fail(relDir + '/en.json [' + k + ']: ' + e.message);
      }
    }

    const loadedMaps = new Map([[manifest.defaultLocale, enMap]]);
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
      loadedMaps.set(tag, map);
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
          const actual = new Map(extractIcuParams(v));
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

    // Reject redundant overlay entries identical to their parent locale
    for (const [tag, parentTag] of overlays) {
      const overlayMap = loadedMaps.get(tag);
      const parentMap = loadedMaps.get(parentTag);
      if (!overlayMap || !parentMap) continue;
      for (const [k, v] of overlayMap) {
        if (parentMap.get(k) === v) {
          fail(relDir + '/' + tag + '.json [' + k + '] duplicates parent ' + parentTag + '.json');
        }
      }
    }
  }

  // 3. Check localized Markdown docs
  for (const docSet of DOC_SETS) {
    const dir = join(rootDir, docSet.dir);
    const enPath = existsSync(join(dir, docSet.prefix + '.en.md'))
      ? join(dir, docSet.prefix + '.en.md')
      : join(dir, docSet.prefix + '.md');
    if (!existsSync(enPath)) {
      fail('Missing base doc: ' + enPath);
      continue;
    }
    const baseText = readFileSync(enPath, 'utf8');
    const baseMarkers = extractMarkers(baseText, docSet.protocolMarkerPrefixes);
    for (const tag of tags) {
      const p = join(dir, docSet.prefix + '.' + tag + '.md');
      if (!existsSync(p)) {
        if (overlays.has(tag)) continue;
        if (tag === manifest.defaultLocale && existsSync(join(dir, docSet.prefix + '.md')))
          continue;
        fail('Missing localized doc: ' + p);
        continue;
      }
      const text = readFileSync(p, 'utf8');
      for (const req of docSet.requiredMarkers) {
        if (!text.includes(req)) fail(p + ' missing required marker ' + req);
      }
      const markers = extractMarkers(text, docSet.protocolMarkerPrefixes);
      if (JSON.stringify(markers) !== JSON.stringify(baseMarkers)) {
        fail(p + ' protocol HTML comment markers differ from base ' + enPath);
      }
    }
  }

  return {
    errors,
    localeCount: tags.length,
    catalogCount: CATALOGS.length,
    docSetCount: DOC_SETS.length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, localeCount, catalogCount, docSetCount } = await checkRepository();
  if (errors.length > 0) {
    console.error('i18n check failed with ' + errors.length + ' error(s):');
    for (const e of errors.slice(0, 50)) console.error('  -', e);
    if (errors.length > 50) console.error('  ... and ' + (errors.length - 50) + ' more');
    process.exit(1);
  }
  console.log(
    'i18n check passed (' +
      localeCount +
      ' locales, ' +
      catalogCount +
      ' catalogs, ' +
      docSetCount +
      ' doc sets).',
  );
}
