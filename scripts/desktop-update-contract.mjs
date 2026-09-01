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
import { readFile, stat } from 'node:fs/promises';
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
 * Validates the update metadata against the bytes that will be published.
 * The release is single-platform and single-architecture, so accepting extra
 * payloads here would create an unverified update path.
 */
export async function verifyDesktopUpdateArtifacts({
  directory,
  metadataName,
  version,
  artifactName,
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
  if (metadata.path !== artifactName || metadata.files?.length !== 1) {
    throw new Error(`${metadataName} must advertise only ${artifactName}`);
  }
  const file = metadata.files[0];
  if (file?.url !== artifactName || file.sha512 !== metadata.sha512) {
    throw new Error(`${metadataName} has inconsistent payload identity for ${artifactName}`);
  }
  const artifactPath = join(directory, artifactName);
  const artifact = await stat(artifactPath);
  if (!artifact.isFile()) throw new Error(`Desktop update payload is not a file: ${artifactPath}`);
  const sha512 = await new Promise((resolvePromise, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(artifactPath);
    stream.once('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => resolvePromise(hash.digest('base64')));
  });
  if (metadata.sha512 !== sha512 || file.sha512 !== sha512) {
    throw new Error(`${metadataName} sha512 does not match ${artifactName}`);
  }
  if (file.size !== artifact.size) {
    throw new Error(
      `${metadataName} records ${artifactName} size ${JSON.stringify(file.size)}, expected ${artifact.size}`,
    );
  }
  const blockmapPath = join(directory, `${artifactName}.blockmap`);
  if (!(await stat(blockmapPath)).isFile()) {
    throw new Error(`Desktop update blockmap is not a file: ${blockmapPath}`);
  }
  return { artifactName, metadata, metadataName, version };
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
