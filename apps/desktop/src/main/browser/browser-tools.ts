import { z } from 'zod';
import { htmlToMarkdown } from '@jackwener/opencli/utils';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import {
  type BrowserPageRun,
  type TakeoverMode,
  browserAutomationAvailable,
  withBrowserPage,
} from './session.js';
import { parseNavigable } from './logic.js';

/**
 * Generic observe→act browser tools over opencli's numbered-ref model:
 * browser_snapshot lists interactive elements as `[N]` refs, the act tools
 * (click / type) take a ref and self-verify the match. All six drive the
 * conversation's OWN embedded-browser view through BrowserSession.
 *
 * Permission: every tool is the dedicated `browser` category — Maka's mode
 * gates it (block in `explore`, prompt in `ask` AND `execute`), so a browser
 * action on the user's logged-in sessions is never silently auto-allowed; the
 * visible view plus the user's "allow for this turn" is the safety net. A
 * finer origin-keyed grant (remember "allow this site") is a later refinement.
 */

const BROWSER_TOOL_CATEGORY = 'browser' as const;

// Above opencli's internal 30s CDP guard so a slow load surfaces the CDP
// command timeout (which names the navigation) rather than our generic one.
const NAVIGATE_TIMEOUT_MS = 35_000;
const MAX_WAIT_SECONDS = 120;
/** Per-call markdown budget; long pages page through `start`/`next_start_char`. */
const EXTRACT_CHAR_LIMIT = 16_000;
/**
 * Page-side ceiling on the raw HTML read. Without it a huge DOM serializes
 * fully over CDP and feeds htmlToMarkdown whole — a synchronous conversion no
 * timeout can interrupt.
 */
const HTML_CHAR_LIMIT = 2_000_000;

/**
 * opencli's target resolver treats ONLY a bare number as a snapshot ref —
 * "[12]" falls through to querySelectorAll and fails as an invalid CSS
 * selector. browser_snapshot prints refs as "[12]" and teaches that spelling,
 * so models echo it. Accept the bracketed form and hand opencli the number;
 * anything else passes through as a CSS selector.
 */
export function normalizeElementRef(ref: string): string {
  const match = /^\s*\[(\d+)\]\s*$/.exec(ref);
  return match ? match[1] : ref;
}

/** One-line note appended to the action that hardened (reloaded) a taken-over page. */
export function takeoverNote(info: { takeoverReloaded: boolean }): string {
  return info.takeoverReloaded
    ? '\n\nNote: attached to the page that was already open; it was reloaded once to apply automation hardening.'
    : '';
}

/**
 * Shared run path for the browser_* tools. Permission is decided by the engine
 * BEFORE impl runs (via the tool's category), so this only guards availability
 * and runs the action through BrowserSession with its tool-level timeout and
 * the user's stop signal.
 */
async function runBrowserAction<T>(input: {
  sessionId: string;
  label: string;
  abortSignal: AbortSignal;
  timeoutMs?: number;
  // How this action treats a page the user already had open (see TakeoverMode);
  // omit for the pure-observe default, which never reloads.
  takeover?: TakeoverMode;
  run: BrowserPageRun<T>;
}): Promise<T> {
  if (!browserAutomationAvailable()) {
    throw new Error('Browser automation is only available inside the desktop app.');
  }
  return withBrowserPage(input.sessionId, input.label, input.run, {
    abort: input.abortSignal,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.takeover ? { takeover: input.takeover } : {}),
  });
}

export function buildBrowserNavigateTool(): MakaTool<{ url: string }, string> {
  return {
    name: 'browser_navigate',
    displayName: '浏览器导航',
    description:
      'Open a URL in the conversation\'s embedded browser. Pass a full http:// or https:// URL; other schemes are rejected. ' +
      'Returns the URL actually landed on (after redirects) and the page title. Follow with browser_snapshot to see what is on the page.',
    parameters: z.object({
      url: z.string().min(1).max(4000).describe('Full http:// or https:// URL to open. Other schemes are rejected.'),
    }),
    categoryHint: BROWSER_TOOL_CATEGORY,
    impl: async ({ url: rawUrl }, { sessionId, abortSignal }) => {
      // Validate BEFORE goto: opencli's goto sends Page.navigate directly,
      // bypassing the view's will-navigate guard, so the scheme check is here.
      const url = parseNavigable(rawUrl);
      if (!url) {
        throw new Error(`Not a navigable URL: ${JSON.stringify(rawUrl)}. Pass a full http:// or https:// URL.`);
      }
      const result = await runBrowserAction({
        sessionId,
        label: 'navigate',
        abortSignal,
        timeoutMs: NAVIGATE_TIMEOUT_MS,
        // goto re-commits the document with the stealth script, so this clears a
        // pending takeover without an extra reload.
        takeover: 'navigate',
        run: async (page, info) => {
          await page.goto(url, { waitUntil: 'load' });
          // Read the document's real location: goto caches the REQUESTED url, so
          // getCurrentUrl() would just echo it back and a redirect would never
          // be visible.
          const landed = await page.evaluate<string>('window.location.href').catch(() => url);
          const title = await page.evaluate<string>('document.title').catch(() => '');
          return { landed: typeof landed === 'string' && landed ? landed : url, title, info };
        },
      });
      return (
        [`Loaded ${result.landed}`, result.title ? `Title: ${result.title}` : undefined].filter(Boolean).join('\n') +
        takeoverNote(result.info)
      );
    },
  };
}

export function buildBrowserSnapshotTool(): MakaTool<Record<string, never>, string> {
  return {
    name: 'browser_snapshot',
    displayName: '浏览器快照',
    description:
      'Observe the current page as a list of interactive elements (links, buttons, inputs), each tagged with a `[N]` ' +
      'reference you pass to browser_click / browser_type. This is the primary way to see what is on the page before acting.',
    parameters: z.object({}),
    categoryHint: BROWSER_TOOL_CATEGORY,
    impl: async (_args, { sessionId, abortSignal }) => {
      const result = await runBrowserAction({
        sessionId,
        label: 'snapshot',
        abortSignal,
        run: async (page, info) => {
          const snapshot = await page.snapshot({ interactive: true });
          const url = (await page.getCurrentUrl?.()) ?? '';
          return { snapshot, url, info };
        },
      });
      const text =
        typeof result.snapshot === 'string' ? result.snapshot : JSON.stringify(result.snapshot, null, 2);
      return (result.url ? `${result.url}\n\n${text}` : text) + takeoverNote(result.info);
    },
  };
}

export function buildBrowserClickTool(): MakaTool<{ ref: string }, string> {
  return {
    name: 'browser_click',
    displayName: '浏览器点击',
    description:
      'Click an element by its browser_snapshot reference (like "[12]") or a CSS selector. ' +
      'Reports how many elements matched and the match confidence; re-snapshot if multiple matched.',
    parameters: z.object({
      ref: z.string().min(1).max(2000).describe('Element reference from browser_snapshot (like "[12]") or a CSS selector.'),
    }),
    categoryHint: BROWSER_TOOL_CATEGORY,
    impl: async ({ ref }, { sessionId, abortSignal }) => {
      const result = await runBrowserAction({
        sessionId,
        label: 'click',
        abortSignal,
        // A mutating action: harden a taken-over page (reload once) before clicking.
        takeover: 'mutate',
        run: async (page, info) => ({ outcome: await page.click(normalizeElementRef(ref)), info }),
      });
      const { matches_n, match_level } = result.outcome;
      return (
        `Clicked ${ref} (matched ${matches_n} element${matches_n === 1 ? '' : 's'}, ${match_level} match).` +
        (matches_n > 1
          ? ' Multiple matches — verify the right element reacted, or re-snapshot for a tighter ref.'
          : '') +
        takeoverNote(result.info)
      );
    },
  };
}

export function buildBrowserTypeTool(): MakaTool<{ ref: string; text: string; submit?: boolean }, string> {
  return {
    name: 'browser_type',
    displayName: '浏览器输入',
    description:
      'Fill text into a field by its browser_snapshot reference (like "[7]") or a CSS selector; replaces the field\'s current content. ' +
      'Set submit=true to press Enter after (search boxes, single-field forms). Self-verifies the field now holds the requested text.',
    parameters: z.object({
      ref: z.string().min(1).max(2000).describe('Element reference from browser_snapshot (like "[7]") or a CSS selector.'),
      text: z.string().max(100_000).describe("Text to fill in; replaces the field's current content."),
      submit: z
        .boolean()
        .optional()
        .describe('Press Enter after filling (for search boxes and single-field forms). Default false.'),
    }),
    categoryHint: BROWSER_TOOL_CATEGORY,
    impl: async ({ ref, text, submit }, { sessionId, abortSignal }) => {
      const result = await runBrowserAction({
        sessionId,
        label: 'type',
        abortSignal,
        // A mutating action: harden a taken-over page (reload once) before typing.
        takeover: 'mutate',
        run: async (page, info) => {
          const outcome = await page.fillText(normalizeElementRef(ref), text);
          if (submit) await page.pressKey('Enter');
          return { outcome, info };
        },
      });
      const { verified, actual, match_level } = result.outcome;
      const lines = [
        `Filled ${ref} (${match_level} match)${submit ? ', then pressed Enter' : ''}.`,
        verified
          ? 'Verified: the field contains the requested text.'
          : `Not verified — the field now contains: ${JSON.stringify(actual)}`,
      ];
      return lines.join('\n') + takeoverNote(result.info);
    },
  };
}

export function buildBrowserWaitTool(): MakaTool<
  { text?: string; selector?: string; time?: number; timeout?: number },
  string
> {
  return {
    name: 'browser_wait',
    displayName: '浏览器等待',
    description:
      'Wait for the page to be ready: until `text` is visible, until a CSS `selector` matches, or a fixed `time` pause in seconds. ' +
      'Provide exactly one of text / selector / time. Prefer text or selector over a blind pause.',
    parameters: z.object({
      text: z.string().optional().describe('Wait until this text is visible on the page.'),
      selector: z.string().optional().describe('Wait until this CSS selector matches an element.'),
      time: z
        .number()
        .optional()
        .describe('Fixed pause in seconds (use only when nothing observable signals readiness).'),
      timeout: z
        .number()
        .optional()
        .describe('Wait limit in seconds for text/selector waits (defaults: text 30s, selector 10s).'),
    }),
    categoryHint: BROWSER_TOOL_CATEGORY,
    impl: async ({ text, selector, time, timeout }, { sessionId, abortSignal }) => {
      const conditions = [text, selector, time].filter((v) => v !== undefined);
      if (conditions.length !== 1) {
        throw new Error('Provide exactly one of `text`, `selector`, or `time`.');
      }
      // The checks below are truthy-based; a blank string would slip past the
      // count above and turn into a meaningless bare-timeout wait.
      for (const [key, value] of [
        ['text', text],
        ['selector', selector],
      ] as const) {
        if (value !== undefined && value.trim() === '') {
          throw new Error(`\`${key}\` must be a non-empty string.`);
        }
      }
      const requested = Math.min(time ?? timeout ?? (selector ? 10 : 30), MAX_WAIT_SECONDS);
      if (requested <= 0) {
        throw new Error('`time`/`timeout` must be a positive number of seconds.');
      }
      const condition = text
        ? `text ${JSON.stringify(text)}`
        : selector
          ? `selector ${JSON.stringify(selector)}`
          : `${requested}s pause`;
      const info = await runBrowserAction({
        sessionId,
        label: 'wait',
        abortSignal,
        // The page-side wait owns the deadline; give the tool wrapper room past it.
        timeoutMs: (requested + 5) * 1000,
        run: async (page, pageInfo) => {
          if (time !== undefined) {
            await page.wait({ time: requested });
            return pageInfo;
          }
          try {
            await page.wait({
              ...(text ? { text } : {}),
              ...(selector ? { selector } : {}),
              timeout: requested,
            });
          } catch (err) {
            // The page-side waiter rejects with a raw in-page exception which
            // neither says it was a timeout nor how to recover. Say both.
            if (err instanceof Error && /Selector not found|Text not found/.test(err.message)) {
              throw new Error(
                `Waited ${requested}s but ${condition} never appeared. The page may be structured differently than expected — take a browser_snapshot to see what is actually there before retrying.`,
              );
            }
            throw err;
          }
          return pageInfo;
        },
      });
      return `Done: ${condition}.` + takeoverNote(info);
    },
  };
}

export function buildBrowserExtractTool(): MakaTool<{ selector?: string; start?: number }, string> {
  return {
    name: 'browser_extract',
    displayName: '浏览器提取',
    description:
      'Read the page (or a CSS-selected region) as Markdown for analysis. Omit selector for the whole body. ' +
      'Long pages page through `start` — the output names the next_start_char to continue from.',
    parameters: z.object({
      selector: z.string().optional().describe('CSS selector to extract from; omit for the whole page body.'),
      start: z
        .number()
        .optional()
        .describe("Character offset to continue from (use the previous call's next_start_char)."),
    }),
    categoryHint: BROWSER_TOOL_CATEGORY,
    impl: async ({ selector, start: rawStart }, { sessionId, abortSignal }) => {
      const start = Math.max(0, Math.floor(rawStart ?? 0));
      const result = await runBrowserAction({
        sessionId,
        label: 'extract',
        abortSignal,
        run: async (page, info) => {
          // The selector is JSON-serialized into the script (never string-
          // concatenated), so it cannot inject.
          const read = await page.evaluate<{ html: string; truncated: boolean } | null>(
            readHtmlJs(JSON.stringify(selector ?? null)),
          );
          const url = (await page.getCurrentUrl?.()) ?? '';
          return { read, url, info };
        },
      });
      if (typeof result.read?.html !== 'string') {
        throw new Error(
          selector
            ? `No element matches selector ${JSON.stringify(selector)}.`
            : 'The page has no readable body yet — navigate somewhere first.',
        );
      }
      const markdown = htmlToMarkdown(result.read.html);
      const chunk = markdown.slice(start, start + EXTRACT_CHAR_LIMIT);
      const nextStart = start + chunk.length;
      const hasMore = nextStart < markdown.length;
      return (
        (result.url ? `${result.url}\n\n` : '') +
        chunk +
        (hasMore
          ? `\n\n(Content continues — call browser_extract again with start=${nextStart}. next_start_char: ${nextStart})`
          : '') +
        (result.read.truncated
          ? "\n\n(The page's HTML was larger than the extraction ceiling; trailing content was dropped before conversion. Use `selector` to target the part you need.)"
          : '') +
        takeoverNote(result.info)
      );
    },
  };
}

// Runs inside the page. The selector arrives pre-serialized via JSON (never
// string-concatenated into code), so selector content cannot inject script. A
// malformed selector (e.g. a "[12]" ref a model echoed) makes querySelector
// throw a SyntaxError; catch it and return null so the tool surfaces its
// friendly "No element matches selector" message instead of a raw DOMException.
export function readHtmlJs(selectorJson: string): string {
  return `(() => {
  const selector = ${selectorJson};
  let el;
  try {
    el = selector ? document.querySelector(selector) : document.body;
  } catch {
    return null;
  }
  if (!el) return null;
  const html = el.outerHTML;
  return { html: html.slice(0, ${HTML_CHAR_LIMIT}), truncated: html.length > ${HTML_CHAR_LIMIT} };
})()`;
}

/** The six generic observe→act browser tools, in observe-before-act order. */
export function buildBrowserTools(): MakaTool[] {
  return [
    buildBrowserNavigateTool(),
    buildBrowserSnapshotTool(),
    buildBrowserClickTool(),
    buildBrowserTypeTool(),
    buildBrowserWaitTool(),
    buildBrowserExtractTool(),
  ] as MakaTool[];
}
