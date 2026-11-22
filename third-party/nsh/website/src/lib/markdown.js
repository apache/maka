import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The site ships its own Shiki themes (allsum-light / allsum-dark: Allsum's
// code palette, which TextView's built-in highlighting colors the same scopes
// with); `global.css` maps their colours onto `--code-*` tokens, so
// fenced blocks, demo sources and the home page's code all share one palette.
// Read from the project root, where Astro runs.
const theme = (name) => JSON.parse(readFileSync(join(process.cwd(), 'src', `${name}.theme.json`), 'utf8'));

export const themes = { light: theme('light'), dark: theme('dark') };

export const langs = ['tsx', 'ts', 'js', 'json', 'sh', 'bash', 'swift', 'java', 'kotlin', 'rust', 'toml', 'diff', 'xml', 'html', 'yaml', 'css'];

export const shikiConfig = {
  themes,
  defaultColor: 'light',
  langs,
};
