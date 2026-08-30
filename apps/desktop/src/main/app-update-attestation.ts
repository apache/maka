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

import { bundleFromJSON, type Bundle } from '@sigstore/bundle';
import { getTrustedRoot } from '@sigstore/tuf';
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const PRODUCT_REPOSITORY = 'apache/maka';
const PRODUCT_RELEASE_WORKFLOW = '.github/workflows/release-cli-finalize.yml';
const PRODUCT_NIGHTLY_WORKFLOW = '.github/workflows/desktop-nightly.yml';
const PRODUCT_NIGHTLY_BASE_URL = 'https://nightlies.apache.org/maka/desktop';
const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const IN_TOTO_STATEMENT_V1 = 'https://in-toto.io/Statement/v1';
const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';
const MAX_ATTESTATION_BYTES = 5 * 1024 * 1024;

type AttestationSubject = {
  readonly name?: unknown;
  readonly digest?: unknown;
};

type AttestationStatement = {
  readonly _type?: unknown;
  readonly predicateType?: unknown;
  readonly subject?: unknown;
};

export type DownloadedUpdateAttestationInput = {
  readonly downloadedFile: string;
  readonly version: string;
};

export type DownloadedUpdateAttestationVerifier = (
  input: DownloadedUpdateAttestationInput,
) => Promise<void>;

type VerifyDownloadedUpdateAttestationOptions = DownloadedUpdateAttestationInput & {
  readonly channel?: DesktopUpdateChannel;
  readonly trustRootCacheDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly fetchBundle?: (url: string) => Promise<Uint8Array>;
  readonly verifyBundle?: (bundle: Bundle) => Promise<void>;
};

export type DesktopUpdateChannel = 'release' | 'nightly';

export function desktopUpdateChannelFromManifest(manifest: unknown): DesktopUpdateChannel {
  const channel =
    manifest && typeof manifest === 'object'
      ? (manifest as { makaUpdateChannel?: unknown }).makaUpdateChannel
      : undefined;
  if (channel !== 'release' && channel !== 'nightly') {
    throw new Error('Packaged Desktop does not declare a trusted update channel');
  }
  return channel;
}

function productWorkflowSigner(channel: DesktopUpdateChannel): RegExp {
  const workflow = channel === 'nightly' ? PRODUCT_NIGHTLY_WORKFLOW : PRODUCT_RELEASE_WORKFLOW;
  return new RegExp(
    `^https://github\\.com/${PRODUCT_REPOSITORY.replace('/', '\\/')}/${workflow.replaceAll('.', '\\.')}` +
      '@refs/heads/main$',
    'u',
  );
}

function exactDesktopUpdateArtifactName(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  if (platform === 'darwin' && arch === 'arm64') return `Maka-${version}-mac-arm64.zip`;
  if (platform === 'win32' && arch === 'x64') return `Maka-${version}-win-x64.exe`;
  throw new Error(`Automatic updates are unsupported on ${platform}/${arch}`);
}

function productReleaseAttestationName(version: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(version)) {
    throw new Error('Update version cannot identify a product attestation');
  }
  return `Maka-${version}-attestation.sigstore.json`;
}

function productReleaseAttestationUrl(
  version: string,
  channel: DesktopUpdateChannel,
): string {
  const name = productReleaseAttestationName(version);
  if (channel === 'nightly') {
    return `${PRODUCT_NIGHTLY_BASE_URL}/versions/${encodeURIComponent(version)}/${encodeURIComponent(name)}`;
  }
  const tag = `v${version}`;
  return `https://github.com/${PRODUCT_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function fetchBytesCapped(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Update attestation download failed with HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTESTATION_BYTES) {
    throw new Error('Update attestation is larger than the accepted limit');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ATTESTATION_BYTES) {
        await reader.cancel();
        throw new Error('Update attestation is larger than the accepted limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseBundle(bytes: Uint8Array): Bundle {
  let serialized: unknown;
  try {
    serialized = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error('Update attestation is not valid JSON', { cause: error });
  }
  try {
    return bundleFromJSON(serialized as Parameters<typeof bundleFromJSON>[0]);
  } catch (error) {
    throw new Error('Update attestation is not a valid Sigstore bundle', { cause: error });
  }
}

function statementFromBundle(bundle: Bundle): AttestationStatement {
  if (bundle.content.$case !== 'dsseEnvelope') {
    throw new Error('Update attestation must contain an in-toto statement');
  }
  const envelope = bundle.content.dsseEnvelope;
  if (envelope.payloadType !== 'application/vnd.in-toto+json') {
    throw new Error('Update attestation payload type is invalid');
  }
  try {
    return JSON.parse(Buffer.from(envelope.payload).toString('utf8')) as AttestationStatement;
  } catch (error) {
    throw new Error('Update attestation statement is not valid JSON', { cause: error });
  }
}

function assertProductReleaseAttestationSubject(
  bundle: Bundle,
  expectedName: string,
  expectedSha256: string,
): void {
  const statement = statementFromBundle(bundle);
  if (statement._type !== IN_TOTO_STATEMENT_V1 || statement.predicateType !== SLSA_PROVENANCE_V1) {
    throw new Error('Update attestation is not SLSA provenance v1');
  }
  if (!Array.isArray(statement.subject)) {
    throw new Error('Update attestation has no subjects');
  }
  const exact = (statement.subject as AttestationSubject[]).some((subject) => {
    if (subject?.name !== expectedName || !subject.digest || typeof subject.digest !== 'object') {
      return false;
    }
    return (subject.digest as Record<string, unknown>).sha256 === expectedSha256;
  });
  if (!exact) throw new Error('Update attestation does not identify the downloaded artifact');
}

export async function verifyDownloadedUpdateAttestation(
  options: VerifyDownloadedUpdateAttestationOptions,
): Promise<void> {
  const version = options.version.trim().replace(/^v/iu, '');
  const expectedName = exactDesktopUpdateArtifactName(
    version,
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  );
  const channel = options.channel ?? 'release';
  const [artifactSha256, bundleBytes] = await Promise.all([
    sha256File(options.downloadedFile),
    (options.fetchBundle ?? fetchBytesCapped)(productReleaseAttestationUrl(version, channel)),
  ]);
  const bundle = parseBundle(bundleBytes);

  if (options.verifyBundle) {
    await options.verifyBundle(bundle);
  } else {
    const trustedRoot = await getTrustedRoot({
      cachePath: options.trustRootCacheDirectory,
      timeout: 10_000,
    });
    const verifier = new Verifier(toTrustMaterial(trustedRoot));
    verifier.verify(toSignedEntity(bundle), {
      subjectAlternativeName: productWorkflowSigner(channel),
      extensions: { issuer: GITHUB_ACTIONS_OIDC_ISSUER },
    });
  }

  assertProductReleaseAttestationSubject(bundle, expectedName, artifactSha256);
}
