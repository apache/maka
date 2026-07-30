import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

const uiSource = (name: string) => readFile(
  fileURLToPath(new URL(`../../../../../packages/ui/src/${name}`, import.meta.url)),
  'utf8',
);

it('uses Astryx as the sole Markdown core without adding a second stream smoother', async () => {
  const [body, wrapper, chat] = await Promise.all([
    uiSource('markdown-body.tsx'),
    uiSource('markdown.tsx'),
    uiSource('chat-turn.tsx'),
  ]);

  assert.match(body, /Markdown as AstryxMarkdown/);
  assert.match(body, /autolink="gfm"/);
  assert.doesNotMatch(body, /Streamdown|rehype|remark|isStreaming=/);
  assert.match(body, /trimStreamingArtifacts\(props\.text\)/);
  assert.match(wrapper, /const safeText = redactSecrets\(props\.text\)/);
  assert.match(wrapper, /MarkdownBody text=\{safeText\} streaming=\{props\.streaming\}/);
  assert.match(chat, /<Markdown text=\{displayed\} streaming \/>/);
  assert.match(chat, /useSmoothStreamContent/);
});

it('declares structural Markdown and reflow migration scopes without styling through them', async () => {
  const [body, chat] = await Promise.all([
    uiSource('markdown-body.tsx'),
    uiSource('chat-turn.tsx'),
  ]);
  assert.match(body, /data-maka-contract="markdown"/);
  assert.match(chat, /data-maka-contract="markdown-flow"/);
  assert.doesNotMatch(body, /\[data-maka-contract(?:=|])/);
  assert.doesNotMatch(chat, /\[data-maka-contract(?:=|])/);
});
