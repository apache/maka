import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { packageWindowsX64, runCommand } = await import(
  new URL('package-windows-x64.mjs', import.meta.url)
);
const {
  assertWindowsProductVersion,
  powerShellLiteral,
  readPeMachine,
  verifyPackagedWindowsApp,
  verifyWindowsX64Release,
} = await import(new URL('verify-windows-x64.mjs', import.meta.url));

const desktopManifest = JSON.parse(
  await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'),
);

function peImage(machine) {
  const image = Buffer.alloc(0x100);
  image.writeUInt8(0x4d, 0);
  image.writeUInt8(0x5a, 1);
  image.writeUInt32LE(0x80, 0x3c);
  image.write('PE\0\0', 0x80, 'latin1');
  image.writeUInt16LE(machine, 0x84);
  return image;
}

function packagedAppOptions(overrides = {}) {
  return {
    // rcedit writes the four-part Windows form of the manifest version, so this
    // is what a correct packaged executable actually reports.
    run: async (command) => {
      if (command === 'powershell')
        return { stdout: `${desktopManifest.version}.0\r\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    },
    requirePath: async () => {},
    forbidPath: async () => {},
    readMachine: async () => 0x8664,
    smokeRenderer: async () => {},
    ...overrides,
  };
}

test('npm is spawned through the shell on Windows, the only way npm.cmd resolves', async () => {
  // libuv's Windows process launcher tries only .com and .exe and ignores
  // PATHEXT, so a bare `npm` is ENOENT there — the packaging script would die
  // on its first command. This cannot be caught by running the suite on macOS,
  // so the spawn strategy itself is what gets pinned.
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, options });
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0, null));
    return child;
  };

  await runCommand('npm', ['run', 'build'], { spawnProcess, platform: 'win32' });
  await runCommand('npm', ['run', 'build'], { spawnProcess, platform: 'darwin' });

  assert.equal(calls[0].options.shell, true);
  assert.equal(calls[1].options.shell, false);
});

test('Windows packaging fails closed on hosts that cannot produce the release', async () => {
  await assert.rejects(packageWindowsX64({ platform: 'darwin', arch: 'x64' }), /Windows x64 host/);
  await assert.rejects(packageWindowsX64({ platform: 'win32', arch: 'arm64' }), /Windows x64 host/);
});

test('Windows packaging regenerates bundled Git evidence before electron-builder consumes it', async () => {
  const commands = [];
  await packageWindowsX64({
    platform: 'win32',
    arch: 'x64',
    run: async (command, args) => commands.push([command, ...args].join(' ')),
    remove: async () => {},
    assertFile: async () => {},
  });

  assert.deepEqual(commands, [
    'npm run clean',
    'npm run build',
    'npm run prepare:bundled-git',
    'npm run check:release',
    'npm --workspace @maka/desktop run package:windows-x64',
  ]);
});

test('Windows verification fails closed on the host, the input, and the architecture', async () => {
  await assert.rejects(
    verifyWindowsX64Release('C:/Maka.exe', { platform: 'darwin' }),
    /requires Windows/,
  );
  await assert.rejects(verifyWindowsX64Release('', { platform: 'win32' }), /Usage:/);
  await assert.rejects(
    verifyWindowsX64Release('C:/Maka.zip', { platform: 'win32' }),
    /NSIS installer/,
  );
  // The app directory the ZIP was archived from has to be there; a release
  // directory without it is a half-built one, not something to verify.
  await assert.rejects(
    verifyWindowsX64Release('C:/does-not-exist/Maka.exe', { platform: 'win32' }),
    /ENOENT/,
  );

  await assert.rejects(
    verifyPackagedWindowsApp('C:/app', packagedAppOptions({ readMachine: async () => 0x014c })),
    /must be x64/,
  );
});

test('the Windows product version resource is read in the four-part form rcedit writes', () => {
  // The release version is the first three parts; the fourth is a build number.
  // Comparing the raw string against the manifest version would reject every
  // real executable, which is exactly what a mock-shaped oracle hides.
  assertWindowsProductVersion('0.1.5.0', '0.1.5');
  assertWindowsProductVersion('0.1.5.42\r\n', '0.1.5');
  assertWindowsProductVersion('0.2.0.0', '0.2.0-beta.1');

  for (const wrong of ['0.1.4.0', '0.1.5', '0.1.5.0.1', '0.1.5.x', '']) {
    assert.throws(() => assertWindowsProductVersion(wrong, '0.1.5'), /Expected app version/);
  }
});

test('a packaged Windows app whose version does not match the manifest is rejected', async () => {
  await assert.rejects(
    verifyPackagedWindowsApp(
      'C:/app',
      packagedAppOptions({
        run: async (command) => {
          if (command === 'powershell') return { stdout: '0.0.0.0\r\n', stderr: '' };
          return { stdout: '', stderr: '' };
        },
      }),
    ),
    /Expected app version/,
  );
});

test('the packaged Windows app is checked for every unsigned helper that could still be in a tree', async () => {
  // Same reason as the macOS check: `apps/desktop/resources/bin` is gitignored,
  // so a helper a developer prepared once is still on their machine and would
  // be packaged without anything noticing.
  const forbidden = [];
  await assert.rejects(
    verifyPackagedWindowsApp(
      'C:/app',
      packagedAppOptions({
        forbidPath: async (path) => {
          forbidden.push(path);
        },
        // Everything before the architecture check has to pass, so the failure
        // that ends this run is the one after the forbids.
        readMachine: async () => 0x014c,
      }),
    ),
    /must be x64/,
  );
  // The exact set, not "some path ends with each name": a helper is forbidden in
  // both the directories it could be staged from, and matching either one would
  // let the other be dropped without a test noticing.
  assert.deepEqual(forbidden.map((path) => path.slice('C:/app/resources/'.length)).sort(), [
    'bin/cua-driver',
    'bin/maka-cu',
    'licenses/officecli',
    'tools/cua-driver',
    'tools/maka-cu',
    'tools/officecli',
  ]);
});

test('paths reach PowerShell as literals, not as strings it expands', () => {
  // A double-quoted PowerShell string expands $, and the path being verified is
  // an argument this script does not choose.
  assert.equal(powerShellLiteral('D:/a/Maka.exe'), "'D:/a/Maka.exe'");
  assert.equal(powerShellLiteral("C:/it's/Maka.exe"), "'C:/it''s/Maka.exe'");
  assert.equal(powerShellLiteral('C:/$env:TEMP/Maka.exe'), "'C:/$env:TEMP/Maka.exe'");
});

test('the PE machine is read from the executable header', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-pe-'));
  try {
    const amd64 = join(directory, 'amd64.exe');
    const i386 = join(directory, 'i386.exe');
    const notPe = join(directory, 'not-pe.exe');
    await writeFile(amd64, peImage(0x8664));
    await writeFile(i386, peImage(0x014c));
    await writeFile(notPe, Buffer.alloc(0x100));

    assert.equal(await readPeMachine(amd64), 0x8664);
    assert.equal(await readPeMachine(i386), 0x014c);
    await assert.rejects(readPeMachine(notPe), /not a PE image/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
