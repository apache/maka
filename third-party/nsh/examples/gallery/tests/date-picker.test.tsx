// The DatePicker demo: a due date on weekdays with a clear button, a
// trip's range with presets, and a meeting's day and time; a booking's stay
// priced by the night, a deadline with quick presets and a locked start, and
// a weekday's time slots. On a phone
// (headless runs are touch screens) the calendar is a sheet; on a desktop
// a popup. The app's clock starts on Wednesday 2026-10-28, so today and
// the presets are known; days are named by their ISO dates.
import { beforeEach, describe, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

describe("on a phone", () => {
  let app: App;
  beforeEach(async () => {
    app = await open("../App.tsx", { clock: { time: new Date(2026, 9, 28, 12) } });
    await app.press("role:button[DatePicker]");
    await app.waitFor("role:combobox[Due date]");
  });

  test("a due date is a weekday, and the clear button empties it", async () => {
    await app.press("role:combobox[Due date]");
    await app.waitFor("label:2026-10-30");
    // Saturday and Sunday take no press.
    expect(app.enabled("label:2026-10-31")).toBe(false);
    expect(app.enabled("label:2026-10-25")).toBe(false);
    expect(app.enabled("label:2026-10-29")).toBe(true);
    await app.press("label:2026-10-30");
    await app.waitFor("Due: 2026-10-30");
    await app.waitUntil(() => !app.shows("label:2026-10-30"));
    await app.waitFor("Oct 30, 2026");
    await app.press("label:Clear the due date");
    await app.waitFor("Due: none");
    await app.waitFor("No due date");
  });

  test("a trip takes two days, or a preset", async () => {
    await app.press("role:combobox[Trip]");
    await app.waitFor("label:2026-10-29");
    // The first day starts the range; only the second ends and reports it.
    await app.press("label:2026-10-29");
    expect(app.shows("label:2026-10-30")).toBe(true);
    expect(app.shows("—")).toBe(true);
    await app.press("label:2026-10-30");
    await app.waitFor("Trip: 2026-10-29 → 2026-10-30");
    await app.waitFor("Oct 29 – Oct 30");
    await app.waitUntil(() => !app.shows("label:2026-10-29"));
    // The coming weekend, from the app's today.
    await app.press("role:combobox[Trip]");
    await app.waitFor("role:button[Weekend]");
    await app.press("role:button[Weekend]");
    await app.waitFor("Trip: 2026-10-31 → 2026-11-01");
    await app.waitUntil(() => !app.shows("role:button[Weekend]"));
    await app.waitFor("Oct 31 – Nov 1");
  });

  test("a tap on the meeting's day closes its sheet, which opens again for the time", async () => {
    await app.press("role:combobox[Meeting]");
    await app.waitFor("label:2026-10-29");
    // One tap: the day at the default time, and the sheet goes.
    await app.press("label:2026-10-29");
    await app.waitFor("Meeting: 2026-10-29T09:00");
    await app.waitUntil(() => !app.shows("label:2026-10-29"));
    await app.waitFor("Oct 29, 2026 · 09:00");
    // Open again for the time: the field takes digits, the hour, then the minute.
    await app.press("role:combobox[Meeting]");
    await app.waitFor("label:Meeting time");
    await app.type("label:Meeting time", "1430");
    await app.waitFor("Meeting: 2026-10-29T14:30");
    // Another day keeps the time, and closes the sheet.
    await app.press("label:2026-10-30");
    await app.waitFor("Meeting: 2026-10-30T14:30");
    await app.waitUntil(() => !app.shows("label:2026-10-30"));
    await app.waitFor("Oct 30, 2026 · 14:30");
  });

  test("a stay takes a check-in and a check-out from today on: the nights and the price follow", async () => {
    expect(app.texts()).toContain("No dates");
    await app.press("role:combobox[Stay]");
    await app.waitFor("label:2026-10-29");
    // The past cannot be booked (the app's function, asked a turn later).
    await app.waitUntil(() => !app.enabled("label:2026-10-27"));
    await app.press("label:2026-10-29");
    await app.press("label:2026-10-31");
    await app.waitFor("Stay: 2026-10-29 → 2026-10-31");
    await app.waitFor("2 nights");
    // A Thursday at $180 and a Friday at $220, then the cleaning.
    expect(app.texts()).toContain("$400.00");
    expect(app.texts()).toContain("$440.00");
    await app.press("role:button[Reserve]");
    await app.waitFor("Reserved: 2026-10-29 → 2026-10-31, $440.00");
  });

  test("a deadline takes a preset or a day from today on, and a locked date does not open", async () => {
    await app.waitFor("Due in 2 days");
    await app.press("role:combobox[Deadline]");
    await app.waitFor("role:button[Tomorrow]");
    expect(app.enabled("label:2026-10-27")).toBe(false);
    await app.press("role:button[Tomorrow]");
    await app.waitFor("Deadline: 2026-10-29");
    await app.waitFor("Due tomorrow");
    await app.waitUntil(() => !app.shows("role:button[Tomorrow]"));
    await app.press("label:Clear the deadline");
    await app.waitFor("Deadline: none");
    await app.waitFor("No deadline");
    expect(app.enabled("role:combobox[Sprint start]")).toBe(false);
  });

  test("a time slot is one of the open times of a weekday from tomorrow on", async () => {
    // Tomorrow, a Thursday, at first: its booked times take no press, and nothing is booked yet.
    expect(app.enabled("role:radio[10:00]")).toBe(false);
    expect(app.enabled("role:button[Pick a time]")).toBe(false);
    await app.press("role:radio[10:30]");
    await app.waitFor("Slot: 2026-10-29 10:30");
    await app.press("role:button[Book Thu, Oct 29 at 10:30]");
    await app.waitFor("Booked: Thu, Oct 29 at 10:30");
    // Another day has its own booked times, and none chosen.
    await app.press("role:combobox[Appointment day]");
    await app.waitFor("label:2026-10-30");
    await app.waitUntil(() => !app.enabled("label:2026-10-31"));
    expect(app.enabled("label:2026-10-28")).toBe(false);
    await app.press("label:2026-10-30");
    await app.waitFor("Day: 2026-10-30");
    await app.waitUntil(() => !app.shows("label:2026-10-30"));
    expect(app.enabled("role:radio[09:00]")).toBe(false);
    expect(app.enabled("role:radio[10:00]")).toBe(true);
    expect(app.enabled("role:button[Pick a time]")).toBe(false);
  });
});
