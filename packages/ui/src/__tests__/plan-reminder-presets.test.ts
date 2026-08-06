import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { planReminderPresetRunAt } from '../plan-reminder-helpers.js';

/**
 * The one-tap presets carry the form's only shortcut past the date picker, and
 * they were deleted once already without a single test failing — nothing in
 * the repo referenced this helper, so removing it looked free. These tests
 * exist so the next deletion has to be deliberate.
 *
 * Fixed instants, never `Date.now()`: "next Monday" is only meaningful
 * relative to a known weekday, and a test whose expectation moves with the
 * calendar cannot pin a boundary.
 */
describe('plan reminder presets', () => {
  const MONDAY_10AM = new Date(2026, 7, 3, 10, 0, 0, 0).getTime(); // Mon 2026-08-03
  const FRIDAY_10AM = new Date(2026, 7, 7, 10, 0, 0, 0).getTime(); // Fri 2026-08-07
  const SUNDAY_10AM = new Date(2026, 7, 9, 10, 0, 0, 0).getTime(); // Sun 2026-08-09

  it('offsets the two relative presets from the moment asked', () => {
    assert.equal(planReminderPresetRunAt('ten-minutes', MONDAY_10AM), MONDAY_10AM + 10 * 60 * 1000);
    assert.equal(planReminderPresetRunAt('one-hour', MONDAY_10AM), MONDAY_10AM + 60 * 60 * 1000);
  });

  it('pins the morning presets to 09:00 rather than the current time of day', () => {
    const at = new Date(planReminderPresetRunAt('tomorrow-morning', MONDAY_10AM));
    assert.equal(at.getDate(), 4, 'the next calendar day');
    assert.equal(at.getHours(), 9);
    assert.equal(at.getMinutes(), 0);
    assert.equal(at.getSeconds(), 0);
    assert.equal(at.getMilliseconds(), 0, 'sub-minute fields cleared, or the label lies');
  });

  /**
   * The boundary the modulo exists for. `(8 - 1) % 7` is 0 on a Monday, so a
   * bare modulo would schedule "next Monday" for the Monday already underway —
   * nine hours in the past at 10:00. The `|| 7` is what makes it a week out.
   */
  it('reads next Monday as the following week when asked on a Monday', () => {
    const at = new Date(planReminderPresetRunAt('next-monday', MONDAY_10AM));
    assert.equal(at.getDay(), 1, 'still a Monday');
    assert.equal(at.getDate(), 10, 'seven days on, not today');
    assert.ok(at.getTime() > MONDAY_10AM, 'a reminder is never scheduled in the past');
    assert.equal(at.getHours(), 9);
  });

  it('reaches the coming Monday from mid-week and from Sunday', () => {
    const fromFriday = new Date(planReminderPresetRunAt('next-monday', FRIDAY_10AM));
    assert.equal(fromFriday.getDay(), 1);
    assert.equal(fromFriday.getDate(), 10, 'three days on');

    // Sunday is the tightest non-Monday case: one day out, and the naive
    // `(8 - 0) % 7 = 1` happens to be right here, which is why Monday rather
    // than Sunday is the case that actually guards the `|| 7`.
    const fromSunday = new Date(planReminderPresetRunAt('next-monday', SUNDAY_10AM));
    assert.equal(fromSunday.getDay(), 1);
    assert.equal(fromSunday.getDate(), 10, 'the very next day');
  });

  it('never returns a past instant for any preset or weekday', () => {
    const presets = ['ten-minutes', 'one-hour', 'tomorrow-morning', 'next-monday'] as const;
    for (let day = 0; day < 7; day++) {
      const now = new Date(2026, 7, 3 + day, 10, 0, 0, 0).getTime();
      for (const preset of presets) {
        assert.ok(
          planReminderPresetRunAt(preset, now) > now,
          `${preset} on weekday ${new Date(now).getDay()} must land in the future`,
        );
      }
    }
  });
});
