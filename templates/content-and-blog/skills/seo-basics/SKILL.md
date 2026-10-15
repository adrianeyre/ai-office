---
name: seo-basics
description: How to give a site's pages and posts good titles, meta descriptions, headings, links, structured data, redirects and a sitemap in its repository, and how to check them. Use it when an issue is about how pages show in search results.
---

# SEO basics

Search results show a page's title and meta description, and search crawlers follow its links and read its structured data. All of these live in the repository, so they are changed like any other file.

## Each page

- **Title**: at most 60 characters, its own, saying what the page is, with the site's name last if the other pages do that.
- **Meta description**: at most 155 characters, its own, a true summary of the page that makes a reader want to open it.
- **Headings**: one top heading (`h1`, or the `title` a Markdown page's front matter turns into one), then headings in order, never skipping one.
- **Address**: lowercase words joined by hyphens. Once a page is live, keep its address; if it must change, add a redirect from the old address, as the site already does (such as a `_redirects` file or the framework's config).
- **Images**: alt text that says what each image shows.

Find where the site sets these (front matter, a layout's `<head>`, or a component such as `<Seo>`) and change them there, not page by page in the markup.

## Across the site

- Link related pages and posts to each other, with link text that says where it goes, never "click here".
- Keep `sitemap.xml` (or what generates it) listing every page that should be found, and `robots.txt` blocking only what should not.
- Give pages structured data where the site already uses it (JSON-LD, such as `Article`, `Product` or `Organization`), true to what the page shows.
- Never stuff keywords, hide text, or write for crawlers rather than readers.

## Check

- Every title and meta description is within its length and its own: search the repository for duplicates.
- Every internal link and redirect goes to a page that exists (`npm run check:links`, if the repository has it).
- The JSON-LD you added parses as JSON.
