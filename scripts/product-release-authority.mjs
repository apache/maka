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

import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseProductTag, remoteProductTagCommit } from './product-release-tag.mjs';

const execFileAsync = promisify(execFile);

function expectedReleaseIdentity(tag) {
  const { prerelease } = parseProductTag(tag);
  return { tag, isPrerelease: prerelease.length > 0 };
}

export function assertDraftProductRelease(release, tag) {
  const expected = expectedReleaseIdentity(tag);
  if (!release || release.tagName !== expected.tag) {
    throw new Error(`GitHub Release does not identify product tag ${tag}`);
  }
  if (release.isDraft !== true) {
    throw new Error(`GitHub Release ${tag} must remain a Draft`);
  }
  if (release.isPrerelease !== expected.isPrerelease) {
    throw new Error(`GitHub Release ${tag} prerelease state must be ${expected.isPrerelease}`);
  }
  return release;
}

export async function verifyDraftProductRelease({
  tag,
  sourceCommit,
  repository,
  cwd = process.cwd(),
  run = execFileAsync,
}) {
  expectedReleaseIdentity(tag);
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error(`Product source must be an exact commit SHA; found ${sourceCommit}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`Product repository must be an exact owner/name; found ${repository}`);
  }

  const remoteCommit = await remoteProductTagCommit({ cwd, remote: 'origin', tag, run });
  if (!remoteCommit) throw new Error(`Product tag ${tag} does not exist on origin`);
  if (remoteCommit !== sourceCommit) {
    throw new Error(`Product tag ${tag} points to ${remoteCommit} instead of ${sourceCommit}`);
  }

  await run('git', ['fetch', '--force', '--no-tags', 'origin', 'main:refs/remotes/origin/main'], {
    cwd,
  });
  await run('git', ['merge-base', '--is-ancestor', sourceCommit, 'refs/remotes/origin/main'], {
    cwd,
  });

  const release = await run(
    'gh',
    ['release', 'view', tag, '--repo', repository, '--json', 'tagName,isDraft,isPrerelease'],
    { cwd },
  );
  let parsedRelease;
  try {
    parsedRelease = JSON.parse(release.stdout);
  } catch (error) {
    throw new Error(`GitHub returned an invalid Release record for ${tag}`, { cause: error });
  }
  return assertDraftProductRelease(parsedRelease, tag);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, tag, sourceCommit, repository = process.env.GITHUB_REPOSITORY] =
    process.argv.slice(2);
  if (command !== 'verify-draft' || !tag || !sourceCommit || !repository) {
    throw new Error(
      'usage: product-release-authority.mjs verify-draft <tag> <source-commit> <owner/repository>',
    );
  }
  await verifyDraftProductRelease({ tag, sourceCommit, repository });
  console.log(`Verified Draft product Release ${tag} at ${sourceCommit}`);
}
