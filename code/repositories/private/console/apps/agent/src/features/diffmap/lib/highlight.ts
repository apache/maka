import hljs from 'highlight.js/lib/common';

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown',
  css: 'css', scss: 'scss', less: 'less', html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  py: 'python', go: 'go', rs: 'rust', java: 'java', cs: 'csharp',
  c: 'cpp', h: 'cpp', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', rb: 'ruby', php: 'php', sql: 'sql',
  kt: 'kotlin', swift: 'swift', lua: 'lua', makefile: 'makefile',
};

export function langOf(p: string): string | null {
  const ext = p.includes('.') ? p.split('.').pop()!.toLowerCase() : '';
  return EXT_LANG[ext] ?? null;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightLine(text: string, lang: string | null): string {
  if (!lang) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}
