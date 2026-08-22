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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { QuoteRef } from '@maka/core/events';
import {
  consumeCompanionQuoteSnapshot,
  consumeCompanionInitialPrompt,
  openCompanionPanel,
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
  it('opens an empty companion and reuses it for the same source session', () => {
    const panel = openCompanionPanel(null, {
      sourceSessionId: 'source',
      newId: ids('panel-1'),
    });
    assert.deepEqual(panel, {
      id: 'panel-1',
      sourceSessionId: 'source',
      quotes: [],
    });
    assert.equal(
      openCompanionPanel(panel, {
        sourceSessionId: 'source',
        newId: ids('unused'),
      }),
      panel,
    );
  });

  it('replaces an empty companion when the source session changes', () => {
    const first = openCompanionPanel(null, {
      sourceSessionId: 'source-a',
      newId: ids('panel-1'),
    });
    assert.deepEqual(
      openCompanionPanel(first, {
        sourceSessionId: 'source-b',
        newId: ids('panel-2'),
      }),
      {
        id: 'panel-2',
        sourceSessionId: 'source-b',
        quotes: [],
      },
    );
  });

  it('owns and consumes an initial slash-command prompt exactly once', () => {
    const panel = openCompanionPanel(null, {
      sourceSessionId: 'source',
      initialPrompt: 'inspect this',
      newId: ids('panel-1'),
    });
    assert.equal(panel.initialPrompt, 'inspect this');
    assert.deepEqual(consumeCompanionInitialPrompt(panel, panel.id), {
      id: 'panel-1',
      sourceSessionId: 'source',
      quotes: [],
    });
    assert.equal(consumeCompanionInitialPrompt(panel, 'stale-panel'), panel);
  });

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
