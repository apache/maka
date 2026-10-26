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

// Measures the parsed-node budget plugin in the actual Markdown parser, not
// browser frame rate. Run after building @maka/ui.
import { parseMarkdownAst } from '@astryxdesign/core/Markdown';
import { markdownDiagramPlugin } from '../dist/markdown-body.js';

const cases = {
  prose: 'Some ordinary message text, with no diagram.\n'.repeat(150),
  images: '![Screenshot](/tmp/result.png)\n\n'.repeat(30),
  code: '```ts\nconst x = 1;\n```\n\n'.repeat(30),
  mermaid: '```mermaid\ngraph TD; A-->B\n```\n\n'.repeat(5),
  quotedSvg: '> ```svg\n> <svg/>\n> ```\n\n'.repeat(5),
  xmlSvg: '```xml\n<svg/>\n```\n\n'.repeat(5),
};
const iterations = 3000;
function run(source, options) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) parseMarkdownAst(source, options);
  return performance.now() - start;
}
const options = { plugins: [markdownDiagramPlugin] };
for (const [name, source] of Object.entries(cases)) {
  for (let i = 0; i < 500; i++) { parseMarkdownAst(source); parseMarkdownAst(source, options); }
  const without = [], withPlugin = [];
  for (let i = 0; i < 7; i++) {
    if (i % 2) { withPlugin.push(run(source, options)); without.push(run(source)); }
    else { without.push(run(source)); withPlugin.push(run(source, options)); }
  }
  without.sort((a, b) => a - b); withPlugin.sort((a, b) => a - b);
  console.log(JSON.stringify({ case: name, iterations, withoutDiagramPluginMs: without[3], withDiagramPluginMs: withPlugin[3] }));
}
