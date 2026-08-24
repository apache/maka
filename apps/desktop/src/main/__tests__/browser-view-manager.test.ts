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

/** BrowserViewManager bookkeeping: lazy create, reuse, live-change, dispose, leak invariant. */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { BrowserViewManager, type ManagedView } from '../browser/view-manager.js';
import type { BrowserViewRect } from '../browser/logic.js';

class StubView implements ManagedView {
  disposed = false;
  rect: BrowserViewRect | null = null;
  constructor(
    public readonly id: string,
    private readonly url = '',
  ) {}
  setViewport(rect: BrowserViewRect | null): void {
    this.rect = rect;
  }
  state(): { hasPage: boolean; url: string } {
    return { hasPage: this.url !== '', url: this.url };
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function makeManager() {
  const created: StubView[] = [];
  const liveSets: string[][] = [];
  const manager = new BrowserViewManager<StubView>({
    create: (id) => {
      const v = new StubView(id);
      created.push(v);
      return v;
    },
    onLiveChange: (ids) => liveSets.push(ids),
  });
  return { manager, created, liveSets };
}

describe('BrowserViewManager', () => {
  it('fires onLiveChange on create and dispose, not on reuse', async () => {
    const { manager, liveSets } = makeManager();
    manager.getOrCreate('s1');
    manager.getOrCreate('s1'); // reuse — no fire
    manager.getOrCreate('s2');
    await manager.dispose('s1');
    assert.deepEqual(liveSets, [['s1'], ['s1', 's2'], ['s2']]);
  });

  it('hideAllExcept hides every other view and leaves the kept one untouched', () => {
    const { manager } = makeManager();
    const a = manager.getOrCreate('s1');
    const b = manager.getOrCreate('s2');
    const c = manager.getOrCreate('s3');
    // Seed a non-null rect so "untouched" is observable.
    a.rect = { x: 1, y: 1, width: 1, height: 1 };
    b.rect = { x: 2, y: 2, width: 2, height: 2 };
    c.rect = { x: 3, y: 3, width: 3, height: 3 };
    manager.hideAllExcept('s2');
    assert.equal(a.rect, null); // hidden
    assert.deepEqual(b.rect, { x: 2, y: 2, width: 2, height: 2 }); // kept
    assert.equal(c.rect, null); // hidden
    // null hides all.
    manager.hideAllExcept(null);
    assert.equal(b.rect, null);
  });

  it('dispose removes the view, disposes it, and lets the next create be fresh', async () => {
    const { manager, created } = makeManager();
    const first = manager.getOrCreate('s1');
    await manager.dispose('s1');
    assert.equal(first.disposed, true);
    assert.equal(manager.liveCount(), 0);
    const second = manager.getOrCreate('s1');
    assert.notEqual(second, first);
    assert.equal(created.length, 2);
  });

  it('disposeAll tears down every view (leak invariant)', async () => {
    const { manager, created } = makeManager();
    manager.getOrCreate('s1');
    manager.getOrCreate('s2');
    manager.getOrCreate('s3');
    await manager.disposeAll();
    assert.equal(manager.liveCount(), 0);
    assert.ok(created.every((v) => v.disposed));
  });
});
