## [1.7.0](https://github.com/adrianeyre/ai-office/compare/v1.6.0...v1.7.0) (2026-11-12)

### Features

* **connections:** write the Google Sheets work log's cost in the office's currency ([7f0fab9](https://github.com/adrianeyre/ai-office/commit/7f0fab9d27f23e294d9fff1866e19e6221de2131))
* **settings:** show every cost in the office's currency, British pounds by default ([06e88aa](https://github.com/adrianeyre/ai-office/commit/06e88aa496d60163026558e00c8501d3e0554422))
* **settings:** take Model prices in the office's currency too, and drop the last dollar-only text ([8639ce2](https://github.com/adrianeyre/ai-office/commit/8639ce2a2627986343b84d9af2db9f5f9cb3fca8))
* **web:** show a spinner, a progress bar and what is happening whenever the Owner waits on the server ([5b564b1](https://github.com/adrianeyre/ai-office/commit/5b564b137e39d6296e547747d05c9a829b7984cf))

### Bug Fixes

* **e2e:** keep the end-to-end tests off the internet, and cover the currency in a browser ([837e9ca](https://github.com/adrianeyre/ai-office/commit/837e9ca4999754b53c57fee127d78b80137fa87d))
* **gateway:** serve Owner tools given a /v1 base URL, list Models, and say why a subscription refuses ([bbbccb4](https://github.com/adrianeyre/ai-office/commit/bbbccb46e1d924f89c170f6ccce598a181a796da))

## [1.6.0](https://github.com/adrianeyre/ai-office/compare/v1.5.0...v1.6.0) (2026-11-06)

### Features

* **site:** add a sitemap, robots.txt, llms.txt, structured data and full link previews ([5d8dc8a](https://github.com/adrianeyre/ai-office/commit/5d8dc8ad7d439fc2f5dd11b2e441bf94cf303e44))

## [1.5.0](https://github.com/adrianeyre/ai-office/compare/v1.4.2...v1.5.0) (2026-11-03)

### Features

* **memory:** cap the memory and Skills injected into Agent prompts ([bfb7b66](https://github.com/adrianeyre/ai-office/commit/bfb7b660de934e424cc93c542adccfc8a3c9d0ac)), closes [#20](https://github.com/adrianeyre/ai-office/issues/20)
* **qa:** retry once when a QA report or design review cannot be parsed ([88595c4](https://github.com/adrianeyre/ai-office/commit/88595c4cee58aeff600c1c8e678e356917a9b04a)), closes [#18](https://github.com/adrianeyre/ai-office/issues/18)
* **review:** size the reviewer's diff limit from the model's context window ([fb51dd7](https://github.com/adrianeyre/ai-office/commit/fb51dd7492727d81a4c8a248c1a4f72db1237057)), closes [#17](https://github.com/adrianeyre/ai-office/issues/17)
* **site:** overhaul the website with stageshow product demos ([e198fbf](https://github.com/adrianeyre/ai-office/commit/e198fbf1dd23e6dd233b4aec266211a088ed80a1))
* **templates:** add a built-in Local Floor template for Ollama and other local models ([0552c31](https://github.com/adrianeyre/ai-office/commit/0552c316b06fab7772a481c45366fdaa3d052e70)), closes [#19](https://github.com/adrianeyre/ai-office/issues/19)
* **watchdog:** make the stall timeout and sandbox time limit configurable ([b116e09](https://github.com/adrianeyre/ai-office/commit/b116e09ef7aec1bcc8655fae728b4ca63f5d78c6)), closes [#16](https://github.com/adrianeyre/ai-office/issues/16)

### Bug Fixes

* **docker:** copy the website's manifest before installing ([71660b9](https://github.com/adrianeyre/ai-office/commit/71660b94e2bd2188bc484725eab35a86e4e7bffd))
* **merge:** judge a Batch's pull request body by its reviewers' diff limit ([14000bf](https://github.com/adrianeyre/ai-office/commit/14000bfa04450d435c0389ce8f5d81ccf34d8fe4)), closes [#17](https://github.com/adrianeyre/ai-office/issues/17)
* **site:** take the demos off their plates and settle the bento tiles ([21c5fd5](https://github.com/adrianeyre/ai-office/commit/21c5fd53aaac6fa1456a91bdf5f4b378788955af))

## [1.4.2](https://github.com/adrianeyre/ai-office/compare/v1.4.1...v1.4.2) (2026-10-20)

### Reverts

* Revert "feat(dev): run every pnpm dev service in Docker, at ai-office.localhost" ([1cd5886](https://github.com/adrianeyre/ai-office/commit/1cd588608329ff5c868d7e5cb45dcceacfc28fa2))
* Revert "feat(dev): serve pnpm dev over HTTPS at https://ai-office.localhost" ([3f1366e](https://github.com/adrianeyre/ai-office/commit/3f1366e04f8390dd05087aa71ec20185fd927fd3))
* Revert "fix(dev): run pnpm dev on Windows with the sandbox directory in Docker Desktop's VM" ([e1c712c](https://github.com/adrianeyre/ai-office/commit/e1c712c24a0cfa9c74c8534412ab9e53c1805902))

## [1.4.1](https://github.com/adrianeyre/ai-office/compare/v1.4.0...v1.4.1) (2026-10-20)

### Bug Fixes

* **dev:** run pnpm dev on Windows with the sandbox directory in Docker Desktop's VM ([9395526](https://github.com/adrianeyre/ai-office/commit/9395526d24f58edd0bb6aaaf16957e44f145808c))

## [1.4.0](https://github.com/adrianeyre/ai-office/compare/v1.3.0...v1.4.0) (2026-10-20)

### Features

* **dev:** serve pnpm dev over HTTPS at https://ai-office.localhost ([17ad8e7](https://github.com/adrianeyre/ai-office/commit/17ad8e72117c6623dad443b19d211366738d78c4))

## [1.3.0](https://github.com/adrianeyre/ai-office/compare/v1.2.0...v1.3.0) (2026-10-20)

### Features

* **dev:** run every pnpm dev service in Docker, at ai-office.localhost ([2bae9cd](https://github.com/adrianeyre/ai-office/commit/2bae9cd67af2da08b7b460a0881b8b75b0811ce1))
* **sandcastle:** forward the env of ~/.claude/settings.json into the sandbox ([8c5f005](https://github.com/adrianeyre/ai-office/commit/8c5f005b4275dbbd62d69003e662b24ef850b14a))

## [1.2.0](https://github.com/adrianeyre/ai-office/compare/v1.1.2...v1.2.0) (2026-10-19)

### Features

* Gemini subscriptions through Google sign-in, and coding-plan keys for Z.ai, MiniMax, Kimi and Qwen ([00d8219](https://github.com/adrianeyre/ai-office/commit/00d8219b91aed525160713264f2f494867f59e0d))

## [1.1.2](https://github.com/adrianeyre/ai-office/compare/v1.1.1...v1.1.2) (2026-10-19)

### Bug Fixes

* a Claude subscription's 5-hour usage shows again when no window is running ([0298b04](https://github.com/adrianeyre/ai-office/commit/0298b0465a8a13b6c7746d91a3536c51693484ac))

## [1.1.1](https://github.com/adrianeyre/ai-office/compare/v1.1.0...v1.1.1) (2026-10-17)

### Bug Fixes

* a ChatGPT sign-in on a remote AI Office says its localhost page will not load, and to paste its address ([5e0de6e](https://github.com/adrianeyre/ai-office/commit/5e0de6eb58831ee3b1877def6e5e0d8be6c01c4b))
* **a11y:** the menu's page divider always has an aria-valuenow ([d4a55b4](https://github.com/adrianeyre/ai-office/commit/d4a55b4da5cb20e59c0575a748a043532cea9db5))
* **security:** the Sandcastle git guard and the pen-test scripts are executable ([7890bd7](https://github.com/adrianeyre/ai-office/commit/7890bd7b1e0e371f6005bb86a7d9b121ec6cc6b9))

## [1.1.0](https://github.com/adrianeyre/ai-office/compare/v1.0.0...v1.1.0) (2026-10-17)

### Features

* a live Overview, with issue titles, each sandbox's latest step and filters ([34d3eaf](https://github.com/adrianeyre/ai-office/commit/34d3eaf7d006d4c2be489fcf1cdcabc099a7af48))
* an Overview of every Agent and Manager at work, each stoppable ([49a17fb](https://github.com/adrianeyre/ai-office/commit/49a17fb799474211d2a5fc6af1c95fbd9b05a376))
* find, filter and page the repositories in Add a Floor ([d858571](https://github.com/adrianeyre/ai-office/commit/d858571bfc5093602e13090c602a1cc9bb52dedc))
* the line above Sign out drags to make the menu's pages shorter ([032f20f](https://github.com/adrianeyre/ai-office/commit/032f20f5cec6cd7e7f6a42c35124b939dcb79731))

### Bug Fixes

* name the missing read-only token when adding an access token ([a7a682c](https://github.com/adrianeyre/ai-office/commit/a7a682c95eb0d1f3afc7c3507d003d9ad0a74898))
* removing a Floor ends everything it was doing ([a6168fc](https://github.com/adrianeyre/ai-office/commit/a6168fc0e3bec21997dba50aaa8693ddc672a14f))

## 1.0.0 (2026-10-15)

### Features

* Initial commit ([5685b2a](https://github.com/adrianeyre/ai-office/commit/5685b2ae0c9ca7b6929e70e0211aab9392385a63))

## 1.0.0
