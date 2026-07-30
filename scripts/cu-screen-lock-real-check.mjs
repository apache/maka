#!/usr/bin/env node
// Real-machine check for the screen-lock guard, and the preflight every other
// real-machine script should run first.
//
// With the screen locked the window server stops exposing window contents, so
// cua-driver answers a window walk with the app's menu bar and nothing else —
// and it does not say so. That tree is indistinguishable from a real reading of
// an app that has no controls, and it cost most of an afternoon: it was read
// first as an accessibility subsystem failure, then as menu expansion crowding
// the window out of a truncated walk, and a pull request was opened for the
// second one before anybody checked the lock.
//
// One syscall rules it out. This runs it, and then proves the guard turns that
// silent degradation into a refusal.
//
//   node scripts/cu-screen-lock-real-check.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createCuaDriverBackend } = await import(
  join(ROOT, 'packages', 'computer-use', 'dist', 'index.js')
);
const BINARY = join(ROOT, 'apps', 'desktop', 'resources', 'bin', 'cua-driver');
const APP = process.argv[2] ?? '计算器';

/** `CGSSessionScreenIsLocked` is the one signal that changes every tree at once. */
const LOCK_PROBE = `
import CoreGraphics
import Foundation
let d = CGSessionCopyCurrentDictionary() as? [String: Any]
print((d?["CGSSessionScreenIsLocked"] as? Int) == 1 ? "locked" : "unlocked")
`;
const probePath = join(mkdtempSync(join(tmpdir(), 'cu-lock-')), 'probe.swift');
writeFileSync(probePath, LOCK_PROBE, 'utf8');
const screenLocked = () =>
  execFileSync('swift', [probePath], { encoding: 'utf8', timeout: 90_000 }).trim() === 'locked';

let failures = 0;
const check = (label, pass, detail) => {
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};

const locked = screenLocked();
console.log(`screen is ${locked ? 'LOCKED' : 'unlocked'}\n`);

const observe = async (opts) => {
  const backend = createCuaDriverBackend({
    binaryPath: BINARY,
    physicalInputRecentlyActive: () => false,
    ...opts,
  });
  try {
    const o = await backend.observeApp(
      { app: APP, includeScreenshot: false },
      new AbortController().signal,
      { sessionId: 'lock-check', turnId: 't', toolCallId: 'c1' },
    );
    return { ok: true, elements: o.elements };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  } finally {
    backend.dispose?.();
  }
};

const guarded = await observe({ screenLocked });
const bare = await observe({});

if (locked) {
  check(
    'the guard refuses an observation while the screen is locked',
    guarded.ok === false,
    guarded.message?.slice(0, 80),
  );
  check(
    'and the refusal names the lock',
    /lock/i.test(guarded.message ?? ''),
    guarded.message?.slice(0, 80),
  );
  // The reason the guard has to exist: without it the same call succeeds, and
  // what it returns looks like an app that simply has no controls.
  const roles = bare.ok ? [...new Set(bare.elements.map((e) => e.role))] : [];
  check(
    'without the guard the same call succeeds and returns a menu-only tree',
    bare.ok === true && roles.length > 0 && roles.every((r) => /Menu/i.test(r)),
    bare.ok
      ? `${bare.elements.length} elements, roles=${roles.join(',')}`
      : bare.message?.slice(0, 60),
  );
} else {
  check('the guard does not refuse while the screen is unlocked', guarded.ok === true);
  check(
    'an unlocked observation reaches past the menu bar',
    guarded.ok === true && guarded.elements.some((e) => !/Menu/i.test(e.role)),
    guarded.ok ? `${guarded.elements.length} elements` : '',
  );
}

console.log(failures === 0 ? '\nSCREEN LOCK GUARD OK' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
