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

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkWebApiHealth,
  resolveWebProjectPath,
  webPreselectedProject,
  type WebApiStatus,
  type WebPathResolution,
} from './web-project.js';

/**
 * Browser-only entry (Chrome/Brave via `maka-web`, or any plain visit to the
 * dev URL). Deliberately depends on nothing Electron: no `window.maka`, no
 * desktop service factories — those throw on a missing preload bridge and
 * leave the index.html skeleton on screen. This page owns the flow you asked
 * for: type/paste a server-local directory, validate it against the local
 * `maka-web` API, and continue in the GUI/CLI from there.
 */
export function WebApp() {
  const [api, setApi] = useState<WebApiStatus>({ ok: false, state: 'checking' });
  const [input, setInput] = useState(() => webPreselectedProject() ?? '');
  const [result, setResult] = useState<WebPathResolution | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void checkWebApiHealth().then((status) => {
      if (mounted.current) setApi(status);
    });
    return () => {
      mounted.current = false;
    };
  }, []);

  const open = useCallback(async () => {
    setBusy(true);
    setResult(null);
    try {
      const resolved = await resolveWebProjectPath(input);
      if (mounted.current) setResult(resolved);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [input]);

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Maka Web</h1>
        <p style={styles.sub}>
          Browser mode (Chrome / Brave). Type or paste a{' '}
          <strong>server-local directory</strong> below — it is validated on
          your machine, never uploaded anywhere.
        </p>
        <ApiStatus api={api} onRetry={() => {
          setApi({ ok: false, state: 'checking' });
          void checkWebApiHealth().then((status) => {
            if (mounted.current) setApi(status);
          });
        }} />
        <form
          style={styles.row}
          onSubmit={(event) => {
            event.preventDefault();
            void open();
          }}
        >
          <input
            style={styles.input}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="/home/you/my-project  (or ~/my-project)"
            spellCheck={false}
            autoFocus
            aria-label="Server-local directory path"
          />
          <button style={styles.button} type="submit" disabled={busy || !input.trim()}>
            {busy ? 'Checking…' : 'Open directory'}
          </button>
        </form>
        <Result result={result} />
        <p style={styles.hint}>
          This is the standalone picker. For the full Maka app, sign in at{' '}
          <code>/login</code> with your passphrase and authenticator while{' '}
          <code>maka-gui</code> is running. The bridge token never appears in
          the URL. The CLI works too: <code>npm run maka-cli</code>.
        </p>
      </div>
    </div>
  );
}

function ApiStatus({ api, onRetry }: { api: WebApiStatus; onRetry(): void }) {
  if (api.state === 'checking') {
    return <p style={styles.status}>Connecting to the local directory API…</p>;
  }
  if (api.ok) {
    return <p style={{ ...styles.status, ...styles.ok }}>Local API connected{api.via ? ` (${api.via})` : ''}.</p>;
  }
  return (
    <p style={{ ...styles.status, ...styles.warn }}>
      Local API unreachable — start it with <code>npm run maka-web</code>, then{' '}
      <button style={styles.link} type="button" onClick={onRetry}>retry</button>.
    </p>
  );
}

function Result({ result }: { result: WebPathResolution | null }) {
  if (!result) return null;
  if (result.ok) {
    return (
      <div style={{ ...styles.result, ...styles.okBox }}>
        <div style={styles.path}>{result.path}</div>
        <div style={styles.next}>
          Directory found on this machine. To work in it:
          <br />
          GUI: Settings → Workspace → <strong>Add by path</strong>, paste the path above.
          <br />
          CLI: <code>cd “{result.path}” && npm run maka-cli --</code>
          <br />
          <button
            style={styles.link}
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(result.path).catch(() => undefined);
            }}
          >
            copy path
          </button>
        </div>
      </div>
    );
  }
  const hints: Record<string, string> = {
    'invalid-path': 'Type a non-empty local path first.',
    'not-found': 'No such directory on this machine. Check the spelling.',
    'not-a-directory': 'That path exists but is a file, not a directory.',
    unreachable: 'The maka-web API is not running — start it with npm run maka-web and retry.',
  };
  return (
    <div style={{ ...styles.result, ...styles.errBox }}>
      {hints[result.reason] ?? 'Could not open that directory.'}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f3f3f5',
    padding: 24,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  card: {
    width: 'min(640px, 100%)',
    background: '#fff',
    borderRadius: 12,
    padding: 28,
    boxShadow: '0 8px 30px rgba(0,0,0,0.08)',
  },
  title: { margin: '0 0 8px', fontSize: 24 },
  sub: { margin: '0 0 12px', color: '#444', lineHeight: 1.5 },
  status: { margin: '0 0 12px', fontSize: 14, color: '#666' },
  ok: { color: '#1a7f37' },
  warn: { color: '#9a6700' },
  row: { display: 'flex', gap: 8 },
  input: {
    flex: 1,
    fontSize: 14,
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #ccc',
  },
  button: {
    fontSize: 14,
    padding: '10px 16px',
    borderRadius: 8,
    border: 'none',
    background: '#4c8dff',
    color: '#fff',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  link: {
    background: 'none',
    border: 'none',
    padding: 0,
    color: '#4c8dff',
    cursor: 'pointer',
    fontSize: 'inherit',
    textDecoration: 'underline',
  },
  hint: { margin: '16px 0 0', fontSize: 13, color: '#666', lineHeight: 1.6 },
  result: { marginTop: 12, fontSize: 14, borderRadius: 8, padding: '10px 12px', lineHeight: 1.6 },
  okBox: { background: '#f0faf2', border: '1px solid #b7e2c0' },
  errBox: { background: '#fdf1f1', border: '1px solid #f0bcbc' },
  path: { fontFamily: 'monospace', wordBreak: 'break-all' },
  next: { marginTop: 8, fontSize: 13, color: '#444' },
};
