import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name: string) => readFile(new URL(`../../src/${name}`, import.meta.url), 'utf8');

test('conversation renders through Astryx chat message taxonomy without legacy row or bubble primitives', async () => {
  const [turn, view, barrel] = await Promise.all([
    source('chat-turn.tsx'),
    source('chat-view.tsx'),
    source('index.ts'),
  ]);

  assert.match(turn, /ChatMessageBubble/);
  assert.match(turn, /ChatMessage/);
  assert.match(view, /ChatMessageList/);
  assert.doesNotMatch(turn, /import \{[^}]*\bBubble\b[^}]*\} from '.\/primitives\/chat\.js'/);
  assert.doesNotMatch(turn, /import \{[^}]*\bMessage\b[^}]*\} from '.\/primitives\/chat\.js'/);
  assert.doesNotMatch(view, /from '.\/primitives\/chat\.js'/);
  assert.doesNotMatch(barrel, /export \{[^}]*\bBubble\b[^}]*\} from '.\/primitives\/chat\.js'/);
  assert.doesNotMatch(barrel, /export \{[^}]*\bMessage\b[^}]*\} from '.\/primitives\/chat\.js'/);
  assert.doesNotMatch(barrel, /export \{[^}]*\bMarker\b[^}]*\} from '.\/primitives\/chat\.js'/);
});

test('conversation exposes streaming state on the Astryx live log', async () => {
  const view = await source('chat-view.tsx');
  assert.match(view, /<ChatMessageList[\s\S]*isStreaming=\{streamingActive\}/);
});

test('composer uses the Astryx composer surface while preserving the product input behavior seam', async () => {
  const composer = await source('composer.tsx');
  assert.match(composer, /ChatComposer as AstryxChatComposer/);
  assert.match(composer, /<AstryxChatComposer/);
  assert.match(composer, /input=\{\([\s\S]*data-maka-contract="composer-input"/);
});
