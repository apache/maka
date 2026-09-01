/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Contract for the narrow #4309 Composer seam. Session selection is a
 * reference action, not an inline text token: the trigger query disappears,
 * the host reads one bounded snapshot, and the resulting QuoteRef owns the
 * actual context sent with the next turn.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../src/${relativePath}`, import.meta.url)), 'utf8');
}

function readRepoFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url)), 'utf8');
}

test('Composer exposes Session references through the @ trigger without serializing them as text', () => {
  const source = readSource('composer.tsx');
  assert.match(source, /sessionReferences\?: ReadonlyArray<ComposerSessionReference>/);
  assert.match(source, /onPickSessionReference\?\(session: ComposerSessionReference\)/);
  assert.match(source, /id: `session:\$\{session\.id\}`/);
  assert.match(source, /MessagesSquare/);
  assert.match(
    source,
    /onPickSessionReference\?\.\(suggestion\.session\)[\s\S]*?return '';/,
  );
});

test('Composer copy tells users that @ can reference files or Sessions', () => {
  const source = readSource('conversation-copy.ts');
  assert.match(source, /@ 引用文件或会话/);
  assert.match(source, /@ to reference files or sessions/);
});

test('Session search stays name-only and @ keeps the menu open after spaces', () => {
  const composer = readSource('composer.tsx');
  const dependencyPatch = readRepoFile('patches/@astryxdesign+core+0.5.2.patch');

  assert.match(composer, /const searchQuery = query\.trim\(\)/);
  assert.match(composer, /mentionQueryMatches\(searchQuery, session\.name\)/);
  assert.doesNotMatch(composer, /session\.lastMessagePreview \?\?/);
  assert.match(dependencyPatch, /if \(trigger\.character !== '@' && \/\[ \\n\]\/u\.test\(query\)\) return null;/);
});

test('Session Quote chips use the conversation icon so they are distinct from pasted excerpts', () => {
  const source = readSource('quote-ref-chip.tsx');
  assert.match(source, /props\.quote\.sourceSessionId \? MessagesSquare : TextQuote/);
});

test('Session-only context stays compact without bypassing the drawer disclosure contract', () => {
  const composer = readSource('composer.tsx');
  const styles = readRepoFile('apps/desktop/src/renderer/styles/composer.css');
  const sessionStyles = styles.slice(
    styles.indexOf('/* A Session reference follows'),
    styles.indexOf('/* Astryx ChatComposerDrawer wraps'),
  );

  assert.match(composer, /count=\{sessionReferenceDrawer \? undefined : drawerTokenCount\}/);
  assert.match(composer, /className=\{quote\.sourceSessionId \? 'maka-composer-session-token' : undefined\}/);
  assert.doesNotMatch(sessionStyles, /\[role=|> div\[id\]|\.astryx-token/);
  assert.match(sessionStyles, /\.maka-composer-session-token[\s\S]*max-width: min\(420px, 100%\)/);
});
