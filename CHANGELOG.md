## [1.15.0](https://github.com/adrianeyre/ai-office/compare/v1.14.0...v1.15.0) (2026-11-25)

### Features

* **db:** keep /guidelines sessions and their Guidelines, and the Floors suggested it ([887295e](https://github.com/adrianeyre/ai-office/commit/887295e812724c441fd761ddb8d4534e0ed4c6a1)), references [#42](https://github.com/adrianeyre/ai-office/issues/42)
* **db:** keep a /spec session's phase, drafts and approved documents ([8374a8a](https://github.com/adrianeyre/ai-office/commit/8374a8aba27687248bb7a7f6aff7413a02d72030)), references [#43](https://github.com/adrianeyre/ai-office/issues/43)
* **db:** keep each Floor's Hooks, their runs, and the head their push Hooks last saw ([1121080](https://github.com/adrianeyre/ai-office/commit/1121080608ab384102a6c8d0827bdeda02ad6931)), references [#49](https://github.com/adrianeyre/ai-office/issues/49)
* **db:** keep the Guideline versions the Owner approved, and those awaiting ([b2a7d5e](https://github.com/adrianeyre/ai-office/commit/b2a7d5ebdc43e06a730ccd8533b9f43aa9731c47)), references [#36](https://github.com/adrianeyre/ai-office/issues/36)
* **db:** keep the Guidelines Agents propose, per Floor, for the Owner ([2c89f5c](https://github.com/adrianeyre/ai-office/commit/2c89f5c115584c42a9edfe28dfcf3012f9b89467)), references [#41](https://github.com/adrianeyre/ai-office/issues/41)
* **events:** batch.approved names the Spec whose confirmed tasks approve it ([5ad8cbe](https://github.com/adrianeyre/ai-office/commit/5ad8cbea69ef7f6768db07e95a109af6170d0563)), references [#45](https://github.com/adrianeyre/ai-office/issues/45)
* **events:** every change to a Hook and every run of one, and the Spec a Batch's Plan was filed from ([bd7befb](https://github.com/adrianeyre/ai-office/commit/bd7befbae133f1db0fd5339c802b8720c50e25dc)), references [#49](https://github.com/adrianeyre/ai-office/issues/49)
* **events:** Guideline approved, awaiting approval and dismissed events ([2dcdc7b](https://github.com/adrianeyre/ai-office/commit/2dcdc7bbd7593650154d22e7dac9b9f66588ad4a)), references [#36](https://github.com/adrianeyre/ai-office/issues/36)
* **events:** guideline.proposed, naming an Agent's proposed Guideline by its hash ([2ded438](https://github.com/adrianeyre/ai-office/commit/2ded438821d4bd10a478eb0414d50b97f3cf09a6)), references [#41](https://github.com/adrianeyre/ai-office/issues/41)
* **github:** read who merged or pushed the commit that changed a file ([13918f5](https://github.com/adrianeyre/ai-office/commit/13918f5ecf37678e4678176cae449bdb27cba35e)), references [#36](https://github.com/adrianeyre/ai-office/issues/36)
* **orchestrator:** /guidelines writes the Floor's Guidelines in .agents/guidelines/, in one pull request ([0d1f6c8](https://github.com/adrianeyre/ai-office/commit/0d1f6c8aa4e632377d0e02d7f997599f8e9378f4)), references [#42](https://github.com/adrianeyre/ai-office/issues/42)
* **orchestrator:** /spec agrees a Spec phase by phase, committing each document as the Owner confirms it ([6aced14](https://github.com/adrianeyre/ai-office/commit/6aced145f1f92b5c19755a522109d3b2bd8b0d75)), references [#43](https://github.com/adrianeyre/ai-office/issues/43)
* **orchestrator:** /spec amend reopens an approved Spec at its requirements, the earlier documents loaded ([da079bd](https://github.com/adrianeyre/ai-office/commit/da079bd7d62c5815c6f0e8954c7e83e2aa41b0f7)), references [#48](https://github.com/adrianeyre/ai-office/issues/48)
* **orchestrator:** a 12,000-character prompt budget for an issue's Spec ([ede5c82](https://github.com/adrianeyre/ai-office/commit/ede5c82a459805e35856efb671ce4c58ae2d966e)), references [#46](https://github.com/adrianeyre/ai-office/issues/46)
* **orchestrator:** a Spec's Batch names its /spec session as its Plan is drafted ([069239e](https://github.com/adrianeyre/ai-office/commit/069239ed2c757f8d30c21b51e72f00508393e4d4)), references [#49](https://github.com/adrianeyre/ai-office/issues/49)
* **orchestrator:** a Spec's issue links the Spec, lists Meets: and quotes those criteria ([5744c9a](https://github.com/adrianeyre/ai-office/commit/5744c9a70bb584cadfdc076c2caa2383fd5a4c50)), references [#45](https://github.com/adrianeyre/ai-office/issues/45)
* **orchestrator:** a Spec's Wrap-up says where the merged work departs from its design.md ([43073c9](https://github.com/adrianeyre/ai-office/commit/43073c952080af5e9be959ae408186cfb4efa4f2)), references [#48](https://github.com/adrianeyre/ai-office/issues/48)
* **orchestrator:** choose each task's Guidelines by Stage, file pattern and label, within a 12,000-character budget ([6a3f042](https://github.com/adrianeyre/ai-office/commit/6a3f042867d9fd5e4d27ecc2f8d3f9cc948447ef)), references [#38](https://github.com/adrianeyre/ai-office/issues/38)
* **orchestrator:** configuration export and import carry each Floor's Hooks ([5c5e429](https://github.com/adrianeyre/ai-office/commit/5c5e4298dbb431fa280d58d2c45493fd68262048)), references [#49](https://github.com/adrianeyre/ai-office/issues/49)
* **orchestrator:** filing a Spec's issues starts its Batch in the tasks' order ([9585858](https://github.com/adrianeyre/ai-office/commit/9585858a23126e85465334accd69f23a61c77551)), references [#45](https://github.com/adrianeyre/ai-office/issues/45)
* **orchestrator:** give Agents only the Guideline versions the Owner approved ([df1d14e](https://github.com/adrianeyre/ai-office/commit/df1d14e15b993b0863caebb40bef1f41aede8b81)), references [#36](https://github.com/adrianeyre/ai-office/issues/36)
* **orchestrator:** give each Stage its Guidelines: mounted for sandboxes, quoted for reviewers ([37e92b7](https://github.com/adrianeyre/ai-office/commit/37e92b769307c0d3ab54cd4ca62ae3db977d0503)), references [#38](https://github.com/adrianeyre/ai-office/issues/38)
* **orchestrator:** give the coder and reviewers the Spec an issue was filed from, as approved ([a794c15](https://github.com/adrianeyre/ai-office/commit/a794c15c9f9759bd3d651e9749ab0d0f396fd279)), references [#46](https://github.com/adrianeyre/ai-office/issues/46)
* **orchestrator:** Hooks have an Agent run a Skill on the Floor events the Owner chose ([c6561c6](https://github.com/adrianeyre/ai-office/commit/c6561c6fa38bb1eedfdabd5348be0753be79e367)), references [#49](https://github.com/adrianeyre/ai-office/issues/49)
* **orchestrator:** intake makes a guideline:<name> label for each manual Guideline ([0867cd6](https://github.com/adrianeyre/ai-office/commit/0867cd6d20e36f8764fb2bb470d329a83cbc7571)), references [#38](https://github.com/adrianeyre/ai-office/issues/38)
* **orchestrator:** keep proposed Guidelines per Floor, and let the Owner open one as a pull request or reject it ([72b2d9e](https://github.com/adrianeyre/ai-office/commit/72b2d9ec95267bc18321cd883f4226e583654155)), references [#41](https://github.com/adrianeyre/ai-office/issues/41)
* **orchestrator:** list a Floor's Guidelines for its admin, approve and dismiss ([f43a9b3](https://github.com/adrianeyre/ai-office/commit/f43a9b3d5c671faf38c3c2377135e30c23b82a0d)), references [#37](https://github.com/adrianeyre/ai-office/issues/37)
* **orchestrator:** QA proves each Acceptance Criterion of an issue filed from a Spec ([be9effd](https://github.com/adrianeyre/ai-office/commit/be9effd90484f46e2665e389f8ebdbde097c6f10)), references [#47](https://github.com/adrianeyre/ai-office/issues/47)
* **orchestrator:** read a Floor's Guidelines from its default branch ([cfe1445](https://github.com/adrianeyre/ai-office/commit/cfe144587c86acb94da32b5706b62b920d56d273)), references [#35](https://github.com/adrianeyre/ai-office/issues/35)
* **orchestrator:** read each Acceptance Criterion's result from QA's report ([5b3d31c](https://github.com/adrianeyre/ai-office/commit/5b3d31c8106eb9acd56e0b78819b3f444b778d45)), references [#47](https://github.com/adrianeyre/ai-office/issues/47)
* **orchestrator:** read the Guideline an Agent proposes, and keep it from later Agents ([0924e10](https://github.com/adrianeyre/ai-office/commit/0924e1082425f88da42541d11823d890dbfc6ef9)), references [#41](https://github.com/adrianeyre/ai-office/issues/41)
* **orchestrator:** refuse "confirm requirements" while any Acceptance Criterion fails, naming each and why ([064d59c](https://github.com/adrianeyre/ai-office/commit/064d59c6aa645d4f4eddc60848d27ad242ac46bb)), references [#44](https://github.com/adrianeyre/ai-office/issues/44)
* **orchestrator:** suggest /guidelines once to a Floor that has never had Guidelines ([b472f9c](https://github.com/adrianeyre/ai-office/commit/b472f9c872f5c2381dbc6ab532ccddbbc746378f)), references [#42](https://github.com/adrianeyre/ai-office/issues/42)
* **orchestrator:** the Manager's triage, Plan and chat follow the always Guidelines ([03af4bb](https://github.com/adrianeyre/ai-office/commit/03af4bb7c0a17cd30d7a0548a52697e77a178c14)), references [#38](https://github.com/adrianeyre/ai-office/issues/38)
* **orchestrator:** the Merge Policy sends an Agent's Guideline or Spec change to the Owner, saying why ([eba24ba](https://github.com/adrianeyre/ai-office/commit/eba24ba1389bc32fdd0d4fbe8bf562fdbc8e9d32))
* **orchestrator:** triage takes an issue filed from a Spec as clear, asking no model ([0973e9c](https://github.com/adrianeyre/ai-office/commit/0973e9ce355ff2d0a62ced0137609bd3a9f9a430)), references [#45](https://github.com/adrianeyre/ai-office/issues/45)
* **server:** a Spec's issues start their Batch, and triage asks no model of them ([bd128fa](https://github.com/adrianeyre/ai-office/commit/bd128fa68ca274764b4bbec393decd273430e210)), references [#45](https://github.com/adrianeyre/ai-office/issues/45)
* **server:** GET a Floor's Guidelines, approve and dismiss the version seen ([c653f91](https://github.com/adrianeyre/ai-office/commit/c653f91b5fb10aa3c79e16272409480de78479d7)), references [#37](https://github.com/adrianeyre/ai-office/issues/37)
* **server:** give every task its Guidelines ([1b13692](https://github.com/adrianeyre/ai-office/commit/1b136923750ed042a566c2acab18744c0787b669)), references [#38](https://github.com/adrianeyre/ai-office/issues/38)
* **server:** list a Floor's proposed Guidelines, open one as a pull request, or reject it ([5b06064](https://github.com/adrianeyre/ai-office/commit/5b060646c58f669c6e88edd6fd88faa76c085824)), references [#41](https://github.com/adrianeyre/ai-office/issues/41)
* **server:** QA reads an issue's Spec from its /spec session ([13abbf2](https://github.com/adrianeyre/ai-office/commit/13abbf272ade8c18034f73205a50696440a29972)), references [#47](https://github.com/adrianeyre/ai-office/issues/47)
* **server:** settle each Floor's Guidelines at intake and before each task ([79b3dd0](https://github.com/adrianeyre/ai-office/commit/79b3dd061555e002e945fd8dad023369125ff041)), references [#36](https://github.com/adrianeyre/ai-office/issues/36)
* **server:** the coder and reviewers read an issue's Spec from its /spec session ([54b3aec](https://github.com/adrianeyre/ai-office/commit/54b3aec5dc05844273185cdad966be3bf6c476b6)), references [#46](https://github.com/adrianeyre/ai-office/issues/46)
* **server:** the Owner lists, adds, changes, deletes and runs a Floor's Hooks now ([fe3d2f0](https://github.com/adrianeyre/ai-office/commit/fe3d2f01fa5f6f60f7605d442b34470d20278c8e)), references [#49](https://github.com/adrianeyre/ai-office/issues/49)
* **server:** the Wrap-up reads an issue's Spec from its /spec session ([2daca63](https://github.com/adrianeyre/ai-office/commit/2daca6368c36c17f15d6b7fde2e23119546f160e)), references [#48](https://github.com/adrianeyre/ai-office/issues/48)
* **shared:** "file the issues of session N in one PR", and tasks.md links each task's issue ([7ab6976](https://github.com/adrianeyre/ai-office/commit/7ab69763ef2285707a82e733ec7580947ea5f8a9)), references [#45](https://github.com/adrianeyre/ai-office/issues/45)
* **shared:** /guidelines starts a Grilling Session that writes the Floor's Guidelines ([c0f0aa5](https://github.com/adrianeyre/ai-office/commit/c0f0aa5ae0fcaa0d1efecc0effe804edb24ac8ea)), references [#42](https://github.com/adrianeyre/ai-office/issues/42)
* **shared:** /spec starts a Grilling Session that agrees a Spec in three phases ([bd0ebfc](https://github.com/adrianeyre/ai-office/commit/bd0ebfc9f4c0eaaaae9501abcf5dd390f0b54203)), references [#43](https://github.com/adrianeyre/ai-office/issues/43)
* **shared:** a Hook's trigger, filters, action and limits, and its API ([12284b9](https://github.com/adrianeyre/ai-office/commit/12284b9a7dac866bbf8b695d110f8ba1a3837d22)), references [#49](https://github.com/adrianeyre/ai-office/issues/49)
* **shared:** a Wrap-up's design checks, and /spec amend <slug> ([9a70924](https://github.com/adrianeyre/ai-office/commit/9a709241ad808a52fb7de03f4f1cab8c97974e88)), references [#48](https://github.com/adrianeyre/ai-office/issues/48)
* **shared:** check each Acceptance Criterion's form and id in plain code ([d02e827](https://github.com/adrianeyre/ai-office/commit/d02e827789fb9b4c9d6fb7301befec37e0e48668)), references [#44](https://github.com/adrianeyre/ai-office/issues/44)
* **shared:** guideline:<name> labels, the Guidelines' mount and budget, and guideline.over_budget ([cd12003](https://github.com/adrianeyre/ai-office/commit/cd1200323d0d93035f0215f02019d3be2b06229c)), references [#38](https://github.com/adrianeyre/ai-office/issues/38)
* **shared:** parse and validate a Guideline's front matter, name and length ([bf71529](https://github.com/adrianeyre/ai-office/commit/bf715291101e8e191d4a933c24039c450f1f3afa)), references [#35](https://github.com/adrianeyre/ai-office/issues/35)
* **shared:** the API of the Guidelines Agents propose: their list, open and reject ([6cc4e9a](https://github.com/adrianeyre/ai-office/commit/6cc4e9abc39f49158ef09844907b5feb07b61fa7)), references [#41](https://github.com/adrianeyre/ai-office/issues/41)
* **shared:** the Guidelines card's API: its list, the version named, and errors ([048cd4c](https://github.com/adrianeyre/ai-office/commit/048cd4cc4ac9bb314b3b45521da525578abc7a40)), references [#37](https://github.com/adrianeyre/ai-office/issues/37)
* **web:** a /guidelines session shows its Guidelines in place of the PRD's outline, and no issues ([1863d02](https://github.com/adrianeyre/ai-office/commit/1863d02480ac64feb1143c382df524d2644ffeef)), references [#42](https://github.com/adrianeyre/ai-office/issues/42)
* **web:** a /spec session shows its phase and each document of its Spec ([b1e4454](https://github.com/adrianeyre/ai-office/commit/b1e44544ee8c1325297b55e9adc07fe4ebc7bb61)), references [#43](https://github.com/adrianeyre/ai-office/issues/43)
* **web:** put the AI Accounts section at the top of AI Settings ([36561fd](https://github.com/adrianeyre/ai-office/commit/36561fd3ae0b77a0d4c68ce0d49453b3668046ee))
* **web:** the Activity Feed says a Plan was approved by a Spec's confirmed tasks ([8971689](https://github.com/adrianeyre/ai-office/commit/8971689c49e24dce01377e2a8652bf8eeacf6be3)), references [#45](https://github.com/adrianeyre/ai-office/issues/45)
* **web:** the Floor admin's Guidelines card, with Approve and Dismiss ([a88574d](https://github.com/adrianeyre/ai-office/commit/a88574d004007867b0d8550edc245211e5b6c557)), references [#37](https://github.com/adrianeyre/ai-office/issues/37)
* **web:** the Floor admin's Hooks card: add, edit, turn off, run now and delete a Hook ([c85b4b9](https://github.com/adrianeyre/ai-office/commit/c85b4b989c5ef27bed62fe40754764f04ec4b7db)), references [#49](https://github.com/adrianeyre/ai-office/issues/49)
* **web:** the Guidelines card shows what Agents proposed, to open as a pull request or reject ([c8d0150](https://github.com/adrianeyre/ai-office/commit/c8d015061d1471dbc87e3be9a3962c1f726c0865)), references [#41](https://github.com/adrianeyre/ai-office/issues/41)
* **web:** the whiteboard's Wrap-up lists where the merged work departs from its Spec's design ([817f0bf](https://github.com/adrianeyre/ai-office/commit/817f0bfa721b3806420efdb13040fbfed9c59699)), references [#48](https://github.com/adrianeyre/ai-office/issues/48)

### Bug Fixes

* **ci:** give ESLint an 8 GB heap, and count the Activity Feed apart from the Guidelines suggestion ([6b0d256](https://github.com/adrianeyre/ai-office/commit/6b0d25641fb5bf5912031257a6c64de8c1081992))
* **gateway:** start new sessions on the account that has spent least for its weight ([c3fdf59](https://github.com/adrianeyre/ai-office/commit/c3fdf5994cb8b23ef6d538eaf891dcd3ce926cfc))
* **orchestrator:** a proposal opened while GitHub is not set up is refused as such ([e5f0247](https://github.com/adrianeyre/ai-office/commit/e5f0247c6c55bd899e6e879bce81582a3ddaaa58)), references [#41](https://github.com/adrianeyre/ai-office/issues/41)
* **templates:** let the word lint allow "check" and "rule" in their everyday sense ([b35eb60](https://github.com/adrianeyre/ai-office/commit/b35eb608f31fe9e5cdc7eab85a294568d900588e))

## [1.14.0](https://github.com/adrianeyre/ai-office/compare/v1.13.0...v1.14.0) (2026-11-24)

### Features

* **web:** lead each AI Account with a priority badge ([7cc1041](https://github.com/adrianeyre/ai-office/commit/7cc1041f0284575b25006d91c4815bb40fb67cb3))

## [1.13.0](https://github.com/adrianeyre/ai-office/compare/v1.12.0...v1.13.0) (2026-11-21)

### Features

* **gateway:** per-key Browser access for Owner tool API keys ([c405b3b](https://github.com/adrianeyre/ai-office/commit/c405b3bfde818160e28ae14b4f875deafb7a1ac8))

### Bug Fixes

* **gateway:** send a browser page's Origin, Referer and Sec-* headers to no AI Provider ([6220e7f](https://github.com/adrianeyre/ai-office/commit/6220e7f60a039e5f9fa4f153ecbd8c18908a44b5))

## [1.12.0](https://github.com/adrianeyre/ai-office/compare/v1.11.0...v1.12.0) (2026-11-16)

### Features

* **gateway:** per-key AI Providers for Owner tool API keys ([0921cfe](https://github.com/adrianeyre/ai-office/commit/0921cfeea7cec8996aeaeb04513c7f68d10783ea))

## [1.11.0](https://github.com/adrianeyre/ai-office/compare/v1.10.0...v1.11.0) (2026-11-16)

### Features

* **gateway:** per-key Token Caps for Owner tool API keys, with unlimited ([fd76588](https://github.com/adrianeyre/ai-office/commit/fd76588a794775d1cf426f6c1f8e92361d6adbcd))

## [1.10.0](https://github.com/adrianeyre/ai-office/compare/v1.9.0...v1.10.0) (2026-11-15)

### Features

* **gateway:** weight load balancing by priority across all accounts ([04524cb](https://github.com/adrianeyre/ai-office/commit/04524cb3f9a7469db089aa123b7eb0363dbeb156))

## [1.9.0](https://github.com/adrianeyre/ai-office/compare/v1.8.1...v1.9.0) (2026-11-14)

### Features

* **events:** mark a Plan approved by the Owner's request in Manager chat ([0212b08](https://github.com/adrianeyre/ai-office/commit/0212b08b916f0da0d023173268b716760bce24ba))
* **manager:** let a chat request or /goal work existing issues and start at once ([ddf1d48](https://github.com/adrianeyre/ai-office/commit/ddf1d48b9b84a53ae8acf5180d0da0caf3d6b954))
* **skills:** refuse a Skill named goal, the chat's built-in command ([9e596f1](https://github.com/adrianeyre/ai-office/commit/9e596f10f61f2f59e88bb9bd44ccd4b2cace3426))
* **web:** offer /goal in the Manager chat's autocomplete and hint ([9968e0f](https://github.com/adrianeyre/ai-office/commit/9968e0f80c3b9d873223331f39cc99293453d817))
* **web:** search for a repository by name while GitHub is still listing them ([065f763](https://github.com/adrianeyre/ai-office/commit/065f763be4c6377239e6f110f6505c345bce3342))

### Bug Fixes

* **manager:** don't read "don't put them in one PR" as asking for one ([1acf0eb](https://github.com/adrianeyre/ai-office/commit/1acf0eb752268d9b3171214cf535fe23288cc42e))
* **sandcastle:** fetch the issue body, not only its comments ([e49b955](https://github.com/adrianeyre/ai-office/commit/e49b9557be17e6c714d473e1289664c48972ff2a))

## [1.8.1](https://github.com/adrianeyre/ai-office/compare/v1.8.0...v1.8.1) (2026-11-13)

### Bug Fixes

* **web:** keep three at 0.186 until n8ao's fix for r187 can be installed ([0ca9179](https://github.com/adrianeyre/ai-office/commit/0ca9179eb3f185bf01ea84c29a921081aee49415))

## [1.8.0](https://github.com/adrianeyre/ai-office/compare/v1.7.0...v1.8.0) (2026-11-12)

### Features

* **web:** check for a newer version the first time AI Office opens each day, and bring the Cookie Policy up to date ([e76f19e](https://github.com/adrianeyre/ai-office/commit/e76f19e736c45a133a035112379697ae7e0afa6f))

### Bug Fixes

* **gateway:** send a Model to the AI Provider that hosts it, never quietly to a compatible endpoint ([30c4c1c](https://github.com/adrianeyre/ai-office/commit/30c4c1c496c6f8075ada1fd61f217328b7be9b47))
* **web:** line up the collapsed menu's status dot, and keep Sign out at the menu's foot ([99c97ce](https://github.com/adrianeyre/ai-office/commit/99c97ce5032a79ead956bf2444c950106531be09))

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
