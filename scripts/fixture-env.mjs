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

// The environment a Maka fixture window launches into.
//
// Extracted from apps/desktop/e2e/fixtures.ts, which worked it out first and
// remains a consumer. Two things now launch fixture windows — the Playwright
// E2E suite and the migration contract harness in scripts/ — and both need the
// same isolation, so the rule lives in one place instead of being restated
// (and, as the harness proved, restated wrongly).

/**
 * Keys deleted from the inherited environment before launch.
 *
 * Deny-list rather than allow-list: Electron relies on undocumented platform
 * env (macOS CoreFoundation / X11 / sandbox session) that an allow-list would
 * silently drop and break the launch.
 *
 * Inheriting `process.env` wholesale leaks:
 *   - provider keys, which auto-bootstrap a connection and change the fixture;
 *   - `VITE_DEV_SERVER_URL`, which loads the dev server instead of the built
 *     bundle — so the run silently measures something other than the build
 *     under test;
 *   - any `MAKA_E2E_*` the operator's shell happens to export, which silently
 *     changes locale, platform, theme, or window visibility.
 * @param {string} key
 */
function isDeniedEnvKey(key) {
  return (
    key === 'VITE_DEV_SERVER_URL' ||
    key.startsWith('MAKA_E2E') ||
    /_API_KEY$/.test(key) ||
    /_API_TOKEN$/.test(key) ||
    /_API_SECRET$/.test(key)
  );
}

/**
 * @param {string} userDataDir
 * @param {string} homeDir
 * @param {{
 *   scenario?: string,
 *   locale?: 'zh' | 'en',
 *   platform?: 'darwin' | 'win32' | 'linux',
 *   theme?: 'light' | 'dark',
 *   scrollMotion?: 'auto' | 'smooth',
 *   timezone?: string,
 *   showWindow?: boolean,
 * }} [options]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildFixtureEnv(userDataDir, homeDir, options = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (isDeniedEnvKey(key)) delete env[key];
  }
  env.MAKA_E2E = '1';
  // The login-shell PATH probe must not make command resolution depend on the
  // developer or CI account. This builder owns the launched environment, so it
  // owns the deterministic skip flag (unlike relying on TERM, which is unset
  // under xvfb).
  env.MAKA_SKIP_SHELL_ENV = '1';
  env.MAKA_E2E_USER_DATA_DIR = userDataDir;
  // Sandbox the home directory. User-scope skill discovery reads
  // `~/.maka/skills` and `~/.agents/skills` via `os.homedir()`, and the Skills
  // panel can now DELETE from those (#1517) — so without this a run would
  // enumerate, and could remove, the developer's own installed skills.
  // Overriding HOME sandboxes every consumer of the home dir at once, rather
  // than plumbing an override through each skills API and hoping none is
  // missed; `os.homedir()` returns $HOME on POSIX and %USERPROFILE% on
  // Windows, so both are set. userData is pinned separately above, so this
  // does not move the app's data dir.
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  if (options.scenario) env.MAKA_E2E_FIXTURE = options.scenario;
  if (options.locale) env.MAKA_E2E_FIXTURE_LOCALE = options.locale;
  if (options.platform) env.MAKA_E2E_FIXTURE_PLATFORM = options.platform;
  if (options.theme) env.MAKA_E2E_FIXTURE_THEME = options.theme;
  // Absolute times render through the host zone, so a capture taken in
  // Asia/Shanghai reads as a diff when the same build is captured in UTC. The
  // fixture already owns an IANA override for exactly this; callers that
  // compare captures pin it, and the E2E suite does not, because its
  // assertions never read a wall-clock string.
  if (options.timezone) env.MAKA_E2E_FIXTURE_TIMEZONE = options.timezone;
  // Windows launch hidden so a run never steals the developer's focus; a
  // caller that needs the compositor (hit testing, real input) or a throttled
  // headless display (see isCiLinuxDisplay) asks for a visible window
  // explicitly. The decision stays with the caller: this builder is a pure
  // function of its arguments, so a test asserting "hidden run stays hidden"
  // means the same thing on a laptop and on a CI runner.
  // Captures collapse scroll motion so their state never depends on when a
  // scroll settles. A fixture whose subject IS the scrolling asks for the
  // production behavior back — see `scroll-motion-policy`. Per launch rather
  // than per scenario: it costs several seconds of settling per window, and
  // only the case that needs it should pay.
  if (options.scrollMotion) env.MAKA_E2E_FIXTURE_SCROLL_MOTION = options.scrollMotion;
  if (options.showWindow) env.MAKA_E2E_SHOW_WINDOW = '1';
  return env;
}

/**
 * Whether the current host is a Linux CI display, where a fixture window must
 * be shown even for captures: under xvfb a hidden window's compositor is
 * throttled to ~1fps — content-visibility turns never inflate and frame-paced
 * protocols crawl. Only that isolated virtual display gets a visible window;
 * nobody is watching it.
 *
 * This is the one ambient read the launch environment needs, kept out of
 * `buildFixtureEnv` so the builder stays a pure function. Callers compose it:
 * `showWindow: wantVisible || isCiLinuxDisplay()`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 */
export function isCiLinuxDisplay(env = process.env, platform = process.platform) {
  return Boolean(env.CI) && platform === 'linux';
}
