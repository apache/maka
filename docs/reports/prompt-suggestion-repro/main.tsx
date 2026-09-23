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

import React, { useState, useEffect, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatComposerInput } from '@astryxdesign/core';
import '@astryxdesign/core/astryx.css';

window.errors = [];
window.commits = 0;
window.mutations = 0;
window.addEventListener('error', (e) =>
  window.errors.push({ message: e.message, stack: e.error?.stack }),
);
window.addEventListener('unhandledrejection', (e) =>
  window.errors.push({ message: String(e.reason), stack: e.reason?.stack }),
);
const realError = console.error;
console.error = (...args) => {
  window.errors.push({ console: args.map(String).join(' ') });
  realError(...args);
};
class Boundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error: String(error) };
  }
  componentDidCatch(error, info) {
    window.errors.push({
      boundary: String(error),
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }
  render() {
    return this.state.error ? <pre id="crash">{this.state.error}</pre> : this.props.children;
  }
}
function App() {
  const [cfg, setCfg] = useState({
    width: 640,
    fontSize: 14,
    lineHeight: 20,
    zoom: 1,
    rows: 10,
    font: 'Arial',
    text: 'Implement ',
    suffix: 'the next step.',
  });
  const [text, setText] = useState(cfg.text);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    window.configure = (v) => {
      window.errors = [];
      window.commits = 0;
      window.mutations = 0;
      setCfg(v);
      setText(v.text);
      setEpoch((e) => e + 1);
    };
  }, []);
  return (
    <>
      <h1 style={{ font: '18px Arial' }}>Maka v0.1.11 patched Astryx 0.4.0</h1>
      <p>Real Chromium layout, no geometry mocks.</p>
      <div
        id="case"
        style={{ width: cfg.width, zoom: cfg.zoom, border: '1px solid #ccc', padding: 12 }}
      >
        <style>{`#case [contenteditable]{font-family:${cfg.font}!important;font-size:${cfg.fontSize}px!important;line-height:${cfg.lineHeight}px!important}`}</style>
        <Boundary key={epoch}>
          <Profiler id="composer" onRender={() => window.commits++}>
            <ChatComposerInput
              value={text}
              onChange={setText}
              hasHistory={false}
              maxRows={cfg.rows}
              inlineCompletion={cfg.suffix}
              inlineCompletionLabel="Tab to accept"
              label="Prompt"
            />
          </Profiler>
        </Boundary>
      </div>
      <pre id="config">{JSON.stringify(cfg, null, 2)}</pre>
    </>
  );
}
createRoot(document.getElementById('root')).render(<App />);
new MutationObserver(() => window.mutations++).observe(document.getElementById('root'), {
  subtree: true,
  childList: true,
  characterData: true,
});
window.focusEnd = () => {
  const e = document.querySelector('[contenteditable=true]');
  if (!e) return;
  e.focus();
  const r = document.createRange();
  r.selectNodeContents(e);
  r.collapse(false);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
};
window.metrics = () => {
  const e = document.querySelector('[contenteditable=true]');
  const o = document.querySelector('[data-astryx-inline-completion]');
  return {
    errors: window.errors,
    commits: window.commits,
    mutations: window.mutations,
    field: e?.getBoundingClientRect().toJSON(),
    offer: o?.getBoundingClientRect().toJSON(),
    scrollHeight: e?.scrollHeight,
    clientHeight: e?.clientHeight,
    scrollTop: e?.scrollTop,
    offerText: o?.textContent,
    ua: navigator.userAgent,
  };
};
