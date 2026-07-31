import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAllRendererCss } from './css-test-helpers.js';

test('renderer error boundary exposes a redacted copyable diagnostic report', async () => {
  const [source, shellCopy] = await Promise.all([
    readFile(join(process.cwd(), 'src/renderer/error-boundary.tsx'), 'utf8'),
    readFile(join(process.cwd(), 'src/renderer/locales/shell-copy.ts'), 'utf8'),
  ]);
  const css = await readAllRendererCss();

  assert.match(source, /import\s+\{[^}]*\bredactSecrets\b[^}]*\}\s+from\s+'@maka\/ui'/);
  assert.match(source, /import\s+\{[^}]*\bButton as UiButton\b[^}]*\}\s+from\s+'@maka\/ui'/);
  assert.match(source, /export function formatRendererErrorReport/);
  assert.match(source, /return redactSecrets\(lines\.join\('\\n'\)\)/);
  assert.match(source, /const safeStack = redactSecrets\(/);
  assert.match(source, /copyState: 'idle' \| 'pending' \| 'copied' \| 'failed'/);
  assert.match(source, /private mounted = false/);
  assert.match(source, /private copyRequestSeq = 0/);
  assert.match(source, /componentDidMount\(\): void \{[\s\S]*this\.mounted = true;[\s\S]*\}/);
  assert.match(source, /componentWillUnmount\(\): void \{[\s\S]*this\.mounted = false;[\s\S]*this\.copyRequestSeq \+= 1;[\s\S]*\}/);
  assert.match(source, /componentDidCatch\(error: Error, info: ErrorInfo\): void \{[\s\S]*this\.copyRequestSeq \+= 1;[\s\S]*this\.setState\(\{ errorInfo: info \}\);[\s\S]*\}/);
  assert.match(source, /private handleReset = \(\) => \{[\s\S]*this\.copyRequestSeq \+= 1;[\s\S]*this\.setState\(\{ error: null, errorInfo: null, copyState: 'idle' \}\);[\s\S]*\};/);
  assert.match(source, /private isCurrentCopyRequest\(copyRequestId: number, error: Error\): boolean \{[\s\S]*return this\.mounted && this\.copyRequestSeq === copyRequestId && this\.state\.error === error;[\s\S]*\}/);
  assert.match(source, /if \(!error \|\| this\.state\.copyState === 'pending'\) return;/);
  assert.match(source, /const copyRequestId = \+\+this\.copyRequestSeq/);
  assert.match(source, /this\.setState\(\{ copyState: 'pending' \}\)/);
  assert.match(source, /navigator\.clipboard\.writeText\(formatRendererErrorReport\(error, errorInfo\)\)/);
  assert.match(source, /if \(this\.isCurrentCopyRequest\(copyRequestId, error\)\) this\.setState\(\{ copyState: 'copied' \}\)/);
  assert.match(source, /if \(this\.isCurrentCopyRequest\(copyRequestId, error\)\) this\.setState\(\{ copyState: 'failed' \}\)/);
  assert.doesNotMatch(source, /await navigator\.clipboard\.writeText\(formatRendererErrorReport\(error, errorInfo\)\);\s*this\.setState\(\{ copyState: 'copied' \}\)/);
  assert.doesNotMatch(source, /\} catch \{\s*this\.setState\(\{ copyState: 'failed' \}\)/);
  assert.match(source, /copyPending\s*\? copy\.copyPending/);
  assert.match(source, /isDisabled=\{copyPending\}/); // #1565 PR 3: Astryx Button uses isDisabled
  assert.match(source, /aria-busy=\{copyPending \? 'true' : undefined\}/);
  assert.match(source, /data-copy-state=\{copyState\}/);
  // PR3 (#527) added a min-w utility to the copy button (text-swap width
  // lock for 复制中…/已复制 feedback). Match the class as a whole word in the
  // class list instead of an exact className="…", same form as the negative
  // maka-button check below.
  assert.match(source, /variant="secondary"[\s\S]*className="[^"]*\bmaka-error-copy-action\b[^"]*"/);
  // #1565 PR 3: Astryx Button — label prop instead of children, primary instead of default.
  assert.match(source, /<UiButton\s+variant="secondary"\s+onClick=\{this\.handleReset\}[\s\S]*?label=\{copy\.retry\}/);
  assert.match(source, /<UiButton variant="primary" onClick=\{this\.handleReload\} label=\{copy\.reload\} \/>/);
  assert.doesNotMatch(source, /className="maka-button/);
  assert.doesNotMatch(source, /data-variant="primary"/);
  assert.match(source, /copy\.copyReport/);
  assert.match(source, /copy\.copyFailed/);
  assert.match(shellCopy, /copyPending: '复制中…'/);
  assert.match(shellCopy, /copyPending: 'Copying…'/);
  assert.match(css, /\.maka-error-copy-status/);
  assert.match(css, /\.maka-error-copy-action\[data-copy-state="pending"\]/);
  assert.match(css, /\.maka-error-copy-action\[data-copy-state="failed"\]/);
  assert.doesNotMatch(css, /\.maka-error-actions \.maka-button/);
});
