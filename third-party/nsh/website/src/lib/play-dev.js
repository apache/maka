// `astro dev` only: serves the player from its sources, so edits show on
// reload without `cargo xtask web` again. A demo (`play/demos/<name>.nshc`) is
// compiled from `demos/<name>.tsx` on request by the nsh CLI the player build
// made; `nsh.js` and `index.html` come from `crates/nsh-platform-web/web`.
// `nsh.wasm` is the one built by `bun run dev` (rebuilt on the next start:
// the runtime of published apps, `nsh.wasm` next to the build's output),
// read from the target directory (the built site's player loads the
// gallery's copy, `play/gallery/nsh.<digest>.wasm`).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const website = fileURLToPath(new URL('../..', import.meta.url));
const root = join(website, '..');
const web = join(root, 'crates/nsh-platform-web/web');
const galleryUi = join(root, 'examples/nsh-gallery-ui');
const nsh = join(root, 'target/release/nsh');

export function playDev(base) {
  const prefix = `${base.replace(/\/$/, '')}/play/`;
  return {
    name: 'nsh-play-dev',
    apply: 'serve',
    configureServer(server) {
      server.watcher.add(join(website, 'demos'));
      server.watcher.add(galleryUi);
      // Demo bytecode is compiled on request, outside Vite's module graph.
      // Reload its frames when the shared component layer or theme changes.
      server.watcher.on('change', (path) => {
        if (path.startsWith(`${galleryUi}/`)) server.ws.send({ type: 'full-reload' });
      });
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (!path.startsWith(prefix)) return next();
        const rest = path.slice(prefix.length) || 'index.html';
        const send = (type, body) => {
          res.setHeader('Content-Type', type);
          res.setHeader('Cache-Control', 'no-store');
          res.end(body);
        };
        if (rest === 'index.html' || rest === 'nsh.js') {
          const file = join(web, rest);
          if (!existsSync(file)) return next();
          return send(rest.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', readFileSync(file));
        }
        if (rest === 'nsh.wasm') {
          const file = join(root, 'target/wasm32-unknown-unknown/web/nsh.wasm');
          if (!existsSync(file)) return next();
          return send('application/wasm', readFileSync(file));
        }
        const demo = /^demos\/([\w-]+)\.nshc$/.exec(rest);
        if (!demo || !existsSync(nsh)) return next();
        const entry = join(website, 'demos', `${demo[1]}.tsx`);
        if (!existsSync(entry)) return next();
        const out = mkdtempSync(join(tmpdir(), 'nsh-demo-'));
        try {
          const built = spawnSync(nsh, ['build', '--release', '-o', out, entry], { encoding: 'utf8' });
          if (built.status !== 0) {
            res.statusCode = 500;
            return send('text/plain; charset=utf-8', built.stderr || built.stdout || 'nsh build failed');
          }
          return send('application/octet-stream', readFileSync(join(out, 'bundle.nshc')));
        } finally {
          rmSync(out, { recursive: true, force: true });
        }
      });
    },
  };
}
