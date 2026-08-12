import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import type { TurnTimelineItem } from '../materialize.js';
import { foldTimeline } from '../timeline-fold.js';

it('keeps a thinking run in the same processing fold when tools arrive', () => {
  const thinking: TurnTimelineItem = {
    kind: 'thinking',
    messageId: 'reasoning-1',
    text: 'working',
    live: true,
  };

  assert.deepEqual(foldTimeline([thinking]), [{
    kind: 'processing',
    id: 'start',
    children: [thinking],
  }]);

  const tools: TurnTimelineItem = { kind: 'tools', items: [] };
  assert.deepEqual(foldTimeline([thinking, tools]), [{
    kind: 'processing',
    id: 'start',
    children: [thinking, tools],
  }]);
});
