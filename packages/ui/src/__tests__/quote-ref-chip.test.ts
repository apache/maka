import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripQuoteHeadingMarkers } from '../quote-ref-chip.js';

test('strips a leading ATX heading marker so the chip shows the title text', () => {
  assert.equal(stripQuoteHeadingMarkers('### Description'), 'Description');
  assert.equal(stripQuoteHeadingMarkers('## Sub section'), 'Sub section');
  assert.equal(stripQuoteHeadingMarkers('# Top'), 'Top');
  assert.equal(stripQuoteHeadingMarkers('###### Deep'), 'Deep');
});

test('strips the marker with one or more spaces/tabs, keeping the rest', () => {
  assert.equal(stripQuoteHeadingMarkers('###  double space'), 'double space');
  assert.equal(stripQuoteHeadingMarkers('###\ttabbed'), 'tabbed');
});

test('leaves non-heading text untouched', () => {
  assert.equal(stripQuoteHeadingMarkers('plain text'), 'plain text');
  assert.equal(stripQuoteHeadingMarkers('.analysis/issue.md ### Description'), '.analysis/issue.md ### Description');
  assert.equal(stripQuoteHeadingMarkers('###Description'), '###Description');
  assert.equal(stripQuoteHeadingMarkers('######x'), '######x');
  assert.equal(stripQuoteHeadingMarkers('####### x'), '####### x');
  assert.equal(stripQuoteHeadingMarkers('C# code'), 'C# code');
  assert.equal(stripQuoteHeadingMarkers('#hashtag'), '#hashtag');
  assert.equal(stripQuoteHeadingMarkers(''), '');
});
