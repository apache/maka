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
// One profile authority for every Maka dev launch shape (#63).
//
// Electron's single-instance lock keys on userData, so "who holds the lock
// for the profile this launch will use" is the question; the profile is the
// unit of ownership, never the bundle path. Both launch shapes (the opt-in
// TCC bundle and a plain `npm run dev` Electron) reach the same shared
// "Maka Dev" profile, so both are judged by the same rules.
//
// Matching strategy: compare KNOWN literals, never reverse-parse unknown
// values. Three literals are known: our own worktree root, the target
// profile, and the Maka dev markers themselves (`Maka Dev.app`,
// `/apps/desktop`). A line that carries a Maka marker and no explicit
// --user-data-dir holds the SHARED DEFAULT lock — this is space-bearing-root
// agnostic and env-file independent, and it excludes foreign Electron apps,
// which carry neither marker.
//
// Failure costs are NOT symmetric, and the expensive direction is
// MISSING another worktree's process: that fails to block and our launch is
// silently absorbed through the lock — the very symptom this gate exists to
// prevent. Misjudging OUR OWN process as foreign blocks one legitimate
// launch (annoying, recoverable). The design therefore errs toward seeing
// MORE holders, never fewer.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export const DEV_USER_DATA_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'Maka Dev',
);
export const DEV_ENV_SCHEMA_VERSION = 1;

/**
 * Known Maka dev markers; a hit means the process is one of ours.
 *
 * The `/apps/desktop` marker is structurally guaranteed, not sample-derived:
 * every plain launch is `spawn(resolveElectronBinary(), [DESKTOP_DIR, ...])`
 * with `DESKTOP_DIR = <root>/apps/desktop`, so a Maka plain dev process
 * ALWAYS carries it as argv[1]. The TCC bundle carries `Maka Dev.app` by
 * construction. (The two captured real plain lines ran against a fixture
 * dir, not DESKTOP_DIR — the structural argument is what makes the marker
 * reliable despite that.)
 *
 * KNOWN LIMITATION of this marker (a tested trade, not an accident):
 * `apps/desktop` is also the standard layout of Turborepo / Nx monorepos,
 * so a foreign monorepo's Electron dev without an explicit
 * `--user-data-dir` is seen as a holder of our shared lock. That errs on
 * the "see MORE holders" side (a launch may be conservatively blocked,
 * never silently absorbed); it cannot be tightened from flat argv.
 */
export function hasMakaDevMarker(commandLine) {
  return (
    commandLine.includes('Maka Dev.app') ||
    commandLine.includes('/apps/desktop')
  );
}

/**
 * Whether the process holds the profile lock for `target` (undefined = the
 * shared default "Maka Dev" profile).
 *
 * Truth table:
 *  - a known Maka marker is present AND `--user-data-dir=<target>` appears
 *    as a literal (bounded per the target's shape)          → true
 *  - a marker is present and some OTHER --user-data-dir appears → false
 *  - a marker is present, no switch, target is the default     → true
 *  - a marker is present, no switch, target is NOT the default → false
 *  - no marker at all                                          → false
 *
 * The explicit-value boundary is uniform: `--user-data-dir=<target>` must be
 * followed by whitespace or the line end. A longer real value appends a
 * non-space character (`-abc123`, `/sub`), which the boundary rejects; only
 * a value equal to `target + space + more` remains undecidable from flat
 * argv — accepted, on the "see MORE holders" side.
 */
export function holdsProfile(commandLine, target, options = {}) {
  const wanted = target ?? DEV_USER_DATA_DIR;
  if (!hasMakaDevMarker(commandLine)) return false;
  // TCC bundle: the profile is NOT on the command line — splitDevelopmentCliArgs
  // strips --user-data-dir into dev-env.json (the switch would be overridden
  // by the bootstrap's setPath). Read that worktree's dev-env.json instead.
  if (commandLine.includes('Maka Dev.app')) {
    const root = worktreeRootFromBundle(commandLine);
    const env = root ? readDevEnvUserDataDir(root, options) : undefined;
    // env missing = abnormal (the launcher writes it before every launch);
    // err toward the shared default (see-MORE direction), never fold unknown
    // into a specific profile.
    return env === undefined ? wanted === DEV_USER_DATA_DIR : env === wanted;
  }
  if (hasUserDataDirSwitch(commandLine)) {
    return explicitSwitchLiteral(commandLine, wanted);
  }
  return wanted === DEV_USER_DATA_DIR;
}

/**
 * Worktree root of a TCC bundle command line, by known-literal matching:
 * argv[0] is the bundle executable, and the bundle path ends with the known
 * literal `/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron`, so
 * everything before it IS the root — spaces inside the root (Dropbox
 * (Personal)) or inside `Maka Dev.app` are matched together and never split.
 */
export function worktreeRootFromBundle(commandLine) {
  const marker = '/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron';
  const at = commandLine.indexOf(marker);
  return at > 0 ? commandLine.slice(0, at) : undefined;
}

function readDevEnvUserDataDir(worktree, options) {
  const envFile = options.envFileFor ?? ((root) => join(root, 'apps', 'desktop', '.maka-dev', 'dev-env.json'));
  const read = options.readFile ?? readFileSync;
  let published;
  try {
    published = JSON.parse(read(envFile(worktree), 'utf8'));
  } catch {
    return undefined;
  }
  if (published.schemaVersion !== DEV_ENV_SCHEMA_VERSION) return undefined;
  return published.userDataDir ?? DEV_USER_DATA_DIR;
}

function explicitSwitchLiteral(commandLine, wanted) {
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Uniform boundary: whitespace or line end (see holdsProfile JSDoc).
  const boundary = '(?=\\s|$)';
  return new RegExp(`(?:^|\\s)--user-data-dir=${escaped}${boundary}`).test(commandLine);
}

function hasUserDataDirSwitch(commandLine) {
  return (
    commandLine.includes(' --user-data-dir=') ||
    commandLine.startsWith('--user-data-dir=')
  );
}

/**
 * True when the command line belongs to OUR worktree: either launch shape
 * carries our workRoot followed by `/apps/desktop` or `/node_modules/` in the
 * line. ownRoot is a known literal (spaces fine), so a sibling root
 * (wt-3 vs wt-35) can never match.
 */
export function isOwnDevApp(commandLine, ownRoot) {
  return (
    commandLine.includes(`${ownRoot}/apps/desktop`) ||
    commandLine.includes(`${ownRoot}/node_modules/`)
  );
}
