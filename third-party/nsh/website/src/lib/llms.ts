import { plainMarkdown } from './markdown-endpoint';
import { SECTIONS, pages } from './sections';
import { SITE_DESCRIPTION, SITE_TITLE, SITE_URL, type Lang } from './site';

const HEADER = `# ${SITE_TITLE}\n\n> ${SITE_DESCRIPTION}\n\nApps are written in Rust (compiled to native code) or TSX (run by QuickJS, and by the browser's JavaScript engine on the web), or both, on one native Rust runtime; the toolchain is the single \`nsh\` binary (\`nsh init my-app --template rust|ts\`, \`nsh run my-app\`, \`nsh package my-app --target <target>\`). Every page below is also served as Markdown at its URL plus \`.md\`.\n`;

/** `llms.txt`: the table of contents, one line per page, linking its Markdown. */
export async function buildLlmsIndex(): Promise<string> {
  const parts = [HEADER];
  for (const lang of ['en', 'zh-CN'] as Lang[]) {
    const all = await pages(lang);
    for (const section of SECTIONS) {
      const list = all.filter((page) => page.section === section.id);
      if (list.length === 0) continue;
      const heading = lang === 'en' ? section.label.en : `${section.label['zh-CN']}（中文）`;
      parts.push(`## ${heading}\n\n${list.map((p) => `- [${p.title}](${SITE_URL}${p.href}.md): ${p.description}`).join('\n')}\n`);
    }
  }
  return parts.join('\n');
}

/** `llms-full.txt`: every English page, in reading order. */
export async function buildLlmsFull(): Promise<string> {
  const all = await pages('en');
  const body = all.map((page) => `${plainMarkdown(page)}\n\nSource: ${SITE_URL}${page.href}`);
  return `${HEADER}\n---\n\n${body.join('\n\n---\n\n')}\n`;
}
