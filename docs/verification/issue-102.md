# Issue #102: Combos: fallback chains — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch at `32974ce`: every commit of the issue except this
document.

## What was built

- **Combos** (PRD FR-40): named, ordered chains of (AI Account, Model)
  slots, each assigned to one or more model families.
  - **Schemas** (`packages/shared/src/combos.ts`): `addComboRequestSchema`,
    `comboUpdateSchema`, `comboSchema`, `comboSettingsSchema` (the switch for
    every Combo, off by default) and `comboErrorCodes`. A family is named as
    `modelFamilyOf` names it, so a Model's name stands for its family
    (`claude-opus-5-5` is `claude-opus`). A Combo has 1 to 20 slots and 1 to
    20 families.
  - **Storage:** the `gateway_combos` table (slots as a JSON array, in
    order) and `office_settings.gateway_combos` for the switch, in migration
    `0053_gateway_combos`.
  - **The Combos** (`packages/gateway/src/combos/combos.ts`): add, list,
    change and delete, each a `config.changed` event naming what changed
    (`combos.added`, `combos.slots`, `combos.enabled`, `combos.deleted`…),
    never values. Refused: a slot naming an AI Account that does not exist,
    a slot whose Model is another AI Provider's than its account's, a
    repeated slot, a name another Combo has, and an enabled Combo assigned
    to a family another enabled Combo has. `forModel(model)` gives the
    enabled Combo for the Model's family while the switch is on. They are
    read once and kept in memory, since every request asks; only this
    module changes them.
- **The waterfall** (`AiAccounts.select` in
  `packages/gateway/src/accounts/accounts.ts`, and the retry loop in
  `packages/gateway/src/gateway.ts`):
  - After a forced account, and in place of the strategy, a request for a
    Model of a family with an enabled Combo goes to the Combo's slots in
    order. Slots are skipped while their AI Account is paused, deleted,
    cannot serve the request (another agent tool's subscription, an
    endpoint it lacks, another AI Provider's Model), has its circuit open,
    or is held back by FR-38's capacity filter (for the slot Model's family)
    or usage throttling. These reuse `route()` with a ranking that keeps the
    Combo's order.
  - The slot's Model replaces the one asked for in the body, which is then
    sent or translated in the account's own format.
  - A slot that is rate-limited, overloaded or fails passes the request to
    the next one at once. Each slot is told apart by `comboSlotKey`
    (account and Model), so one account may be in two slots with two
    Models. Every slot gets its turn, whatever the retry attempts.
  - When every slot is held back, the answer is FR-38's `429`, `529` or
    `503` with `retry-after`.
  - The request history records the account and the **Model that served**.
    The Gateway's log line names the Combo.
- **The switch** (`packages/orchestrator/src/office/settings.ts`,
  `apps/server/src/office/routes.ts`): `GET` and `PUT /api/office/combos`
  with `{"enabled"}`, a `config.changed` event (`comboSettings.enabled`).
  The server reads it at start and on each change (`apps/server/src/server.ts`).
- **The API** (`apps/server/src/combos/routes.ts`): `GET` and
  `POST /api/gateway/combos`, `PATCH` and `DELETE /api/gateway/combos/:id`,
  all `owner` access. Invalid bodies and slots that could never serve are
  `400`s, a taken name or family `409`, an unknown Combo `404`.
- **Admin UI** (`apps/web/src/combos-card.tsx`): a **Combos** card on AI
  Settings, after Retries.
  - The switch, off by default.
  - Each Combo with its families and its slots in order. A slot whose
    account is deleted or paused is shown as skipped.
  - Enable or Disable, Edit, and Delete (after asking).
  - A form to build one: name, families separated by commas, and slots.
    Each slot is an AI Account and a Model offered from that account's AI
    Provider's catalogue, and can be moved up, moved down or removed.
- **Guide:** a **Combos** section in `docs/guide/ai-gateway.md`.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). The first full `pnpm test` run had one timeout,
      in a test this branch does not touch; see "A timeout under load".
- [x] **Tests: waterfall order.**
      `packages/gateway/src/combos/routing.test.ts` drives a real Gateway
      with real AI Accounts in front of fake AI Providers:
  - Slots in an order other than the accounts' priority, none with the
    Model asked for. The first is rate-limited and the second fails, so
    the AI Providers receive `Third: claude-opus-5-5`, `First:
    claude-haiku-5-5`, then `Second: claude-sonnet-4-5`, with no wait. The
    request is recorded as `Second` with `claude-sonnet-4-5`. On the next
    request, the rate-limited slot is skipped and the failed one is tried
    first.
  - With retry attempts set to 1, all three slots still get their turn.
  - Paused, deleted and held-back slots are skipped. A resumed one is
    first again.
  - One account in two slots: out of Opus for the week (the
    `seven_day_opus` fixture), its Sonnet slot serves, at once from then on.
  - A Grok slot is sent Chat Completions with `grok-4`, and the caller gets
    an Anthropic message back.
  - Once every slot is held back the answer is `429` with `retry-after`,
    and an account outside the Combo is never sent anything.
  - A request for another family goes to the strategy with its own Model.
- [x] **Tests: disabled combos are ignored.** `routing.test.ts`, "a
      disabled Combo": while disabled, the strategy serves with the Model
      asked for. Enabled, the Combo applies from the next request. Disabled
      again, it is ignored again. A disabled Combo's family goes to another,
      enabled Combo. `combos.test.ts` checks the same through `forModel`,
      and checks that a disabled Combo may share a family but cannot be
      enabled while another enabled Combo has that family.
- [x] **Tests: global switch.** `routing.test.ts`, "the switch for every
      Combo": off, an enabled Combo does not apply; on, it does; off again,
      it does not. With no switch given, Combos are off. The switch's
      default, storage and event are tested in
      `packages/orchestrator/src/office/settings.test.ts`. Its API, including
      the `400`s, is tested in `apps/server/src/office/routes.test.ts`. The
      shared schema is tested in `packages/shared/src/combos.test.ts`.
- Also covered:
  - The Combos API, with its error codes and events
    (`apps/server/src/combos/routes.test.ts`).
  - The route-access check passes with the new routes declared `owner`.
  - The card (`apps/web/src/combos-card.test.tsx`): the switch is off by
    default and saves. A Combo is built with its slots reordered, and the
    exact body is posted. A Combo is enabled, edited, deleted after
    asking, and a deleted account's slot is shown as skipped. Refusals are
    shown, from the form's own check and from the API.
- The tests depend on the feature: with `select`'s Combo lookup disabled,
  9 of the 11 routing tests fail. The 2 that still pass expect the
  strategy to serve.

### Real output

`pnpm lint` (at `32974ce`):

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

`pnpm typecheck`:

```text
$ tsc && pnpm --recursive typecheck
…
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

`pnpm test`:

```text
start load 45.44 35.66 37.80
 Test Files  242 passed (242)
      Tests  2783 passed | 385 skipped (3168)
exit 0
```

The issue's tests (`--reporter=verbose`; Postgres cases skipped, see below):

```text
 ✓ |@ai-office/shared| src/combos.test.ts > the switch for every Combo > is off by default, and only says whether Combos are on
 ✓ |@ai-office/shared| src/combos.test.ts > a Combo > names its model families as modelFamilyOf does, once each
 ✓ |@ai-office/shared| src/combos.test.ts > a Combo > needs a name, a family and between one and the most slots
 ✓ |@ai-office/shared| src/combos.test.ts > a Combo > changes only what an update names
 ✓ |@ai-office/gateway| src/combos/combos.test.ts > Combos, kept in memory > adds, changes and deletes a Combo, telling which settings changed
 ✓ |@ai-office/gateway| src/combos/combos.test.ts > Combos, kept in memory > lists Combos oldest first
 ✓ |@ai-office/gateway| src/combos/combos.test.ts > Combos, kept in memory > refuses slots that could never serve, or that repeat one another
 ✓ |@ai-office/gateway| src/combos/combos.test.ts > Combos, kept in memory > refuses a name another Combo has
 ✓ |@ai-office/gateway| src/combos/combos.test.ts > Combos, kept in memory > lets only one enabled Combo have a model family
 ✓ |@ai-office/gateway| src/combos/combos.test.ts > Combos, kept in memory > finds the enabled Combo for a Model's family, while Combos are on
 ✓ |@ai-office/gateway| src/combos/combos.test.ts > Combos, kept in memory > keeps a slot whose AI Account was deleted, and changes the rest
 ✓ |@ai-office/gateway| src/combos/routing.test.ts > a request for a family with an enabled Combo > waterfalls through the slots in the Combo's order, each asking for its own Model
 ✓ |@ai-office/gateway| src/combos/routing.test.ts > a request for a family with an enabled Combo > gives every slot its turn, however few attempts the retry settings allow
 ✓ |@ai-office/gateway| src/combos/routing.test.ts > a request for a family with an enabled Combo > skips slots whose AI Account is paused, deleted or held back
 ✓ |@ai-office/gateway| src/combos/routing.test.ts > a request for a family with an enabled Combo > uses one AI Account in two slots, with two Models
 ✓ |@ai-office/gateway| src/combos/routing.test.ts > a request for a family with an enabled Combo > reaches another AI Provider's account in that account's own format
 ✓ |@ai-office/gateway| src/combos/routing.test.ts > a request for a family with an enabled Combo > answers 429 once every slot is held back, until the first is back
 ✓ |@ai-office/gateway| src/combos/routing.test.ts > a request for a family with an enabled Combo > leaves a request for another family to the strategy, with its own Model
 ✓ |@ai-office/gateway| src/combos/routing.test.ts > a disabled Combo > is ignored: the strategy serves, with the Model asked for
 ✓ |@ai-office/gateway| src/combos/routing.test.ts > a disabled Combo > leaves its family to another, enabled Combo
 ✓ |@ai-office/gateway| src/combos/routing.test.ts > the switch for every Combo > is off by default, and turned on and off at runtime
 ✓ |@ai-office/gateway| src/combos/routing.test.ts > the switch for every Combo > is off when nothing turns it on
 ✓ |@ai-office/orchestrator| src/office/settings.test.ts > office settings, kept in memory > waterfalls no request through a Combo until the Owner turns Combos on
 ✓ |@ai-office/server| src/auth/route-access.test.ts > every route > requires a session or is an explicit exemption
 ✓ |@ai-office/server| src/auth/route-access.test.ts > every route > that requires a session answers 401 without one
 ✓ |@ai-office/server| src/combos/routes.test.ts > the Combos API, kept in memory > adds a Combo, changes it and deletes it
 ✓ |@ai-office/server| src/combos/routes.test.ts > the Combos API, kept in memory > refuses a Combo that does not make sense, saying why
 ✓ |@ai-office/server| src/office/routes.test.ts > the office's settings, in memory > waterfalls through no Combo by default, and turns Combos on at runtime
 ✓ |@ai-office/web| src/combos-card.test.tsx > Combos in AI Settings > are off by default, and turned on
 ✓ |@ai-office/web| src/combos-card.test.tsx > Combos in AI Settings > builds a Combo: its families, and its slots in the order they are tried
 ✓ |@ai-office/web| src/combos-card.test.tsx > Combos in AI Settings > enables and deletes a Combo, showing a deleted account's slot as skipped
 ✓ |@ai-office/web| src/combos-card.test.tsx > Combos in AI Settings > changes a Combo's slots
 ✓ |@ai-office/web| src/combos-card.test.tsx > Combos in AI Settings > says why a Combo was refused
```

### A timeout under load

The first full `pnpm test` run, at a load average of about 30 on the shared
host, failed one test with `Error: Test timed out in 5000ms.` and no failed
assertion:

```text
 FAIL  |@ai-office/web| src/scene/floor-layout.test.ts > a Floor's waypoints > keep every path of 10 Agents' Floor clear of furniture and walls
 Test Files  1 failed | 241 passed (242)
      Tests  1 failed | 2782 passed | 385 skipped (3168)
exit 1
```

This is the 3D Floor's waypoint test that `issue-101.md` already reports
timing out under load. This branch changes no file under
`apps/web/src/scene/`. Run on its own, it passes (`Tests  77 passed (77)`).
The plain `pnpm test` run above then passed in full. No test was skipped,
deleted or given a longer timeout.

## Not verifiable in this sandbox

- **Postgres 18 (Docker):** migration `0053_gateway_combos`,
  `databaseComboStore`, and the Postgres cases of `combos.test.ts`,
  `routes.test.ts` (Combos and office settings) and `settings.test.ts`
  skip here with the reason. They run on the host and in CI.
- **Playwright (`pnpm e2e`)** needs Docker, so it was not run, and no
  end-to-end test was added. The slice is covered at the Gateway (real
  HTTP, fake AI Providers), API and component levels.
- **The README's AI Settings screenshot** (`docs/images/ai-settings.png`)
  was not retaken (`pnpm screenshots` needs Docker), so it does not show
  the Combos card yet.
- **Real AI Providers:** a waterfall between real accounts, and a real
  Claude Code session switching Models mid-session, were not tried.

## Notes

These are outside the issue's "What to build", or for the Owner to decide.
This run has no GitHub access, so raise them on the issue.

- **The chain is the route.** When every slot is held back or cannot serve,
  the request fails (`429`/`529`/`503`). It does not fall back to accounts
  outside the Combo. FR-40 says only "waterfall to the next slot on
  failure", so this is my reading. The other choice, falling back to the
  strategy, would serve more requests but would ignore the chain the Owner
  built.
- **One enabled Combo per family.** FR-40 does not say what happens when two
  enabled Combos share a family. Rather than pick one silently, enabling
  the second is refused (`409`). A disabled Combo may wait for its turn.
- **The request history records the Model that served**, not the one asked
  for, so estimated costs and the analytics' breakdown by Model follow what
  was used. Which Combo served is in the Gateway's log line only.
  `gateway_requests` has no column for it, and FR-43 does not ask for a
  breakdown by Combo.
- **Sessions do not apply to a Combo:** its order does. A session stays on
  slot 1 while it can serve, so its prompt cache stays warm there. When a
  slot ahead of it recovers, the next request goes back to that slot.
- **Subscriptions keep FR-35:** a slot whose account is a subscription
  serves only its own agent tool's requests. For any other request, the
  slot is skipped.
- **A deleted AI Account's slots stay,** and are skipped (the card says so).
  Saving that Combo's slots again refuses the missing account. Deleting an
  account could offer to remove its slots; that is not done.
- **GLOSSARY.md** has no entry for "Combo", though the PRD and this slice
  use the term. I left the glossary unchanged; it may want one.
- **Model mappings and aliases** (FR-41, #103) are out of scope. A slot
  names a Model exactly.
