import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { QuoteRef } from '@maka/core';
import {
  consumeCompanionQuoteSnapshot,
  removeStagedCompanionQuote,
  snapshotCompanionQuotes,
  stageCompanionQuote,
  type QuoteCompanionPanelState,
} from '../../renderer/quote-companion-panel-state.js';

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++]!;
}

function quote(text: string): QuoteRef {
  return { text };
}

describe('quote companion panel ownership', () => {
  it('consumes only the snapshot attached to the accepted send', () => {
    const newId = ids('quote-a', 'panel-1', 'quote-b');
    let panel: QuoteCompanionPanelState | null = stageCompanionQuote(null, {
      sourceSessionId: 'source',
      quote: quote('A'),
      newId,
    });
    const sent = snapshotCompanionQuotes(panel.id, panel.quotes);

    panel = stageCompanionQuote(panel, {
      sourceSessionId: 'source',
      quote: quote('B'),
      newId,
    });
    panel = consumeCompanionQuoteSnapshot(panel, sent);

    assert.deepEqual(panel?.quotes, [{ id: 'quote-b', value: quote('B') }]);
  });

  it('ignores a late callback from a panel that has been replaced', () => {
    const firstIds = ids('quote-a', 'panel-1');
    const first = stageCompanionQuote(null, {
      sourceSessionId: 'source',
      quote: quote('A'),
      newId: firstIds,
    });
    const stale = snapshotCompanionQuotes(first.id, first.quotes);
    const replacement = stageCompanionQuote(null, {
      sourceSessionId: 'source',
      quote: quote('B'),
      newId: ids('quote-b', 'panel-2'),
    });

    assert.equal(consumeCompanionQuoteSnapshot(replacement, stale), replacement);
  });

  it('removes one staged quote by stable panel and quote ids', () => {
    const newId = ids('quote-a', 'panel-1', 'quote-b');
    let panel: QuoteCompanionPanelState | null = stageCompanionQuote(null, {
      sourceSessionId: 'source',
      quote: quote('A'),
      newId,
    });
    panel = stageCompanionQuote(panel, {
      sourceSessionId: 'source',
      quote: quote('B'),
      newId,
    });

    panel = removeStagedCompanionQuote(panel, {
      panelId: panel.id,
      quoteId: 'quote-a',
    });

    assert.deepEqual(panel?.quotes, [{ id: 'quote-b', value: quote('B') }]);
  });

  it('ignores a stale removal from a replaced panel', () => {
    const replacement = stageCompanionQuote(null, {
      sourceSessionId: 'source',
      quote: quote('B'),
      newId: ids('quote-b', 'panel-2'),
    });

    assert.equal(
      removeStagedCompanionQuote(replacement, {
        panelId: 'panel-1',
        quoteId: 'quote-b',
      }),
      replacement,
    );
  });
});
