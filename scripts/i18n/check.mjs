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
  { dir: 'products/maka/workbench/locales', strictBraces: false },
  { dir: 'plugins/shared/manifest-locales', strictBraces: true },
  { dir: 'platform/computer-use/locales', strictBraces: true },
  { dir: 'plugins/agent/facts/locales', strictBraces: true },
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
    throw new Error(`Expected JSON object at ${prefix || '<root>'}`);
  }
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      out.set(full, v);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v, full, out);
    } else {
      throw new Error(`Unsupported value at ${full}`);
    }
  }
  return out;
}

export function parseIcuParams(input, { strictBraces = false } = {}) {
  let pos = 0;
  const params = new Map();
  const selectVars = new Set();

  function skipWs() {
    while (pos < input.length && /\s/.test(input[pos])) pos++;
  }

  function readIdent() {
    skipWs();
    const start = pos;
    while (pos < input.length && /[a-zA-Z0-9_=-]/.test(input[pos])) pos++;
    return input.slice(start, pos);
  }

  function parseNodes(stopOnRbrace, inPlural) {
    while (pos < input.length) {
      const ch = input[pos];
      if (ch === '}') {
        if (stopOnRbrace) return;
        if (strictBraces) throw new Error(`Unmatched '}' at ${pos}`);
        pos++;
        continue;
      }
      if (ch === "'" && pos + 1 < input.length) {
        const next = input[pos + 1];
        if (next === "'") {
          pos += 2;
          continue;
        }
        if (next === '{' || next === '}' || (inPlural && next === '#')) {
          const quoteStart = pos;
          pos++;
          let closed = false;
          while (pos < input.length) {
            if (input[pos] === "'") {
              if (input[pos + 1] === "'") pos += 2;
              else {
                pos++;
                closed = true;
                break;
              }
            } else {
              pos++;
            }
          }
          if (!closed) {
            throw new Error(`Unclosed quoted literal starting at ${quoteStart}`);
          }
          continue;
        }
      }
      if (ch === '{') {
        const start = pos;
        pos++;
        if (strictBraces) {
          skipWs();
        }
        if (pos >= input.length || !/[a-zA-Z_]/.test(input[pos])) {
          if (strictBraces) throw new Error(`Invalid placeholder at ${start}`);
          continue;
        }
        const name = readIdent();
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          if (strictBraces) throw new Error(`Invalid placeholder name '${name}' at ${start}`);
          pos = start + 1;
          continue;
        }
        skipWs();
        if (input[pos] === '}') {
          pos++;
          if (!params.has(name)) params.set(name, 'text');
          continue;
        }
        if (input[pos] === ',') {
          pos++;
          const kind = readIdent();
          skipWs();
          if (input[pos] !== ',') throw new Error(`Expected ',' after ${kind} at ${pos}`);
          pos++;
          if (kind === 'plural') {
            if (selectVars.has(name)) {
              throw new Error(`Variable '${name}' used as both select and plural`);
            }
            params.set(name, 'count');
            const seen = new Set();
            let hasOther = false;
            let closed = false;
            while (pos < input.length) {
              skipWs();
              if (input[pos] === '}') {
                pos++;
                closed = true;
                break;
              }
              const sel = readIdent();
              if (!sel) throw new Error(`Expected plural selector at ${pos}`);
              if (!/^(=-?\d+|zero|one|two|few|many|other)$/.test(sel)) {
                throw new Error(`Invalid plural selector '${sel}' on ${name}`);
              }
              if (seen.has(sel)) {
                throw new Error(`Duplicate plural selector '${sel}' on ${name}`);
              }
              seen.add(sel);
              if (sel === 'other') hasOther = true;
              skipWs();
              if (input[pos] !== '{') throw new Error(`Expected '{' for plural branch ${sel}`);
              pos++;
              parseNodes(true, true);
              if (input[pos] !== '}') throw new Error(`Expected '}' for plural branch ${sel}`);
              pos++;
            }
            if (!closed) throw new Error(`Unclosed plural block for ${name}`);
            if (!hasOther) throw new Error(`Plural for ${name} missing 'other' branch`);
            continue;
          }
          if (kind === 'select') {
            if (params.get(name) === 'count') {
              throw new Error(`Variable '${name}' used as both plural and select`);
            }
            selectVars.add(name);
            params.set(name, 'text');
            const seen = new Set();
            let hasOther = false;
            let closed = false;
            while (pos < input.length) {
              skipWs();
              if (input[pos] === '}') {
                pos++;
                closed = true;
                break;
              }
              const key = readIdent();
              if (!key) throw new Error(`Expected select key at ${pos}`);
              if (seen.has(key)) {
                throw new Error(`Duplicate select branch '${key}' on ${name}`);
              }
              seen.add(key);
              if (key === 'other') hasOther = true;
              skipWs();
              if (input[pos] !== '{') throw new Error(`Expected '{' for select branch ${key}`);
              pos++;
              parseNodes(true, inPlural);
              if (input[pos] !== '}') throw new Error(`Expected '}' for select branch ${key}`);
              pos++;
            }
            if (!closed) throw new Error(`Unclosed select block for ${name}`);
            if (!hasOther) throw new Error(`Select for ${name} missing 'other' branch`);
            continue;
          }
          throw new Error(`Unsupported ICU type '${kind}' for ${name}`);
        }
        if (strictBraces) throw new Error(`Malformed placeholder '${name}' at ${start}`);
        pos = start + 1;
        continue;
      }
      pos++;
    }
    if (stopOnRbrace) throw new Error('Unclosed ICU brace');
  }

  parseNodes(false, false);
  return [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
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

  // 1. Structurally verify SDK SUPPORTED_LOCALES matches locales.manifest.json
  const sdkUrl = pathToFileURL(join(rootDir, 'packages/plugin-sdk/src/i18n.ts')).href;
  const { SUPPORTED_LOCALES } = await import(sdkUrl);
  const expectedLocales = manifest.locales.map((entry) => ({
    tag: entry.tag,
    autonym: entry.autonym,
    englishName: entry.englishName,
    dir: entry.dir,
    ...(entry.overlay ? { overlay: entry.overlay } : {}),
    fallbacks: entry.fallbacks,
  }));
  const actualLocales = SUPPORTED_LOCALES.map((entry) => ({
    tag: entry.tag,
    autonym: entry.autonym,
    englishName: entry.englishName,
    dir: entry.dir,
    ...(entry.overlay ? { overlay: entry.overlay } : {}),
    fallbacks: [...entry.fallbacks],
  }));
  if (JSON.stringify(actualLocales) !== JSON.stringify(expectedLocales)) {
    fail('packages/plugin-sdk/src/i18n.ts SUPPORTED_LOCALES does not match locales.manifest.json');
  }

  // 2. Check all JSON catalogs
  for (const { dir: relDir, strictBraces } of CATALOGS) {
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
        enSchema.set(k, JSON.stringify(parseIcuParams(v, { strictBraces })));
      } catch (e) {
        fail(`${relDir}/en.json [${k}]: ${e.message}`);
      }
    }

    const loadedMaps = new Map([[manifest.defaultLocale, enMap]]);
    for (const tag of tags) {
      if (tag === manifest.defaultLocale) continue;
      const p = join(dir, tag + '.json');
      const isOverlay = overlays.has(tag);
      if (!existsSync(p)) {
        if (!isOverlay) fail(`Missing locale file: ${relDir}/${tag}.json`);
        continue;
      }
      let map;
      try {
        map = flatten(JSON.parse(readFileSync(p, 'utf8')));
      } catch (e) {
        fail(`${relDir}/${tag}.json: ${e.message}`);
        continue;
      }
      loadedMaps.set(tag, map);
      if (!isOverlay) {
        for (const k of enMap.keys()) {
          if (!map.has(k)) fail(`${relDir}/${tag}.json missing key: ${k}`);
        }
      }
      for (const [k, v] of map) {
        if (!enMap.has(k)) {
          fail(`${relDir}/${tag}.json defines unknown key: ${k}`);
          continue;
        }
        try {
          const actual = new Map(parseIcuParams(v, { strictBraces }));
          const expected = new Map(JSON.parse(enSchema.get(k)));
          for (const [name, ty] of actual) {
            const expTy = expected.get(name);
            if (!expTy || (expTy !== ty && !(expTy === 'count' && ty === 'text'))) {
              fail(
                `${relDir}/${tag}.json [${k}] placeholder ${name} mismatch: expected ${expTy ?? 'none'}, got ${ty}`,
              );
            }
          }
          for (const [name, expTy] of expected) {
            if (!actual.has(name) && expTy !== 'count') {
              fail(`${relDir}/${tag}.json [${k}] missing placeholder: ${name}`);
            }
          }
        } catch (e) {
          fail(`${relDir}/${tag}.json [${k}]: ${e.message}`);
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
          fail(`${relDir}/${tag}.json [${k}] duplicates parent ${parentTag}.json`);
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
    const enDoc = readFileSync(enPath, 'utf8');
    const enMarkers = JSON.stringify(extractMarkers(enDoc, docSet.protocolMarkerPrefixes));
    for (const tag of tags) {
      if (tag === manifest.defaultLocale) continue;
      const p = join(dir, docSet.prefix + '.' + tag + '.md');
      if (!existsSync(p)) {
        if (!overlays.has(tag))
          fail(`Missing localized doc: ${docSet.dir}/${docSet.prefix}.${tag}.md`);
        continue;
      }
      const text = readFileSync(p, 'utf8');
      for (const m of docSet.requiredMarkers) {
        if (!text.includes(m)) fail(`${p} missing required marker ${m}`);
      }
      const markers = JSON.stringify(extractMarkers(text, docSet.protocolMarkerPrefixes));
      if (markers !== enMarkers) {
        fail(`${p} protocol HTML comment markers differ from en`);
      }
    }
  }

  return {
    errors,
    tagsCount: tags.length,
    catalogsCount: CATALOGS.length,
    docsCount: DOC_SETS.length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, tagsCount, catalogsCount, docsCount } = await checkRepository();
  if (errors.length > 0) {
    console.error(`i18n check failed with ${errors.length} error(s):`);
    for (const e of errors.slice(0, 50)) console.error('  - ' + e);
    process.exit(1);
  }
  console.log(
    `i18n check passed (${tagsCount} locales, ${catalogsCount} catalogs, ${docsCount} doc sets).`,
  );
}
