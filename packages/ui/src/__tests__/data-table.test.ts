import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataTable } from '../primitives/data-table.js';

// The hairline table recipe promoted out of usage-settings (#1252). These
// assertions are the re-pinned home of the markup the settings-usage-contract
// used to guard inline: the accessible name, the scoped col/row headers, the
// numeric right-align + tabular-nums, and the single grow column absorbing
// slack while the rest size to content on one line.

function render() {
  return renderToStaticMarkup(
    createElement(DataTable, {
      ariaLabel: 'Providers table',
      className: 'pinnedTable',
      columns: [
        { header: 'Provider', grow: true },
        { header: 'Requests', numeric: true },
      ],
      rows: [
        ['Anthropic', 42],
        ['OpenAI', 7],
      ],
    }),
  );
}

test('DataTable exposes the caller-provided accessible name and pin class', () => {
  const markup = render();
  assert.match(markup, /<table\b[^>]*aria-label="Providers table"/);
  assert.match(markup, /data-slot="data-table"/);
  assert.match(markup, /class="[^"]*pinnedTable/, 'pin class must pass through for CSS/CDP selectors');
});

test('DataTable scrolls wide content inside its own container (#1360)', () => {
  const markup = render();
  // The nowrap column recipe gives the table a min-content width as wide as
  // its widest cells, so the primitive owns the horizontal scroller (#1303
  // acceptance rule: wide content scrolls in its own overflow-x container).
  assert.match(
    markup,
    /^<div\b[^>]*data-slot="data-table-scroller"[^>]*class="[^"]*overflow-x-auto/,
    'the scroller wraps the table and owns overflow-x',
  );
  // The hairline box + radius live on the scroller — a border on the <table>
  // itself would scroll along with the content.
  assert.match(markup, /data-slot="data-table-scroller"[^>]*class="[^"]*border-border/);
  assert.match(markup, /data-slot="data-table-scroller"[^>]*class="[^"]*pinnedTable/, 'pin class addresses the outermost element');
  const tableClass = markup.match(/<table[^>]*class="([^"]*)"/)?.[1] ?? '';
  assert.ok(!tableClass.includes('border-border'), 'the table itself carries no box border');
  // Without border-collapse merging into the box border, the last row sheds
  // its hairline so the bottom edge is a single line. (`&`/`>` arrive
  // HTML-escaped in static markup.)
  assert.match(markup, /\[&amp;&gt;tbody&gt;tr:last-child&gt;\*\]:border-b-0/);
});

test('DataTable scopes the header row and the first data cell of every row', () => {
  const markup = render();
  // Column headers are scoped to their column.
  assert.equal((markup.match(/<th scope="col"/g) ?? []).length, 2);
  // The first data cell of each row is promoted to a scoped row header.
  assert.equal((markup.match(/<th scope="row"/g) ?? []).length, 2);
  // Non-first cells stay <td>.
  assert.equal((markup.match(/<td\b/g) ?? []).length, 2);
});

test('DataTable right-aligns numeric columns with tabular-nums', () => {
  const markup = render();
  assert.match(markup, /text-right \[font-variant-numeric:tabular-nums\]/);
});

test('DataTable lets one column grow while the rest size to content on one line', () => {
  const markup = render();
  assert.match(markup, /w-full/, 'the grow column absorbs slack');
  assert.match(markup, /whitespace-nowrap/, 'non-grow columns stay on one line and size to content');
});
