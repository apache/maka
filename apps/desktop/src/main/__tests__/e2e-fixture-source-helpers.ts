import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Tests run from the compiled `dist/main/__tests__` tree, so climb back to
// the repo root and re-anchor on the SOURCE `apps/desktop/src/main` dir the
// way `renderer-shell-source-helpers` does.
const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const MAIN_ROOT = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'main');

// The e2e-fixture fixture was split (arch Round 3) from a single
// ~2.5K-line module into a thin registry barrel
// (`e2e-fixture.ts`) plus per-domain seeder modules under
// `e2e-fixture/`. Source-scanning contracts (placeholder-copy hygiene,
// visible-copy hygiene) must aggregate ALL of these so the coverage that
// used to hit the monolith keeps hitting its new homes. Add a new module
// here whenever the fixture grows another domain file.
const sourcePaths = [
  'e2e-fixture.ts',
  'e2e-fixture/seed-helpers.ts',
  'e2e-fixture/scenarios-settings.ts',
  'e2e-fixture/scenarios-modules.ts',
  'e2e-fixture/scenarios-artifacts.ts',
  'e2e-fixture/scenarios-chat.ts',
  'e2e-fixture/scenarios-sessions.ts',
] as const;

export async function readE2eFixtureCombinedSource(): Promise<string> {
  const sources = await Promise.all(
    sourcePaths.map((sourcePath) => readFile(resolve(MAIN_ROOT, sourcePath), 'utf8')),
  );
  return sources.join('\n');
}
