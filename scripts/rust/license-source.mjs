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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: Infinity });
}

function pinnedGitHubLicense(url, root, trees) {
  const source =
    /^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([a-f0-9]{40})\/([^?#]+)$/.exec(
      url,
    );
  if (!source) return;
  const [, owner, repo, revision, path] = source;
  const parts = path.split('/').map(decodeURIComponent);
  if (
    [owner, repo, ...parts].some((part) => !part || part === '.' || part === '..') ||
    parts.some((part) => /[\/\\\x00-\x1f\x7f]/.test(part))
  )
    throw new Error('Invalid pinned GitHub license path: ' + url);
  const entry = JSON.parse(
    run(
      'gh',
      [
        'api',
        '--hostname',
        'github.com',
        `repos/${owner}/${repo}/contents/${parts.map(encodeURIComponent).join('/')}?ref=${revision}`,
      ],
      root,
    ),
  );
  if (
    entry?.type !== 'file' ||
    entry.path !== parts.join('/') ||
    entry.encoding !== 'base64' ||
    typeof entry.content !== 'string' ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    typeof entry.sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(entry.sha)
  )
    throw new Error('Invalid pinned GitHub license response: ' + url);
  const base64 = entry.content.replace(/\r?\n/g, '');
  const content = Buffer.from(base64, 'base64');
  if (
    content.toString('base64') !== base64 ||
    content.length !== entry.size ||
    createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex') !==
      entry.sha
  )
    throw new Error('Pinned GitHub license content does not match its blob: ' + url);
  // Contents can dereference symlinks; bind the bytes to an ordinary blob at this pinned path.
  let tree = revision;
  for (let index = 0; index < parts.length; index++) {
    const key = `${owner}/${repo}/${tree}`;
    if (!trees.has(key)) {
      const data = JSON.parse(
        run(
          'gh',
          ['api', '--hostname', 'github.com', `repos/${owner}/${repo}/git/trees/${tree}`],
          root,
        ),
      );
      if (
        !Array.isArray(data?.tree) ||
        data.truncated !== false ||
        typeof data.sha !== 'string' ||
        !/^[a-f0-9]{40}$/.test(data.sha) ||
        (index > 0 && data.sha !== tree)
      )
        throw new Error('Invalid pinned GitHub license tree: ' + url);
      trees.set(key, data.tree);
    }
    const matches = trees.get(key).filter((item) => item.path === parts[index]);
    const item = matches[0];
    const last = index === parts.length - 1;
    if (
      matches.length !== 1 ||
      typeof item?.sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(item.sha) ||
      (last
        ? item.type !== 'blob' ||
          !['100644', '100755'].includes(item.mode) ||
          item.sha !== entry.sha
        : item.type !== 'tree' || item.mode !== '040000')
    )
      throw new Error('Pinned GitHub license path is not the expected blob: ' + url);
    tree = item.sha;
  }
  return new TextDecoder().decode(content);
}

export function licenseDownloader(root) {
  const downloaded = new Map();
  const githubTrees = new Map();
  async function download(url) {
    if (!downloaded.has(url))
      downloaded.set(
        url,
        (async () => {
          let fallbackCause;
          const rawCauses = [];
          for (let attempt = 0; ; attempt++) {
            try {
              const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
              if (!response.ok) throw new Error('HTTP ' + response.status);
              return await response.text();
            } catch (cause) {
              rawCauses.push(cause);
              if (attempt === 0) {
                try {
                  const content = pinnedGitHubLicense(url, root, githubTrees);
                  if (content !== undefined) return content;
                } catch (error) {
                  fallbackCause = error;
                }
              }
              if (attempt === 2)
                throw new Error('License source failed: ' + url, {
                  cause: fallbackCause ? new AggregateError([...rawCauses, fallbackCause]) : cause,
                });
              await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
            }
          }
        })(),
      );
    return downloaded.get(url);
  }
  return download;
}
