/**
 * Heavy markdown rendering pipeline — split out of `markdown.tsx` so the
 * initial renderer chunk doesn't have to parse the streaming Markdown
 * pipeline before React can mount the chat shell.
 *
 * This module is loaded on demand via `React.lazy` from `markdown.tsx`
 * the first time a message actually needs to be rendered. On a fresh
 * launch with no active session, none of this code is parsed at all,
 * which keeps "open window → see the app shell" snappy.
 *
 * Everything security-sensitive (the `maka://` URI allowlist, the safe-
 * scheme external-link gate, the broken-link inline errors) lives here
 * alongside the `Markdown` body so renderer choice cannot bypass the
 * routing policy. See `markdown.tsx` for the trust-boundary rationale.
 */

import { useContext, type ReactNode } from 'react';
import * as React from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown, type ExtraProps } from 'streamdown';
import rehypeHighlight from 'rehype-highlight';
import remarkBreaks from 'remark-breaks';
import { Check, Copy } from './icons.js';

import {
  isMakaUriCandidate,
  isSafeExternalScheme,
  parseMakaUri,
} from './maka-uri.js';
import { useClipboardCopyFeedback } from './clipboard-feedback.js';
import { MakaUriContext } from './markdown.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

const MARKDOWN_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkBreaks];
type StreamdownRehypePlugin = (typeof defaultRehypePlugins)[string];

function allowMakaHrefProtocol(plugin: StreamdownRehypePlugin): StreamdownRehypePlugin {
  if (!Array.isArray(plugin)) return plugin;
  const [transform, options] = plugin;
  if (!options || typeof options !== 'object' || Array.isArray(options)) return plugin;
  const schema = options as {
    protocols?: Record<string, string[] | null | undefined>;
  };
  return [transform, {
    ...schema,
    protocols: {
      ...schema.protocols,
      href: [...(schema.protocols?.href ?? []), 'maka'],
    },
  }] as StreamdownRehypePlugin;
}

const MARKDOWN_REHYPE_PLUGINS = [
  ...Object.entries(defaultRehypePlugins)
    .filter(([name]) => name !== 'raw')
    .map(([name, plugin]) => name === 'sanitize'
      ? allowMakaHrefProtocol(plugin)
      : plugin),
  [rehypeHighlight, { detect: true, ignoreMissing: true }] as [
    typeof rehypeHighlight,
    { detect: boolean; ignoreMissing: boolean },
  ],
];

/**
 * Streamdown's default components merge Tailwind utility classes into every
 * markdown element (h1 "text-3xl", h3 "text-xl", th/td "px-4 py-2 text-sm",
 * thead "bg-muted/80", ul "list-disc", ...) via an internal `r(utility, t)`
 * call. Those utilities sit in the `utilities` cascade layer and override
 * prose.css's `components`-layer markdown rules, so the .maka-prose layer
 * never reaches the rendered DOM (#739: the heading ladder and table padding
 * declared in prose.css were silently overwritten).
 *
 * A `components` override REPLACES the default component, so Streamdown's
 * internal utility merge never runs. The `className` react-markdown forwards
 * here is the HAST node's semantic class (remark-gfm's `contains-task-list`/
 * `task-list-item`, rehype-highlight's `language-*`) — NOT Streamdown's
 * utilities. So render the element with its HAST className preserved and only
 * `node` (the AST node, which would otherwise leak to the DOM as
 * `node="[object Object]"`) dropped. prose.css then styles the bare element.
 *
 * Only apply this to elements whose ONLY Streamdown default is the utility
 * merge — p, ol, and section carry functional logic (p unwraps a lone image,
 * ol/section clean streaming footnotes) and must stay on Streamdown's default
 * renderer; h5/h6 have no prose.css rule and would lose all heading styling
 * if stripped. See the components prop below for the exact override set.
 */
function bareElement<K extends keyof React.JSX.IntrinsicElements>(Tag: K) {
  return ({ node: _node, children, ...rest }: React.JSX.IntrinsicElements[K] & ExtraProps) =>
    React.createElement(Tag, rest, children);
}

export function MarkdownBody(props: { text: string; streaming?: boolean }) {
  return (
    <Streamdown
      className="maka-markdown-root"
      mode={props.streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={props.streaming}
      controls={false}
      lineNumbers={false}
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      urlTransform={markdownUrlTransform}
      components={{
        // PR-UI-RENDER-2: route `maka://` links through the internal
        // URI parser so the assistant can drop in-app navigation
        // affordances ("用账号登录 Settings → Account"). The parser
        // is a strict allowlist; anything outside (`maka://tool/`,
        // `maka://auth/`, malformed sections) renders as a
        // non-clickable broken-link inline error. NEVER falls back
        // to `openExternal` — internal-link routing must not become
        // a hidden external-URL escape.
        a: ({ children, href, ...rest }) => (
          <MarkdownLink href={href} {...rest}>
            {children}
          </MarkdownLink>
        ),
        // Inline `code` keeps the bubble's foreground color; only block code
        // gets the framed treatment via `pre > code` in CSS. react-markdown
        // forwards the HAST className here (inline code has none; block code
        // carries `language-*` from rehype-highlight), so passing it through
        // styles block code for hljs and leaves inline code to prose.css.
        code: ({ children, className, ...rest }) => (
          <code {...rest} className={className}>
            {children}
          </code>
        ),
        // Wrap block code with a language pill header + copy affordance.
        // Surface the detected language so users can verify highlighting.
        pre: ({ children, ...rest }) => <CodeBlock {...rest}>{children}</CodeBlock>,
        // `remarkBreaks` above makes every single newline a hard break, and
        // model answers use `**subhead**\nbody` for section splits, so this
        // element routinely carries one. The span does all the spacing work
        // (39px → 45px); CSS cannot give a native <br> any height, since an
        // inline break box takes none. The <br> buys exactly one thing, and
        // it is not visual: without it the `LineBreak` node disappears from
        // the accessibility tree — the same trade TABLE-A11Y-SEMANTICS-0
        // below refuses for table roles. Copy fidelity is a single "\n"
        // either way; nesting the <br> INSIDE the span is what yields a
        // spurious "\n\n".
        // MARKDOWN-PROSE-CJK-MIXED-SPACING-0.
        br: () => (
          <>
            <br />
            <span className="maka-hardbreak" aria-hidden="true" />
          </>
        ),
        // #618 item 5: the horizontal scroller for over-wide tables lives on
        // a wrapper div. Scrolling on the table itself requires
        // `display: block`, which stops the element generating a table box —
        // Chromium then drops the implicit table/row/cell ARIA roles and
        // screen readers lose table navigation. TABLE-A11Y-SEMANTICS-0.
        table: ({ children, ...rest }) => (
          <div className="maka-table-scroll">
            <table {...rest}>{children}</table>
          </div>
        ),
        // #739: render bare heading + table-structure + list elements so
        // prose.css (heading ladder, frameless table, cell padding, task-list)
        // actually applies — Streamdown's default components tag them with
        // Tailwind utilities in the `utilities` layer that override the
        // `components`-layer prose.css rules. bareElement preserves the HAST
        // className (task-list, language-*) so prose.css's `.maka-prose
        // ul.contains-task-list` rules still match. p/ol/section are NOT
        // overridden — Streamdown's default p unwraps a lone image, and
        // ol/section clean streaming footnotes; stripping them breaks that
        // logic. h5/h6 are NOT overridden — prose.css has no rule for them, so
        // stripping would lose Streamdown's heading styling. See bareElement.
        h1: bareElement('h1'),
        h2: bareElement('h2'),
        h3: bareElement('h3'),
        h4: bareElement('h4'),
        blockquote: bareElement('blockquote'),
        ul: bareElement('ul'),
        li: bareElement('li'),
        thead: bareElement('thead'),
        tbody: bareElement('tbody'),
        tr: bareElement('tr'),
        th: bareElement('th'),
        td: bareElement('td'),
      }}
    >
      {props.text}
    </Streamdown>
  );
}

function markdownUrlTransform(url: string): string {
  return isMakaUriCandidate(url) || isSafeExternalScheme(url) ? url : '';
}

/**
 * PR-UI-RENDER-2 — Markdown link router. See `markdown.tsx` for the
 * full routing contract; this implementation is byte-for-byte the same
 * as the original, just relocated so the eager `markdown.tsx` only
 * holds the context + lazy wrapper.
 */
function MarkdownLink(props: {
  href?: string;
  children?: ReactNode;
  [key: string]: unknown;
}) {
  const { href, children, ...rest } = props;
  const dispatch = useContext(MakaUriContext);
  const copy = getSharedUiCopy(useUiLocale()).markdown;

  if (typeof href === 'string' && isMakaUriCandidate(href)) {
    const dest = parseMakaUri(href);
    if (dest && dispatch) {
      return (
        <button
          type="button"
          className="maka-markdown-link maka-markdown-link-internal"
          data-maka-uri-kind={dest.kind}
          onClick={() => dispatch(dest)}
        >
          {children}
        </button>
      );
    }
    return (
      <span
        className="maka-markdown-link maka-markdown-link-broken"
        data-reason="internal-invalid"
        title={copy.invalidInternalLink}
        aria-label={copy.invalidInternalLink}
      >
        {children}
      </span>
    );
  }

  if (typeof href === 'string' && isSafeExternalScheme(href)) {
    return (
      <a {...rest} href={href} className="maka-markdown-link maka-markdown-link-external" target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  return (
    <span
      className="maka-markdown-link maka-markdown-link-broken"
      data-reason="unsafe-scheme"
      title={copy.unsafeLink}
      aria-label={copy.unsafeLink}
    >
      {children}
    </span>
  );
}

function CodeBlock({ children, ...rest }: { children?: ReactNode }) {
  const codeCopy = getSharedUiCopy(useUiLocale()).markdown;
  const code = isElementWithClassName(children) ? children : null;
  const lang = code?.props.className?.match(/language-([A-Za-z0-9_+-]+)/)?.[1]?.toLowerCase();
  const copyFeedback = useClipboardCopyFeedback(1400, { redact: false });
  const copyPhase = copyFeedback.phaseFor('code');
  const copyPending = copyPhase === 'pending';
  const copied = copyPhase === 'copied';

  async function copy() {
    const text = collectCodeText(code?.props.children);
    await copyFeedback.copy('code', text);
  }

  return (
    <div className="maka-code-block">
      <div className="maka-code-block-header">
        <span className="maka-code-block-lang">{lang ?? 'code'}</span>
        <BaseButton
          type="button"
          className="maka-code-block-copy"
          onClick={() => void copy()}
          aria-label={copyPhase === 'pending' ? codeCopy.copyingCode : copyPhase === 'copied' ? codeCopy.copiedCode : copyPhase === 'failed' ? codeCopy.copyCodeFailed : codeCopy.copyCode}
          aria-busy={copyPending ? 'true' : undefined}
          disabled={copyPending}
          data-copied={copied}
          data-copy-feedback={copyPhase ?? undefined}
          data-pending={copyPending ? 'true' : undefined}
        >
          {copied
            ? <Check size={12} aria-hidden="true" />
            : <Copy size={12} aria-hidden="true" />}
        </BaseButton>
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  );
}

function isElementWithClassName(node: ReactNode): node is React.ReactElement<{ className?: string; children?: ReactNode }> {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function collectCodeText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(collectCodeText).join('');
  if (isElementWithClassName(children)) return collectCodeText(children.props.children);
  return '';
}
