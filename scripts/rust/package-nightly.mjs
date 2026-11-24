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

import { execFile, execFileSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 as win32Path } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { npmSpawnOptions } from '../npm-spawn.mjs';
import { buildCli, rustTarget, stageDesktopBundle } from './build-cli.mjs';
import { buildV8 } from './build-v8.mjs';
import { packV8 } from './v8-prebuilt.mjs';

const run = promisify(execFile);
const repositoryRootDefault = fileURLToPath(new URL('../../', import.meta.url));

export const NIGHTLY_TARGETS = {
  'darwin-arm64': {
    os: 'darwin',
    cpu: 'arm64',
    archiveName: 'Maka-nightly-macos-arm64.tar.gz',
    installerName: 'Maka-nightly-macos-arm64.dmg',
  },
  'linux-x64-gnu': {
    os: 'linux',
    cpu: 'x64',
    libc: ['glibc'],
    archiveName: 'Maka-nightly-linux-x64.tar.gz',
  },
  'linux-arm64-gnu': {
    os: 'linux',
    cpu: 'arm64',
    libc: ['glibc'],
    archiveName: 'Maka-nightly-linux-arm64.tar.gz',
  },
  'win32-x64': {
    os: 'win32',
    cpu: 'x64',
    archiveName: 'Maka-nightly-windows-x64.zip',
    installerName: 'Maka-nightly-windows-x64-setup.exe',
  },
};

const LEGAL_FILES = ['DISCLAIMER', 'LICENSE', 'NOTICE'];

function localLinuxInstallScript() {
  return [
    '#!/usr/bin/env sh',
    'set -eu',
    'SRC_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    'INSTALL_DIR="${MAKA_INSTALL_DIR:-$HOME/.local/share/maka}"',
    'BIN_DIR="$HOME/.local/bin"',
    'APP_DIR="$HOME/.local/share/applications"',
    'ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"',
    'mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR" "$APP_DIR" "$ICON_DIR"',
    'rm -rf "${INSTALL_DIR}.new"',
    'cp -R "$SRC_DIR" "${INSTALL_DIR}.new"',
    'rm -rf "$INSTALL_DIR"',
    'mv "${INSTALL_DIR}.new" "$INSTALL_DIR"',
    'ln -sf "$INSTALL_DIR/maka" "$BIN_DIR/maka"',
    'if [ -f "$INSTALL_DIR/maka.png" ]; then cp "$INSTALL_DIR/maka.png" "$ICON_DIR/org.apache.maka.desktop.png"; fi',
    'cat > "$APP_DIR/org.apache.maka.desktop.desktop" <<EOF',
    '[Desktop Entry]',
    'Type=Application',
    'Name=Maka',
    'Comment=Apache Maka (incubating) Nightly developer build',
    'Exec=$INSTALL_DIR/maka-desktop-shell',
    'Icon=org.apache.maka.desktop',
    'Terminal=false',
    'Categories=Development;Utility;',
    'StartupWMClass=org.apache.maka.desktop',
    'EOF',
    'echo "Installed Maka (unofficial nightly build) to $INSTALL_DIR"',
    'echo "CLI symlink: $BIN_DIR/maka"',
    '',
  ].join('\n');
}

export function renderInnoSetupScript({ sourceDir, outputDir, setupBaseName, version, iconPath }) {
  const esc = (value) => String(value).replaceAll('{', '{{').replaceAll('"', '""');
  const numericVersion = /^[0-9]+\.[0-9]+\.[0-9]+/u.exec(version)?.[0] ?? '0.0.0';
  return [
    '; Apache Maka (incubating) Nightly per-user installer (Inno Setup 6).',
    '[Setup]',
    'AppId=org.apache.maka.desktop',
    'AppName=Maka',
    'AppVersion=' + esc(version),
    'VersionInfoVersion=' + numericVersion,
    'AppVerName=Maka ' + esc(version) + ' (Nightly - Unofficial Developer Build)',
    'DefaultDirName={localappdata}\\Programs\\Maka',
    'UninstallFilesDir={localappdata}\\Programs\\Maka-Uninstall',
    'DefaultGroupName=Maka',
    'DisableProgramGroupPage=yes',
    'DisableDirPage=auto',
    'PrivilegesRequired=lowest',
    'ArchitecturesAllowed=x64compatible',
    'ArchitecturesInstallIn64BitMode=x64compatible',
    'MinVersion=10.0.17763',
    'OutputDir=' + esc(outputDir),
    'OutputBaseFilename=' + esc(setupBaseName),
    'Compression=lzma2',
    'SolidCompression=yes',
    'WizardStyle=modern',
    'CloseApplications=force',
    'ChangesEnvironment=yes',
    'UninstallDisplayIcon={app}\\maka-desktop-shell.exe',
    'UninstallDisplayName=Maka (Nightly)',
    ...(iconPath ? ['SetupIconFile=' + esc(iconPath)] : []),
    '',
    '[Tasks]',
    'Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked',
    'Name: "addtopath"; Description: "Add maka CLI to user PATH"; GroupDescription: "Command Line:"; Flags: checkedonce',
    '',
    '[Files]',
    'Source: "' +
      esc(sourceDir) +
      '\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs',
    '',
    '[Icons]',
    'Name: "{autoprograms}\\Maka"; Filename: "{app}\\maka-desktop-shell.exe"; AppUserModelID: "org.apache.maka.desktop"',
    'Name: "{autodesktop}\\Maka"; Filename: "{app}\\maka-desktop-shell.exe"; AppUserModelID: "org.apache.maka.desktop"; Tasks: desktopicon',
    '',
    '[Run]',
    'Filename: "{app}\\maka-desktop-shell.exe"; Description: "{cm:LaunchProgram,Maka}"; Flags: nowait postinstall skipifsilent',
    '',
    '[Code]',
    "const EnvKey = 'Environment';",
    '',
    'procedure AddDirToUserPath(Dir: String);',
    'var Paths: String;',
    'begin',
    "  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Paths) then Paths := '';",
    "  if Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Paths) + ';') > 0 then Exit;",
    "  if (Length(Paths) > 0) and (Paths[Length(Paths)] <> ';') then Paths := Paths + ';';",
    '  Paths := Paths + Dir;',
    "  RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Paths);",
    'end;',
    '',
    'procedure RemoveDirFromUserPath(Dir: String);',
    'var Paths, UpperPaths, UpperDir: String; P: Integer;',
    'begin',
    "  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Paths) then Exit;",
    "  UpperPaths := ';' + Uppercase(Paths) + ';';",
    "  UpperDir := ';' + Uppercase(Dir) + ';';",
    '  P := Pos(UpperDir, UpperPaths);',
    '  if P = 0 then Exit;',
    '  Delete(Paths, P, Length(Dir));',
    "  StringChangeEx(Paths, ';;', ';', True);",
    "  if (Length(Paths) > 0) and (Paths[1] = ';') then Delete(Paths, 1, 1);",
    "  if (Length(Paths) > 0) and (Paths[Length(Paths)] = ';') then Delete(Paths, Length(Paths), 1);",
    "  RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Paths);",
    'end;',
    '',
    'procedure CurStepChanged(CurStep: TSetupStep);',
    'begin',
    "  if (CurStep = ssPostInstall) and WizardIsTaskSelected('addtopath') then",
    "    AddDirToUserPath(ExpandConstant('{app}'));",
    'end;',
    '',
    'procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);',
    'begin',
    '  if CurUninstallStep = usPostUninstall then',
    "    RemoveDirFromUserPath(ExpandConstant('{app}'));",
    'end;',
    '',
  ].join('\r\n');
}

/** Resolve Windows's built-in bsdtar so Git Bash's GNU tar cannot shadow it on PATH. */
export function windowsTarExecutable(env = process.env) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.WINDIR || env.windir || 'C:\\Windows';
  return win32Path.join(systemRoot, 'System32', 'tar.exe');
}

function findIscc() {
  const candidates = [
    process.env.ISCC,
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function copyLegal(repositoryRoot, noticesPath, destDir) {
  for (const name of LEGAL_FILES) {
    await copyFile(join(repositoryRoot, name), join(destDir, name));
  }
  await copyFile(resolve(noticesPath), join(destDir, 'THIRD_PARTY_NOTICES.txt'));
}

async function createMacDmg(appBundlePath, dmgPath) {
  const staging = await mkdtemp(join(tmpdir(), 'maka-dmg-'));
  try {
    execFileSync('/usr/bin/ditto', [appBundlePath, join(staging, 'Maka.app')], {
      stdio: 'inherit',
    });
    await symlink('/Applications', join(staging, 'Applications'));
    await rm(dmgPath, { force: true });
    execFileSync(
      '/usr/bin/hdiutil',
      [
        'create',
        '-volname',
        'Maka Nightly',
        '-srcfolder',
        staging,
        '-ov',
        '-format',
        'UDZO',
        dmgPath,
      ],
      {
        stdio: 'inherit',
      },
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function notarizeAndStapleMac(dmgPath, appBundlePath) {
  const key = process.env.APPLE_API_KEY;
  const keyId = process.env.APPLE_API_KEY_ID;
  const issuer = process.env.APPLE_API_ISSUER;
  const identity = process.env.MAKA_CODESIGN_IDENTITY;
  if (!key || !keyId || !issuer || !identity || identity === '-') {
    return false;
  }
  execFileSync(
    '/usr/bin/xcrun',
    [
      'notarytool',
      'submit',
      dmgPath,
      '--key',
      key,
      '--key-id',
      keyId,
      '--issuer',
      issuer,
      '--wait',
    ],
    {
      stdio: 'inherit',
    },
  );
  execFileSync('/usr/bin/xcrun', ['stapler', 'staple', dmgPath], { stdio: 'inherit' });
  // Notarizing the DMG notarizes the enclosed Maka.app as well; stapling the app
  // ensures the updater .tar.gz carries an offline notarization ticket too.
  execFileSync('/usr/bin/xcrun', ['stapler', 'staple', appBundlePath], { stdio: 'inherit' });
  return true;
}

export async function packageNightly({
  target,
  version,
  binary,
  notices,
  output,
  repositoryRoot = repositoryRootDefault,
  skipDmg = false,
  smoke = false,
}) {
  const info = NIGHTLY_TARGETS[target];
  if (!info) throw new Error('Unsupported nightly target: ' + target);
  const binDir = dirname(resolve(binary));
  const outDir = resolve(output);
  await mkdir(outDir, { recursive: true });
  const stage = await mkdtemp(join(tmpdir(), 'maka-nightly-stage-'));
  const produced = [];

  try {
    if (info.os === 'darwin') {
      const legalStage = join(stage, 'legal');
      await mkdir(legalStage);
      await copyLegal(repositoryRoot, notices, legalStage);
      const resources = [...LEGAL_FILES, 'THIRD_PARTY_NOTICES.txt'].map((name) =>
        join(legalStage, name),
      );
      const appPath = join(stage, 'Maka.app');
      await stageDesktopBundle(
        repositoryRoot,
        join(binDir, 'maka-desktop-shell'),
        appPath,
        resources,
        {
          executables: [resolve(binary), join(binDir, 'maka-python-worker')],
          version,
        },
      );
      if (smoke) {
        await smokeTestBuiltBinaries({
          binary: join(appPath, 'Contents/MacOS/maka'),
          shell: join(appPath, 'Contents/MacOS/maka-desktop-shell'),
          worker: join(appPath, 'Contents/MacOS/maka-python-worker'),
        });
      }
      if (!skipDmg) {
        const dmgPath = join(outDir, info.installerName);
        await createMacDmg(appPath, dmgPath);
        notarizeAndStapleMac(dmgPath, appPath);
        produced.push(dmgPath);
      }
      const tarPath = join(outDir, info.archiveName);
      execFileSync('/usr/bin/tar', ['-czf', tarPath, '-C', stage, 'Maka.app'], {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
        stdio: 'inherit',
      });
      produced.push(tarPath);
    } else if (info.os === 'linux') {
      const dir = join(stage, 'maka');
      await mkdir(dir, { recursive: true });
      for (const name of ['maka', 'maka-desktop-shell', 'maka-python-worker']) {
        const src = name === 'maka' ? resolve(binary) : join(binDir, name);
        const dst = join(dir, name);
        await copyFile(src, dst, constants.COPYFILE_FICLONE);
        await chmod(dst, 0o755);
      }
      await copyFile(join(repositoryRoot, 'assets/logo.png'), join(dir, 'maka.png'));
      await copyLegal(repositoryRoot, notices, dir);
      if (smoke) {
        await smokeTestBuiltBinaries({
          binary: join(dir, 'maka'),
          shell: join(dir, 'maka-desktop-shell'),
          worker: join(dir, 'maka-python-worker'),
        });
      }
      const installScript = join(dir, 'install.sh');
      await writeFile(installScript, localLinuxInstallScript(), 'utf8');
      await chmod(installScript, 0o755);
      const tarPath = join(outDir, info.archiveName);
      execFileSync('tar', ['-czf', tarPath, '-C', stage, 'maka'], { stdio: 'inherit' });
      produced.push(tarPath);
    } else if (info.os === 'win32') {
      const dir = join(stage, 'Maka');
      await mkdir(dir, { recursive: true });
      for (const name of [
        'maka.exe',
        'maka-desktop-shell.exe',
        'maka-python-worker.exe',
        'maka-service.exe',
      ]) {
        const src = name === 'maka.exe' ? resolve(binary) : join(binDir, name);
        await copyFile(src, join(dir, name));
      }
      await copyLegal(repositoryRoot, notices, dir);
      if (smoke) {
        await smokeTestBuiltBinaries({
          binary: join(dir, 'maka.exe'),
          shell: join(dir, 'maka-desktop-shell.exe'),
          worker: join(dir, 'maka-python-worker.exe'),
        });
      }
      const zipPath = join(outDir, info.archiveName);
      if (process.platform === 'win32') {
        execFileSync(windowsTarExecutable(), ['-a', '-cf', zipPath, '-C', stage, 'Maka'], {
          stdio: 'inherit',
        });
      } else {
        execFileSync('zip', ['-rq', zipPath, 'Maka'], { cwd: stage, stdio: 'inherit' });
      }
      produced.push(zipPath);

      const issPath = join(stage, 'Maka.iss');
      const iconPath = join(repositoryRoot, 'products/maka/desktop-shell/maka.ico');
      const setupBaseName = info.installerName.replace(/\.exe$/iu, '');
      await writeFile(
        issPath,
        renderInnoSetupScript({
          sourceDir: dir,
          outputDir: outDir,
          setupBaseName,
          version,
          iconPath: existsSync(iconPath) ? iconPath : null,
        }),
        'utf8',
      );
      if (process.platform === 'win32') {
        const iscc = findIscc();
        if (!iscc) {
          throw new Error('Inno Setup compiler (ISCC.exe) not found on Windows build host');
        }
        execFileSync(iscc, ['/Qp', issPath], { stdio: 'inherit' });
        produced.push(join(outDir, info.installerName));
      }
    }
    const releaseNoticesPath = join(outDir, `THIRD_PARTY_NOTICES-${target}.txt`);
    await copyFile(resolve(notices), releaseNoticesPath);
    produced.push(releaseNoticesPath);
    return produced;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function packNightlyNpmPlatform({
  target,
  version,
  binary,
  notices,
  output,
  tag = 'nightly',
  repositoryRoot = repositoryRootDefault,
}) {
  const info = NIGHTLY_TARGETS[target];
  if (!info) throw new Error('Unsupported npm target: ' + target);
  const binDir = dirname(resolve(binary));
  const outDir = resolve(output);
  await mkdir(outDir, { recursive: true });
  const stage = await mkdtemp(join(tmpdir(), 'maka-nightly-npm-'));
  try {
    const pkgDir = join(stage, 'package');
    const pkgBin = join(pkgDir, 'bin');
    await mkdir(pkgBin, { recursive: true });
    const exeName = info.os === 'win32' ? 'maka.exe' : 'maka';
    await copyFile(resolve(binary), join(pkgBin, exeName));
    await chmod(join(pkgBin, exeName), 0o755);

    const workerName = info.os === 'win32' ? 'maka-python-worker.exe' : 'maka-python-worker';
    await copyFile(join(binDir, workerName), join(pkgBin, workerName));
    await chmod(join(pkgBin, workerName), 0o755);

    if (info.os === 'win32') {
      await copyFile(join(binDir, 'maka-service.exe'), join(pkgBin, 'maka-service.exe'));
    }

    await copyLegal(repositoryRoot, notices, pkgDir);
    const disclaimer = await readFile(join(pkgDir, 'DISCLAIMER'), 'utf8');
    const readme = [
      '# `@maka-agent/cli-' + target + '`',
      '',
      '> **Unofficial Developer Nightly Build — Not an Apache Software Foundation Release.**',
      '> Provided strictly for developer testing. Not approved by an ASF release vote.',
      '',
      disclaimer.trim(),
      '',
    ].join('\n');
    await writeFile(join(pkgDir, 'README.md'), readme, 'utf8');

    if (info.os === 'darwin') {
      const resources = [...LEGAL_FILES, 'THIRD_PARTY_NOTICES.txt'].map((name) =>
        join(pkgDir, name),
      );
      await stageDesktopBundle(
        repositoryRoot,
        join(binDir, 'maka-desktop-shell'),
        join(pkgBin, 'Maka.app'),
        resources,
        { version },
      );
    } else {
      const shellName = info.os === 'win32' ? 'maka-desktop-shell.exe' : 'maka-desktop-shell';
      await copyFile(join(binDir, shellName), join(pkgBin, shellName));
      await chmod(join(pkgBin, shellName), 0o755);
    }

    const name = '@maka-agent/cli-' + target;
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name,
          version,
          description:
            'Unofficial developer nightly build of Apache Maka (incubating) for ' +
            target +
            '; NOT an ASF release',
          license: 'Apache-2.0',
          repository: { type: 'git', url: 'https://github.com/apache/maka.git' },
          os: [info.os],
          cpu: [info.cpu],
          ...(info.libc ? { libc: info.libc } : {}),
          bin: { maka: 'bin/' + exeName },
          files: ['bin', 'DISCLAIMER', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'README.md'],
          publishConfig: {
            access: 'public',
            registry: 'https://registry.npmjs.org/',
            tag,
          },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    const packed = await run(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--offline'],
      npmSpawnOptions({ cwd: pkgDir, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 180_000 }),
    );
    const [{ filename }] = Object.values(JSON.parse(packed.stdout));
    const archivePath = join(outDir, filename);
    await copyFile(join(pkgDir, filename), archivePath);
    return { name, target, version, archive: archivePath };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function packNightlyNpmLaunchers({
  version,
  output,
  targets = Object.keys(NIGHTLY_TARGETS),
  tag = 'nightly',
  repositoryRoot = repositoryRootDefault,
}) {
  const outDir = resolve(output);
  await mkdir(outDir, { recursive: true });
  const disclaimer = await readFile(join(repositoryRoot, 'DISCLAIMER'), 'utf8');
  const produced = [];

  // 1. @maka-agent/cli launcher
  {
    const stage = await mkdtemp(join(tmpdir(), 'maka-nightly-cli-'));
    try {
      const pkgDir = join(stage, 'package');
      await mkdir(join(pkgDir, 'bin'), { recursive: true });
      await copyFile(
        join(repositoryRoot, 'packages/cli/bin/maka.mjs'),
        join(pkgDir, 'bin/maka.mjs'),
      );
      await chmod(join(pkgDir, 'bin/maka.mjs'), 0o755);
      for (const name of LEGAL_FILES) {
        await copyFile(join(repositoryRoot, name), join(pkgDir, name));
      }
      for (const name of ['README.md', 'README.zh-CN.md']) {
        await copyFile(join(repositoryRoot, 'packages/cli', name), join(pkgDir, name));
        await appendFile(join(pkgDir, name), '\n\n' + disclaimer);
      }
      const optionalDependencies = Object.fromEntries(
        targets.map((target) => ['@maka-agent/cli-' + target, version]),
      );
      await writeFile(
        join(pkgDir, 'package.json'),
        JSON.stringify(
          {
            name: '@maka-agent/cli',
            version,
            description:
              'Unofficial developer nightly build of Apache Maka (incubating); NOT an ASF release',
            license: 'Apache-2.0',
            type: 'module',
            engines: { node: '>=24.0.0' },
            bin: { maka: 'bin/maka.mjs' },
            optionalDependencies,
            files: ['bin', 'DISCLAIMER', 'LICENSE', 'NOTICE', 'README.md', 'README.zh-CN.md'],
            repository: { type: 'git', url: 'https://github.com/apache/maka.git' },
            publishConfig: {
              access: 'public',
              registry: 'https://registry.npmjs.org/',
              tag,
            },
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      const packed = await run(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--offline'],
        npmSpawnOptions({
          cwd: pkgDir,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          timeout: 180_000,
        }),
      );
      const [{ filename }] = Object.values(JSON.parse(packed.stdout));
      const archivePath = join(outDir, filename);
      await copyFile(join(pkgDir, filename), archivePath);
      produced.push({ name: '@maka-agent/cli', version, archive: archivePath });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  // 2. maka-agent alias package -> exact-version @maka-agent/cli
  {
    const stage = await mkdtemp(join(tmpdir(), 'maka-nightly-alias-'));
    try {
      const pkgDir = join(stage, 'package');
      await mkdir(join(pkgDir, 'bin'), { recursive: true });
      await copyFile(
        join(repositoryRoot, 'packages/maka-agent/bin/maka.mjs'),
        join(pkgDir, 'bin/maka.mjs'),
      );
      await chmod(join(pkgDir, 'bin/maka.mjs'), 0o755);
      for (const name of LEGAL_FILES) {
        await copyFile(join(repositoryRoot, name), join(pkgDir, name));
      }
      await copyFile(
        join(repositoryRoot, 'packages/maka-agent/README.md'),
        join(pkgDir, 'README.md'),
      );
      await appendFile(join(pkgDir, 'README.md'), '\n\n' + disclaimer);
      await writeFile(
        join(pkgDir, 'package.json'),
        JSON.stringify(
          {
            name: 'maka-agent',
            version,
            description:
              'Alias for @maka-agent/cli (unofficial developer nightly build; NOT an ASF release)',
            license: 'Apache-2.0',
            type: 'module',
            engines: { node: '>=24.0.0' },
            bin: { maka: 'bin/maka.mjs' },
            dependencies: { '@maka-agent/cli': version },
            files: ['bin', 'DISCLAIMER', 'LICENSE', 'NOTICE', 'README.md'],
            repository: { type: 'git', url: 'https://github.com/apache/maka.git' },
            publishConfig: {
              access: 'public',
              registry: 'https://registry.npmjs.org/',
              tag,
            },
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      const packed = await run(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--offline'],
        npmSpawnOptions({
          cwd: pkgDir,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          timeout: 180_000,
        }),
      );
      const [{ filename }] = Object.values(JSON.parse(packed.stdout));
      const archivePath = join(outDir, filename);
      await copyFile(join(pkgDir, filename), archivePath);
      produced.push({ name: 'maka-agent', version, archive: archivePath });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  return produced;
}

export async function smokeTestBuiltBinaries({ binary, shell, worker }) {
  for (const exe of [binary, shell, worker]) {
    await run(exe, ['--version'], { timeout: 15_000, windowsHide: true });
  }
  const stage = await mkdtemp(join(tmpdir(), 'maka-smoke-'));
  try {
    const rootDir = join(stage, 'root');
    const stdout = await new Promise((resolveOut, reject) => {
      const child = execFile(
        binary,
        ['code', '--root', rootDir, '--dangerously-bypass-approvals-and-sandbox'],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, out) => (error ? reject(error) : resolveOut(out)),
      );
      child.stdin.end(
        'if (Math.cos(0) !== 1 || Temporal.PlainDate.from("2026-11-21").year !== 2026) throw new Error("smoke failed"); text("smoke-ok");',
      );
      child.stdin.on('error', reject);
    });
    const parsed = JSON.parse(stdout);
    const hasMarker =
      Array.isArray(parsed.output?.content) &&
      parsed.output.content.some((item) => item?.kind === 'text' && item?.text === 'smoke-ok');
    if (
      parsed.error !== null ||
      parsed.output?.state !== 'completed' ||
      parsed.output?.result?.ok !== true ||
      !hasMarker
    ) {
      throw new Error('Built maka binary failed V8 code smoke test: ' + stdout);
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function assembleNotices(repositoryRoot, v8NoticesText, outPath) {
  const baseNotices = await readFile(
    join(repositoryRoot, 'products/maka/cli/THIRD_PARTY_NOTICES.txt'),
    'utf8',
  );
  const sysroot = (
    await run('rustc', ['--print', 'sysroot'], { cwd: repositoryRoot })
  ).stdout.trim();
  const rustNotices = await readFile(
    join(sysroot, 'share/doc/rust/COPYRIGHT-library.html'),
    'utf8',
  );
  await writeFile(outPath, [baseNotices, v8NoticesText, rustNotices].join('\n\n'), 'utf8');
}

export async function buildAndPackageNightly({
  target,
  version,
  output,
  npmOutput,
  v8Output,
  repositoryRoot = repositoryRootDefault,
}) {
  const info = NIGHTLY_TARGETS[target];
  if (!info) throw new Error('Unsupported nightly target: ' + target);
  const triple = rustTarget(info.os, info.cpu);
  const stage = await mkdtemp(join(tmpdir(), 'maka-nightly-build-'));
  try {
    const metadata = JSON.parse(
      (
        await run(
          'cargo',
          ['metadata', '--locked', '--format-version', '1', '--filter-platform', triple],
          { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024, timeout: 600_000 },
        )
      ).stdout,
    );
    const v8CacheDir = resolve(process.env.CARGO_TARGET_DIR || 'target', 'v8');
    const v8 = await buildV8({
      root: repositoryRoot,
      directory: join(stage, 'v8'),
      cache: v8CacheDir,
      target: triple,
      env: process.env,
      metadata,
    });

    const buildEnv = {
      ...process.env,
      ...v8.environment,
      MAKA_UPDATE_CHANNEL: 'nightly',
      MAKA_BUILD_VERSION: version,
      ...(process.env.MAKA_UPDATE_PUBLIC_KEY
        ? { MAKA_UPDATE_PUBLIC_KEY: process.env.MAKA_UPDATE_PUBLIC_KEY }
        : {}),
      ...(process.env.MAKA_UPDATE_REPO ? { MAKA_UPDATE_REPO: process.env.MAKA_UPDATE_REPO } : {}),
    };

    const { binary } = await buildCli({
      profile: 'dist',
      target: triple,
      repositoryRoot,
      env: buildEnv,
    });

    const noticesPath = join(stage, 'THIRD_PARTY_NOTICES.txt');
    await assembleNotices(repositoryRoot, v8.notices, noticesPath);

    const produced = await packageNightly({
      target,
      version,
      binary,
      notices: noticesPath,
      output,
      repositoryRoot,
      smoke: true,
    });

    let npmPackage = null;
    if (npmOutput) {
      npmPackage = await packNightlyNpmPlatform({
        target,
        version,
        binary,
        notices: noticesPath,
        output: npmOutput,
        repositoryRoot,
      });
    }

    if (v8Output && process.env.V8_CACHE_KEY) {
      const pins = JSON.parse(
        await readFile(join(repositoryRoot, 'scripts/rust/v8-prebuilts.json'), 'utf8'),
      );
      if (!Object.hasOwn(pins, process.env.V8_CACHE_KEY)) {
        await packV8({
          directory: v8CacheDir,
          key: process.env.V8_CACHE_KEY,
          target: triple,
          output: v8Output,
          verifiedBy: process.env.GITHUB_SHA
            ? {
                commit: process.env.GITHUB_SHA,
                run:
                  'https://github.com/' +
                  process.env.GITHUB_REPOSITORY +
                  '/actions/runs/' +
                  process.env.GITHUB_RUN_ID,
              }
            : undefined,
        });
      }
    }

    return { produced, npmPackage };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function publishNightlyNpm({
  directory,
  version,
  tag = 'nightly',
  provenance = false,
}) {
  const dir = resolve(directory);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.tgz'));
  const platformPackages = Object.keys(NIGHTLY_TARGETS)
    .map((target) => 'maka-agent-cli-' + target + '-' + version + '.tgz')
    .filter((name) => files.includes(name));
  const launcher = 'maka-agent-cli-' + version + '.tgz';
  const alias = 'maka-agent-' + version + '.tgz';
  if (!files.includes(launcher) || !files.includes(alias)) {
    throw new Error('Missing launcher or maka-agent alias tarball in ' + dir);
  }
  const ordered = [...platformPackages, launcher, alias];
  for (const file of ordered) {
    const pkgName = file.startsWith('maka-agent-cli-')
      ? '@maka-agent/cli' + file.slice('maka-agent-cli'.length, -('-' + version + '.tgz').length)
      : 'maka-agent';
    try {
      const existing = execFileSync(
        'npm',
        ['view', pkgName + '@' + version, 'version'],
        npmSpawnOptions({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
      ).trim();
      if (existing === version) {
        console.log('Skipping already published ' + pkgName + '@' + version);
        continue;
      }
    } catch {
      // Not published yet.
    }
    const args = ['publish', join(dir, file), '--access', 'public', '--tag', tag];
    if (provenance) args.push('--provenance');
    execFileSync('npm', args, npmSpawnOptions({ stdio: 'inherit' }));
  }
  return ordered;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'build') {
    const { values } = parseArgs({
      args: rest,
      options: {
        target: { type: 'string' },
        version: { type: 'string' },
        output: { type: 'string' },
        'npm-output': { type: 'string' },
        'v8-output': { type: 'string' },
      },
    });
    if (!values.target || !values.version || !values.output) {
      throw new Error('usage: package-nightly.mjs build --target <t> --version <v> --output <dir>');
    }
    const result = await buildAndPackageNightly({
      target: values.target,
      version: values.version,
      output: values.output,
      npmOutput: values['npm-output'],
      v8Output: values['v8-output'],
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'pack-npm-launchers') {
    const { values } = parseArgs({
      args: rest,
      options: {
        version: { type: 'string' },
        output: { type: 'string' },
        tag: { type: 'string' },
      },
    });
    if (!values.version || !values.output) {
      throw new Error('usage: package-nightly.mjs pack-npm-launchers --version <v> --output <dir>');
    }
    const files = await readdir(resolve(values.output));
    const presentTargets = Object.keys(NIGHTLY_TARGETS).filter((t) =>
      files.includes('maka-agent-cli-' + t + '-' + values.version + '.tgz'),
    );
    if (presentTargets.length === 0) {
      throw new Error('No platform npm tarballs found for version ' + values.version);
    }
    const result = await packNightlyNpmLaunchers({
      version: values.version,
      output: values.output,
      targets: presentTargets,
      tag: values.tag ?? 'nightly',
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'publish-npm') {
    const { values } = parseArgs({
      args: rest,
      options: {
        dir: { type: 'string' },
        version: { type: 'string' },
        tag: { type: 'string' },
        provenance: { type: 'boolean' },
      },
    });
    if (!values.dir || !values.version) {
      throw new Error('usage: package-nightly.mjs publish-npm --dir <dir> --version <v>');
    }
    const published = await publishNightlyNpm({
      directory: values.dir,
      version: values.version,
      tag: values.tag ?? 'nightly',
      provenance: Boolean(values.provenance),
    });
    console.log(JSON.stringify(published, null, 2));
  } else {
    throw new Error('usage: package-nightly.mjs <build|pack-npm-launchers|publish-npm> ...');
  }
}
