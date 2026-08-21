import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const MAKA_EVAL_BUNDLE_ENV = 'MAKA_EVAL_MAKA_BUNDLE_PATH';

export function configureInstalledEvalBundle(
  environment: NodeJS.ProcessEnv = process.env,
  packageRoot = resolve(import.meta.dirname, '..'),
): void {
  if (Object.hasOwn(environment, MAKA_EVAL_BUNDLE_ENV)) return;
  try {
    if (!statSync(resolve(packageRoot, 'packages/eval')).isDirectory()) return;
  } catch {
    return;
  }
  environment[MAKA_EVAL_BUNDLE_ENV] = packageRoot;
}
