// The files search engines and AI crawlers read alongside the website:
// `sitemap.xml`, `robots.txt` and `llms.txt`. site/build.ts writes them
// into `site/dist/` from the page itself, so a screenshot added to the
// gallery is in the sitemap without anyone listing it twice.
// test/site-seo.test.ts holds them, and the page's own head, to the rules
// search engines publish.

/** The page's one-line pitch, shared by `llms.txt` and the structured data. */
export const tagline =
  "A self-hosted 3D office where AI coding agents work your GitHub issues in sandboxes, with a built-in AI Gateway that pools your Claude, ChatGPT and local-model accounts.";

/**
 * Every screenshot the page shows, in page order and once each: the
 * `images/…` files its `<img>` tags name.
 */
export function pageImages(page: string): string[] {
  const found = page.matchAll(/<img\b[^>]*\bsrc="(images\/[^"]+)"/g);
  return [...new Set([...found].map((match) => match[1] ?? ""))];
}

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/**
 * The sitemap: the one page, when it was last built, and its screenshots
 * as an image sitemap so they can be found in image search. `siteUrl` has
 * no trailing slash; `lastModified` is a `YYYY-MM-DD` date.
 */
export function sitemapXml(
  siteUrl: string,
  lastModified: string,
  images: readonly string[],
): string {
  const imageEntries = images.map(
    (image) =>
      `    <image:image>\n      <image:loc>${escapeXml(`${siteUrl}/${image}`)}</image:loc>\n    </image:image>\n`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n',
    '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n',
    "  <url>\n",
    `    <loc>${escapeXml(`${siteUrl}/`)}</loc>\n`,
    `    <lastmod>${lastModified}</lastmod>\n`,
    ...imageEntries,
    "  </url>\n",
    "</urlset>\n",
  ].join("");
}

/** Every crawler may read everything, and is told where the sitemap is. */
export function robotsTxt(siteUrl: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`;
}

/**
 * `llms.txt` (llmstxt.org): a plain summary of the project, with links to
 * the documents worth reading, for AI assistants and AI search.
 */
export function llmsTxt(siteUrl: string, repositoryUrl: string): string {
  const doc = (path: string) => `${repositoryUrl}/blob/main/${path}`;
  return `# AI Office

> ${tagline}

Each GitHub repository is a Floor with a Manager and a team of Agents. Label an issue, or tell the Manager "complete issues 1 to 5", and the Agents plan, code, review and merge it, each in its own Docker sandbox. AI reviewers and QA check each pull request, and the Floor's Merge Policy decides whether it merges. It runs on Windows, macOS and Linux with Docker.

- Website: ${siteUrl}/
- Source code: ${repositoryUrl}

## Docs

- [Guide](${doc("docs/guide/README.md")}): how AI Office works, part by part
- [Running AI Office](${doc("docs/guide/running.md")}): development, docker compose, first run and sign-in
- [Setting up a Floor](${doc("docs/processes/setting-up-a-floor.md")}): connecting a repository and its team
- [Glossary](${doc("GLOSSARY.md")}): the terms AI Office uses

## Optional

- [Issues](${repositoryUrl}/issues): bugs and feature requests
- [Third-party notices](${doc("THIRD-PARTY-NOTICES.md")}): the licences of the assets it includes
`;
}

/** What the structured data needs to know that the page does not say. */
export interface StructuredDataInput {
  siteUrl: string;
  repositoryUrl: string;
  version: string;
  images: readonly string[];
}

/**
 * The page's schema.org structured data (JSON-LD): the website, the page,
 * and AI Office as a piece of software with its source code, so search
 * engines can show it as an application rather than as a bare link.
 */
export function structuredData({
  siteUrl,
  repositoryUrl,
  version,
  images,
}: StructuredDataInput): string {
  const home = `${siteUrl}/`;
  const author = {
    "@type": "Person",
    "@id": `${home}#author`,
    name: "Adrian Eyre",
    url: "https://github.com/adrianeyre",
  };
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${home}#website`,
        url: home,
        name: "AI Office",
        description: tagline,
        inLanguage: "en-GB",
        publisher: { "@id": `${home}#author` },
      },
      {
        "@type": "WebPage",
        "@id": `${home}#webpage`,
        url: home,
        name: "AI Office: self-hosted AI coding agents for GitHub issues",
        isPartOf: { "@id": `${home}#website` },
        about: { "@id": `${home}#software` },
        primaryImageOfPage: { "@id": `${home}#share-image` },
        inLanguage: "en-GB",
      },
      {
        "@type": "ImageObject",
        "@id": `${home}#share-image`,
        url: `${siteUrl}/og-image.png`,
        width: 1200,
        height: 630,
        caption: "AI Office: AI agents work your GitHub issues in a 3D office.",
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${home}#software`,
        name: "AI Office",
        description: tagline,
        url: home,
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "AI coding agents",
        operatingSystem: "Windows, macOS, Linux",
        softwareVersion: version,
        softwareRequirements: "Docker",
        downloadUrl: repositoryUrl,
        image: { "@id": `${home}#share-image` },
        screenshot: images.map((image) => `${siteUrl}/${image}`),
        author: { "@id": `${home}#author` },
        sameAs: [repositoryUrl],
      },
      {
        "@type": "SoftwareSourceCode",
        "@id": `${home}#source`,
        name: "AI Office",
        codeRepository: repositoryUrl,
        programmingLanguage: "TypeScript",
        targetProduct: { "@id": `${home}#software` },
        author: { "@id": `${home}#author` },
      },
      author,
    ],
  };
  // `<` escaped, so no text in it can close the script tag it sits in.
  return JSON.stringify(graph).replaceAll("<", "\\u003c");
}
