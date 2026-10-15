---
name: mobile-checks
description: How to set up and run a mobile app's checks (unit tests and simulator tests) as npm scripts in its repository, and what happens where no simulator can start. Use it when the checks fail, are missing, or need changing.
---

# The app's checks

A Mobile app Floor checks every change with two scripts in the repository's `package.json`, run by the Floor's check command:

```sh
npm run test:unit && npm run test:simulator
```

Each one exits with an error, naming the test and the file, when a test fails. Run one on its own with `npm run <name>`.

## What each one checks

| Script | What it checks | A tool that does it |
| --- | --- | --- |
| `test:unit` | The app's logic and components, with no device | Jest and React Native Testing Library; for a native or Flutter app, `./gradlew testDebugUnitTest`, `xcodebuild test` or `flutter test` |
| `test:simulator` | The app's main flows, end to end, on a simulator or an emulator, on a debug build | Maestro (`maestro test .maestro`) or Detox |

## Setting them up

For a React Native app, for example:

```json
{
  "scripts": {
    "test:unit": "jest",
    "test:simulator": "node scripts/simulator-tests.mjs"
  }
}
```

where `scripts/simulator-tests.mjs` starts a simulator or an emulator, installs a debug build, runs `maestro test .maestro` and, where none can start, prints `no simulator or emulator could start` and exits with 1. A Flutter or native app wraps its own tools in the same two scripts, so that the Floor's check command stays the same.

## Where no simulator can start

An iOS simulator needs macOS, and an Android emulator needs hardware acceleration, so a Linux sandbox often has neither. There, `test:simulator` fails saying so, and device-test QA says so in its Summary rather than failing the change for that alone. The repository's CI, on machines with simulators, runs them for every pull request.

## Never a release

The checks build in debug only. None of them signs a build for release, uploads one, or sends one to the app stores or a beta-testing service.
