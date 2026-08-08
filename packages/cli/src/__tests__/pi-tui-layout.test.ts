import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { Component, Terminal } from '@earendil-works/pi-tui';
import { _setColorLevelForTesting } from '../tui-ansi.js';
import {
  appendUserPrompt,
  applyMakaSessionEventToTranscript,
  createMakaPiTranscriptState,
  replaceTranscriptWithStoredMessages,
  toggleAllToolExpansion,
  type MakaPiTranscriptMetadata,
  type MakaPiTranscriptState,
} from '../pi-transcript.js';
import {
  MakaActivityStripComponent,
  MakaPendingQueueComponent,
  MakaPiLayoutComponent,
  MakaStatusLineComponent,
  MakaTranscriptComponent,
} from '../pi-tui-layout.js';
import type { SessionEvent } from '@maka/core';

before(() => _setColorLevelForTesting(3));

// The viewport-top estimate must shadow pi-tui's real viewport (#1097): reset
// to the document tail exactly when pi-tui would full-redraw (size change,
// change above the top, shrink below the top), stay monotonic otherwise.
describe('MakaPiLayoutComponent viewport geometry', () => {
  test('a wholesale replacement (/new) re-anchors the viewport and keeps toggles alive', () => {
    const { state, layout } = harness();
    growTranscript(state, 60);
    layout.render(80);
    assert.ok(state.renderGeometry.viewportTop > 0);

    replaceTranscriptWithStoredMessages(state, []);
    layout.render(80);
    assert.equal(state.renderGeometry.viewportTop, 0);

    addTool(state, 'tool-new', 'echo hi');
    layout.render(80);
    assert.equal(toggleAllToolExpansion(state), true);
  });

  test('a terminal size change re-anchors the viewport to the document tail', () => {
    const { state, layout, terminal } = harness();
    growTranscript(state, 60);
    const lines = layout.render(80);
    assert.equal(state.renderGeometry.viewportTop, lines.length - 24);

    terminal.rows = 50;
    const taller = layout.render(80);
    assert.equal(state.renderGeometry.viewportTop, Math.max(0, taller.length - 50));

    // pi-tui full-redraws on any width change, even without a wrap difference.
    terminal.rows = 24;
    layout.render(80);
    const before = state.renderGeometry.viewportTop;
    terminal.columns = 120;
    const wider = layout.render(120);
    assert.equal(state.renderGeometry.viewportTop, Math.max(0, wider.length - 24));
    assert.ok(state.renderGeometry.viewportTop <= before);
  });

  test('a shallow truncation keeps the viewport top, a deep one re-anchors it', () => {
    const { state, layout } = harness();
    growTranscript(state, 60, 'message-1');
    growTranscript(state, 60, 'message-2');
    addTool(state, 'tool-tail', 'echo tail');
    layout.render(80);
    const top = state.renderGeometry.viewportTop;
    assert.ok(top > 0);

    // Shallow: dropping the tail entry keeps the document longer than the
    // viewport top; pi-tui clears the vacated rows without a full redraw and
    // its viewport stays put, so the estimate must too.
    state.entries.pop();
    layout.render(80);
    assert.equal(state.renderGeometry.viewportTop, top);

    // Deep: truncating below the viewport top forces pi-tui's full redraw,
    // which re-anchors its viewport to the new document tail.
    state.entries.length = 1;
    const shrunk = layout.render(80);
    assert.equal(state.renderGeometry.viewportTop, Math.max(0, shrunk.length - 24));
    assert.ok(state.renderGeometry.viewportTop < top);
  });

  test('appends and in-viewport edits keep the viewport top monotonic', () => {
    const { state, layout } = harness();
    growTranscript(state, 60);
    layout.render(80);
    const top = state.renderGeometry.viewportTop;

    addTool(state, 'tool-append', 'echo more');
    const grown = layout.render(80);
    assert.equal(state.renderGeometry.viewportTop, grown.length - 24);
    assert.ok(state.renderGeometry.viewportTop >= top);
  });

  // The remaining branches only differ from "reset to the tail on anything"
  // once the estimate sits above the tail, so each case first shallow-truncates
  // to open that gap, then exercises exactly one rule.
  test('with the top above the tail, each shadow-diff rule acts independently', () => {
    const opened = () => {
      const { state, layout } = harness();
      // First entry: an expanded thinking block (full-text cache key), so an
      // in-place edit above the viewport top really changes rendered lines.
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'thinking_delta',
          messageId: 'message-head',
          text: 'head-reasoning-xำy',
        }),
      );
      const head = state.entries[0];
      assert.ok(head?.kind === 'thinking');
      head.expanded = true;
      growTranscript(state, 60, 'message-1');
      growTranscript(state, 10, 'message-2');
      layout.render(80);
      const top = state.renderGeometry.viewportTop;
      // Shallow truncation: drop the m2 filler; the top stays put and now
      // sits above the document tail.
      state.entries.pop();
      const lines = layout.render(80);
      assert.equal(state.renderGeometry.viewportTop, top);
      assert.ok(top > lines.length - 24);
      return { state, layout, head, top };
    };

    // Append: keeps the top (an unconditional reset would drop it to the tail).
    {
      const { state, layout, top } = opened();
      addTool(state, 'tool-small', 'echo hi');
      layout.render(80);
      assert.equal(state.renderGeometry.viewportTop, top);
    }
    // In-place edit above the top: off-screen freeze (#1135) keeps the
    // rendered lines unchanged, so the shadow diff sees no change and the
    // top stays put. Without the freeze, pi-tui would full-redraw and the
    // top would re-anchor to the tail.
    {
      const { state, layout, head, top } = opened();
      assert.ok(head.kind === 'thinking');
      head.text = 'head-reasoning-EDITEDำy'.slice(0, head.text.length);
      layout.render(80);
      assert.equal(state.renderGeometry.viewportTop, top);
    }
    // Normalization-equivalent change above the top: pi-tui diffs normalized
    // lines and sees no change, so the top must not fall.
    {
      const { state, layout, head, top } = opened();
      assert.ok(head.kind === 'thinking');
      head.text = head.text.replace('ำ', 'ํา');
      layout.render(80);
      assert.equal(state.renderGeometry.viewportTop, top);
    }
  });

  test('truncating to exactly the viewport top re-anchors (pi-tui redraws at that boundary)', () => {
    const { state, layout } = harness();
    for (let i = 0; i < 100; i += 1) appendUserPrompt(state, `prompt-${i}`);
    const lines = layout.render(80);
    const top = state.renderGeometry.viewportTop;
    assert.equal(top, lines.length - 24);

    // Each user entry is two composed lines (blank + prompt); chrome is five.
    // Truncate so the composed document ends exactly at the old top.
    const keep = (top - 5) / 2;
    assert.equal(keep, Math.floor(keep));
    state.entries.length = keep;
    const shrunk = layout.render(80);
    assert.equal(shrunk.length, top);
    assert.equal(state.renderGeometry.viewportTop, Math.max(0, top - 24));
  });

  test('a Termux height change keeps the buffer-derived top instead of re-anchoring', () => {
    process.env.TERMUX_VERSION = '0.118';
    try {
      const { state, layout, terminal } = harness();
      growTranscript(state, 60, 'message-1');
      growTranscript(state, 10, 'message-2');
      layout.render(80);
      const top = state.renderGeometry.viewportTop;
      state.entries.pop();
      layout.render(80);
      assert.equal(state.renderGeometry.viewportTop, top);

      // pi-tui keeps the buffer under Termux and recomputes the top from it;
      // re-anchoring to the shorter document tail would fall below it.
      terminal.rows = 30;
      layout.render(80);
      assert.equal(state.renderGeometry.viewportTop, top + 24 - 30);
    } finally {
      delete process.env.TERMUX_VERSION;
    }
  });

  test('after a wholesale replacement the toggles stay inert until the next render', () => {
    const { state, layout } = harness();
    growTranscript(state, 60);
    layout.render(80);
    assert.ok(state.renderGeometry.viewportTop > 0);

    replaceTranscriptWithStoredMessages(state, []);
    addTool(state, 'tool-hydrated', 'echo hi');
    // Entry positions are unknown and the viewport has scrolled: a toggle here
    // could rewrite lines above pi-tui's real viewport, so it must do nothing.
    assert.equal(toggleAllToolExpansion(state), false);

    layout.render(80);
    assert.equal(toggleAllToolExpansion(state), true);
  });
});

interface StubTerminal {
  rows: number;
  columns: number;
}

function harness(): {
  state: MakaPiTranscriptState;
  layout: MakaPiLayoutComponent;
  terminal: StubTerminal;
} {
  const state = createMakaPiTranscriptState();
  const metadata = (): MakaPiTranscriptMetadata => ({
    title: 'Maka',
    cwd: '/repo',
    model: 'deepseek-v4-flash',
    connectionSlug: 'deepseek',
    permissionMode: 'ask',
    usage: state.usage,
  });
  const terminal: StubTerminal = { rows: 24, columns: 80 };
  const stubComponent = (lines: string[]): Component => ({
    render: () => lines,
    invalidate: () => {},
  });
  const layout = new MakaPiLayoutComponent(
    state,
    new MakaTranscriptComponent(state, metadata),
    new MakaActivityStripComponent(metadata),
    new MakaPendingQueueComponent(state),
    stubComponent(['editor-1', 'editor-2', 'editor-3']),
    new MakaStatusLineComponent(metadata),
    terminal as unknown as Terminal,
  );
  return { state, layout, terminal };
}

function growTranscript(
  state: MakaPiTranscriptState,
  paragraphs: number,
  messageId = 'message-filler',
): void {
  applyMakaSessionEventToTranscript(
    state,
    event({
      type: 'text_delta',
      messageId,
      text: Array.from({ length: paragraphs }, (_, i) => `${messageId}-filler-${i}`).join('\n\n'),
    }),
  );
}

function addTool(state: MakaPiTranscriptState, toolUseId: string, command: string): void {
  applyMakaSessionEventToTranscript(
    state,
    event({
      type: 'tool_start',
      toolUseId,
      toolName: 'Bash',
      args: { command },
    }),
  );
  applyMakaSessionEventToTranscript(
    state,
    event({
      type: 'tool_result',
      toolUseId,
      isError: false,
      content: { kind: 'text', text: 'ok' },
    }),
  );
}

function event(input: { type: SessionEvent['type'] } & Record<string, unknown>): SessionEvent {
  return {
    id: `${input.type}-id`,
    turnId: 'turn-1',
    ts: 1,
    ...input,
  } as SessionEvent;
}
