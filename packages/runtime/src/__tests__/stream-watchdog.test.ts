import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import { StreamWatchdog, type StreamWatchdogTimeout } from '../stream-watchdog.js';

describe('StreamWatchdog', () => {
  test('fires connect timeout before any activity', () => {
    const timers = fakeTimers(1_000);
    const fired: StreamWatchdogTimeout[] = [];
    const watchdog = new StreamWatchdog({
      now: timers.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      connectTimeoutMs: 30_000,
      idleTimeoutMs: 120_000,
      onTimeout: (timeout) => fired.push(timeout),
    });

    watchdog.start();
    timers.advance(29_999);
    expect(fired).toEqual([]);
    timers.advance(1);

    expect(fired).toEqual([{ phase: 'connect', elapsedMs: 30_000 }]);
  });

  test('activity switches to idle timeout and resets the clock', () => {
    const timers = fakeTimers(2_000);
    const fired: StreamWatchdogTimeout[] = [];
    const watchdog = new StreamWatchdog({
      now: timers.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      connectTimeoutMs: 30_000,
      idleTimeoutMs: 10_000,
      onTimeout: (timeout) => fired.push(timeout),
    });

    watchdog.start();
    timers.advance(5_000);
    watchdog.markActivity();
    timers.advance(9_999);
    expect(fired).toEqual([]);
    timers.advance(1);

    expect(fired).toEqual([{ phase: 'idle', elapsedMs: 10_000 }]);
  });

  test('pause suppresses timeout while waiting for user permission', () => {
    const timers = fakeTimers(3_000);
    const fired: StreamWatchdogTimeout[] = [];
    const watchdog = new StreamWatchdog({
      now: timers.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      connectTimeoutMs: 30_000,
      idleTimeoutMs: 10_000,
      onTimeout: (timeout) => fired.push(timeout),
    });

    watchdog.start();
    watchdog.markActivity();
    watchdog.pause();
    timers.advance(600_000);
    expect(fired).toEqual([]);

    watchdog.resume();
    timers.advance(9_999);
    expect(fired).toEqual([]);
    timers.advance(1);
    expect(fired).toEqual([{ phase: 'idle', elapsedMs: 10_000 }]);
  });

  test('nested pauses require matching resumes before idle timeout restarts', () => {
    const timers = fakeTimers(3_500);
    const fired: StreamWatchdogTimeout[] = [];
    const watchdog = new StreamWatchdog({
      now: timers.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      connectTimeoutMs: 30_000,
      idleTimeoutMs: 10_000,
      onTimeout: (timeout) => fired.push(timeout),
    });

    watchdog.start();
    watchdog.markActivity();
    watchdog.pause();
    watchdog.pause();
    timers.advance(600_000);
    expect(fired).toEqual([]);

    watchdog.resume();
    timers.advance(60_000);
    expect(fired).toEqual([]);

    watchdog.resume();
    timers.advance(9_999);
    expect(fired).toEqual([]);
    timers.advance(1);
    expect(fired).toEqual([{ phase: 'idle', elapsedMs: 10_000 }]);
  });

  test('stop cancels the active timer', () => {
    const timers = fakeTimers(4_000);
    const fired: StreamWatchdogTimeout[] = [];
    const watchdog = new StreamWatchdog({
      now: timers.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      connectTimeoutMs: 1,
      idleTimeoutMs: 1,
      onTimeout: (timeout) => fired.push(timeout),
    });

    watchdog.start();
    watchdog.stop();
    timers.advance(1_000);

    expect(fired).toEqual([]);
  });
});

function fakeTimers(start: number) {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer: (callback: () => void, delayMs: number) => {
      const id = ++nextId;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimer: (timer: unknown) => {
      timers.delete(Number(timer));
    },
    advance: (deltaMs: number) => {
      const target = now + deltaMs;
      while (true) {
        let next: { id: number; at: number; callback: () => void } | undefined;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!next || timer.at < next.at)) {
            next = { id, at: timer.at, callback: timer.callback };
          }
        }
        if (!next) break;
        now = next.at;
        timers.delete(next.id);
        next.callback();
      }
      now = target;
    },
  };
}
