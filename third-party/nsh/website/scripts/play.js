// Prepares what `bun run dev` / `bun run build` need: the dependencies and
// the WebAssembly player with the demos (`cargo xtask web`, incremental).
// Without a Rust toolchain the site still works: demos show their source.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const website = fileURLToPath(new URL('..', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));

// A dev server of this checkout still running (in another terminal, or as a
// background `astro dev` daemon) holds the port and serves stale files:
// kill it before starting a new one.
if (process.argv.includes('--kill-dev')) {
  const modules = `${website}node_modules/`;
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  for (const line of (ps.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    // `node_modules/.bin/astro dev` or `node_modules/astro/bin/astro.mjs dev`.
    if (!match || !match[2].includes(modules) || !/astro(\.mjs)?\s+dev(\s|$)/.test(match[2])) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
      console.log(`[play] killed the old dev server (pid ${pid})`);
    } catch {}
  }
}

if (!existsSync(`${website}node_modules`)) {
  spawnSync('bun', ['install'], { cwd: website, stdio: 'inherit' });
}

const result = spawnSync('cargo', ['xtask', 'web'], { cwd: root, stdio: 'inherit' });
if (result.error || result.status !== 0) {
  // Deployments set it: a site without its live demos must not go out.
  if (process.env.NSH_REQUIRE_PLAY) {
    console.error('[play] building the WebAssembly player failed');
    process.exit(1);
  }
  console.warn(
    '\n[play] could not build the WebAssembly player (needs Rust with the wasm32-unknown-unknown target);\n' +
      '[play] pages show demo sources without the live preview.\n',
  );
}
