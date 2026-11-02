# Stageshow kit (vendored)

The React kit from the Stageshow skill by Benji Taylor (MIT, see `LICENSE`
and `NOTICE.md`), which the website's product demos in `site/demos/` are
built on. `kit/` is copied as published, unmodified: restyle it from
`site/demos/` (`look.css` maps the app's tokens onto the kit's), never by
editing it, so it can be replaced by a newer copy whole. ESLint and Prettier
leave it alone, and `site/demos/tsconfig.json` checks it under plain
`strict`.

The kit's own brand artwork in `kit/brands/` keeps the sources and licences
listed in `kit/brands/SOURCES.md`; the website uses only the Connections
tile's marks, listed in `THIRD-PARTY-NOTICES.md`.

`REHEARSAL.md` records how each demo was rehearsed with the skill's filming
tools.
