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
 * How a project's absolute path is shown next to its name.
 *
 * The path is machine data and stays mono, but on the projects list it was
 * outweighing the thing it belongs to: a full absolute path wrapped to two
 * lines under a one-line project name, so the row read as a path with a title
 * rather than a project with a location.
 *
 * Two rules, in this order:
 *
 * 1. Collapse the home directory to `~`. It is the single longest constant
 *    prefix in a personal machine's paths and carries no information — every
 *    project under it shares it.
 * 2. Keep the TAIL when it still does not fit. A path's identity lives at its
 *    end: `.../experiments/astryx-design-system` says which project this is,
 *    while `/Users/someone/Developer/exp...` says which machine it is on. Head
 *    truncation is the opposite of what `text-overflow: ellipsis` does by
 *    default, which is why it needs saying here rather than in CSS alone.
 *
 * The full path always remains available as the element's tooltip, so nothing
 * is actually hidden — only de-emphasised.
 */

/** Collapse a home-directory prefix to `~`. */
export function collapseHomePath(path: string, homePath: string | undefined): string {
  if (!homePath) return path;
  // Trailing separators would otherwise leave `~/` for the home dir itself.
  const home = homePath.replace(/[/\\]+$/, '');
  if (home === '') return path;
  if (path === home) return '~';
  // Only a real path boundary counts: `/Users/mak` must not match inside
  // `/Users/maka-agent`.
  if (path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/**
 * Shorten from the head, keeping the last `maxLength` characters.
 *
 * Returns the path unchanged when it already fits, so short paths never gain
 * a leading ellipsis they did not need.
 */
export function truncatePathHead(path: string, maxLength: number): string {
  if (maxLength <= 1 || path.length <= maxLength) return path;
  // The ellipsis costs one character of the budget, so the kept tail is
  // maxLength - 1 and the result is exactly maxLength wide.
  return `…${path.slice(path.length - (maxLength - 1))}`;
}

export interface ProjectPathDisplay {
  /** What the row renders. */
  text: string;
  /** What the tooltip carries — the unabbreviated path, always. */
  title: string;
}

export function projectPathDisplay(
  path: string,
  options: { homePath?: string; maxLength?: number } = {},
): ProjectPathDisplay {
  const collapsed = collapseHomePath(path, options.homePath);
  return {
    text: truncatePathHead(collapsed, options.maxLength ?? 52),
    // The ORIGINAL path, not the `~` form: a tooltip exists to answer "where
    // exactly is this", and `~` is precisely the part that was elided.
    title: path,
  };
}
