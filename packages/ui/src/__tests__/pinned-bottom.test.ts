import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createPinnedBottomFollower,
  resolvePinnedBottomScroll,
} from '../pinned-bottom.js';

describe('resolvePinnedBottomScroll', () => {
  it('re-follows a stale programmatic scroll event after pinned content grows again', () => {
    assert.deepEqual(
      resolvePinnedBottomScroll({
        scrollTop: 500,
        scrollHeight: 1_100,
        clientHeight: 100,
        threshold: 64,
        wasPinned: true,
        lastFollowedScrollTop: 500,
      }),
      { pinned: true, shouldFollow: true },
    );
  });

  it('unpins when the user moves away from the last followed position', () => {
    assert.deepEqual(
      resolvePinnedBottomScroll({
        scrollTop: 400,
        scrollHeight: 1_100,
        clientHeight: 100,
        threshold: 64,
        wasPinned: true,
        lastFollowedScrollTop: 500,
      }),
      { pinned: false, shouldFollow: false },
    );
  });
});

describe('createPinnedBottomFollower', () => {
  it('follows every observed content growth while pinned', () => {
    const viewport = { scrollTop: 100, scrollHeight: 200 };
    const content = {} as Element;
    let notifyContentCommit!: () => void;
    let observed: Element | undefined;
    let disconnected = false;
    const followed: number[] = [];
    const stop = createPinnedBottomFollower({
      viewport,
      content,
      isPinned: () => true,
      onFollow: (scrollTop) => { followed.push(scrollTop); },
      createObserver: (callback) => {
        notifyContentCommit = callback;
        return {
          observe: (element) => { observed = element; },
          disconnect: () => { disconnected = true; },
        };
      },
    });

    assert.equal(observed, content);
    viewport.scrollHeight = 260;
    notifyContentCommit();
    assert.equal(viewport.scrollTop, 260);
    viewport.scrollHeight = 320;
    notifyContentCommit();
    assert.equal(viewport.scrollTop, 320);
    assert.deepEqual(followed, [260, 320]);
    stop();
    assert.equal(disconnected, true);
  });

  it('does not move the viewport after the user unpins', () => {
    const viewport = { scrollTop: 100, scrollHeight: 200 };
    let pinned = true;
    let notifyContentCommit!: () => void;
    createPinnedBottomFollower({
      viewport,
      content: {} as Element,
      isPinned: () => pinned,
      createObserver: (callback) => {
        notifyContentCommit = callback;
        return { observe: () => {}, disconnect: () => {} };
      },
    });

    pinned = false;
    viewport.scrollHeight = 300;
    notifyContentCommit();
    assert.equal(viewport.scrollTop, 100);
  });

  // Render-skipped turns (content-visibility: auto) inflate from their
  // placeholder to their real height without any DOM mutation, so the
  // follower needs a size channel alongside the mutation channel.
  it('follows child size growth that produces no mutation', () => {
    const childA = {} as Element;
    const childB = {} as Element;
    const viewport = { scrollTop: 100, scrollHeight: 200 };
    const content = { children: [childA, childB] } as unknown as Element;
    let notifySizeChange!: () => void;
    const sizeObserved: Element[] = [];
    createPinnedBottomFollower({
      viewport,
      content,
      isPinned: () => true,
      createObserver: () => ({ observe: () => {}, disconnect: () => {} }),
      createSizeObserver: (callback) => {
        notifySizeChange = callback;
        return {
          observe: (element) => { sizeObserved.push(element); },
          disconnect: () => {},
        };
      },
    });

    assert.deepEqual(sizeObserved, [childA, childB]);
    viewport.scrollHeight = 1400;
    notifySizeChange();
    assert.equal(viewport.scrollTop, 1400);
  });

  it('starts observing children appended after a mutation, exactly once each', () => {
    const childA = {} as Element;
    const childB = {} as Element;
    const children: Element[] = [childA];
    const viewport = { scrollTop: 0, scrollHeight: 100 };
    const content = { children } as unknown as Element;
    let notifyContentCommit!: () => void;
    const sizeObserved: Element[] = [];
    createPinnedBottomFollower({
      viewport,
      content,
      isPinned: () => true,
      createObserver: (callback) => {
        notifyContentCommit = callback;
        return { observe: () => {}, disconnect: () => {} };
      },
      createSizeObserver: () => ({
        observe: (element) => { sizeObserved.push(element); },
        disconnect: () => {},
      }),
    });

    children.push(childB);
    notifyContentCommit();
    notifyContentCommit();
    assert.deepEqual(sizeObserved, [childA, childB]);
  });

  it('does not move the viewport on size growth after the user unpins, and stop disconnects both observers', () => {
    const viewport = { scrollTop: 50, scrollHeight: 100 };
    const content = { children: [{} as Element] } as unknown as Element;
    let pinned = true;
    let notifySizeChange!: () => void;
    let mutationDisconnected = false;
    let sizeDisconnected = false;
    const stop = createPinnedBottomFollower({
      viewport,
      content,
      isPinned: () => pinned,
      createObserver: () => ({ observe: () => {}, disconnect: () => { mutationDisconnected = true; } }),
      createSizeObserver: (callback) => {
        notifySizeChange = callback;
        return { observe: () => {}, disconnect: () => { sizeDisconnected = true; } };
      },
    });

    pinned = false;
    viewport.scrollHeight = 900;
    notifySizeChange();
    assert.equal(viewport.scrollTop, 50);
    stop();
    assert.equal(mutationDisconnected, true);
    assert.equal(sizeDisconnected, true);
  });
});
