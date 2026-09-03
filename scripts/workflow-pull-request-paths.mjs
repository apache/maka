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
 * One reader for what a workflow's triggers filter on. Two lanes
 * derive a path filter from an import closure and compare it against this, and
 * `ci-workflow-policy.test.mjs` runs before `npm ci` installs a YAML parser, so
 * the install-free spelling is the only one that can be shared — which makes it
 * the one both use, rather than a second parser that agrees until it does not.
 *
 * Node builtins only, for that same reason.
 *
 * Given up by hand-scanning rather than parsing: flow sequences
 * (`paths: [a, b]`), block scalars, anchors and the rest of legal YAML. The
 * workflows are written one entry per line, and several assertions over these
 * lists already depend on that.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function readWorkflow(workflowName, repoRoot = defaultRepoRoot) {
  return readFileSync(join(repoRoot, '.github', 'workflows', workflowName), 'utf8');
}

/**
 * The `on:` block only, with comment lines stripped, so a workflow cannot
 * escape a trigger contract by writing `on: [pull_request]`, prose elsewhere in
 * the file cannot fake one, and a comment between a trigger and its list cannot
 * end a scan. Stripped comments survive as blank lines.
 */
export function workflowTriggerBlock(source) {
  const withoutComments = source.replaceAll(/^[ \t]*#.*$/gmu, '');

  return withoutComments.match(/^on:(.*(?:\n(?![^\s#]).*)*)/mu)?.[1] ?? '';
}

/**
 * The `paths` list belonging to one of a workflow's triggers, or `null` when it
 * carries no such trigger at all — which is what lets a caller tell "no such
 * trigger" apart from "this trigger runs on everything". Anchoring to the
 * trigger, instead of matching entry text anywhere in the file, is what makes
 * the filter assertions fail when entries move under `paths-ignore`, under
 * another trigger, or out of `on:` altogether.
 */
export function triggerPathFilter(source, trigger) {
  const lines = workflowTriggerBlock(source).split('\n');
  const start = lines.findIndex((line) => new RegExp(`^ {2}${trigger}:\\s*$`, 'u').test(line));
  if (start < 0) return null;

  // Accepts the quoting and spacing YAML allows, so a legal rewrite reports the
  // entries it really has instead of an empty list that reads as no filter.
  const paths = [];
  let inPaths = false;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (/^ {0,2}\S/u.test(line)) break;
    if (/^ {4}\S/u.test(line)) {
      inPaths = /^ {4}paths:\s*$/u.test(line);
      continue;
    }
    const entry = inPaths ? /^\s+-\s+['"]?(.+?)['"]?\s*$/u.exec(line) : null;
    if (entry) paths.push(entry[1]);
  }
  return paths;
}

export function readTriggerPathFilter(workflowName, trigger, repoRoot = defaultRepoRoot) {
  return triggerPathFilter(readWorkflow(workflowName, repoRoot), trigger);
}

/**
 * The `pull_request` filter, with "no trigger" and "no filter" both reported as
 * the empty list: every caller of this one asks what a pull request is filtered
 * on, and neither answer is a filter.
 */
export function readPullRequestPathFilter(workflowName, repoRoot = defaultRepoRoot) {
  return readTriggerPathFilter(workflowName, 'pull_request', repoRoot) ?? [];
}
