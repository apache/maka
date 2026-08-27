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

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyDesktopUpdateArtifacts } from './desktop-update-contract.mjs';
import { packageMacosAutoupdateNext } from './package-macos-autoupdate-next.mjs';
import { verifyMacosAutoupdate } from './verify-macos-autoupdate.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = join(repoRoot, 'apps', 'desktop');

function run(command, args, { env = process.env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise({ stdout: '', stderr: '' });
      else
        reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit ${code}`}`));
    });
  });
}

export async function experimentMacosAutoupdate({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error('The local macOS auto-update experiment requires Apple Silicon macOS.');
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'maka-update-signing-'));
  const password = 'maka-local-update-test';
  const privateKey = join(temporaryDirectory, 'identity.key');
  const certificate = join(temporaryDirectory, 'identity.crt');
  const identity = join(temporaryDirectory, 'identity.p12');
  const keychain = join(temporaryDirectory, 'local-signing.keychain-db');
  const manifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
  const candidateZipName = `Maka-${manifest.version}-mac-arm64.zip`;
  const candidateZip = join(desktopRoot, 'release', candidateZipName);

  try {
    await run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=Maka Local Update Test',
      '-addext',
      'keyUsage=digitalSignature',
      '-addext',
      'extendedKeyUsage=codeSigning',
      '-keyout',
      privateKey,
      '-out',
      certificate,
    ]);
    await run('openssl', [
      'pkcs12',
      '-export',
      // macOS Security still imports PKCS#12 through its legacy-compatible
      // cipher path; OpenSSL 3's defaults otherwise fail as a wrong password.
      '-legacy',
      '-inkey',
      privateKey,
      '-in',
      certificate,
      '-name',
      'Maka Local Update Test',
      '-passout',
      `pass:${password}`,
      '-out',
      identity,
    ]);
    await run('security', ['create-keychain', '-p', password, keychain]);
    await run('security', ['unlock-keychain', '-p', password, keychain]);
    await run('security', ['set-keychain-settings', '-lut', '21600', keychain]);
    await run('security', [
      'import',
      identity,
      '-k',
      keychain,
      '-P',
      password,
      '-T',
      '/usr/bin/codesign',
      '-T',
      '/usr/bin/productbuild',
    ]);
    await run('security', [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:',
      '-s',
      '-k',
      password,
      keychain,
    ]);
    await run('security', [
      'add-trusted-cert',
      '-r',
      'trustRoot',
      '-p',
      'codeSign',
      '-k',
      keychain,
      certificate,
    ]);
    await run('security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
    const env = {
      ...process.env,
      CSC_KEYCHAIN: keychain,
      MAKA_LOCAL_UPDATE_SIGNING_IDENTITY: 'Maka Local Update Test',
    };
    delete env.CSC_LINK;
    delete env.CSC_KEY_PASSWORD;

    console.log('[experiment-macos-autoupdate] building the application once');
    await run('npm', ['run', 'clean'], { env });
    await run('npm', ['run', 'build'], { env });
    await run('npm', ['run', 'build:runtime-host-peer'], { env });
    await run('npm', ['run', 'check:runtime-host-peer-notices'], { env });
    await rm(join(desktopRoot, 'release'), { recursive: true, force: true });

    console.log(`[experiment-macos-autoupdate] packaging signed candidate ${manifest.version}`);
    await run(
      'npm',
      [
        '--workspace',
        '@maka/desktop',
        'exec',
        '--',
        'electron-builder',
        '--config',
        'electron-builder.config.mjs',
        '--mac',
        'zip',
        '--arm64',
        '--publish',
        'never',
        '-c.mac.notarize=false',
        '-c.mac.identity=Maka Local Update Test',
        '-c.mac.timestamp=none',
        // A self-signed identity has no Apple Team ID, so macOS library
        // validation cannot relate Electron's nested signatures to the app.
        // Production and release E2E builds keep hardenedRuntime enabled and
        // use the real Developer ID identity.
        '-c.mac.hardenedRuntime=false',
      ],
      { env },
    );
    await verifyDesktopUpdateArtifacts({
      directory: join(desktopRoot, 'release'),
      metadataName: 'latest-mac.yml',
      version: manifest.version,
      artifactName: candidateZipName,
    });

    console.log('[experiment-macos-autoupdate] packaging the signed successor');
    await packageMacosAutoupdateNext({ run, env });
    return await verifyMacosAutoupdate(candidateZip, join(desktopRoot, 'release-autoupdate-next'));
  } finally {
    await run('security', ['remove-trusted-cert', certificate]).catch(() => {});
    await run('security', ['delete-keychain', keychain]).catch(() => {});
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await experimentMacosAutoupdate();
  console.log(JSON.stringify(result, null, 2));
}
