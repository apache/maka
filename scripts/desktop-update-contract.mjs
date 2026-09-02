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

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { parseProductReleaseVersion } from './release-version.mjs';

export const DESKTOP_UPDATE_PROVIDER = Object.freeze({
  provider: 'github',
  owner: 'apache',
  repo: 'maka',
  updaterCacheDirName: '@makadesktop-updater',
});
export const DESKTOP_NIGHTLY_UPDATE_PROVIDER = Object.freeze({
  provider: 'github',
  owner: 'apache',
  repo: 'maka',
  channel: 'dev',
  updaterCacheDirName: '@makadesktop-updater',
});

/**
 * electron-builder suffixes the Linux feed with the architecture for everything
 * except x64, so the two Linux architectures never share a feed the way the two
 * macOS ones do.
 */
export function linuxUpdateMetadataName(arch, isNightly) {
  const channel = isNightly ? 'dev' : 'latest';
  return arch === 'x64' ? `${channel}-linux.yml` : `${channel}-linux-${arch}.yml`;
}

/**
 * The payloads electron-builder writes a `<file>.blockmap` beside. Only the
 * archive and NSIS targets call `createBlockmap`, which writes that sidecar; the
 * AppImage calls `appendBlockmap`, which puts the block map inside the AppImage,
 * and fpm targets build none. Naming the two that have one keeps a payload with
 * no sidecar from silently skipping the check.
 */
const SIDECAR_BLOCKMAP_EXTENSIONS = Object.freeze(['.exe', '.zip']);

/** A stable successor lets stable, alpha, and beta candidates use one feed contract. */
export function bumpedAutoupdateVersion(candidateVersion) {
  const { core, prerelease } = parseProductReleaseVersion(candidateVersion);
  const [major, minor, patch] = core;
  return prerelease.length > 0 ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1n}`;
}

async function readYaml(path, read = readFile) {
  const [source, { parse }] = await Promise.all([read(path, 'utf8'), import('yaml')]);
  return parse(source);
}

function requireExactObject(actual, expected, subject) {
  const exact =
    actual &&
    typeof actual === 'object' &&
    !Array.isArray(actual) &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value);
  if (!exact) {
    throw new Error(
      `${subject} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

/** Proves that a packaged client points at the one production release authority. */
export async function assertPackagedUpdateConfiguration(
  resourcesPath,
  { channel = 'release', read = readFile } = {},
) {
  const path = join(resourcesPath, 'app-update.yml');
  let configuration;
  try {
    configuration = await readYaml(path, read);
  } catch (error) {
    throw new Error(`Packaged update configuration is unreadable: ${path}`, { cause: error });
  }
  const expected =
    channel === 'nightly' ? DESKTOP_NIGHTLY_UPDATE_PROVIDER : DESKTOP_UPDATE_PROVIDER;
  requireExactObject(configuration, expected, 'Packaged update configuration');
  return configuration;
}

/**
 * macOS carries every architecture in one feed, and electron-updater picks its
 * payload out of that one `files` list. Each architecture is packaged on a
 * runner of its own, so each build writes a feed naming only its own zip;
 * publishing either alone would offer one architecture an update it cannot
 * install. The first document is the primary: its `path` and top-level digest
 * survive the merge, and the rest contribute only their payloads.
 */
function mergeDesktopUpdateFeedDocuments(documents) {
  const [primary, ...rest] = documents;
  if (!primary) {
    throw new Error('Desktop update feed merge requires at least one feed');
  }
  for (const document of rest) {
    if (document?.version !== primary.version) {
      throw new Error(
        `Desktop update feeds disagree on version: ${JSON.stringify(primary.version)} and ${JSON.stringify(document?.version)}`,
      );
    }
  }
  const files = documents.flatMap((document) => document.files ?? []);
  const urls = files.map((file) => file?.url);
  if (new Set(urls).size !== urls.length) {
    throw new Error(`Desktop update feeds advertise the same payload twice: ${urls.join(', ')}`);
  }
  return { ...primary, files };
}

export async function mergeDesktopUpdateFeeds({ sourcePaths, outputPath }) {
  const documents = await Promise.all(sourcePaths.map((path) => readYaml(path)));
  const merged = mergeDesktopUpdateFeedDocuments(documents);
  const { stringify } = await import('yaml');
  await writeFile(outputPath, stringify(merged), 'utf8');
  return merged;
}

async function sha512Base64(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(path);
    stream.once('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => resolvePromise(hash.digest('base64')));
  });
}

/**
 * Validates the update metadata against the bytes that will be published.
 * One feed carries every payload a client on that platform may be offered —
 * both macOS architectures, or the AppImage and the deb — so the caller names
 * all of them and anything else in the feed is an unverified update path.
 */
export async function verifyDesktopUpdateArtifacts({
  directory,
  metadataName,
  version,
  artifactNames,
}) {
  const metadataPath = join(directory, metadataName);
  let metadata;
  try {
    metadata = await readYaml(metadataPath);
  } catch (error) {
    throw new Error(`Desktop update metadata is unreadable: ${metadataPath}`, { cause: error });
  }
  if (metadata?.version !== version) {
    throw new Error(
      `${metadataName} advertises version ${JSON.stringify(metadata?.version)}, expected ${version}`,
    );
  }
  const expected = [...artifactNames].sort();
  const advertised = (metadata.files ?? []).map((file) => file?.url).sort();
  if (JSON.stringify(advertised) !== JSON.stringify(expected)) {
    throw new Error(
      `${metadataName} advertises ${JSON.stringify(advertised)}, expected ${JSON.stringify(expected)}`,
    );
  }
  if (!artifactNames.includes(metadata.path)) {
    throw new Error(
      `${metadataName} points at ${JSON.stringify(metadata.path)}, expected one of ${JSON.stringify(expected)}`,
    );
  }
  // The top-level digest belongs to the payload named by `path`; an updater
  // that trusts it while downloading a different file would verify nothing.
  const primary = metadata.files.find((file) => file.url === metadata.path);
  if (primary.sha512 !== metadata.sha512) {
    throw new Error(`${metadataName} has inconsistent payload identity for ${metadata.path}`);
  }

  for (const file of metadata.files) {
    const artifactPath = join(directory, file.url);
    const artifact = await stat(artifactPath);
    if (!artifact.isFile()) {
      throw new Error(`Desktop update payload is not a file: ${artifactPath}`);
    }
    if (file.sha512 !== (await sha512Base64(artifactPath))) {
      throw new Error(`${metadataName} sha512 does not match ${file.url}`);
    }
    if (file.size !== artifact.size) {
      throw new Error(
        `${metadataName} records ${file.url} size ${JSON.stringify(file.size)}, expected ${artifact.size}`,
      );
    }
    if (!SIDECAR_BLOCKMAP_EXTENSIONS.some((extension) => file.url.endsWith(extension))) continue;
    const blockmapPath = join(directory, `${file.url}.blockmap`);
    if (!(await stat(blockmapPath)).isFile()) {
      throw new Error(`Desktop update blockmap is not a file: ${blockmapPath}`);
    }
  }
  return { artifactNames, metadata, metadataName, version };
}

/**
 * Exact loopback replica of the generic feed used by the packaged E2E tests.
 * Mapped-but-absent files intentionally return 404: that is how the updater
 * probes an unavailable previous blockmap before falling back to a full file.
 */
export async function startDesktopUpdateFeed(files) {
  const requests = [];
  let unexpectedRequests = 0;
  const bodies = new Map();
  for (const [name, filePath] of files) {
    try {
      bodies.set(`/${name}`, await readFile(filePath));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const knownPaths = new Set([...files.keys()].map((name) => `/${name}`));
  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    const target = request.url ?? '/';
    const queryIndex = target.indexOf('?');
    const path = queryIndex === -1 ? target : target.slice(0, queryIndex);
    const record = { method, path, target, status: 0 };
    requests.push(record);
    if ((method !== 'GET' && method !== 'HEAD') || !knownPaths.has(path)) {
      unexpectedRequests += 1;
      record.status = 404;
      response.writeHead(404).end();
      return;
    }
    const body = bodies.get(path);
    if (body === undefined) {
      record.status = 404;
      response.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1);
      if (start > end || start >= body.length) {
        record.status = 416;
        response.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
        return;
      }
      record.status = 206;
      response.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Content-Type': 'application/octet-stream',
      });
      response.end(method === 'HEAD' ? undefined : body.subarray(start, end + 1));
      return;
    }
    record.status = 200;
    response.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': body.length,
      'Content-Type': 'application/octet-stream',
    });
    response.end(method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not start the loopback update feed.');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    unexpectedCount: () => unexpectedRequests,
    close: () =>
      new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections?.();
      }),
  };
}

export function feedServed(feed, name) {
  return feed.requests.some(
    (request) =>
      request.method === 'GET' &&
      request.path === `/${name}` &&
      (request.status === 200 || request.status === 206),
  );
}
