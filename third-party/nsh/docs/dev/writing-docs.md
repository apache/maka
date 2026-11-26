# Writing user docs

These rules cover every website page (`website/docs/`, `website/elements/`, `website/modules/` and
their `website/zh-CN/` copies) and the home page copy
(`website/src/home/*.json`). AI tools read the docs as well, but people come first. If a person
can't follow a page, it has failed, however complete it is.

## The test

Read each paragraph aloud. If you would never say it that way to a colleague, rewrite it.

## Order of a page

1. **What it is**: one or two plain sentences.
2. **Why you would use it**, or what problem it solves.
3. **The smallest working example.**
4. **The details**: options, limits, edge cases, internals.

Put the common case first and rare cases last.

## Sentences

- Keep sentences short, with one idea each. Split any sentence that has more than one clause joined by
  `;`, `,` or `which`.
- Use the subject–verb–object order: "NSH checks every `fetch` against the allowed hosts", not "every
  `fetch` goes through, under what a host grants, the same checks".
- Use concrete nouns: name the API, the file and the platform. Avoid "the thing that", "the rest of
  that app", "as X is".
- Prefer the active voice and present tense. Address the reader as "you".
- Don't hedge or pad. Remove "It's important to note", "seamlessly", "robust", "powerful",
  "leverage", "in order to", "simply", "effectively", "comprehensive" and "first-class".
- Don't repeat a point in other words. Say it once, where it belongs.
- Don't use marketing adjectives without a number or an example behind them.

## Technical depth

Keep it. Short does not mean shallow. Keep the exact limits, defaults, error names and
platform differences, and present them as tables or lists instead of long sentences.

## Chinese pages

Write zh-CN pages directly in natural Chinese, not as a sentence-by-sentence translation of the
English page. The content must match; the wording does not have to. Avoid translation patterns
such as long "的" chains, "被" passives and literal English clause order. Keep API names, code and
units as they are.

## Terms

Define a term the first time a page uses it, in one plain sentence or a link. Examples:
capability, host grant, reactive graph, `MountBatch`, hardening. Use one name per concept across
pages; don't switch between synonyms.

## Example rewrite

Before (flagged on Hacker News):

> An app written in Rust is native code compiled into the app that ships it, as the rest of that
> app is, and runs with its trust; its calls into NSH's services go through the same native checks
> as TSX's, under what a host grants.

After:

> Rust code in your app is compiled into the app binary. It has the same trust as the rest of
> your app. When it calls an NSH service such as `fetch`, NSH applies the same checks as it does
> for TSX code.

## Self-check (run it before you commit)

Docs in this repo are written by AI and shipped without a separate human edit, so the writer
must check its own output. Go through every item; fix the page until all pass.

1. The first paragraph alone tells a newcomer what the page is about.
2. No sentence is longer than about 30 words, and none joins clauses with `;`.
3. Every pronoun ("it", "this", "that") points at a noun in the same or previous sentence.
4. None of these appear: "It's important to note", "seamlessly", "robust", "powerful",
   "leverage", "in order to", "simply", "effectively", "comprehensive", "first-class",
   "under the hood", "as X is", "the rest of that".
   Quick check: `grep -nEiw "seamless(ly)?|robust|leverag\w*|in order to|first-class|important to note|powerful|simply|effectively|comprehensive|under the hood" <file>`.
5. Each idea appears once. Principles already stated on Goals are linked, not restated.
6. Every new term is defined at first use (see Terms).
7. Every number, default, limit and API name matches the code or a benchmark.
8. Every code example compiles or runs as shown, with its imports.
9. The zh-CN page reads as natural Chinese and carries the same facts as the English page.
10. Long reference material (all options, every edge case) sits below the common case, or on its
    own page.
