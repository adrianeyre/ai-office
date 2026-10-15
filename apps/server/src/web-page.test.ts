import { describe, expect, it } from "vitest";

import {
  originOf,
  originPlaceholder,
  pageUrlPlaceholder,
  renderIndexHtml,
  robotsTxt,
  sitemapXml,
} from "./web-page.ts";

describe("renderIndexHtml", () => {
  it("fills in the origin and the page's address", () => {
    const html = `<meta property="og:image" content="${originPlaceholder}/og-image.png" /><link rel="canonical" href="${pageUrlPlaceholder}" />`;
    expect(
      renderIndexHtml(html, {
        origin: "https://office.example",
        path: "/login",
      }),
    ).toBe(
      '<meta property="og:image" content="https://office.example/og-image.png" /><link rel="canonical" href="https://office.example/login" />',
    );
  });

  it("escapes what it fills in", () => {
    const rendered = renderIndexHtml(`<a href="${pageUrlPlaceholder}">`, {
      origin: "https://office.example",
      path: '/"><script>',
    });
    expect(rendered).not.toContain("<script>");
    expect(rendered).not.toContain('"><');
  });
});

describe("originOf", () => {
  it("drops the path and trailing slash", () => {
    expect(originOf("https://office.example:8443/ai/")).toBe(
      "https://office.example:8443",
    );
  });
});

describe("robots.txt and the sitemap", () => {
  it("lets crawlers in, keeps them off the API and names the sitemap", () => {
    const robots = robotsTxt("https://office.example");
    expect(robots).toContain("Allow: /\n");
    expect(robots).toContain("Disallow: /api/\n");
    expect(robots).toContain("Sitemap: https://office.example/sitemap.xml");
  });

  it("lists the sign-in page by its absolute URL", () => {
    expect(sitemapXml("https://office.example")).toContain(
      "<loc>https://office.example/login</loc>",
    );
  });
});
