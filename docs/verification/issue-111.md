# Issue #111: Ambient office sound and music — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU, no display and no speakers) on this branch, at the issue's
last code commit (`4b71363`; the commit after it changes only the
README).

The blocker is built on this branch: #64, the 3D scene shell with its
**Scene settings** panel and their local storage
([`issue-64.md`](issue-64.md)). The sound sits in that panel and follows
the lift (#65) to each Floor.

## What was built

- **The settings, as data** (`scene/sound-settings.ts`,
  `useSoundSettings`): muted (**on by default**), the ambience's volume
  (60%) and the music's (40%), each 0 to 1, and each Floor's ambience by
  its id. Like the other scene settings they belong to the browser, in its
  local storage (`ai-office:sound-settings`); a stored value this version
  cannot read is dropped and its default kept, so a browser with nothing
  readable stored is muted.
- **Per-Floor ambience** (`ambiences`, `ambienceOf`): the lobby has its
  own; each Floor has open plan until the Owner picks quiet, café or
  server room for it. Each ambience is data: a room tone, a hum, far-off
  voices (each 0 to 1) and how many keys click a second with every Agent
  at work.
- **What plays** (`soundMix`): nothing at all while muted; otherwise the
  place's ambience at the ambience volume, its keys clicking as often as
  the share of the Floor's Agents that are typing, and the music at its
  volume.
- **The player** (`scene/sound-player.ts`): synthesised with the Web Audio
  API. Looped noise is filtered into the room tone, the hum (with a soft
  100 Hz tone) and voices (band-passed, wobbling slowly); key clicks are
  15 ms bursts at random (exponential gaps), and the music is a slow
  progression of soft triangle-wave chords (Cmaj7, Am7, Fmaj7, G6, 8 s
  each). Changes ease in over 0.4 s. **Nothing is made, not even an
  AudioContext, until a mix has something to play.** Muted again, it
  fades out and the context is suspended. Browsers only let a page play
  once it has had a click or a key, so it resumes then.
- **In the page** (`scene/office-sound.tsx`, `office-view.tsx`):
  `OfficeSound` plays where the lift is, with the share of that Floor's
  Agents at work; `SoundControls` in **Scene settings** has **Mute office
  sound** (checked by default), the **Ambience volume** and **Music
  volume** sliders (0 to 100%, with their values as text for screen
  readers) and, on a Floor, **This Floor's ambience**.
- **Licences:** there are no sound files. The art direction allows sounds
  only from its approved sources (Kenney, Quaternius, Poly Pizza CC0), and
  none has office ambience or background music, so the sound is AI
  Office's own, synthesised at run time. `THIRD-PARTY-NOTICES.md` now says
  so, with no row to add.
- **README:** a new "Ambient sound and music" section, and the sound in
  "Scene settings".

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). `pnpm build` passes too. See the note on
      timeouts under load below.
- [x] **Unit test: muted by default.**
  - `scene/sound-settings.test.ts`: the default settings and the store
    start muted; a browser that stored nothing, or nothing readable, is
    muted; by default nothing plays, in the lobby or on a Floor, even with
    every Agent at work; while muted nothing plays whatever the volumes.
  - `scene/sound-player.test.ts`, against a fake AudioContext: a muted mix
    makes nothing at all, not even an AudioContext, even after a click.
  - `scene/office-sound.test.tsx`: **Mute office sound** starts checked
    in the **Sound** group; `OfficeSound` asks its player for nothing
    audible by default.

Also checked: unmuting plays the place's ambience at the ambience volume
and the music at its own; each Floor keeps its own ambience and the lobby
has its own; keys click about six a second with every Agent at work on an
open plan and none with none; chords follow each other every 8 s while
the music is up and none play at volume 0; muting again fades every layer
to 0 and suspends the context, and unmuting resumes the same one; the
sliders and the Floor's ambience change the settings, which are stored;
volumes stay between 0 and 1; a browser without Web Audio plays nothing
and throws nothing.

### Not verifiable in this sandbox

- **How it sounds**: whether the ambience and music are pleasant and at a
  sensible level, the ease between places, and the autoplay behaviour of
  real browsers (sound unmuted in an earlier visit starting at the first
  click or key). The sandbox has no browser or audio output; this needs
  the host.
- The 3D Office's **Scene settings** panel in a real browser, including
  the end-to-end accessibility checks (Playwright and axe-core), which
  need a browser the sandbox does not have.

## Notes

- No migration and no dependency were added.
- **Timeouts under load.** The first two full runs of `pnpm test` after
  this issue's commits failed 7 tests (`floors.test.tsx`,
  `whiteboard.test.tsx`, `floor-layout.test.ts`'s clearance sweep), each
  "Test timed out in 5000ms", while the sandbox's host was at a load
  average of 70 to 115 on 16 CPUs. None is in code this issue touches,
  the same tests failed on this branch before any of this batch's
  changes under load (a run of the web app's tests at the base commit
  `47b77b5`: 5 failed, two in `floors.test.tsx` and three of
  `floor-layout.test.ts`'s clearance sweep, the latter timeouts), and the
  three files pass alone (104 of 104). Once the load had fallen, the full run below passed. No test
  was skipped, changed or given a longer timeout.

## Output of the checks

`pnpm lint` (tail):

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`, without Docker (the Postgres and Docker tests skip):

```text
 Test Files  235 passed (235)
      Tests  2768 passed | 366 skipped (3134)
   Duration  49.67s (tests 45%, import 30%, environment 14%, transform 8%, setup 2%)
```

`pnpm build` (tail):

```text
dist/assets/index-DFLyQ1yS.css              48.30 kB │ gzip:   9.85 kB
dist/assets/avatar-preview-DCNsOK-A.js      17.37 kB │ gzip:   5.56 kB
dist/assets/office-scene-Ce_7sCUq.js       506.29 kB │ gzip: 217.70 kB
dist/assets/materials-C18AzPA_.js          948.56 kB │ gzip: 254.22 kB
dist/assets/index-5pbF3I-r.js            1,019.79 kB │ gzip: 307.61 kB
✓ built in 2.83s
```

The new tests, verbose:

```text
✓ sound-player.test.ts > the sound player > makes nothing at all, not even an AudioContext, while muted
✓ sound-player.test.ts > the sound player > eases each layer to the mix once unmuted
✓ sound-player.test.ts > the sound player > clicks keys as often as the Floor's Agents work, and none while none does
✓ sound-player.test.ts > the sound player > plays one chord after another while the music is up, and none without it
✓ sound-player.test.ts > the sound player > fades out and rests when muted again, and plays again when unmuted
✓ sound-player.test.ts > the sound player > waits for the Owner's first click or key when the browser has not let it play yet
✓ sound-player.test.ts > the sound player > plays nothing where the browser has no Web Audio
✓ sound-settings.test.ts > the sound settings > are muted by default
✓ sound-settings.test.ts > the sound settings > are muted in a browser that has stored nothing, or nothing it can read
✓ sound-settings.test.ts > the sound settings > keep what the Owner set, in this browser
✓ sound-settings.test.ts > the sound settings > keep each volume between 0 and 1
✓ sound-settings.test.ts > the sound settings > drop a Floor's ambience this version does not know, keeping the others
✓ sound-settings.test.ts > a place's ambience > is the lobby's in the lobby, and open plan on a Floor until the Owner picks another
✓ sound-settings.test.ts > a place's ambience > is one of the Floors' ambiences, each with its layers between 0 and 1
✓ sound-settings.test.ts > what plays > is nothing at all by default, anywhere
✓ sound-settings.test.ts > what plays > is nothing while muted, whatever the volumes
✓ sound-settings.test.ts > what plays > is the place's ambience at the ambience volume, and the music at its own, once unmuted
✓ sound-settings.test.ts > what plays > follows each Floor's own ambience
✓ sound-settings.test.ts > what plays > types as busily as the Floor's Agents work
✓ sound-settings.test.ts > what plays > is silent at volume 0
✓ office-sound.test.tsx > the sound controls > start muted
✓ office-sound.test.tsx > the sound controls > unmute, and set each volume
✓ office-sound.test.tsx > the sound controls > choose the ambience of the Floor the lift is at, and none in the lobby
✓ office-sound.test.tsx > the Office's sound > plays nothing by default
✓ office-sound.test.tsx > the Office's sound > plays the Floor's ambience once unmuted, follows the lift, and stops when muted again
✓ office-sound.test.tsx > the Office's sound > lets the browser play on the Owner's clicks and keys, and stops for good when it goes
```
