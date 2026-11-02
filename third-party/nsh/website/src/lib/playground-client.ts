// The playground in the browser: a CodeMirror editor whose code the player
// iframe (`play/index.html?playground`) compiles and runs on every pause in
// typing. The code lives in the URL when shared (`#code=`, deflated and
// base64url-encoded) and in localStorage between visits.

import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { onThemeChange, siteTheme } from './demo-client';
import { inlineGalleryUi } from './inline-gallery-ui';
import { mountSelect } from './ui/select';

// Each demo's source, loaded when picked.
const DEMOS = import.meta.glob('/demos/*.tsx', { query: '?raw', import: 'default' }) as Record<
  string,
  () => Promise<string>
>;

// The player compiles one file. Include the internal shared example UI
// behind each demo's palette adapter, with module scopes kept separate.
import paletteSource from '/demos/palette.ts?raw';
const gallerySources = import.meta.glob([
  '../../../examples/nsh-gallery-ui/**/*.{ts,tsx,json}',
  '!../../../examples/nsh-gallery-ui/tests/**',
], {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;
const sharedUiSources = {
  ...Object.fromEntries(Object.entries(gallerySources).map(([path, text]) => [path.replace('../../../', ''), text])),
  'website/demos/palette.ts': paletteSource,
};

function withPalette(source: string): string {
  return inlineGalleryUi(source, sharedUiSources);
}

const STORAGE_KEY = 'nsh-playground-code';
const RUN_DELAY = 450;

type Copy = Record<string, string>;

async function demoSource(name: string): Promise<string | null> {
  const load = DEMOS[`/demos/${name}.tsx`];
  return load ? load() : null;
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

async function encodeCode(code: string): Promise<string> {
  return toBase64Url(await pipe(new TextEncoder().encode(code), new CompressionStream('deflate-raw')));
}

async function decodeCode(text: string): Promise<string> {
  return new TextDecoder().decode(await pipe(fromBase64Url(text), new DecompressionStream('deflate-raw')));
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export async function mountPlayground(root: HTMLElement) {
  const t: Copy = JSON.parse(root.dataset.copy ?? '{}');
  const picker = root.querySelector<HTMLElement>('[data-example]')!;
  const select = mountSelect(picker);
  picker.addEventListener('change', () => pick(select.value));
  const status = root.querySelector<HTMLElement>('[data-status]')!;
  const log = root.querySelector<HTMLElement>('[data-log]')!;
  const frame = root.querySelector<HTMLIFrameElement>('[data-frame]');
  // The app's appearance follows the page's theme until changed here.
  // A toggle (`aria-pressed`): pressed is dark.
  const darkToggle = root.querySelector<HTMLButtonElement>('[data-dark]')!;
  const dark = {
    get checked() {
      return darkToggle.getAttribute('aria-pressed') === 'true';
    },
    set checked(on: boolean) {
      darkToggle.setAttribute('aria-pressed', String(on));
    },
  };
  dark.checked = siteTheme() === 'dark';
  onThemeChange((theme) => {
    dark.checked = theme === 'dark';
    frame?.contentWindow?.postMessage({ theme }, '*');
  });

  const setStatus = (text: string, kind?: 'ok' | 'error') => {
    // Errors start with a blank line before their code frame.
    status.textContent = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    if (kind) status.dataset.kind = kind;
    else delete status.dataset.kind;
  };

  const clearLog = () => {
    log.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'playground__empty';
    p.textContent = t.empty;
    log.append(p);
  };
  const addLog = (level: string, text: string) => {
    log.querySelector('.playground__empty')?.remove();
    const pre = document.createElement('pre');
    pre.dataset.level = level;
    pre.textContent = text;
    log.append(pre);
    log.scrollTop = log.scrollHeight;
  };

  // The initial code: a shared link, then a demo named in the hash, then
  // the last session, then the first example.
  const hash = new URLSearchParams(location.hash.slice(1));
  let initial: string | null = null;
  if (hash.get('code')) {
    try {
      initial = await decodeCode(hash.get('code')!);
    } catch {
      initial = null;
    }
  }
  const named = hash.get('demo');
  if (!initial && named && (await demoSource(named)) !== null) {
    select.set(named);
    initial = await demoSource(named);
  }
  if (!initial) initial = storage()?.getItem(STORAGE_KEY) ?? null;
  if (!initial) initial = (await demoSource(select.value)) ?? '';

  let ready = false;
  let pending = false;
  let timer = 0;

  const run = () => {
    clearTimeout(timer);
    if (!frame) return;
    if (!ready) {
      pending = true;
      return;
    }
    clearLog();
    frame.contentWindow?.postMessage({ type: 'run', source: withPalette(view.state.doc.toString()) }, '*');
  };

  const view = new EditorView({
    doc: initial,
    parent: root.querySelector<HTMLElement>('[data-editor]')!,
    extensions: [
      basicSetup,
      javascript({ jsx: true, typescript: true }),
      syntaxHighlighting(classHighlighter),
      keymap.of([{ key: 'Mod-Enter', run: () => (run(), true) }]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        storage()?.setItem(STORAGE_KEY, update.state.doc.toString());
        clearTimeout(timer);
        timer = window.setTimeout(run, RUN_DELAY);
      }),
    ],
  });

  const replace = (code: string) => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
    run();
  };

  async function pick(value: string) {
    const code = await demoSource(value);
    if (code !== null) replace(code);
    history.replaceState(null, '', `#demo=${encodeURIComponent(value)}`);
  }
  root.querySelector('[data-reset]')?.addEventListener('click', async () => {
    const code = await demoSource(select.value);
    if (code !== null) replace(code);
  });
  root.querySelector('[data-run]')?.addEventListener('click', run);
  root.querySelector('[data-clear]')?.addEventListener('click', clearLog);
  root.querySelector('[data-share]')?.addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}#code=${await encodeCode(view.state.doc.toString())}`;
    history.replaceState(null, '', link);
    try {
      await navigator.clipboard.writeText(link);
      setStatus(t.copied, 'ok');
    } catch {
      setStatus(link);
    }
  });
  darkToggle.addEventListener('click', () => {
    dark.checked = !dark.checked;
    frame?.contentWindow?.postMessage({ theme: dark.checked ? 'dark' : 'light' }, '*');
  });

  if (!frame) return;
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.data?.source !== 'nsh-player') return;
    const data = e.data;
    if (data.type === 'ready') {
      ready = true;
      setStatus('');
      frame.contentWindow?.postMessage({ theme: dark.checked ? 'dark' : 'light' }, '*');
      if (pending || initial) run();
    } else if (data.type === 'compiled') {
      if (data.error) {
        setStatus(data.error, 'error');
        addLog('error', data.error);
      } else {
        setStatus(t.compiled, 'ok');
      }
    } else if (data.type === 'runtime-error') {
      setStatus(String(data.message), 'error');
      addLog('error', data.message);
    } else if (data.type === 'log') {
      addLog(data.level, data.message);
    }
  });
  setStatus(t.loading);
  frame.src = root.dataset.player!.replace(/theme=(dark|light)/, `theme=${siteTheme()}`);
}
