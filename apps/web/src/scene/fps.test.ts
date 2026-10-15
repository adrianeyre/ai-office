import { describe, expect, it } from "vitest";

import { FpsMeter } from "./fps.ts";

describe("the FPS meter", () => {
  it("reads the frame rate once an interval, from the frames in it", () => {
    const meter = new FpsMeter(500);
    expect(meter.frame(1000)).toBeUndefined();
    // 30 frames, 1/60 s apart: half a second.
    const readings = Array.from({ length: 30 }, (_, index) =>
      meter.frame(1000 + ((index + 1) * 1000) / 60),
    );
    expect(
      readings.slice(0, -1).every((reading) => reading === undefined),
    ).toBe(true);
    const reading = readings.at(-1);
    expect(reading?.fps).toBeCloseTo(60);
    expect(reading?.frameMs).toBeCloseTo(16.67, 1);
  });

  it("starts each interval afresh", () => {
    const meter = new FpsMeter(1000);
    meter.frame(0);
    for (let frame = 1; frame <= 60; frame += 1) {
      meter.frame((frame * 1000) / 60);
    }
    // The next second runs at 20 fps.
    let reading;
    for (let frame = 1; frame <= 20; frame += 1) {
      reading = meter.frame(1000 + frame * 50);
    }
    expect(reading?.fps).toBeCloseTo(20);
    expect(reading?.frameMs).toBeCloseTo(50);
  });

  it("reads a long stall as the slow frame it was", () => {
    const meter = new FpsMeter(500);
    meter.frame(0);
    expect(meter.frame(2000)).toEqual({ fps: 0.5, frameMs: 2000 });
  });
});
