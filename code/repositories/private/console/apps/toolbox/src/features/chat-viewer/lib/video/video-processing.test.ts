import { describe, expect, it } from "vitest";

import { buildFrameSchedule } from "./frame-sampler";
import { detectDesktopWechatChatRegion } from "./region-detect";

describe("buildFrameSchedule", () => {
  it("builds an evenly spaced schedule for the full duration", () => {
    expect(buildFrameSchedule({ durationSeconds: 10, framesPerSecond: 2 })).toEqual([
      0,
      0.5,
      1,
      1.5,
      2,
      2.5,
      3,
      3.5,
      4,
      4.5,
      5,
      5.5,
      6,
      6.5,
      7,
      7.5,
      8,
      8.5,
      9,
      9.5,
    ]);
  });

  it("truncates the schedule to maxFrames", () => {
    expect(
      buildFrameSchedule({
        durationSeconds: 10,
        framesPerSecond: 2,
        maxFrames: 5,
      }),
    ).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it("returns an empty schedule when duration is 0", () => {
    expect(buildFrameSchedule({ durationSeconds: 0, framesPerSecond: 2 })).toEqual([]);
  });
});

describe("detectDesktopWechatChatRegion", () => {
  it("detects a conservative desktop chat region inside a 1440x900 frame", () => {
    const region = detectDesktopWechatChatRegion({ width: 1440, height: 900 });

    expect(region.x).toBeGreaterThanOrEqual(280);
    expect(region.y).toBeGreaterThanOrEqual(40);
    expect(region.width).toBeGreaterThan(800);
    expect(region.height).toBeGreaterThan(600);
    expect(region.x + region.width).toBeLessThanOrEqual(1440);
    expect(region.y + region.height).toBeLessThanOrEqual(900);
  });
});
