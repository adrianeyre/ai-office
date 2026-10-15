import { audible, type SoundMix } from "./sound-settings.ts";

// The Office's ambient sound and music (PRD FR-64), synthesised in the
// browser with the Web Audio API: no recordings, so no third-party sound
// files. The ambience is noise shaped into a room's tone, an air
// conditioning hum and far-off voices, with keyboard clicks as often as
// the place's Agents type; the music is a slow progression of soft
// chords. Nothing is made, not even an AudioContext, until a mix has
// something to play; muted again, it fades out and the context is
// suspended.

/** How loud each layer is at its loudest, before the Owner's volume. */
export const layerLevels = {
  roomTone: 0.18,
  hum: 0.12,
  murmur: 0.1,
  click: 0.05,
  music: 0.12,
} as const;

/** How long a change of mix takes to settle, as a time constant, in seconds. */
export const easeSeconds = 0.4;

/** How often the clicks and chords ahead are scheduled, in milliseconds. */
export const scheduleEvery = 200;

/** How long each chord lasts, in seconds; the next starts as it fades. */
export const chordSeconds = 8;

/** Cmaj7, Am7, Fmaj7 and G6, low and close, in Hz. */
export const chords: readonly (readonly number[])[] = [
  [130.81, 164.81, 196, 246.94],
  [110, 130.81, 164.81, 196],
  [87.31, 110, 130.81, 164.81],
  [98, 123.47, 146.83, 164.81],
];

export interface SoundPlayer {
  /** Eases to a mix; makes nothing while it, and every mix before it, is silent. */
  readonly apply: (mix: SoundMix) => void;
  /**
   * Lets the page play sound. Browsers allow it only once the Owner has
   * interacted with the page, so this is called on their clicks and keys.
   */
  readonly unlock: () => void;
  /** Stops everything for good. */
  readonly dispose: () => void;
}

/** The parts of a running graph that a mix sets. */
interface Graph {
  readonly context: AudioContext;
  readonly roomTone: GainNode;
  readonly hum: GainNode;
  readonly murmur: GainNode;
  readonly clicks: GainNode;
  readonly music: GainNode;
  readonly click: AudioBuffer;
}

const defaultContext = (): AudioContext | undefined =>
  "AudioContext" in globalThis ? new AudioContext() : undefined;

/** Seconds of white noise, looped as the ambience's source. */
function noise(context: AudioContext, seconds: number, random: () => number) {
  const length = Math.round(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) {
    data[index] = random() * 2 - 1;
  }
  return buffer;
}

/** A key's click: 15 ms of noise, dying away. */
function clickBuffer(context: AudioContext, random: () => number) {
  const length = Math.round(context.sampleRate * 0.015);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) {
    data[index] = (random() * 2 - 1) * (1 - index / length) ** 3;
  }
  return buffer;
}

function filter(
  context: AudioContext,
  type: BiquadFilterType,
  frequency: number,
  q = 0.7,
): BiquadFilterNode {
  const node = context.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = q;
  return node;
}

function gain(context: AudioContext, value: number): GainNode {
  const node = context.createGain();
  node.gain.value = value;
  return node;
}

function build(context: AudioContext, random: () => number): Graph {
  const out = context.destination;
  const source = context.createBufferSource();
  source.buffer = noise(context, 4, random);
  source.loop = true;

  const roomTone = gain(context, 0);
  source.connect(filter(context, "lowpass", 600)).connect(roomTone);
  roomTone.connect(out);

  const hum = gain(context, 0);
  source.connect(filter(context, "lowpass", 120, 1.5)).connect(hum);
  const mains = context.createOscillator();
  mains.type = "sine";
  mains.frequency.value = 100;
  mains.connect(gain(context, 0.15)).connect(hum);
  hum.connect(out);

  // Voices come and go: a slow wobble on the murmur.
  const murmur = gain(context, 0);
  const wobble = gain(context, 0.6);
  const lfo = context.createOscillator();
  lfo.frequency.value = 0.23;
  lfo.connect(gain(context, 0.4)).connect(wobble.gain);
  source
    .connect(filter(context, "bandpass", 500, 1.2))
    .connect(wobble)
    .connect(murmur);
  murmur.connect(out);

  const clicks = gain(context, 0);
  clicks.connect(filter(context, "highpass", 2000)).connect(out);

  const music = gain(context, 0);
  music.connect(filter(context, "lowpass", 1400)).connect(out);

  source.start();
  mains.start();
  lfo.start();
  return {
    context,
    roomTone,
    hum,
    murmur,
    clicks,
    music,
    click: clickBuffer(context, random),
  };
}

/** Plays one chord on `music` from `at`, easing in and out. */
function playChord(graph: Graph, notes: readonly number[], at: number) {
  const { context, music } = graph;
  const end = at + chordSeconds + 1;
  for (const frequency of notes) {
    const tone = context.createOscillator();
    tone.type = "triangle";
    tone.frequency.value = frequency;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(1 / notes.length, at + 2);
    envelope.gain.setValueAtTime(1 / notes.length, end - 2.5);
    envelope.gain.linearRampToValueAtTime(0, end);
    tone.connect(envelope).connect(music);
    tone.start(at);
    tone.stop(end);
  }
}

/** Plays one key's click at `at`, at a pitch of its own. */
function playClick(graph: Graph, at: number, pitch: number) {
  const click = graph.context.createBufferSource();
  click.buffer = graph.click;
  click.playbackRate.value = 0.8 + pitch * 0.4;
  click.connect(graph.clicks);
  click.start(at);
}

export function createSoundPlayer({
  createContext = defaultContext,
  random = Math.random,
}: {
  readonly createContext?: () => AudioContext | undefined;
  readonly random?: () => number;
} = {}): SoundPlayer {
  let graph: Graph | undefined;
  let mix: SoundMix | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let suspending: ReturnType<typeof setTimeout> | undefined;
  let nextChord = 0;
  let chord = 0;
  let scheduledTo = 0;

  // The clicks and chords for the next while, so none is late.
  const schedule = () => {
    if (graph === undefined || mix === undefined || !audible(mix)) {
      return;
    }
    const now = graph.context.currentTime;
    const until = now + (scheduleEvery / 1000) * 2;
    let at = Math.max(scheduledTo, now);
    if (mix.clicksPerSecond > 0) {
      // Keys are pressed at random: the gaps between them are exponential.
      at += -Math.log(1 - random()) / mix.clicksPerSecond;
      while (at < until) {
        playClick(graph, at, random());
        at += -Math.log(1 - random()) / mix.clicksPerSecond;
      }
    }
    scheduledTo = until;
    if (mix.music > 0) {
      if (nextChord < now) {
        nextChord = now + 0.05;
      }
      while (nextChord < until) {
        playChord(graph, chords[chord % chords.length] ?? [], nextChord);
        chord += 1;
        nextChord += chordSeconds;
      }
    } else {
      nextChord = 0;
    }
  };

  return {
    apply(next) {
      mix = next;
      if (graph === undefined) {
        if (!audible(next)) {
          return;
        }
        const context = createContext();
        if (context === undefined) {
          return;
        }
        graph = build(context, random);
      }
      const { context } = graph;
      const now = context.currentTime;
      const ease = (node: GainNode, value: number) => {
        node.gain.cancelScheduledValues(now);
        node.gain.setTargetAtTime(value, now, easeSeconds);
      };
      ease(graph.roomTone, next.roomTone * layerLevels.roomTone);
      ease(graph.hum, next.hum * layerLevels.hum);
      ease(graph.murmur, next.murmur * layerLevels.murmur);
      ease(graph.clicks, next.clicks * layerLevels.click);
      ease(graph.music, next.music * layerLevels.music);
      clearTimeout(suspending);
      suspending = undefined;
      if (audible(next)) {
        if (context.state === "suspended") {
          void context.resume().catch(() => undefined);
        }
        timer ??= setInterval(schedule, scheduleEvery);
        schedule();
      } else {
        clearInterval(timer);
        timer = undefined;
        // Once it has faded out, the context rests.
        suspending = setTimeout(
          () => {
            void context.suspend().catch(() => undefined);
          },
          easeSeconds * 5 * 1000,
        );
      }
    },
    unlock() {
      if (
        graph !== undefined &&
        mix !== undefined &&
        audible(mix) &&
        graph.context.state === "suspended"
      ) {
        void graph.context.resume().catch(() => undefined);
      }
    },
    dispose() {
      clearInterval(timer);
      clearTimeout(suspending);
      timer = undefined;
      void graph?.context.close().catch(() => undefined);
      graph = undefined;
    },
  };
}
