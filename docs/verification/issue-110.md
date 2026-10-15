# Issue #110: Idle behaviours — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) on this branch, at the issue's last code
commit (`a7a5119`).

The blocker is built on this branch: #74, Handoff walks
([`issue-74.md`](issue-74.md)). Idle trips reuse its walk: standing up,
stepping off the chair to the walkway (`stepOff`, now exported), the
waypoint graph's shortest way (`walk()`), the walking pace and the
`stand-up`, `walk` and `sit-down` animations. They also stand on:

- #66, the Floor's layout ([`issue-66.md`](issue-66.md)): the canteen's
  coffee machine, the gym and the water cooler, each with its waypoint;
- #70, the character kit ([`issue-70.md`](issue-70.md)), whose `stretch`,
  `drink` (with a mug), `work-out`, `chat` and `sleep` animations were
  made for this issue's activities;
- #73, the Agents' states in the Office ([`issue-73.md`](issue-73.md)):
  an Agent's look (typing, waiting on review, sitting back; its marker;
  its pile of tickets) says whether it has anything to do.

## What was built

- **The activities, as data** (`scene/idle-behaviours.ts`,
  `idleActivities`): each has a name, when it may be chosen (`finished`,
  `idle` or `long idle`), its location, its animation, its duration, its
  weight, its occupancy limit and an optional bubble:

  | Activity | When | Location | Animation | Duration | Weight | Occupancy |
  | --- | --- | --- | --- | --- | --- | --- |
  | stretch | once, on finishing work | beside the desk | `stretch` | 6.4 s | 1 | its own |
  | coffee | idle | `coffee-machine` | `drink` | 16 s | 3 | 2 |
  | workout | idle | `gym` | `work-out` | 20 s | 2 | 2 |
  | water-cooler chat | idle | `water-cooler` | `chat` | 18 s | 3 | 3 |
  | doze ("zzz") | idle for 180 s | the chair | `sleep` | 44 s | 4 | its own |

  A new activity is one more entry. Each amenity has its standing places
  (`idlePlaces`): two at the canteen's counter facing the coffee machine,
  two on the gym's mat, three round the water cooler facing each other.
- **The weighted choice** (`chooseActivity`): each candidate's share of a
  draw is as wide as its weight; one weighted 0 is never chosen.
- **Idling** (`advanceIdle`, pure; `createIdleBehaviours`, as the scene
  keeps it): an idle Agent rests 20 to 60 s (at random), then chooses by
  weight among the activities that may be chosen now and whose location
  has room. Occupancy counts every Agent at the location, whatever it is
  doing there, and each takes a free place; an Agent's own chair and desk
  are its alone. One turned away rests again. Having finished work, an
  Agent stretches first.
- **The trip** (`idleTrip`, `idlePose`): stand up, step off the chair to
  the walkway, along the waypoints to the amenity's waypoint and on to its
  place, play the activity facing its way, walk back, sit down. A doze is
  in the chair; a stretch is a step aside from it.
- **Interruption** (`idleStateOf`): an Agent is idle only while it sits
  back with no marker and no tickets, and is not walking a Handoff; it is
  working while it types, and busy otherwise. The moment it is not idle
  its activity ends, whatever the phase, and it is back in its chair:
  there is no walk back. The pipeline does not depend on the scene at
  all, so idling cannot delay work.
- **In the scene** (`scene/idle-activities.tsx`, `desk-agents.tsx`,
  `floor.tsx`): `IdleActivities` advances the Floor's idling each frame
  from each Agent's look and Handoff walk, and again the moment the looks
  change; `DeskAgent` takes its place, heading and animation from its
  Handoff walk, else its idle activity, else its desk. The doze's "zzz"
  is HTML over the canvas (drei's `Html`, as the ticket labels are),
  `aria-hidden`, with no pointer events. With reduced motion no one idles
  about.
- **README:** a new "Idle behaviours" section.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). `pnpm build` passes too.
- [x] **Unit tests: weighted choice.** `scene/idle-behaviours.test.ts`,
      "choosing an idle activity": the draw's bands are as wide as the
      weights (0 and 0.2499 → weight 1 of 4; 0.25 and 0.9999 → weight 3);
      20,000 seeded draws over the five activities land within 0.05 of
      each weight's share; weight 0 is never chosen; nothing is chosen
      from nothing. "idling" also checks a stretch comes first on
      finishing, and a doze only after 180 s idle.
- [x] **Unit tests: occupancy limits.** "each spot's occupancy limit":
      with all six Agents wanting coffee only two go, at different places;
      a spot counts every Agent there whatever it does (two chatting at
      the cooler leave no room for a third's activity limited to two);
      a place is freed as soon as its Agent leaves, and the next to finish
      resting takes it; an Agent's own chair and desk never limit another.
      "the idle activities" checks each amenity has a place for each
      Agent its limit lets in.
- [x] **Unit tests: interruption.** "a new task": in each phase of a trip
      (standing up, walking there, at the coffee machine, walking back,
      each phase checked by its animation), a change to working or busy
      ends the activity at the same instant (no time passing); a dozing
      Agent wakes and its "zzz" goes; once interrupted it starts nothing
      until it is idle again, then stretches; reduced motion stops every
      activity. `scene/idle-activities.test.tsx` checks it on a rendered
      Floor: the idle coder leaves its chair after its rest while the
      working Agents stay; given a task it is back in its seat on the very
      next frame (of 1 µs) and stays; with reduced motion it never leaves.

Also checked: every trip, for teams of 2, 5, 6, 9 and 12 and every place,
starts in the Agent's chair, ends at its place, stays on the Floor and at
least 0.2 m from anything standing once 0.45 m from the chair (sampled
every 5 cm); places at a spot are at least 0.6 m apart; each activity in
the chair is a seated animation and every other a standing one.

### Verified on the host

- [ ] **A quiet Floor looks alive and never delays work.** Not verifiable
      here: there is no GPU or display in the sandbox. That idling never
      delays work is covered above (the pipeline does not wait for the
      scene, and the scene drops an activity the instant the Agent has
      work); how alive a quiet Floor looks, the animations' feel, and the
      frame rate with Agents walking about need a browser on the host.

## Notes

- No migration and no dependency were added.
- The doze's "zzz" floats 1.55 m up, over a seated head; the activities'
  timings and weights are a first tuning, to adjust on the host.

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
 Test Files  232 passed (232)
      Tests  2742 passed | 366 skipped (3108)
   Duration  85.08s (tests 43%, import 36%, transform 10%, environment 9%, setup 1%)
```

`pnpm build` (tail):

```text
dist/assets/index-DFLyQ1yS.css              48.30 kB │ gzip:   9.85 kB
dist/assets/avatar-preview-CkRWxxBg.js      17.37 kB │ gzip:   5.56 kB
dist/assets/office-scene-kqpxYdH_.js       506.29 kB │ gzip: 217.70 kB
dist/assets/materials-CcpaLguf.js          948.56 kB │ gzip: 254.22 kB
dist/assets/index-DOr3yCl1.js            1,012.81 kB │ gzip: 305.20 kB
✓ built in 4.79s
```

The new tests, verbose:

```text
✓ idle-behaviours.test.ts > the idle activities > are the PRD's five: a stretch after finishing, a coffee, the gym, the water cooler and a doze after a long idle
✓ idle-behaviours.test.ts > the idle activities > each last a while, may be chosen and hold at least one Agent
✓ idle-behaviours.test.ts > the idle activities > are seated in the chair, and standing everywhere else, as their animations are
✓ idle-behaviours.test.ts > the idle activities > have a place for every Agent each spot's occupancy limit lets in
✓ idle-behaviours.test.ts > choosing an idle activity > gives each candidate a share of the draw as wide as its weight
✓ idle-behaviours.test.ts > choosing an idle activity > picks each as often as its weight, over many draws
✓ idle-behaviours.test.ts > choosing an idle activity > never picks one weighted 0, and picks nothing from nothing
✓ idle-behaviours.test.ts > an Agent's idle state > is idle only with nothing to do: not working, waiting, queued, paused, capped or walking
✓ idle-behaviours.test.ts > the trip to an idle activity > for each of 2 Agents and each place, starts in its chair, ends at its place, and keeps clear of furniture and walls once off the chair
✓ idle-behaviours.test.ts > the trip to an idle activity > for each of 5 Agents and each place, starts in its chair, ends at its place, and keeps clear of furniture and walls once off the chair
✓ idle-behaviours.test.ts > the trip to an idle activity > for each of 6 Agents and each place, starts in its chair, ends at its place, and keeps clear of furniture and walls once off the chair
✓ idle-activities.test.tsx > idle behaviours on a Floor > get an Agent with nothing to do up for an activity after a rest, and leave working Agents at their desks
✓ idle-activities.test.tsx > idle behaviours on a Floor > bring the Agent back to its desk on the very next frame once it has a new task, with no walk back
✓ idle-activities.test.tsx > idle behaviours on a Floor > leave everyone in their chairs with reduced motion
✓ idle-activities.test.tsx > a dozing Agent's bubble > is "zzz" in HTML over its head, hidden from assistive technology, and goes when it wakes
✓ idle-behaviours.test.ts > the trip to an idle activity > for each of 9 Agents and each place, starts in its chair, ends at its place, and keeps clear of furniture and walls once off the chair
✓ idle-behaviours.test.ts > the trip to an idle activity > for each of 12 Agents and each place, starts in its chair, ends at its place, and keeps clear of furniture and walls once off the chair
✓ idle-behaviours.test.ts > the trip to an idle activity > keeps the Agents at one spot apart
✓ idle-behaviours.test.ts > the trip to an idle activity > stays in the chair for a doze, and steps aside to stretch
✓ idle-behaviours.test.ts > the trip to an idle activity > stands up, walks there, plays its activity, walks back and sits down
✓ idle-behaviours.test.ts > the trip to an idle activity > is none for an Agent with no desk on the Floor
✓ idle-behaviours.test.ts > idling > sits for a rest first, then goes off on an activity
✓ idle-behaviours.test.ts > idling > stretches first once it has finished its work, before anything else
✓ idle-behaviours.test.ts > idling > dozes only after a long idle
✓ idle-behaviours.test.ts > each spot's occupancy limit > lets no more Agents in than it holds, each at a place of its own
✓ idle-behaviours.test.ts > each spot's occupancy limit > counts every Agent at the spot, whatever it is doing there
✓ idle-behaviours.test.ts > each spot's occupancy limit > frees its place as soon as an Agent leaves it, for the next to take
✓ idle-behaviours.test.ts > each spot's occupancy limit > never limits an Agent's own chair or desk
✓ idle-behaviours.test.ts > a new task > brings the Agent back to its chair at once while it is standing up
✓ idle-behaviours.test.ts > a new task > brings the Agent back to its chair at once while it is walking there
✓ idle-behaviours.test.ts > a new task > brings the Agent back to its chair at once while it is at the coffee machine
✓ idle-behaviours.test.ts > a new task > brings the Agent back to its chair at once while it is walking back
✓ idle-behaviours.test.ts > a new task > wakes a dozing Agent, and its "zzz" goes
✓ idle-behaviours.test.ts > a new task > is never kept waiting: once interrupted, the Agent has no activity until it is idle again
✓ idle-behaviours.test.ts > a new task > stops every activity with reduced motion
✓ idle-behaviours.test.ts > a new task > forgets an Agent that has left the Floor
```

## After merging into the integration branch

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) at `e713845`, after the merge (`9629801`) and its follow-ups:
`0ae986e` (two stray `.orig` files removed), `945c595` (retention deletes
Connections' delivery logs) and `e713845` (a test of the Batches' prompt
check).

- **Migrations.** This branch keeps `0044_retention` and
  `0045_github_webhooks`. The merged branch's `0044_communications`,
  `0045_push_connections`, `0046_connection_detail_quiet_hours_digests`,
  `0047_batch_kickoff_wrap_up` and `0048_publishing_destinations` are
  replaced by one regenerated `0046_communications`, with their header
  comments, and `0047_connection_delivery_retention` follows it.
  `drizzle-kit generate` finds nothing more to generate. Neither migration
  has been applied to a real Postgres here (no Docker).

- **Meetings win over idle activities.** The merged branch's Kickoff and
  Wrap-up (#85) also take Agents from their chairs. `scene/away-pose.ts`
  makes the order explicit for `DeskAgent`: a meeting, then a Handoff
  walk, then an idle activity. For idling, an Agent gathered for a meeting
  (or waiting to set off for one) is away on work, like one on a Handoff
  walk (`idleStateOf`'s second argument). Its activity stops at once, as a
  new task stops it, and none starts until the meeting is over.
  `IdleActivities` takes the Floor's meetings for this.
- `away-pose.test.ts` uses the real meeting walker, idle behaviours and
  layout: a walk shows over an activity at the walk's pace, a meeting
  shows over a walk, and a Kickoff stops one Agent's coffee trip while
  another Agent's activity carries on.
- `docs/guide/web-app.md.orig`, a stray copy left by this branch's earlier
  merge of `main`, was removed (`0ae986e`).
- The look of a gathering interrupting a coffee trip is to be checked on
  the host.

### Output of the checks

```text
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  266 passed (266)
      Tests  3067 passed | 435 skipped (3502)
test exit=0

$ pnpm --filter @ai-office/db db:generate
No schema changes, nothing to migrate 😴
generate exit=0
```

The 435 skipped tests need what the sandbox lacks: 409 Postgres 18 and
3 Mailpit through Testcontainers (Docker), 10 Docker, hadolint or Caddy
for the deployment, and 13 the real GitHub App. They run on the host and
in CI.

The idle and pose tests:

```text
 ✓ |@ai-office/web| src/scene/away-pose.test.ts > an Agent away from its chair > is in its chair when nothing takes it away
 ✓ |@ai-office/web| src/scene/away-pose.test.ts > an Agent away from its chair > shows a Handoff walk over an idle activity, at the walk's pace
 ✓ |@ai-office/web| src/scene/away-pose.test.ts > an Agent away from its chair > shows a meeting over a Handoff walk
 ✓ |@ai-office/web| src/scene/away-pose.test.ts > an Agent away from its chair > stops its idle activity at once when a Kickoff gathers it, and walks to the meeting from its desk
 Test Files  3 passed (3)
      Tests  40 passed (40)
```
