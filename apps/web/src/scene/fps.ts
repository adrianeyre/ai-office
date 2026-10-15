import { create } from "zustand";

// The frame rate, measured in the render loop and shown by the FPS overlay,
// an HTML panel outside the canvas. It is read twice a second, so the
// overlay re-renders twice a second rather than every frame.

export interface FpsReading {
  /** Frames a second over the last interval. */
  readonly fps: number;
  /** The mean time between frames over that interval, in milliseconds. */
  readonly frameMs: number;
}

/** Counts frames, and reads the rate once every `intervalMs`. */
export class FpsMeter {
  private started: number | undefined;
  private frames = 0;
  private readonly intervalMs: number;

  constructor(intervalMs = 500) {
    this.intervalMs = intervalMs;
  }

  /**
   * Counts a frame drawn at `now` (milliseconds); returns a reading when
   * an interval has passed since the last one, and undefined otherwise.
   */
  frame(now: number): FpsReading | undefined {
    if (this.started === undefined) {
      this.started = now;
      return undefined;
    }
    this.frames += 1;
    const elapsed = now - this.started;
    if (elapsed < this.intervalMs) {
      return undefined;
    }
    const reading = {
      fps: (this.frames * 1000) / elapsed,
      frameMs: elapsed / this.frames,
    };
    this.started = now;
    this.frames = 0;
    return reading;
  }
}

/** The latest reading, while the overlay is on. */
export const useFpsStore = create<{ readonly reading: FpsReading | undefined }>(
  () => ({ reading: undefined }),
);
