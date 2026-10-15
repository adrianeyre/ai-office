import { useMatches } from "@tanstack/react-router";
import { useEffect } from "react";

import { brand } from "./brand/brand.ts";
import { useOfficePlace } from "./office-place.ts";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The page's name, for the browser tab's title (WCAG 2.4.2). */
    title?: string;
    /** Whether the tab also names where the Office's scene is, "AI Office - Lobby". */
    officePlace?: boolean;
  }
}

/**
 * The browser tab's title: simply the product's name, "AI Office", on
 * every page, as the Owner asked, and on the Office with where its scene
 * is, "AI Office - Lobby". The page's own name stays in its heading, which
 * screen readers announce on each navigation.
 */
export const documentTitle = (place?: string): string =>
  place === undefined ? brand.name : `${brand.name} - ${place}`;

/** Sets the browser tab's title as each page named `title` opens. */
export function DocumentTitle({
  title,
  place,
}: {
  title: string;
  place?: string | undefined;
}) {
  useEffect(() => {
    document.title = documentTitle(place);
  }, [title, place]);
  return null;
}

/** The Office's tab title, kept in step with the lift. */
function OfficeDocumentTitle({ title }: { title: string }) {
  return <DocumentTitle title={title} place={useOfficePlace()} />;
}

/** Sets the browser tab's title to the deepest matched route's. */
export function RouteTitle() {
  const staticData = useMatches({
    select: (matches) =>
      matches.findLast((match) => match.staticData.title !== undefined)
        ?.staticData,
  });
  const title = staticData?.title;
  if (title === undefined) return null;
  return staticData?.officePlace === true ? (
    <OfficeDocumentTitle title={title} />
  ) : (
    <DocumentTitle title={title} />
  );
}
