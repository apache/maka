/**
 * Source-contract guard for the ModelAdapter provider boundary (#1381 slice 1).
 *
 * Mirrors the `containment-guard-contract` pattern: scan the monorepo source
 * trees and fail if a file outside the adapter boundary re-introduces a direct
 * AI SDK *protocol* import. The seam established by #1390 means runtime/CLI
 * consumers import `ModelMessage` / `JSONValue` from `@maka/runtime`
 * (re-exported from `./model-protocol.js`) instead of from `ai`; this test
 * keeps that property cheap and enforceable as the codebase evolves.
 *
 * The only allowed home is `packages/runtime/src/model-adapter.ts`, the
 * value/implementation boundary where request lowering and response
 * normalization live. `model-protocol.ts` owns independent Maka contracts and
 * must not import the SDK at all.
 *
 * Schema helpers (`jsonSchema` / `zodSchema`), `RetryError`, and
 * `generateText` / `LanguageModel` value imports are deliberately out of scope
 * for slice 1 (RFC #1381 follow-up Q2/Q4) and are NOT policed by this guard —
 * only the message/value protocol symbols are.
 */
import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const PROTOCOL_HOME = resolve(REPO_ROOT, 'packages/runtime/src/model-protocol.ts');
const PROTOCOL_DECLARATION = resolve(REPO_ROOT, 'packages/runtime/dist/model-protocol.d.ts');
const ADAPTER_HOME = resolve(REPO_ROOT, 'packages/runtime/src/model-adapter.ts');
const ALLOWED_HOMES = new Set([ADAPTER_HOME]);

// Scan every TypeScript source tree under the monorepo; `walk` prunes tests,
// build output, deps, worktrees, and Playwright e2e (mirrors the containment
// guard's traversal so the two contracts stay consistent).
const SCAN_ROOTS = ['packages', 'apps'];

// SDK protocol symbols that must not cross the ModelAdapter boundary into
// runtime/CLI consumers. Re-importing any of these from `ai` / `@ai-sdk/*`
// outside the adapter re-opens the leak #1390 / #1381 slice 1 closed.
// `NormalizedUsage` / `ModelStreamEvent` / `ModelStreamResult` /
// `ModelFinishReason` / `RawUsageFields` are Maka-owned contracts exported from
// `model-protocol.ts`; the adapter lowers/normalizes to them. `StreamTextResult`
// / `AiSdkStreamChunk` are the retired SDK-shaped boundary types the relocation
// removed — re-introducing them would re-expose raw SDK chunk names to the
// backend.
const PROTOCOL_SYMBOLS = new Set([
  'ModelMessage',
  'JSONValue',
  'NormalizedUsage',
  'RawUsageFields',
  'ModelStreamEvent',
  'ModelStreamResult',
  'ModelFinishReason',
  'ModelToolDefinition',
  'ModelToolSet',
  'ModelFailure',
  'ModelRequestMetadata',
  // Corresponding AI SDK source contracts. Aliasing one of these under a
  // Maka name outside the adapter still crosses the boundary.
  'Tool',
  'ToolSet',
  'LanguageModelRequestMetadata',
  // Retired SDK-shaped boundary types (now adapter-internal). Flagging a
  // re-import keeps the backend from re-learning raw SDK chunk names.
  'StreamTextResult',
  'AiSdkStreamChunk',
  'handleStreamChunk',
  'ModelAdapterStreamCallbacks',
]);
const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](?:ai|@ai-sdk\/[^'"]+)['"]/g;
const SDK_DEPENDENCY_RE = /(?:from\s*|import\s*\(\s*)['"](?:ai|@ai-sdk\/[^'"]+)['"]/;

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (['node_modules', '__tests__', 'dist', '.worktree', '.pi', 'e2e'].includes(entry.name))
      continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) yield full;
  }
}

function importedProtocolSymbols(fileText: string): string[] {
  const found: string[] = [];
  for (const match of fileText.matchAll(IMPORT_RE)) {
    for (const spec of match[1].split(',')) {
      // `ModelMessage` or `ModelMessage as Foo` — flag the source binding.
      const name = spec.split(' as ')[0].trim();
      if (PROTOCOL_SYMBOLS.has(name)) found.push(name);
    }
  }
  return found;
}

describe('model-protocol boundary contract', () => {
  it('does not exempt the Maka-owned protocol seam from SDK import checks', () => {
    assert.equal(
      ALLOWED_HOMES.has(PROTOCOL_HOME),
      false,
      'model-protocol.ts must remain independent from ai and @ai-sdk/*',
    );
  });

  it('the protocol seam home exists and exports ModelMessage and JSONValue', async () => {
    const home = await readFile(PROTOCOL_HOME, 'utf8');
    assert.match(home, /export type ModelMessage\b/, 'model-protocol.ts must export ModelMessage');
    assert.match(home, /export type JSONValue\b/, 'model-protocol.ts must export JSONValue');
    assert.match(home, /export interface ModelToolDefinition\b/);
    assert.match(home, /export interface ModelFailure\b/);
    assert.match(home, /export interface ModelRequestMetadata\b/);
    assert.doesNotMatch(home, /kind: 'error'; error: unknown/);
    assert.doesNotMatch(
      home,
      SDK_DEPENDENCY_RE,
      'model-protocol.ts must not import ai or @ai-sdk/*',
    );
  });

  it('emits a declaration with no AI SDK dependency', async () => {
    const declaration = await readFile(PROTOCOL_DECLARATION, 'utf8');
    assert.doesNotMatch(
      declaration,
      SDK_DEPENDENCY_RE,
      'model-protocol.d.ts must not import ai or @ai-sdk/*',
    );
  });

  it('no source outside the adapter boundary imports ModelMessage/JSONValue from ai or @ai-sdk/*', async () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for await (const file of walk(resolve(REPO_ROOT, root))) {
        if (ALLOWED_HOMES.has(file)) continue;
        const text = await readFile(file, 'utf8');
        const symbols = importedProtocolSymbols(text);
        if (symbols.length > 0) {
          offenders.push(
            `${relative(REPO_ROOT, file)} imports ${symbols.join(', ')} from ai/ai-sdk`,
          );
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'ModelMessage/JSONValue must be imported from @maka/runtime (or ./model-protocol.js), not from ai. ' +
        'Re-introducing a direct SDK protocol import outside model-adapter.ts re-opens the #1381 slice-1 leak.',
    );
  });
});
