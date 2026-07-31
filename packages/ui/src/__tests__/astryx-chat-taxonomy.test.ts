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

test('composer uses the native Astryx slot hierarchy while preserving the product input behavior seam', async () => {
  const composer = await source('composer.tsx');
  assert.match(composer, /ChatComposer as AstryxChatComposer/);
  assert.match(composer, /<AstryxChatComposer/);
  assert.match(composer, /input=\{\([\s\S]*data-maka-contract="composer-input"/);
  assert.match(composer, /drawer=\{\(/);
  assert.match(composer, /headerActions=\{/);
  assert.match(composer, /footerActions=\{\(/);
  assert.match(composer, /sendActions=\{\(/);
  const headerActions = composer.slice(
    composer.indexOf('headerActions='),
    composer.indexOf('input={'),
  );
  const sendActions = composer.slice(
    composer.indexOf('sendActions='),
    composer.indexOf('sendButton='),
  );
  const footerActions = composer.slice(
    composer.indexOf('footerActions='),
    composer.indexOf('headerContext='),
  );
  const headerContext = composer.slice(
    composer.indexOf('headerContext='),
    composer.indexOf('sendActions='),
  );
  assert.match(headerActions, /maka-composer-voice-button/);
  assert.match(headerActions, /maka-composer-realtime-voice-button/);
  assert.doesNotMatch(sendActions, /maka-composer-(?:realtime-)?voice-button/);
  assert.doesNotMatch(footerActions, /PermissionModeSelect/);
  assert.match(headerContext, /PermissionModeSelect/);
  assert.doesNotMatch(composer, /elevation="none"/);
  assert.doesNotMatch(composer, /sendButton=\{<span aria-hidden="true" \/>\}/);
});

test('ordinary tool calls render through Astryx ChatToolCalls', async () => {
  const tools = await source('tool-activity.tsx');
  assert.match(tools, /ChatToolCalls/);
  assert.match(tools, /function AstryxToolCalls/);
  assert.match(tools, /<ChatToolCalls[\s\S]*calls=/);
});
