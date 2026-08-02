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

// Heavy pipeline — parsed on first `<Markdown>` mount, not at app boot.
const MarkdownBody = lazy(() => import('./markdown-body.js').then((m) => ({ default: m.MarkdownBody })));

export function Markdown(props: {
  text: string;
  streaming?: boolean;
  /** Block rhythm. Transcript turns pass `compact`; documents leave it. */
  density?: 'default' | 'compact';
}) {
  const safeText = redactSecrets(props.text);
  return (
    <Suspense
      // Plain-text fallback so message content is visible immediately while
      // the markdown pipeline chunk finishes loading (a few tens of ms on a
      // local file:// load; once cached, subsequent mounts are synchronous).
      fallback={
        <div className="maka-markdown maka-markdown-pending" style={{ whiteSpace: 'pre-wrap' }}>
          {safeText}
        </div>
      }
    >
      <MarkdownBody text={safeText} streaming={props.streaming} density={props.density} />
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
