#!/usr/bin/env node
/**
 * Workspace `console.*` audit (@kenji PR101 follow-up).
 *
 * Walks all .ts / .tsx source under apps/ and packages/, excludes
 * __tests__/, dist/, node_modules/. Flags any `console.<method>(...)` call
 * site that isn't on the allow-list. Exits 1 with a printed diff if a new
 * console site appears.
 *
 * Why a script and not an ESLint plugin: keeps tooling surface minimal and
 * the policy auditable from a single file. ESLint plugins drag in shared
 * config + parser deps for a 50-line check.
 *
 * To add a legitimate new console site: append to ALLOW with a one-line
 * reason. The audit grants every match in the allowed file path; specific
 * line-level allow-listing isn't worth the maintenance churn.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOTS = ['apps', 'packages'];
const EXTS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__']);

/**
 * Allow-list — file path (relative to repo root) → reason.
 * Allowing the whole file means every `console.*` site inside is OK.
 */
const ALLOW = new Map([
  [
    'apps/desktop/src/renderer/error-boundary.tsx',
    'React error boundary; DevTools-only, surfaces uncaught render errors.',
  ],
  ['apps/desktop/src/main/main.ts', 'dev-gated by VITE_DEV_SERVER_URL / NODE_ENV (PR100).'],
  [
    'apps/desktop/src/main/app-lifecycle.ts',
    'startup/shutdown diagnostics (dock icon, credential migration, e2e-fixture marker, cleanup failures); no secrets (moved from main.ts, arch R6).',
  ],
  [
    'apps/desktop/src/main/settings-runtime-effects.ts',
    'external-settings apply failure is a main-process diagnostic, no secrets (moved from main.ts, arch R5).',
  ],
  [
    'apps/desktop/src/main/daily-review-main.ts',
    'scheduler failures are main-process diagnostics and do not expose secrets.',
  ],
  [
    'apps/desktop/src/main/main-window.ts',
    'real-window smoke diagnostics are dev/test gated and stdout-parsed by capture tooling.',
  ],
  [
    'apps/desktop/src/main/oauth-model-connections-main.ts',
    'OAuth model sync logs provider-level failure reason only; no tokens or raw provider bodies.',
  ],
  [
    'apps/desktop/src/main/onboarding-service.ts',
    'PR110b: credential lookup failure logs error class only (no message / secret bytes); never reaches renderer.',
  ],
  [
    'packages/runtime/src/bots/bot-registry.ts',
    'message routed through generalizedErrorMessage (xuan raw-error sweep).',
  ],
  [
    'packages/runtime/src/telemetry/record-llm-call.ts',
    'message routed through generalizedErrorMessage.',
  ],
  [
    'packages/runtime/src/telemetry/record-tool-invocation.ts',
    'message routed through generalizedErrorMessage.',
  ],
  [
    'packages/headless/src/cli.ts',
    'CLI entrypoint prints command progress, usage, and failures to stdout/stderr by design.',
  ],
  [
    'packages/headless/src/harbor-cli.ts',
    'Harbor CLI subcommand prints usage and command failures to stderr by design.',
  ],
  [
    'apps/desktop/src/main/config-file-watcher.ts',
    'Watcher startup failure and runtime error diagnostics; non-fatal, no secrets.',
  ],
  [
    'apps/desktop/src/main/shell-env.ts',
    'login-shell env resolution diagnostics at startup (PATH-entry count, shell stderr snippet, capture failure reason); non-fatal, no secrets.',
  ],
  ['scripts/check-console.mjs', 'this script — explicit allow.'],
  [
    'apps/desktop/src/main/automation-wiring.ts',
    'best-effort sync warning when durable automation persistence fails.',
  ],
  [
    'packages/storage/src/automation-store.ts',
    'best-effort warning when automation store read/write fails.',
  ],
  [
    'packages/cli/src/runtime-bootstrap.ts',
    'best-effort warning when CLI durable automation persistence fails.',
  ],
  [
    'packages/core/src/shell-run-result.ts',
    'ShellRun reconciliation invariant diagnostics contain only runtime refs and revisions, never command or output data.',
  ],
]);

async function walk(root) {
  const out = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf('.');
        const ext = dot >= 0 ? entry.name.slice(dot) : '';
        if (EXTS.has(ext)) out.push(full);
      }
    }
  }
  await visit(root);
  return out;
}

const CONSOLE_RE = /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/g;

async function main() {
  const offenders = [];
  for (const root of ROOTS) {
    const files = await walk(join(REPO_ROOT, root));
    for (const file of files) {
      const rel = relative(REPO_ROOT, file).split('\\').join('/');
      if (ALLOW.has(rel)) continue;
      const src = await readFile(file, 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        CONSOLE_RE.lastIndex = 0;
        const match = CONSOLE_RE.exec(line);
        if (match) {
          offenders.push({ path: rel, line: i + 1, method: match[1], code: line.trim() });
        }
      });
    }
  }
  if (offenders.length === 0) {
    console.log(
      `[check-console] OK — ${ALLOW.size} files explicitly allow-listed, no other console sites found.`,
    );
    return;
  }
  console.error('[check-console] FAILED — new console.* call sites detected:');
  for (const o of offenders) {
    console.error(`  ${o.path}:${o.line}  console.${o.method}(...)`);
    console.error(`    ${o.code}`);
  }
  console.error('');
  console.error('If the new site is dev-gated or routed through generalizedErrorMessage,');
  console.error('add the file path to the ALLOW map in scripts/check-console.mjs with a');
  console.error('one-line reason. Otherwise, replace with a dev-only / generalized log.');
  process.exit(1);
}

main().catch((err) => {
  console.error('[check-console] unexpected error:', err);
  process.exit(2);
});
