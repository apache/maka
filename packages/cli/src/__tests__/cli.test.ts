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

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseMakaCliArgs, runMakaCli } from '../cli-core.js';

describe('Maka CLI args', () => {
  test('declares a bin-only package surface', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    assert.deepEqual(manifest.bin, {
      maka: './dist/cli.js',
    });
    assert.deepEqual(manifest.exports, {});
    assert.equal(Object.hasOwn(manifest, 'main'), false);
    assert.equal(Object.hasOwn(manifest, 'types'), false);
    await assert.rejects(access(new URL('../index.js', import.meta.url)), { code: 'ENOENT' });
  });

  test('publishes the supported release command surface', () => {
    const help = parseMakaCliArgs(['--help'], '0.1.0');
    assert.equal(help.kind, 'help');
    if (help.kind !== 'help') return;
    assert.match(help.text, /^  maka              Start the TUI$/m);
    assert.doesNotMatch(help.text, /maka-agent/);
    assert.match(help.text, /^  maka run /m);
    assert.match(help.text, /^  maka activate /m);
    assert.match(help.text, /^  maka eval /m);
    assert.match(help.text, /^  maka runtime-host serve /m);
    assert.doesNotMatch(help.text, /cli:dev/);
  });

  test('selects a Runtime Host and Project for TUI startup', () => {
    assert.deepEqual(parseMakaCliArgs(['--host', 'office', '--project', 'project-1'], '0.1.0'), {
      kind: 'tui',
      hostProfileId: 'office',
      projectId: 'project-1',
    });
  });

  test('uses the active launcher in development help and rejects an empty profile name', async () => {
    const help = parseMakaCliArgs(['--help'], '0.1.0', 'npm run cli:dev --');
    assert.equal(help.kind, 'help');
    if (help.kind === 'help') {
      assert.match(help.text, /^Usage: npm run cli:dev --$/m);
      assert.match(
        help.text,
        /^  npm run cli:dev -- runtime-host access issue --principal <id> --preset /m,
      );
      assert.match(help.text, /^  npm run cli:dev -- runtime-host project list /m);
      assert.match(
        help.text,
        /^  npm run cli:dev -- runtime-host profile set .*--ssh-destination /m,
      );
      assert.match(help.text, /^  npm run cli:dev -- runtime-host profile set .*--plaintext-url /m);
      assert.doesNotMatch(help.text, /^  maka runtime-host /m);
      assert.doesNotMatch(help.text, /maka-agent/);
    }
    await assert.rejects(
      runMakaCli(['--version'], {
        dataProfileName: '',
        cliCommand: 'invalid',
        capabilityProviderIdentityScope: 'client-data-root',
      }),
      /profile name must be a non-empty path segment/,
    );
  });

  test('does not add a discoverable global locale flag', () => {
    assert.deepEqual(parseMakaCliArgs(['--locale', 'zh'], '0.1.0'), {
      kind: 'error',
      message: 'Unexpected argument: --locale',
      exitCode: 2,
    });
  });

  test('establishes the fatal exit before reporting can throw', async () => {
    const cliUrl = new URL('../cli-core.js', import.meta.url).href;
    const childSource = `
      import { handleMakaCliProcessExit } from ${JSON.stringify(cliUrl)};
      try {
        handleMakaCliProcessExit(1, new Error('fatal'), () => { throw new Error('writer failed'); });
      } catch {}
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      stdio: 'ignore',
    });
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];

    assert.equal(signal, null);
    assert.equal(code, 1);
  });

  test('compiled release and repository entries isolate profile writes', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-cli-launch-profile-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const applicationData = join(root, 'application-data');
    const releaseRoot = platformProfileRoot(home, applicationData, 'Maka');
    const developmentRoot = platformProfileRoot(home, applicationData, 'Maka Dev');
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: applicationData,
      XDG_CONFIG_HOME: applicationData,
      MAKA_TEST_RUNTIME_HOST_CREDENTIAL: 'opaque-token',
    };
    const profileArgs = [
      'runtime-host',
      'profile',
      'set',
      '--id',
      'office',
      '--name',
      'Office',
      '--tls-url',
      'wss://runtime.example.com/runtime-host',
      '--expected-root',
      'a'.repeat(64),
      '--credential-env',
      'MAKA_TEST_RUNTIME_HOST_CREDENTIAL',
    ];

    await mkdir(releaseRoot, { recursive: true });
    await writeFile(join(releaseRoot, 'sentinel.txt'), 'release-data\n', 'utf8');
    const development = await runCompiledCli('dev-cli.js', profileArgs, env);
    assert.equal(development.signal, null);
    assert.equal(development.code, 0, development.stderr);
    await assertProfileFiles(developmentRoot);
    assert.deepEqual(await readdir(releaseRoot), ['sentinel.txt']);
    assert.equal(await readFile(join(releaseRoot, 'sentinel.txt'), 'utf8'), 'release-data\n');
    await assert.rejects(access(join(developmentRoot, 'sentinel.txt')), { code: 'ENOENT' });

    const developmentProfile = await readFile(
      join(developmentRoot, 'runtime-host-profiles.json'),
      'utf8',
    );
    const release = await runCompiledCli('cli.js', profileArgs, env);
    assert.equal(release.signal, null);
    assert.equal(release.code, 0, release.stderr);
    await assertProfileFiles(releaseRoot);
    assert.equal(
      await readFile(join(developmentRoot, 'runtime-host-profiles.json'), 'utf8'),
      developmentProfile,
    );
    assert.equal(await readFile(join(releaseRoot, 'sentinel.txt'), 'utf8'), 'release-data\n');
  });

  test('compiled launchers isolate capability-provider identities', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-cli-provider-identity-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const applicationData = join(root, 'application-data');
    const releaseRoot = platformProfileRoot(home, applicationData, 'Maka');
    const developmentRoot = platformProfileRoot(home, applicationData, 'Maka Dev');
    const configPath = join(root, 'mcp.json');
    const url = 'https://invalid.example/runtime-host';
    const identityFile = providerIdentityFileName(url, configPath);
    const developmentIdentityPath = join(
      developmentRoot,
      'runtime-host-capability-providers',
      identityFile,
    );
    const releaseIdentityPath = join(
      home,
      '.maka',
      'runtime-host-capability-providers',
      identityFile,
    );
    const releaseProfileIdentityPath = join(
      releaseRoot,
      'runtime-host-capability-providers',
      identityFile,
    );
    const explicitUrl = 'https://explicit.invalid/runtime-host';
    const explicitDefaultIdentityPath = join(
      developmentRoot,
      'runtime-host-capability-providers',
      providerIdentityFileName(explicitUrl, configPath),
    );
    const explicitIdentityPath = join(root, 'explicit-provider-identity.json');
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: applicationData,
      XDG_CONFIG_HOME: applicationData,
      MAKA_TEST_RUNTIME_HOST_CREDENTIAL: 'opaque-token',
    };
    await writeFile(configPath, '{"mcpServers": {}}\n', 'utf8');
    const providerArgs = [
      'runtime-host',
      'capability-provider',
      'serve',
      '--url',
      url,
      '--mcp-config',
      configPath,
      '--expected-root',
      'b'.repeat(64),
      '--credential-env',
      'MAKA_TEST_RUNTIME_HOST_CREDENTIAL',
    ];

    const development = await runCompiledCli('dev-cli.js', providerArgs, env);
    assert.equal(development.signal, null);
    assert.equal(development.code, 1);
    const developmentIdentity = await readClientInstanceId(developmentIdentityPath);
    await assert.rejects(access(releaseIdentityPath), { code: 'ENOENT' });

    const release = await runCompiledCli('cli.js', providerArgs, env);
    assert.equal(release.signal, null);
    assert.equal(release.code, 1);
    const releaseIdentity = await readClientInstanceId(releaseIdentityPath);
    assert.notEqual(releaseIdentity, developmentIdentity);
    await assert.rejects(access(releaseProfileIdentityPath), { code: 'ENOENT' });

    const developmentIdentityBeforeOverride = await readFile(developmentIdentityPath, 'utf8');
    const explicitProviderArgs = providerArgs.map((arg) => (arg === url ? explicitUrl : arg));
    const explicit = await runCompiledCli(
      'dev-cli.js',
      [...explicitProviderArgs, '--client-identity', explicitIdentityPath],
      env,
    );
    assert.equal(explicit.signal, null);
    assert.equal(explicit.code, 1);
    const explicitIdentity = await readClientInstanceId(explicitIdentityPath);
    assert.notEqual(explicitIdentity, developmentIdentity);
    assert.notEqual(explicitIdentity, releaseIdentity);
    await assert.rejects(access(explicitDefaultIdentityPath), { code: 'ENOENT' });
    assert.equal(
      await readFile(developmentIdentityPath, 'utf8'),
      developmentIdentityBeforeOverride,
    );
  });
});

async function runCompiledCli(
  entrypoint: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL(`../${entrypoint}`, import.meta.url)), ...args],
    { env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000, killSignal: 'SIGKILL' },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
  return { code, signal, stderr };
}

function platformProfileRoot(home: string, applicationData: string, profileName: string): string {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', profileName);
  }
  return join(applicationData, profileName);
}

async function assertProfileFiles(root: string): Promise<void> {
  await access(join(root, 'runtime-host-profiles.json'));
  await access(join(root, 'runtime-host-client', 'credentials.json'));
}

function providerIdentityFileName(url: string, configPath: string): string {
  const identity = createHash('sha256')
    .update(`runtime-host-capability-provider\0${url}\0${configPath}`)
    .digest('hex')
    .slice(0, 24);
  return `${identity}.json`;
}

async function readClientInstanceId(path: string): Promise<string> {
  const document = JSON.parse(await readFile(path, 'utf8')) as {
    schemaVersion?: unknown;
    clientInstanceId?: unknown;
  };
  assert.equal(document.schemaVersion, 1);
  if (typeof document.clientInstanceId !== 'string') {
    assert.fail('Expected a persisted Client instance id');
  }
  return document.clientInstanceId;
}
