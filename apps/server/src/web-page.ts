// What search engines and link previews (Slack, social sites) read: the web
// app's index.html with its absolute URLs filled in, robots.txt and the
// sitemap. Open Graph images and canonical links must be absolute, and only
// the server knows the address AI Office is reached at (PUBLIC_URL).

/** Stands for the site's origin in the built index.html. */
export const originPlaceholder = "__AI_OFFICE_ORIGIN__";
/** Stands for the page's own address (origin and path) in index.html. */
export const pageUrlPlaceholder = "__AI_OFFICE_PAGE_URL__";

/** The pages a signed-out visitor, or a crawler, can see. */
export const indexablePaths = ["/login"] as const;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** `publicUrl`'s origin: scheme, host and port, no trailing slash. */
export const originOf = (publicUrl: string): string =>
  new URL(publicUrl).origin;

/** index.html for the page at `path` (no query), with its URLs filled in. */
export function renderIndexHtml(
  html: string,
  { origin, path }: { origin: string; path: string },
): string {
  const pageUrl = new URL(path, origin).href;
  return html
    .replaceAll(pageUrlPlaceholder, escapeHtml(pageUrl))
    .replaceAll(originPlaceholder, escapeHtml(origin));
}

/** robots.txt: the sign-in page may be crawled; the API never. */
export function robotsTxt(origin: string): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

/** sitemap.xml: the pages a crawler can reach without signing in. */
export function sitemapXml(origin: string): string {
  const urls = indexablePaths
    .map(
      (path) =>
        `  <url><loc>${escapeHtml(new URL(path, origin).href)}</loc></url>`,
    )
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    "</urlset>",
    "",
  ].join("\n");
}
