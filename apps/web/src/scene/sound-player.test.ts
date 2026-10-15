import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chordSeconds,
  createSoundPlayer,
  layerLevels,
  scheduleEvery,
} from "./sound-player.ts";
import {
  defaultSoundSettings,
  soundMix,
  type SoundMix,
} from "./sound-settings.ts";

// The Office's ambient sound and music, synthesised with the Web Audio
// API, against a fake AudioContext: nothing is made while muted, the
// layers ease to the mix once unmuted, keys click as often as Agents work,
// chords follow each other, and muting again fades out and rests.

class FakeParam {
  value = 0;
  setTargetAtTime(value: number) {
    this.value = value;
    return this;
  }
  setValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class FakeNode {
  readonly kind: string;
  readonly gain = new FakeParam();
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  readonly playbackRate = new FakeParam();
  type = "";
  buffer: unknown = null;
  loop = false;
  started: number | undefined;
  stopped: number | undefined;
  readonly outputs: unknown[] = [];
  constructor(kind: string) {
    this.kind = kind;
  }
  connect<T>(target: T): T {
    this.outputs.push(target);
    return target;
  }
  start(at = 0) {
    this.started = at;
  }
  stop(at = 0) {
    this.stopped = at;
  }
}

class FakeContext {
  currentTime = 0;
  sampleRate = 8000;
  state: "running" | "suspended" | "closed" = "suspended";
  readonly destination = new FakeNode("destination");
  readonly nodes: FakeNode[] = [];
  private make(kind: string) {
    const node = new FakeNode(kind);
    this.nodes.push(node);
    return node;
  }
  createGain() {
    return this.make("gain");
  }
  createBiquadFilter() {
    return this.make("filter");
  }
  createOscillator() {
    return this.make("oscillator");
  }
  createBufferSource() {
    return this.make("buffer source");
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  suspend() {
    this.state = "suspended";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

let contexts: FakeContext[];
const createContext = () => {
  const context = new FakeContext();
  contexts.push(context);
  return context as unknown as AudioContext;
};

/** The player's layers' gains, in the order it makes them. */
const layers = (context: FakeContext) => {
  const direct = context.nodes.filter(
    (node) =>
      node.kind === "gain" &&
      node.outputs.some(
        (out) =>
          out === context.destination ||
          (out instanceof FakeNode &&
            out.kind === "filter" &&
            out.outputs.includes(context.destination)),
      ),
  );
  const [roomTone, hum, murmur, clicks, music] = direct;
  return { roomTone, hum, murmur, clicks, music };
};

const mix = (more: Partial<typeof defaultSoundSettings> = {}, working = 0) =>
  soundMix(
    { ...defaultSoundSettings, ...more },
    { floorId: "web-shop", working },
  );

const started = (context: FakeContext, kind: string) =>
  context.nodes.filter(
    (node) => node.kind === kind && node.started !== undefined,
  );

beforeEach(() => {
  contexts = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the sound player", () => {
  it("makes nothing at all, not even an AudioContext, while muted", () => {
    const player = createSoundPlayer({ createContext });
    player.apply(mix());
    player.unlock();
    vi.advanceTimersByTime(10_000);
    expect(contexts).toHaveLength(0);
    player.dispose();
  });

  it("eases each layer to the mix once unmuted", () => {
    const player = createSoundPlayer({ createContext });
    const playing: SoundMix = mix({ muted: false });
    player.apply(playing);
    expect(contexts).toHaveLength(1);
    const context = contexts[0] ?? new FakeContext();
    const { roomTone, hum, murmur, music } = layers(context);
    expect(roomTone?.gain.value).toBeCloseTo(
      playing.roomTone * layerLevels.roomTone,
      6,
    );
    expect(hum?.gain.value).toBeCloseTo(playing.hum * layerLevels.hum, 6);
    expect(murmur?.gain.value).toBeCloseTo(
      playing.murmur * layerLevels.murmur,
      6,
    );
    expect(music?.gain.value).toBeCloseTo(playing.music * layerLevels.music, 6);
    expect(context.state).toBe("running");
    player.dispose();
    expect(context.state).toBe("closed");
  });

  it("clicks keys as often as the Floor's Agents work, and none while none does", () => {
    const random = (() => {
      let seed = 1;
      return () => {
        seed = (seed * 16_807) % 2_147_483_647;
        return seed / 2_147_483_647;
      };
    })();
    const player = createSoundPlayer({ createContext, random });
    player.apply(mix({ muted: false }, 0));
    const context = contexts[0] ?? new FakeContext();
    const clicks = () =>
      started(context, "buffer source").filter((node) => !node.loop).length;
    for (let tick = 0; tick < 50; tick += 1) {
      context.currentTime += scheduleEvery / 1000;
      vi.advanceTimersByTime(scheduleEvery);
    }
    expect(clicks()).toBe(0);

    player.apply(mix({ muted: false }, 1));
    const before = clicks();
    // Ten seconds of every Agent typing on an open plan: about 6 a second.
    for (let tick = 0; tick < 50; tick += 1) {
      context.currentTime += scheduleEvery / 1000;
      vi.advanceTimersByTime(scheduleEvery);
    }
    const typed = clicks() - before;
    expect(typed).toBeGreaterThan(30);
    expect(typed).toBeLessThan(90);
    player.dispose();
  });

  it("plays one chord after another while the music is up, and none without it", () => {
    const player = createSoundPlayer({ createContext });
    player.apply(mix({ muted: false, musicVolume: 0 }));
    const context = contexts[0] ?? new FakeContext();
    const tones = () =>
      started(context, "oscillator").filter((node) => node.type === "triangle")
        .length;
    for (let tick = 0; tick < 100; tick += 1) {
      context.currentTime += scheduleEvery / 1000;
      vi.advanceTimersByTime(scheduleEvery);
    }
    expect(tones()).toBe(0);

    player.apply(mix({ muted: false, musicVolume: 0.5 }));
    const start = context.currentTime;
    while (context.currentTime < start + chordSeconds * 2.5) {
      context.currentTime += scheduleEvery / 1000;
      vi.advanceTimersByTime(scheduleEvery);
    }
    // Three chords of four notes each, every chord fading out after it ends.
    expect(tones()).toBe(12);
    player.dispose();
  });

  it("fades out and rests when muted again, and plays again when unmuted", () => {
    const player = createSoundPlayer({ createContext });
    player.apply(mix({ muted: false }));
    const context = contexts[0] ?? new FakeContext();
    player.apply(mix({ muted: true }));
    for (const layer of Object.values(layers(context))) {
      expect(layer?.gain.value).toBe(0);
    }
    vi.advanceTimersByTime(5_000);
    expect(context.state).toBe("suspended");
    player.apply(mix({ muted: false }));
    expect(context.state).toBe("running");
    expect(contexts).toHaveLength(1);
    player.dispose();
  });

  it("waits for the Owner's first click or key when the browser has not let it play yet", async () => {
    const player = createSoundPlayer({ createContext });
    player.apply(mix({ muted: false }));
    const context = contexts[0] ?? new FakeContext();
    // As a browser does without a gesture: resuming leaves it suspended.
    context.state = "suspended";
    const resume = vi.spyOn(context, "resume");
    player.unlock();
    await Promise.resolve();
    expect(resume).toHaveBeenCalledOnce();
    player.dispose();
  });

  it("plays nothing where the browser has no Web Audio", () => {
    const player = createSoundPlayer({ createContext: () => undefined });
    expect(() => {
      player.apply(mix({ muted: false }));
      player.unlock();
      player.dispose();
    }).not.toThrow();
  });
});
