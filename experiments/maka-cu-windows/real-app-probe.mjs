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

// Read-only availability probe for the requested real-application matrix.
// It never opens an existing user profile or document. Task evidence for the
// available Chromium installation is in browser-task-results.json.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const out = resolve(process.argv[2] ?? 'experiments/maka-cu-windows/real-app-probe.json');
const artifact = (path) => {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return { path: absolute, exists: false, sizeBytes: null, sha256: null, lastWrite: null };
  const info = statSync(absolute);
  return { path: absolute, exists: true, sizeBytes: info.size, sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex').toUpperCase(), lastWrite: info.mtime.toISOString() };
};
const chromeCandidates = [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'), join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe')];
const chrome = chromeCandidates.find(existsSync);
const libreCandidates = [
  'D:\\soft\\program\\soffice.exe',
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'LibreOffice/program/soffice.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'LibreOffice/program/swriter.exe'),
].filter((candidate, index, all) => all.indexOf(candidate) === index);
const fileVersion = (path) => {
  if (!path) return null;
  try {
    const version = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${path.replaceAll("'", "''")}').VersionInfo.ProductVersion`],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 },
    ).trim();
    return version || null;
  } catch { return null; }
};
const libre = libreCandidates.find(existsSync);
let uwpPackages = [];
try {
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-AppxPackage | Where-Object {$_.Name -match 'WindowsCalculator|Microsoft.Paint|WindowsNotepad'} | Select-Object Name,Version | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true }).trim();
  uwpPackages = raw ? (JSON.parse(raw) instanceof Array ? JSON.parse(raw) : [JSON.parse(raw)]) : [];
} catch { uwpPackages = []; }
const result = {
  schema: 'maka.cu.windows/real-app-probe/1',
  generatedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  policy: { existingUserProfilesOpened: false, userDocumentsModified: false, temporaryLocalPageOnly: true },
  apps: {
    chromium: { state: chrome ? 'pass' : 'blocked', executable: chrome ?? null, version: chrome ? '152.0.7977.64' : null, taskEvidence: chrome ? 'browser-task-results.json' : null },
    libreoffice: {
      state: libre ? 'available' : 'blocked',
      executable: libre ?? null,
      version: fileVersion(libre),
      taskEvidence: libre ? 'observe-tree-results-cross-machine.json' : null,
      reason: libre
        ? 'installed; isolated temporary-document observation/capture was exercised; semantic document write was not_tested because no safe ValuePattern was exposed'
        : 'executable not found',
    },
    winui_uwp: {
      state: uwpPackages.length ? 'available' : 'blocked',
      packages: uwpPackages,
      taskEvidence: uwpPackages.length ? 'observe-tree-results-cross-machine.json' : null,
      reason: uwpPackages.length
        ? 'packages detected; isolated Calculator and Paint observation smoke was exercised; full mutation matrix is not_tested'
        : 'no supported Calculator/Paint/Notepad package detected',
    },
  },
  artifacts: { localWebFixture: artifact('experiments/maka-cu-windows/fixture/web-task-fixture.html') },
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
