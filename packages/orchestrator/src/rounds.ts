// Work done in rounds, one at a time, every interval, such as intake's
// look at each Floor's issues (PRD FR-8) or the Batches' check for issues
// whose dependencies are done (FR-25). A round may also be asked for now,
// as a GitHub webhook does: it starts at once, or straight after the round
// running, and the interval starts again from it.

export interface Rounds {
  /** Runs rounds every interval until stopped; the first now if asked. */
  start(options: { readonly now: boolean }): void;
  /** Stops, waiting for a round in progress to finish. */
  stop(): Promise<void>;
  /**
   * Runs a round now, or once the round running has finished; resolves
   * when a round that started after the call has finished. Rounds asked
   * for while one waits to start are run as one. Nothing happens while
   * stopped.
   */
  trigger(): Promise<void>;
}

export function createRounds(options: {
  /** One round. It should report its own failures; a rejection is ignored. */
  readonly run: () => Promise<void>;
  /** How long until the next round, read after each round. */
  readonly intervalMs: () => Promise<number>;
}): Rounds {
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let round: Promise<void> = Promise.resolve();
  let busy = false;
  let again = false;
  // Read through a function: `trigger()` sets it while a round awaits.
  const askedAgain = (): boolean => again;
  /** Told when the next round to start has finished. */
  let waiting: (() => void)[] = [];

  const tell = (told: readonly (() => void)[]): void => {
    for (const resolve of told) {
      resolve();
    }
  };

  const tick = (): void => {
    clearTimeout(timer);
    busy = true;
    round = (async () => {
      for (;;) {
        again = false;
        const told = waiting;
        waiting = [];
        await options.run().catch(() => undefined);
        tell(told);
        const intervalMs = await options.intervalMs();
        // A round asked for while this one ran (or `stop()`) decides what
        // comes next.
        if (!askedAgain() || !running) {
          busy = false;
          if (running) {
            timer = setTimeout(tick, intervalMs);
          } else {
            tell(waiting);
            waiting = [];
          }
          return;
        }
      }
    })();
  };

  return {
    start({ now }) {
      if (running) {
        return;
      }
      running = true;
      if (now) {
        tick();
      } else {
        void options.intervalMs().then((intervalMs) => {
          if (running && !busy) {
            clearTimeout(timer);
            timer = setTimeout(tick, intervalMs);
          }
        });
      }
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      await round;
      tell(waiting);
      waiting = [];
    },
    trigger() {
      if (!running) {
        return Promise.resolve();
      }
      const finished = new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
      if (busy) {
        again = true;
      } else {
        tick();
      }
      return finished;
    },
  };
}
