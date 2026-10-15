# Third-party notices

AI Office includes third-party assets (3D models, textures, sounds, fonts,
Skills) under their own licences. Every one is listed here with its source and licence
when it is added to the repository. npm dependencies are covered by their own
package metadata and are not repeated here.

The Office's ambient sound and music (`apps/web/src/scene/sound-player.ts`)
are synthesised in the browser by AI Office's own code with the Web Audio
API. They use no recordings or other sound files, so there is no sound to
list.

| Asset | Used for | Source | Author | Licence |
| ----- | -------- | ------ | ------ | ------- |
| Compose Specification JSON schema (`docker/compose-spec.json`) | Schema check of `docker-compose.yml` in `docker/deployment.test.ts` | [compose-spec/compose-go@14d7cfa](https://github.com/compose-spec/compose-go/blob/14d7cfa43f0b464014ed1114d4f1fbfe3344845c/schema/compose-spec.json) | The Compose Specification authors | Apache-2.0 |
| Inter Display Bold, as outlines in `apps/web/src/brand/logo.svg` | The "AI Office" wordmark in the default company logo | [rsms/inter v4.1](https://github.com/rsms/inter/releases/tag/v4.1) | The Inter Project Authors | OFL-1.1 |
| Inter (variable, Latin subset), `site/fonts/inter-latin-wght-normal.woff2` | The website's text | [@fontsource-variable/inter v5.3.0](https://github.com/fontsource/font-files/tree/main/fonts/variable/inter) | The Inter Project Authors | OFL-1.1 |
| JetBrains Mono (variable, Latin subset), `site/fonts/jetbrains-mono-latin-wght-normal.woff2` | The website's code and commands | [@fontsource-variable/jetbrains-mono v5.3.0](https://github.com/fontsource/font-files/tree/main/fonts/variable/jetbrains-mono) | The JetBrains Mono Project Authors | OFL-1.1 |
| Lucide icons, as SVG paths in `site/index.html` | The website's icons | [lucide-icons/lucide (lucide-react v1.55.0)](https://github.com/lucide-icons/lucide) | Lucide Contributors | ISC |
| Furniture Kit models in `apps/web/src/scene/models/`: `coffee-machine.glb`, `fridge.glb`, `bookcase.glb`, `books.glb`, `laptop.glb`, `potted-plant.glb` (from `kitchenCoffeeMachine`, `kitchenFridge`, `bookcaseOpen`, `books`, `laptop` and `pottedPlant`) | A Floor's canteen (coffee machine, fridge), bookshelf and books, a QA Agent's test laptop, a docs Agent's books and the plants; modified: scaled to real size, recoloured to the palette, Meshopt-compressed (`apps/web/scripts/prepare-models.ts`) | [Kenney Furniture Kit 2.0](https://kenney.nl/assets/furniture-kit) | Kenney | CC0-1.0 |
| Matt Pocock's skills, adapted, in `packages/orchestrator/src/skills/built-in/`: `grill-with-docs`, `wayfinder`, `to-tickets`, `to-spec`, `pr` (with `CREDITS.md`), `domain-modeling` (with `ADR-FORMAT.md`, `GLOSSARY-FORMAT.md`), `research`, `prototype` (with `UI.md`, `LOGIC.md`), `tdd` (with `tests.md`, `mocking.md`), `codebase-design` (with `DEEPENING.md`, `DESIGN-IT-TWICE.md`), `diagnosing-bugs` and `code-review`; modified: adapted to AI Office's Grilling Sessions, Manager chat and document folders, each saying so | AI Office's built-in Skills (PRD FR-83b) | [mattpocock/skills@f3fc563](https://github.com/mattpocock/skills/tree/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills) | Matt Pocock; `pr`'s Summary section from [Dex Horthy](https://github.com/dexhorthy)'s `show-me` skill (Humanlayer), as `pr/CREDITS.md` credits it | MIT (below, and `packages/orchestrator/src/skills/built-in/LICENSE`) |

## The MIT licence of Matt Pocock's skills

```text
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
