---
name: design-tokens
description: How a design system keeps and names its design tokens (colours, font sizes, spacing, radii and shadows), and how to add or change one. Use it when a change needs a colour, a size or a space.
---

# Design tokens

Design tokens are the design system's named values: its colours, font sizes, line heights, spacing, radii, shadows and durations. Components take every such value from a design token, never a literal, so that one change to a design token changes every component that uses it.

## Where they are

The repository keeps them in one place, such as `tokens/*.json` in the Design Tokens Community Group's format, and builds them into what the components read (CSS custom properties, or a theme object), such as with Style Dictionary. Change the source files, never the built ones.

## Names

- A base design token names a value: `colour.blue.600`, `space.4`.
- A semantic design token names a use, and refers to a base one: `text.default`, `surface.raised`, `border.focus`. Components use the semantic ones.
- Each theme (light, dark, high contrast) gives every semantic design token its value, so a new semantic design token has one in every theme.

## Adding or changing one

- Add a design token only when no design token there is fits the use, and name it for the use, not the value.
- When a colour changes, check every pair it is in with `npm run check:contrast`, in every theme.
- When a design token is renamed, keep its old name as an alias for one release and say so in the changelog, so that code using it has time to change.
