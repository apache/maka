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

/**
 * Markdown rendering layer — eager entry.
 *
 * This module is intentionally lightweight: it only owns the
 * `MakaUriContext` (which the renderer installs once at the App root)
 * and a thin `Markdown` wrapper that `React.lazy`-loads the heavy
 * Astryx Markdown renderer from `./markdown-body.js` on first use.
 *
 * Why the split: the markdown pipeline is by far the heaviest thing the
 * chat shell transitively imports, yet it's only needed once a message
 * actually renders. On a fresh launch (no active session) nothing ever
 * mounts `<Markdown>`, so forcing the browser to parse hundreds of KB
 * the Markdown component before first paint was pure overhead. With the
 * lazy split, that code is parsed on demand the first time a message appears,
 * and cached for every subsequent render.
 *
 * Secret redaction happens eagerly in this wrapper so the Suspense fallback
 * is safe. The remaining trust-boundary contract (URI allowlist, safe-scheme
 * external gate, broken-link inline errors) lives in `markdown-body.tsx`;
 * see that file for the routing rationale.
 *
 * PR-UI-LIB-EXTRACT-6 (WAWQAQ msg `510fef52`, round 7/10): pulled out
 * of `components.tsx`. `MakaUriContext` was already a public export
 * (the renderer's main.tsx provides the dispatcher), so `index.ts`
 * re-exports the new module to keep the `@maka/ui` surface identical.
 * `Markdown` and its rendering helpers remain package-private — only consumed
 * within `@maka/ui`.
 */

import { createContext, lazy, Suspense } from 'react';
import { redactSecrets } from './redact.js';
import { isProgressiveStreamingEnabled } from './streaming-presentation.js';

// Heavy pipeline — parsed on first `<Markdown>` mount, not at app boot.
const MarkdownBody = lazy(() => import('./markdown-body.js').then((m) => ({ default: m.MarkdownBody })));

export function Markdown(props: {
  text: string;
  streaming?: boolean;
  settledText?: string;
  /** Block rhythm. Transcript turns pass `compact`; documents leave it. */
  density?: 'default' | 'compact';
}) {
  const safeText = redactSecrets(props.text);
  const safeSettledText = props.settledText === undefined
    ? undefined
    : redactSecrets(props.settledText);
  const streaming = isProgressiveStreamingEnabled(props.streaming);
  return (
    <Suspense
      // Settled history can show the safe source while the renderer loads.
      // A live stream must stay behind Astryx's display cursor; showing the
      // full source here would flash the unreached tail before Astryx mounts.
      fallback={streaming ? null : (
        <div className="maka-markdown maka-markdown-pending" style={{ whiteSpace: 'pre-wrap' }}>
          {safeText}
        </div>
      )}
    >
      <MarkdownBody
        text={safeText}
        streaming={streaming}
        settledText={safeSettledText}
        density={props.density}
      />
    </Suspense>
  );
}

/**
 * PR-UI-RENDER-2 — context for the internal-link dispatcher.
 *
 * The desktop renderer installs the dispatcher once at the App root
 * (see `apps/desktop/src/renderer/main.tsx`). The dispatcher takes a
 * typed `MakaUriDest` and routes to whatever real navigation surface
 * the app uses (e.g. `setNavSelection({section: 'settings', tab: ...})`
 * for `kind: 'settings'`, or `composer.prefill(text)` for `kind:
 * 'compose'`). The Markdown link renderer never invokes navigation
 * directly — that's the dispatcher's job, and the dispatcher is the
 * single chokepoint to add observability / consent prompts later.
 *
 * Defined here (eager) rather than in `markdown-body.tsx` (lazy) so the
 * context identity is stable across the eager/lazy boundary — the
 * renderer installs the provider against THIS module's export, and the
 * lazy body reads it via `useContext(MakaUriContext)` imported back
 * from here.
 */
export const MakaUriContext = createContext<((dest: import('./maka-uri.js').MakaUriDest) => void) | undefined>(undefined);
