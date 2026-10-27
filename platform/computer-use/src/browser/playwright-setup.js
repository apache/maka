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

const engine = new (module.exports.InjectedScript())(globalThis, {
  isUnderTest: false,
  sdkLanguage: 'javascript',
  testIdAttributeName: 'data-testid',
  stableRafCount: 1,
  browserName: 'chromium',
  isUtilityWorld: true,
  customEngines: [],
});
// Adapt the upstream data tree before rendering. No live DOM value or attribute
// changes, and the published dependency remains byte-identical.
engine.makaSnapshot = (root, protectedInput) => {
  const options = { mode: 'ai' };
  const snapshot = generateAriaTree(root, options);
  const pending = [snapshot.root];
  while (pending.length) {
    const node = pending.pop();
    const element = ariaNodeElement(node);
    if (element && protectedInput(element)) node.children = [''];
    for (const child of node.children) if (typeof child === 'object' && child) pending.push(child);
  }
  engine._lastAriaSnapshotForQuery = snapshot;
  return { full: renderAriaTree(snapshot, options), iframeRefs: snapshot.iframeRefs };
};
// Group the upstream parser's structured parts, never the raw selector text.
engine.makaSegments = (query) => {
  const parsed = engine.parseSelector(query);
  const result = [];
  let start = 0;
  for (let index = 0; index < parsed.parts.length; index++) {
    const part = parsed.parts[index];
    if (part.name !== 'internal:control' || part.body !== 'enter-frame') continue;
    if (index === start) throw new Error('Select an iframe before entering its frame');
    if (parsed.capture !== undefined && parsed.capture >= start && parsed.capture < index)
      throw new Error('Selector capture must occur after the last frame boundary');
    const chunk = { parts: parsed.parts.slice(start, index) };
    result.push({ text: stringifySelector(chunk), parsed: chunk });
    start = index + 1;
  }
  if (start === parsed.parts.length)
    throw new Error('A frame selector requires a descendant selector');
  const capture = parsed.capture === undefined ? undefined : parsed.capture - start;
  const chunk = { parts: parsed.parts.slice(start), capture };
  result.push({ text: stringifySelector(chunk), parsed: chunk });
  return result;
};
globalThis.__makaPlaywright = engine;
