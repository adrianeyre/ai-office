---
name: product-data
description: How to find, read and change a store's product data in its repository (products, variants, prices, stock, collections and images) and keep it consistent. Use it when an issue adds, changes or checks products.
---

# Product data

A store's repository keeps its product data in files, so that changes to it are reviewed like any other change. This Skill is how to work with them.

## Find it

Look for the files that list products before you change anything:

- a CSV export, such as `products.csv`, with one row per variant;
- JSON or YAML files, such as `products/*.json` or `data/products.yml`, with one product each or a list of them;
- the README or a `CONTRIBUTING.md`, which may say where the data lives and how it is imported into the store.

Follow the format the repository already uses. Never add a second place for the same data.

## Change it

- Copy the fields of a product next to the one you add, in the same order, and fill in every one that product has.
- Give each product a handle (the part of its address after `/products/`) of lowercase words joined by hyphens, unique in the store, and never change an existing product's handle unless the issue asks: links to it would break.
- Give every variant its own SKU, unique in the store, and its options (such as size and colour) in the order the other products list them.
- Write prices as the repository already does (often a decimal such as `79.00`, or whole pence or cents), in the store's currency, above zero. A compare-at price, where there is one, is above the price.
- Keep stock as a whole number, never below zero.
- For each image, add the file to the repository, at the size the other product images are, and give it alt text that says what the image shows, not the product's name alone.
- Put each product in the collections the issue names, as the repository lists them (a field on the product, or a collection file listing handles).

## Check it

Before you finish:

- every product you touched has a price, a SKU on each variant, and an image with alt text;
- every collection you named exists;
- `npm run check:prices` and `npm run check:images` pass, if the repository has them.

Say in your Handoff anything the issue left out, such as a missing price, rather than making it up.
