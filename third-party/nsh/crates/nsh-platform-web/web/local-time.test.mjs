// The page's answers for Intl's default zone (the `time_zone` import) and
// local time's offset (`local_offset`), in
// several zones: `node --test crates/nsh-platform-web/web/local-time.test.mjs`.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("nsh.js", import.meta.url), "utf8");
// The helper is not exported; the page only uses it as a wasm import.
const { localOffset, timeZoneName } = await import(
  `data:text/javascript,${encodeURIComponent(`${source}\nexport { localOffset, timeZoneName };`)}`
);

/** Runs `f` with the process in time zone `zone` (node follows `TZ` as it changes). */
function inZone(zone, f) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    f();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

test("the zone is the one the browser runs in", () => {
  for (const zone of ["Asia/Shanghai", "America/New_York"]) {
    inZone(zone, () => assert.equal(timeZoneName(), zone));
  }
  inZone("UTC", () => assert.ok(["UTC", "Etc/UTC"].includes(timeZoneName()), timeZoneName()));
});

test("the offset is local time's at that moment, east of UTC", () => {
  const winter = Date.UTC(2026, 0, 15);
  const summer = Date.UTC(2026, 6, 15);
  inZone("Asia/Shanghai", () => assert.equal(localOffset(winter), 8 * 3600));
  inZone("America/New_York", () => {
    assert.equal(localOffset(winter), -5 * 3600);
    assert.equal(localOffset(summer), -4 * 3600);
  });
  inZone("UTC", () => assert.equal(localOffset(winter), 0));
});
