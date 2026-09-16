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
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
// Node 24 strips this module's erasable types, exercising the shipped source
// without a stale dist copy, an app build, or a separate pipe implementation.
import { acquireWindowsHistoryOwnership } from '../src/main/computer-history-windows-ownership.ts';
// Resolve the resolver's one shared local helper against current source as well.
const sourceHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === '@maka/core/computer-history' &&
      context.parentURL?.endsWith('/computer-history-applications.ts')
      ? new URL('../../../packages/core/src/computer-history.ts', import.meta.url).href : specifier, context);
  },
});
const { ComputerHistoryApplications } = await import('../src/main/computer-history-applications.ts');
sourceHook.deregister();

const run = promisify(execFile);
const helper = fileURLToPath(new URL('../resources/bin/open-history.exe', import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32', timeout: 60_000 };

function invoke(home, args) {
  // Missing/broken staged helpers fail the Windows test.
  return run(helper, args, {
    env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
  });
}

async function status(home) {
  const { stdout } = await invoke(home, ['status']);
  const value = JSON.parse(stdout);
  assert.equal(typeof value.recorderActive, 'boolean');
  return value.recorderActive;
}

async function validateHome(home) {
  const { stdout, stderr } = await invoke(home, ['validate-home']);
  assert.match(stdout, /^history-home-valid\r?\n$/);
  assert.equal(stderr, '');
}

async function cleanupNativeFixture({
  resolvers = [], children = [], keys = [], registry, root, wait = withinDeadline, remove = rm,
}) {
  const errors = [];
  async function attempt(action) {
    try { await action(); return true; }
    catch (error) { errors.push(error); return false; }
  }
  for (const resolver of resolvers) await attempt(() => resolver.dispose());
  let released = true;
  for (const { child, closed } of children) {
    await attempt(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    if (!await attempt(() => wait(closed, 'metadata child cleanup'))) released = false;
  }
  for (const [hive, view] of keys) await attempt(() => registry('remove', hive, view));
  for (const [hive, view] of keys) {
    if (!await attempt(() => registry('absent', hive, view))) released = false;
  }
  // Keep executables available for recovery when an owner could not be released.
  if (released) await attempt(() => remove(root, { recursive: true, force: true }));
  if (errors.length) throw new AggregateError(errors, released
    ? 'Native fixture cleanup failed' : `Native fixture cleanup failed; directory retained at ${root}`);
}

test('native fixture teardown attempts every owner and registry view after independent failures', async () => {
  const keys = ['CurrentUser', 'LocalMachine'].flatMap((hive) =>
    ['Registry64', 'Registry32'].map((view) => [hive, view]));
  const registryCalls = (action) => keys.map(([hive, view]) => `${action} ${hive} ${view}`);
  const baseCalls = ['dispose one', 'dispose two', 'kill one', 'wait one', 'kill two', 'wait two',
    ...registryCalls('remove'), ...registryCalls('absent')];
  for (const failures of [
    [],
    ['dispose one'],
    ['kill one'],
    ['wait one'],
    ['remove CurrentUser Registry64'],
    ['absent CurrentUser Registry64'],
    ['remove root'],
    ['dispose one', 'kill one', 'wait one', 'remove CurrentUser Registry64', 'absent LocalMachine Registry32'],
  ]) {
    const calls = [];
    const errors = new Map(failures.map((label) => [label, new Error(label)]));
    const call = (label) => {
      calls.push(label);
      if (errors.has(label)) throw errors.get(label);
    };
    const children = ['one', 'two'].map((name) => ({
      child: { exitCode: null, kill: (signal) => { assert.equal(signal, 'SIGKILL'); call(`kill ${name}`); } },
      closed: Promise.resolve(name),
    }));
    const released = !failures.some((label) => label.startsWith('wait ') || label.startsWith('absent '));
    const result = cleanupNativeFixture({
      resolvers: ['one', 'two'].map((name) => ({ dispose: () => call(`dispose ${name}`) })),
      children, keys, root: 'fixture-root',
      wait: async (closed) => call(`wait ${await closed}`),
      registry: async (action, hive, view) => call(`${action} ${hive} ${view}`),
      remove: async (root, options) => {
        assert.equal(root, 'fixture-root');
        assert.deepEqual(options, { recursive: true, force: true });
        call('remove root');
      },
    });
    if (failures.length) {
      await assert.rejects(result, (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, calls.filter((label) => errors.has(label)).map((label) => errors.get(label)));
        if (!released) assert.match(error.message, /directory retained at fixture-root/);
        return true;
      });
    } else await result;
    assert.deepEqual(calls, released ? [...baseCalls, 'remove root'] : baseCalls);
  }
});

test('native fixture teardown reaps exited children and cleans registry-free fixtures', async () => {
  const calls = [];
  await cleanupNativeFixture({
    children: [{
      child: { exitCode: 0, kill: () => assert.fail('exited child must not be signalled') },
      closed: Promise.resolve(),
    }],
    root: 'fixture-root',
    wait: async (closed) => { await closed; calls.push('closed'); },
    remove: async () => { calls.push('remove root'); },
  });
  assert.deepEqual(calls, ['closed', 'remove root']);
});

test('application metadata never requires or touches history storage', windowsOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-history-native-applications-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = join(root, 'must-not-be-created');
  for (const home of [undefined, missing, String.raw`\\maka-history-invalid\no-share`]) {
    const env = { ...process.env };
    delete env.OPEN_COMPUTER_HISTORY_HOME;
    if (home !== undefined) env.OPEN_COMPUTER_HISTORY_HOME = home;
    const { stdout, stderr } = await run(helper, ['applications', 'win32.maka-history-missing'], {
      env, windowsHide: true, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
    });
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), [{
      bundleIdentifier: 'win32.maka-history-missing', name: 'win32.maka-history-missing', iconDataUrl: null,
      resolution: 'not_running',
    }]);
    assert.deepEqual(await readdir(root), []);
  }
});

test('packaged metadata lookup is exact, storage-free and rejects malformed IDs', windowsOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-history-packaged-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = join(root, 'must-not-be-created');
  const id = `winapp.MakaMissing${randomUUID().replaceAll('-', '')}_8wekyb3d8bbwe!App`;
  const { stdout, stderr } = await invoke(missing, ['applications', id]);
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), [{
    bundleIdentifier: id, name: id, iconDataUrl: null, resolution: 'unavailable',
  }]);
  for (const invalid of ['winapp.invalid', id.replace('!', '/'), id + '!Other', id.replace('!App', '!应用')]) {
    await assert.rejects(invoke(missing, ['applications', invalid]), /invalid_application_identifiers/);
  }
  assert.deepEqual(await readdir(root), []);
});

test('exact current packaged AppInfo metadata passes the fresh production resolver', {
  skip: process.platform !== 'win32' || process.env.MAKA_HISTORY_PACKAGED_APP_FIXTURE !== '1',
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-history-installed-package-'));
  const resolver = new ComputerHistoryApplications({ helperPath: helper });
  t.after(() => cleanupNativeFixture({ resolvers: [resolver], root }));
  const id = 'winapp.Microsoft.WindowsNotepad_8wekyb3d8bbwe!App';
  const { stdout, stderr } = await invoke(join(root, 'must-not-be-created'), ['applications', id]);
  const [native] = JSON.parse(stdout);
  assert.equal(stderr, '');
  assert.equal(native.bundleIdentifier, id);
  assert.equal(native.resolution, 'registered');
  assert.notEqual(native.name, id);
  assert.match(native.iconDataUrl, /^data:image\/png;base64,/);
  const { resolution: _resolution, ...expected } = native;
  assert.deepEqual(await resolver.applications([id]), [expected]);
  assert.deepEqual(await readdir(root), []);
});

test('native application ambiguity invalidates icons and confirmed closure retains only session metadata', windowsOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-history-native-icons-'));
  const missing = join(root, 'must-not-be-created');
  const stem = `maka-icon-${process.pid}-${Date.now()}`;
  const id = `win32.${stem}`;
  let now = 0;
  const resolver = new ComputerHistoryApplications({ helperPath: helper, now: () => now });
  const cold = new ComputerHistoryApplications({ helperPath: helper });
  const children = [];
  t.after(() => cleanupNativeFixture({ resolvers: [resolver, cold], children, root }));
  async function launch(directory) {
    const path = join(root, directory);
    await mkdir(path);
    const executable = join(path, `${stem}.exe`);
    await copyFile(process.execPath, executable);
    const child = spawn(executable, ['-e',
      'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));process.send("ready");',
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true, stdio: ['pipe', 'ignore', 'ignore', 'ipc'],
    });
    const closed = once(child, 'close');
    void closed.catch(() => {});
    children.push({ child, closed });
    const [message] = await withinDeadline(once(child, 'message'), 'metadata child readiness');
    assert.equal(message, 'ready');
    return async () => {
      child.stdin.end();
      assert.deepEqual(await withinDeadline(closed, 'metadata child exit'), [0, null]);
    };
  }
  async function nativeResolution() {
    const { stdout } = await invoke(missing, ['applications', id]);
    return JSON.parse(stdout)[0];
  }
  const stopFirst = await launch('one');
  assert.equal((await nativeResolution()).resolution, 'resolved');
  const [known] = await resolver.applications([id]);
  assert.match(known.iconDataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(Object.keys(known).sort(), ['bundleIdentifier', 'iconDataUrl', 'name']);

  const stopSecond = await launch('two');
  assert.equal((await nativeResolution()).resolution, 'unavailable');
  now += 5 * 60_000;
  assert.deepEqual(await resolver.applications([id]), [{ bundleIdentifier: id, name: id, iconDataUrl: null }]);
  await stopSecond();
  now += 30_000;
  assert.deepEqual(await resolver.applications([id]), [known]);
  await stopFirst();
  assert.equal((await nativeResolution()).resolution, 'not_running');
  now += 5 * 60_000;
  assert.deepEqual(await resolver.applications([id]), [known]);
  assert.deepEqual(await cold.applications([id]), [{ bundleIdentifier: id, name: id, iconDataUrl: null }]);
  await assert.rejects(readdir(missing), { code: 'ENOENT' });
});

test('exact App Paths supplies current cold-start metadata, never historical executable identity', {
  skip: process.platform !== 'win32' || process.env.MAKA_HISTORY_APP_PATHS_FIXTURE !== '1',
  timeout: 120_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-history-app-paths-'));
  const token = randomUUID();
  const stem = `maka-reg-${token}`;
  const id = `win32.${stem}`;
  const filename = `${stem}.exe`;
  const missing = join(root, 'must-not-be-created');
  const children = [];
  const resolvers = [];
  const views = ['Registry64', 'Registry32'];
  const hives = ['CurrentUser', 'LocalMachine'];
  // Every write is gated and confined to an absent UUID key; existing keys need
  // our ownership marker. No elevation, ACL changes, or writes to other apps.
  const registryScript = String.raw`
    $ErrorActionPreference = 'Stop'
    $p = $env:MAKA_APP_PATHS_TEST | ConvertFrom-Json
    if ($p.action -eq 'set' -and $p.view -eq 'Registry32' -and [IntPtr]::Size -ne 4) {
      throw 'Fixture requires an actual 32-bit writer'
    }
    $sub = 'Software\Microsoft\Windows\CurrentVersion\App Paths\' + $p.filename
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
      [Enum]::Parse([Microsoft.Win32.RegistryHive], $p.hive),
      [Enum]::Parse([Microsoft.Win32.RegistryView], $p.view))
    $key = $null
    try {
      $key = $base.OpenSubKey($sub, $p.action -in @('set', 'remove'))
      if ($p.action -eq 'absent') {
        if ($null -ne $key) { throw 'Fixture key was not absent' }
      } elseif ($p.action -eq 'verify') {
        if ($null -eq $key -or $key.GetValue('MakaHistoryFixture') -ne $p.token) {
          throw 'Shared registration not visible in canonical view'
        }
        if ($key.GetValueKind('') -ne [Microsoft.Win32.RegistryValueKind]::String -or
            $key.GetValue('') -cne $p.value) { throw 'Canonical registration value mismatch' }
      } elseif ($p.action -eq 'remove') {
        if ($null -ne $key) {
          if ($key.GetValue('MakaHistoryFixture') -ne $p.token) { throw 'Not our fixture key' }
          $key.Dispose(); $key = $null
          $base.DeleteSubKeyTree($sub, $false)
        }
      } elseif ($p.action -eq 'set') {
        if ($null -eq $key) {
          $key = $base.CreateSubKey($sub)
          $key.SetValue('MakaHistoryFixture', $p.token)
        } elseif ($key.GetValue('MakaHistoryFixture') -ne $p.token) { throw 'Not our fixture key' }
        $key.SetValue('', $p.value, [Enum]::Parse([Microsoft.Win32.RegistryValueKind], $p.kind))
        $key.SetValue('Path', '\\maka-invalid\must-not-search')
        $key.Flush()
      } else { throw 'Unknown fixture operation' }
    } finally {
      if ($null -ne $key) { $key.Dispose() }
      $base.Dispose()
    }
  `;
  async function registry(action, hive, view, value = '', kind = 'String') {
    const executable = action === 'set' && view === 'Registry32'
      ? join(process.env.SystemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    await run(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(registryScript, 'utf16le').toString('base64')], {
      env: { ...process.env, MAKA_APP_PATHS_TEST: JSON.stringify({ action, hive, view, value, kind, filename, token }) },
      windowsHide: true, encoding: 'utf8', timeout: 5_000,
    });
  }
  async function allKeys(action) {
    for (const hive of hives) {
      for (const view of views) await registry(action, hive, view);
    }
  }
  t.after(async () => {
    await cleanupNativeFixture({
      resolvers, children, root, registry, keys: hives.flatMap((hive) => views.map((view) => [hive, view])),
    });
    t.diagnostic('App Paths fixture cleanup: all four hive/view keys absent');
  });
  await allKeys('absent');
  const oldDirectory = join(root, 'historical');
  const currentDirectory = join(root, 'current');
  await mkdir(oldDirectory);
  await mkdir(currentDirectory);
  const historicalExecutable = join(oldDirectory, filename);
  const currentExecutable = join(currentDirectory, filename);
  await copyFile(process.execPath, historicalExecutable);
  await copyFile(join(process.env.SystemRoot, 'System32', 'cmd.exe'), currentExecutable);
  async function launch(executable) {
    const child = spawn(executable, ['-e',
      'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));process.send("ready");',
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true, stdio: ['pipe', 'ignore', 'ignore', 'ipc'],
    });
    const closed = once(child, 'close');
    void closed.catch(() => {});
    children.push({ child, closed });
    const [message] = await withinDeadline(once(child, 'message'), 'App Paths child ready');
    assert.equal(message, 'ready');
    return async () => {
      child.stdin.end();
      assert.deepEqual(await withinDeadline(closed, 'App Paths child exit'), [0, null]);
    };
  }
  async function native() {
    const { stdout, stderr } = await invoke(missing, ['applications', id]);
    assert.equal(stderr, '');
    const [value] = JSON.parse(stdout);
    assert.deepEqual(Object.keys(value).sort(), ['bundleIdentifier', 'iconDataUrl', 'name', 'resolution']);
    assert.equal(value.bundleIdentifier, id);
    return value;
  }
  function fresh(now = () => 0) {
    const resolver = new ComputerHistoryApplications({ helperPath: helper, now });
    resolvers.push(resolver);
    return resolver;
  }
  const fallback = { bundleIdentifier: id, name: id, iconDataUrl: null };
  const stopHistorical = await launch(historicalExecutable);
  const historical = await native();
  assert.equal(historical.resolution, 'resolved');
  assert.match(historical.iconDataUrl, /^data:image\/png;base64,/);
  await stopHistorical();
  assert.equal((await native()).resolution, 'not_running');
  assert.deepEqual(await fresh().applications([id]), [fallback]);

  await registry('set', 'CurrentUser', 'Registry64', currentExecutable);
  const current = await native();
  assert.equal(current.resolution, 'registered');
  assert.match(current.iconDataUrl, /^data:image\/png;base64,/);
  assert.notEqual(current.name, historical.name, 'registration describes cmd, not the earlier Node producer');
  assert.notEqual(current.iconDataUrl, historical.iconDataUrl);
  const { resolution: _resolution, ...visible } = current;
  let now = 0;
  const cold = fresh(() => now);
  assert.deepEqual(await cold.applications([id]), [visible]);
  t.diagnostic(JSON.stringify({
    historical: { resolution: historical.resolution, name: historical.name, iconBytes: historical.iconDataUrl.length },
    baseline: { resolution: 'not_running', icon: null },
    current: { resolution: current.resolution, name: current.name, iconBytes: current.iconDataUrl.length },
    attribution: 'current registration only; historical executable is different',
  }));

  // Identical hive/view registrations are allowed; neither hive wins a conflict.
  await registry('set', 'LocalMachine', 'Registry32', currentExecutable);
  assert.deepEqual(await native(), current);
  await registry('set', 'LocalMachine', 'Registry32', historicalExecutable);
  assert.deepEqual(await native(), { ...fallback, resolution: 'unavailable' });
  await registry('remove', 'LocalMachine', 'Registry32');
  // A 32-bit writer must be visible through canonical64 with the other hive absent.
  await registry('remove', 'CurrentUser', 'Registry64');
  for (const hive of hives) {
    await registry('set', hive, 'Registry32', currentExecutable);
    await registry('verify', hive, 'Registry64', currentExecutable);
    assert.deepEqual(await native(), current, `${hive} 32-bit writer resolves independently`);
    assert.deepEqual(await fresh().applications([id]), [visible]);
    await registry('remove', hive, 'Registry64');
    await registry('absent', hive, 'Registry32');
    assert.equal((await native()).resolution, 'not_running');
    t.diagnostic(`${hive}: 32-bit write, canonical64 readback/native lookup, cross-view removal passed`);
  }
  await registry('set', 'CurrentUser', 'Registry64', currentExecutable);
  assert.deepEqual(await native(), current);

  for (const [path, kind] of [
    [`"${currentExecutable}"`, 'String'],
    [`${currentExecutable} --flag`, 'String'],
    [join(root, 'missing', filename), 'String'],
    [`${currentExecutable}:stream`, 'String'],
    [currentExecutable, 'ExpandString'],
  ]) {
    await registry('set', 'CurrentUser', 'Registry64', path, kind);
    assert.deepEqual(await native(), { ...fallback, resolution: 'unavailable' });
  }
  await registry('set', 'CurrentUser', 'Registry64', currentExecutable);
  const junction = join(root, 'redirect');
  await symlink(currentDirectory, junction, 'junction');
  await registry('set', 'CurrentUser', 'Registry64', join(junction, filename));
  assert.deepEqual(await native(), { ...fallback, resolution: 'unavailable' });
  await registry('set', 'CurrentUser', 'Registry64', currentExecutable);

  const otherDirectory = join(root, 'other-producer');
  await mkdir(otherDirectory);
  const otherExecutable = join(otherDirectory, filename);
  await copyFile(process.execPath, otherExecutable);
  const stopOne = await launch(historicalExecutable);
  assert.deepEqual(await native(), historical, 'running executable takes precedence over current registration');
  const stopTwo = await launch(otherExecutable);
  assert.deepEqual(await native(), { ...fallback, resolution: 'unavailable' });
  await stopTwo();
  await stopOne();
  assert.deepEqual(await native(), current);
  await allKeys('remove');
  assert.equal((await native()).resolution, 'not_running');
  now = 5 * 60_000;
  assert.deepEqual(await cold.applications([id]), [fallback], 'registered metadata is not retained after expiry');
  assert.deepEqual(await fresh().applications([id]), [fallback]);
  await assert.rejects(readdir(missing), { code: 'ENOENT' });
});

test('native home validation is read-only before and during Node ownership', windowsOnly, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'maka-history-native-validation-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await validateHome(home);
  assert.deepEqual(await readdir(home), [], 'validation must not create history or consent');

  const owner = await acquireWindowsHistoryOwnership(home);
  try {
    // A validator that acquires recorder admission would fail while Node owns it.
    for (const path of [home, toNamespacedPath(home)]) await validateHome(path);
    await assert.rejects(acquireWindowsHistoryOwnership(home), { code: 'EADDRINUSE' });
    assert.equal(await status(home), true, 'validation must preserve Node ownership');
    assert.deepEqual(await readdir(home), []);
  } finally {
    await owner.close();
  }
  await validateHome(home);
  assert.equal(await status(home), false);
  assert.deepEqual(await readdir(home), []);
});

for (const [name, home] of [
  ['UNC', String.raw`\\maka-history-validator.invalid\missing-share\history`],
  ['verbatim UNC', String.raw`\\?\UNC\maka-history-validator.invalid\missing-share\history`],
]) {
  test(`native home validation rejects nonexistent ${name} in the path parser`, windowsOnly, async () => {
    // Pass only the environment string: never stat, resolve or map this network
    // path. Native windows_drive_root rejects the prefix before filesystem I/O.
    await assert.rejects(invoke(home, ['validate-home']), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.killed, false, 'network timeout must not count as path rejection');
      assert.equal(error.signal, null);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr.trim(), 'history_home_must_be_a_local_drive_path');
      return true;
    });
  });
}

test('native status observes Node ownership across helper exit, aliases and release', windowsOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-history-native-parity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'History');
  const other = join(root, 'Other');
  await mkdir(home);
  await mkdir(other);
  const aliases = [home, join(root, 'history'), toNamespacedPath(home)];

  assert.equal(await status(home), false);
  assert.deepEqual(await readdir(home), [], 'read-only status must leave a fresh home empty');
  // Reacquisition also proves the read-only status probe released its instance.
  for (let iteration = 0; iteration < 2; iteration++) {
    const owner = await acquireWindowsHistoryOwnership(home);
    try {
      for (const alias of aliases) {
        assert.equal(await status(alias), true, `native must observe Node owner: ${alias}`);
      }
      assert.equal(await status(other), false, 'a distinct directory has independent admission');
      await assert.rejects(acquireWindowsHistoryOwnership(home), { code: 'EADDRINUSE' });
      assert.equal(await status(home), true, 'exited status helpers must not release Node admission');
    } finally {
      await owner.close();
    }
    assert.equal(await status(home), false);
  }
  assert.deepEqual(await readdir(home), [], 'ownership/status must not create history or consent');
  assert.deepEqual(await readdir(other), []);
});

for (const scenario of [
  { name: 'disabled recording with the actual parent', parent: process.pid, held: false, code: 1, error: 'recording_disabled' },
  { name: 'recording with a non-parent PID', parent: process.ppid, held: false, code: 1, error: 'invalid_parent' },
  { name: 'recording while Node owns admission', parent: process.pid, held: true, code: 75, error: 'recorder_occupied' },
]) {
  test(`native rejects ${scenario.name} before creating segments`, windowsOnly, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'maka-history-native-rejected-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const settings = '{"enabled":false}\n';
    await writeFile(join(home, 'maka-settings.json'), settings);
    const owner = scenario.held ? await acquireWindowsHistoryOwnership(home) : undefined;
    try {
      const pending = invoke(home, [
        'record', '--no-prompt', '--parent-pid', String(scenario.parent),
      ]);
      // execFile spawns directly, so process.pid really is the native parent.
      // Keep stdin piped and open: EOF must not be the reason recording stops.
      assert.ok(pending.child.stdin);
      assert.equal(pending.child.stdin.writableEnded, false);
      await assert.rejects(pending, (error) => {
        assert.equal(error.code, scenario.code);
        assert.equal(error.killed, false, 'a timeout/forced kill must not count as rejection');
        assert.equal(error.signal, null);
        assert.equal(error.stdout, '');
        assert.equal(error.stderr.trim(), scenario.error);
        return true;
      });
      assert.equal(await status(home), scenario.held, 'a rejected child must not change ownership');
    } finally {
      await owner?.close();
    }
    assert.equal(await status(home), false);
    assert.deepEqual(await readdir(home), ['maka-settings.json'], 'no segments or runtime output');
    assert.equal(await readFile(join(home, 'maka-settings.json'), 'utf8'), settings);
  });
}

test('Node, native status and validation reject junction homes and junction ancestors', windowsOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-history-native-junction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'Target');
  const alias = join(root, 'Alias');
  await mkdir(join(target, 'History'), { recursive: true });
  await symlink(target, alias, 'junction');
  for (const home of [alias, join(alias, 'History')]) {
    await assert.rejects(acquireWindowsHistoryOwnership(home), /real directories/);
    for (const command of ['status', 'validate-home']) {
      await assert.rejects(invoke(home, [command]), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /history_home_must_be_a_real_directory/);
        return true;
      });
    }
  }
});

test('paused native recorder releases ownership on stdin EOF and seals an empty segment', windowsOnly, async (t) => {
  const home = await pausedHome();
  const recorder = trackProcess(t, spawn(helper, [
    'record', '--no-prompt', '--parent-pid', String(process.pid),
  ], {
    env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }), home);

  await waitForPaused(home, recorder, recorder.child.pid);
  assert.equal(recorder.child.stdin.writableEnded, false);
  recorder.child.stdin.end();
  const [result] = await withinDeadline(Promise.all([recorder.exited, recorder.closed]), 'stdin EOF exit');
  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(recorder.stdout(), '');
  assert.equal(recorder.stderr(), '');
  await assertStoppedAndEmpty(home);
});

const pausedParentSource = String.raw`
  const { spawn } = require('node:child_process');
  const child = spawn(process.argv[1], [
    'record', '--no-prompt', '--parent-pid', String(process.pid),
  ], {
    env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: process.argv[2] },
    windowsHide: true,
    // libuv otherwise force-kills this child when Node's Job handle closes.
    // Leave that Job to exercise Parent::alive and the final store flush.
    detached: true,
    stdio: [3, 'inherit', 'inherit'],
  });
  child.on('spawn', () => process.send({ pid: child.pid }));
  child.on('error', (error) => { console.error(error); process.exit(1); });
  child.on('exit', (code) => process.exit(code ?? 1));
`;

test('paused native recorder exits and releases ownership when only its Node parent dies', windowsOnly, async (t) => {
  const home = await pausedHome();
  const parent = trackProcess(t, spawn(process.execPath, ['-e', pausedParentSource, helper, home], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ipc'],
  }), home, 3);
  const [message] = await withinDeadline(once(parent.child, 'message'), 'native child PID');
  const nativePid = message.pid;
  assert.ok(Number.isSafeInteger(nativePid) && nativePid > 1);
  assert.notEqual(nativePid, parent.child.pid);
  await waitForPaused(home, parent, nativePid);

  // Node destroys child.stdin on exit, but not this extra inherited fd 3.
  // Keeping its write side here isolates Parent::alive from stdin EOF.
  // No taskkill /T or native PID signal is used.
  assert.equal(parent.input.writableEnded, false);
  assert.equal(parent.child.kill('SIGKILL'), true);
  const result = await withinDeadline(parent.exited, 'owned Node parent exit');
  assert.notEqual(result.code, 0);
  // Inherited stdout/stderr remain open in native after Node's exit. Their
  // closure, plus the read-only process probe, witnesses the grandchild exit.
  // Native may already have exited here; do not assert fd 3 is still open.
  await withinDeadline(parent.closed, 'orphaned native child output closure');
  await waitUntil(() => {
    try { process.kill(nativePid, 0); return false; }
    catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
  }, 'orphaned native child exit');
  assert.equal(parent.stdout(), '');
  assert.equal(parent.stderr(), '');
  await assertStoppedAndEmpty(home);
});

const pausedFiles = {
  'control.json': JSON.stringify({ state: 'paused', resumeAt: null, revision: 'synthetic-indefinite-pause' }),
  'config.json': JSON.stringify({
    captureText: false,
    showMenuBarIcon: false,
    observation: {
      defaultApplicationBehavior: 'do_not_observe',
      defaultURLBehavior: 'do_not_observe',
      allowlist: [],
      blocklist: [],
    },
  }),
  'maka-settings.json': JSON.stringify({ enabled: true }),
};

async function pausedHome() {
  const home = await mkdtemp(join(tmpdir(), 'maka-history-native-paused-'));
  // All safety inputs exist before spawning; no resume or live capture command.
  try {
    for (const [name, contents] of Object.entries(pausedFiles)) {
      await writeFile(join(home, name), contents);
    }
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
  return home;
}

function trackProcess(t, child, home, inputFd = 0) {
  const input = child.stdio[inputFd];
  let result;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (data) => { stdout = (stdout + data).slice(-65_536); });
  child.stderr.setEncoding('utf8').on('data', (data) => { stderr = (stderr + data).slice(-65_536); });
  const exited = new Promise((resolve) => {
    child.once('error', (error) => { result = { error }; resolve(result); });
    child.once('exit', (code, signal) => { result = { code, signal }; resolve(result); });
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => {
    // Only owned handles are cleaned up. For an orphaned native child, stdin
    // EOF is a second graceful stop path if the parent-death assertion failed.
    if (!input.destroyed) input.end();
    if (!result) child.kill('SIGKILL');
    await withinDeadline(closed, 'owned process cleanup');
    // Do not remove safety files while a failed lifecycle could still be alive.
    await rm(home, { recursive: true, force: true });
  });
  return { child, input, exited, closed, result: () => result, stdout: () => stdout, stderr: () => stderr };
}

async function waitForPaused(home, process, nativePid) {
  await waitUntil(async () => {
    assert.equal(process.result(), undefined, `recorder exited before readiness: ${process.stderr()}`);
    let runtime;
    try { runtime = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    assert.equal(runtime.state, 'paused');
    assert.equal(runtime.processIdentifier, nativePid);
    return true;
  }, 'native paused readiness');
  assert.equal(await status(home), true);
  // The native owner's one-instance limit maps to EBUSY in libuv; a Node
  // owner permits more instances and FIRST_PIPE_INSTANCE maps to EADDRINUSE.
  await assert.rejects(acquireWindowsHistoryOwnership(home), { code: 'EBUSY' });
}

async function assertStoppedAndEmpty(home) {
  assert.equal(await status(home), false);
  const successor = await acquireWindowsHistoryOwnership(home);
  await successor.close();
  const runtime = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8'));
  assert.equal(runtime.state, 'stopped');
  assert.equal(runtime.captureFailures, 0);
  assert.ok(Number.isFinite(Date.parse(runtime.endedAt)));
  // Native status intentionally still reports the persisted indefinite pause;
  // runtime.json, not control.json, must record the stopped process lifecycle.
  for (const [name, contents] of Object.entries(pausedFiles)) {
    assert.equal(await readFile(join(home, name), 'utf8'), contents, `${name} must remain unchanged`);
  }
  const segments = await readdir(join(home, 'segments'));
  assert.equal(segments.length, 1);
  for (const id of segments) {
    const segment = join(home, 'segments', id);
    assert.equal((await readFile(join(segment, 'events.jsonl'))).length, 0, 'paused recorder wrote content');
    const metadata = JSON.parse(await readFile(join(segment, 'metadata.json'), 'utf8'));
    assert.equal(metadata.eventCount, 0);
    assert.equal(metadata.suppressedEventCount, 0);
    assert.equal(metadata.endReason, 'finished');
    assert.ok(Number.isFinite(Date.parse(metadata.endedAt)));
  }
}

async function waitUntil(check, label) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function withinDeadline(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
