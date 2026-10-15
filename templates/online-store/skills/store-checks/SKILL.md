---
name: store-checks
description: How to set up and run an online store's checks (theme check, links, prices, images and accessibility) as npm scripts in its repository, and what each one checks. Use it when the checks fail, are missing, or need changing.
---

# The store's checks

An Online store Floor checks every change with five scripts in the repository's `package.json`, run by the Floor's check command:

```sh
npm run check:theme && npm run check:links && npm run check:prices && npm run check:images && npm run check:accessibility
```

Each one exits with an error, naming the file and the problem, when its check fails. Run one on its own with `npm run check:<name>`.

## What each one checks

| Script | What it checks | A tool that does it |
| --- | --- | --- |
| `check:theme` | The theme's templates, sections and settings, by the theme platform's own linter | Shopify's Theme Check (`shopify theme check`) |
| `check:links` | Every link in the theme and the product data goes to a page or a file that exists | `linkinator` or `lychee`, on a local preview or the files |
| `check:prices` | Every product and variant has a price above zero in the store's currency; a compare-at price is above the price | a short Node script over the product data |
| `check:images` | Every product image is a file in the repository, has alt text, and is no larger than the theme shows it | a short Node script over the product data |
| `check:accessibility` | The theme's main pages: labels, contrast, headings and alt text | `axe` (`@axe-core/cli`) or `pa11y`, on a local preview |

## Setting them up

When a script is missing, add it to `package.json`, with the tool it needs in `devDependencies`, so that `npm install` brings it. For example:

```json
{
  "scripts": {
    "check:theme": "shopify theme check",
    "check:links": "linkinator . --recurse --skip '^https?://'",
    "check:prices": "node scripts/check-prices.mjs",
    "check:images": "node scripts/check-images.mjs",
    "check:accessibility": "node scripts/check-accessibility.mjs"
  }
}
```

The price and image checks read the product data where the repository keeps it (see the `product-data` Skill). Each prints one line per problem, such as `products/autumn.json: coat-3 has no price`, and exits with 1 if it found any.

Every check runs on the repository and a local preview only: none of them signs in to the live store.
