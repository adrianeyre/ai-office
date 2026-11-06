// The website's search and link-preview metadata (site/index.html's head)
// and the crawler files site/build.ts writes from site/seo.ts: the
// sitemap, robots.txt, llms.txt and the page's structured data. Each is
// held to the rules the search engines and preview cards publish, so a
// longer title or a missing share-image size fails here, not in a search
// result.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  llmsTxt,
  pageImages,
  robotsTxt,
  sitemapXml,
  structuredData,
} from "../site/seo.ts";

const root = join(import.meta.dirname, "..");
const page = await readFile(join(root, "site/index.html"), "utf8");
const head = page.slice(0, page.indexOf("</head>"));
const siteUrl = "https://ai-office.example";
const repositoryUrl = "https://github.com/example/ai-office";

/** The `content` of the head's meta tag with that `name` or `property`. */
function meta(key: string): string | undefined {
  const pattern = new RegExp(
    `<meta\\s+(?:name|property)="${key}"\\s+content="([^"]*)"`,
  );
  return pattern.exec(head)?.[1];
}

describe("the page's head", () => {
  it("has a title and description Google shows in full", () => {
    const title = /<title>([^<]*)<\/title>/.exec(head)?.[1] ?? "";
    expect(title).toContain("AI Office");
    expect(title.length).toBeGreaterThanOrEqual(30);
    expect(title.length).toBeLessThanOrEqual(60);
    const description = meta("description") ?? "";
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(160);
  });

  it("lets crawlers index it and names its canonical address", () => {
    expect(meta("robots")).toMatch(/^index, follow/);
    expect(head).toContain('<link rel="canonical" href="{{SITE_URL}}/" />');
  });

  it("gives every link preview a title, description and image", () => {
    for (const key of [
      "og:type",
      "og:site_name",
      "og:url",
      "og:title",
      "og:description",
      "og:image",
      "og:image:alt",
      "twitter:title",
      "twitter:description",
      "twitter:image",
      "twitter:image:alt",
    ]) {
      expect(meta(key), key).toBeTruthy();
    }
    expect(meta("twitter:card")).toBe("summary_large_image");
    // Previews fetch the image from elsewhere, so it must be absolute.
    expect(meta("og:image")).toBe("{{SITE_URL}}/og-image.png");
    expect(meta("og:title")?.length).toBeLessThanOrEqual(70);
    expect(meta("og:description")?.length).toBeLessThanOrEqual(200);
  });

  it("states the share image's true size and type", async () => {
    const image = await readFile(join(root, "apps/web/public/og-image.png"));
    // A PNG's width and height are the IHDR chunk's first two words.
    expect(image.subarray(1, 4).toString()).toBe("PNG");
    expect(meta("og:image:type")).toBe("image/png");
    expect(meta("og:image:width")).toBe(String(image.readUInt32BE(16)));
    expect(meta("og:image:height")).toBe(String(image.readUInt32BE(20)));
    expect(image.readUInt32BE(16)).toBe(1200);
    expect(image.readUInt32BE(20)).toBe(630);
  });

  it("carries the structured data", () => {
    expect(head).toMatch(
      /<script type="application\/ld\+json">\s*\{\{STRUCTURED_DATA\}\}\s*<\/script>/,
    );
  });
});

describe("the page's images", () => {
  it("lists each screenshot once, and each is in docs/images", () => {
    const images = pageImages(page);
    expect(images.length).toBeGreaterThan(0);
    expect(new Set(images).size).toBe(images.length);
    for (const image of images) {
      expect(existsSync(join(root, "docs", image)), image).toBe(true);
    }
  });
});

describe("sitemap.xml", () => {
  const sitemap = sitemapXml(siteUrl, "2026-11-06", [
    "images/a.png",
    "images/b&c.png",
  ]);

  it("lists the page with when it was built", () => {
    expect(sitemap).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n/);
    expect(sitemap).toContain("<loc>https://ai-office.example/</loc>");
    expect(sitemap).toContain("<lastmod>2026-11-06</lastmod>");
  });

  it("lists the screenshots as images, escaped for XML", () => {
    expect(sitemap).toContain(
      "<image:loc>https://ai-office.example/images/a.png</image:loc>",
    );
    expect(sitemap).toContain("images/b&amp;c.png");
    expect(sitemap).not.toContain("b&c");
  });
});

describe("robots.txt", () => {
  it("allows every crawler and names the sitemap by its full address", () => {
    const robots = robotsTxt(siteUrl);
    expect(robots).toContain("User-agent: *\nAllow: /\n");
    expect(robots).toContain(
      "Sitemap: https://ai-office.example/sitemap.xml\n",
    );
  });
});

describe("llms.txt", () => {
  it("follows llmstxt.org: a title, a summary and linked sections", () => {
    const text = llmsTxt(siteUrl, repositoryUrl);
    expect(text).toMatch(/^# AI Office\n\n> \S/);
    expect(text).toContain("\n## Docs\n");
    expect(text).toContain(`(${repositoryUrl}/blob/main/GLOSSARY.md)`);
  });
});

describe("the structured data", () => {
  const json = structuredData({
    siteUrl,
    repositoryUrl,
    version: "9.8.7",
    images: ["images/a.png"],
  });
  const graph = (JSON.parse(json) as { "@graph": Record<string, unknown>[] })[
    "@graph"
  ];
  const ofType = (type: string) => graph.find((node) => node["@type"] === type);

  it("is JSON that cannot close the script tag it sits in", () => {
    expect(json).not.toContain("<");
    expect(JSON.parse(json)).toMatchObject({
      "@context": "https://schema.org",
    });
  });

  it("describes the website, the page and the software", () => {
    expect(ofType("WebSite")).toMatchObject({ url: `${siteUrl}/` });
    expect(ofType("WebPage")).toMatchObject({ url: `${siteUrl}/` });
    expect(ofType("SoftwareApplication")).toMatchObject({
      name: "AI Office",
      applicationCategory: "DeveloperApplication",
      softwareVersion: "9.8.7",
      screenshot: [`${siteUrl}/images/a.png`],
    });
    expect(ofType("SoftwareSourceCode")).toMatchObject({
      codeRepository: repositoryUrl,
    });
  });
});
