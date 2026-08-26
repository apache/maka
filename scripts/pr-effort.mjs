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

// How much reading a pull request asks for. Review state is deliberately not
// labelled here: GitHub already indexes review, check and draft state, so a
// search qualifier answers "whose move is it" without a workflow keeping a
// copy fresh. Pull request search has no size qualifier, which leaves reading
// effort as the one axis a query cannot express.

const EFFORT_LABELS = ['effort/XS', 'effort/S', 'effort/M', 'effort/L', 'effort/XL'];

// Counted changes should track what a human actually reads. Lockfiles,
// regenerated artifacts and binaries are verified by their own contracts, so
// letting their line counts reach the tiers would inflate every pull request
// that happens to touch one. A Rust dependency bump alone rewrites thousands
// of Cargo.lock lines that nobody reviews line by line.
const UNREAD_PATTERNS = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|uv\.lock)$/,
  /(^|\/)THIRD_PARTY_(NOTICES|LICENSES)[^/]*$/,
  /\.generated\.[cm]?[jt]sx?$/,
  /\.snapshot\.json$/,
  /\.min\.(js|css)$/,
  /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|sqlite|zip|gz|pdf)$/,
];

// Tier boundaries are inclusive upper bounds on readable lines. Test code is
// not discounted anywhere here; it is reviewed too.
const EFFORT_TIERS = [
  { label: 'effort/XS', maxLines: 10 },
  { label: 'effort/S', maxLines: 100 },
  { label: 'effort/M', maxLines: 500 },
  { label: 'effort/L', maxLines: 1000 },
  { label: 'effort/XL', maxLines: Number.POSITIVE_INFINITY },
];

function isUnreadPath(path) {
  const normalized = String(path).replace(/\\/g, '/');
  return UNREAD_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * @param {Array<{filename: string, additions?: number, deletions?: number}>} files
 */
function countReadableLines(files = []) {
  return files.reduce((total, file) => {
    if (isUnreadPath(file.filename)) return total;
    return total + (file.additions ?? 0) + (file.deletions ?? 0);
  }, 0);
}

/**
 * @param {Array<object>} files
 */
function classifyEffort(files = []) {
  const lines = countReadableLines(files);
  const tier = EFFORT_TIERS.find((candidate) => lines <= candidate.maxLines);
  return { label: tier.label, lines };
}

/**
 * @param {Array<object>} files
 * @param {string[]} currentLabels
 */
export function planLabels(files = [], currentLabels = []) {
  const { label, lines } = classifyEffort(files);
  const current = new Set(currentLabels);

  return {
    label,
    lines,
    addLabels: current.has(label) ? [] : [label],
    removeLabels: EFFORT_LABELS.filter((name) => name !== label && current.has(name)),
  };
}
