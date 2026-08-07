import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
export const RENDERER_STYLES_ENTRY = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');

const CSS_IMPORT_RE = /@import\s+"([^"]+\.css)"(?:\s+layer\([^)]+\))?\s*;/g;

// Generated Astryx theme output (#1565 PR 3). The converge contracts govern
// Maka's hand-written CSS vocabulary; astryx-theme/maka.css is an
// `astryx theme build` artifact with Astryx's own token system, excluded here
// for the same reason node_modules sheets never entered the scan (bare
// imports are skipped below).
// First-party workspace stylesheets reached through a bare specifier. These
// are product CSS in the same cascade layer as styles/*, so they belong in the
// scan; the bare-import skip below exists to keep node_modules sheets out, and
// once read as "skip anything not starting with ." it silently exempted the
// one first-party sheet imported that way. Resolved from the package's own
// `exports` map rather than guessed, so a moved file fails loudly.
const WORKSPACE_CSS_EXPORTS: Record<string, string> = {
  '@maka/ui/styles.css': 'packages/ui/src/styles.css',
};

export async function expandCssImports(file: string, seen: Set<string>): Promise<string> {
  const source = await readFile(file, 'utf8');
  let expanded = source;

  for (const match of source.matchAll(CSS_IMPORT_RE)) {
    const importPath = match[1];
    const workspaceCss = WORKSPACE_CSS_EXPORTS[importPath];
    if (!workspaceCss && !importPath.startsWith('.')) continue;
    if (importPath.includes('astryx-theme/')) continue;

    const resolvedPath = workspaceCss
      ? resolve(REPO_ROOT, workspaceCss)
      : resolve(dirname(file), importPath);
    if (seen.has(resolvedPath)) continue;

    seen.add(resolvedPath);
    expanded += `\n${await expandCssImports(resolvedPath, seen)}`;
  }

  return expanded;
}

export async function readAllRendererCss(): Promise<string> {
  // Fail closed: if import expansion breaks (missing file, bad @import path),
  // surface the error so converge contracts catch it instead of silently
  // degrading to only the styles.css entry and skipping styles/*.
  return expandCssImports(RENDERER_STYLES_ENTRY, new Set([RENDERER_STYLES_ENTRY]));
}
