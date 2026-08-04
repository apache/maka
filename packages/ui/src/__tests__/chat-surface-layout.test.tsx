import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatSurfaceLayout } from '../chat-surface-layout.js';

describe('ChatSurfaceLayout', () => {
  it('uses one Astryx layout as the chat scroll and composer owner', () => {
    const markup = renderToStaticMarkup(
      <ChatSurfaceLayout composer={<div data-composer>Composer</div>}>
        <div data-transcript>Transcript</div>
      </ChatSurfaceLayout>,
    );

    assert.match(markup, /class="[^"]*astryx-chat-layout[^"]*"/);
    assert.equal(markup.match(/data-chat-scroll-container="true"/g)?.length, 1);
    assert.match(markup, /data-transcript="true"/);
    assert.match(markup, /data-composer="true"/);
  });

  it('docks the composer at Astryx balanced density', () => {
    // The tier is the product decision; the px it resolves to is Astryx's.
    // Asserting the tier here leaves the E2E free to measure only what the
    // cascade decides — that the gutter is positive and height-invariant —
    // instead of pinning a spacing token this package does not own.
    const markup = renderToStaticMarkup(
      <ChatSurfaceLayout composer={<div data-composer>Composer</div>}>
        <div>Transcript</div>
      </ChatSurfaceLayout>,
    );

    assert.match(markup, /data-density="balanced"/);
  });

  it('keeps the composer mounted when the chat surface is hidden', () => {
    const markup = renderToStaticMarkup(
      <ChatSurfaceLayout hidden composer={<div data-composer>Draft survives navigation</div>}>
        <div>Transcript</div>
      </ChatSurfaceLayout>,
    );

    assert.match(markup, /hidden=""/);
    assert.match(markup, /data-composer="true"/);
    assert.match(markup, /Draft survives navigation/);
  });
});
