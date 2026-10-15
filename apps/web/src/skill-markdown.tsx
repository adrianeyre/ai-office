import type { ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// A Skill's Markdown, rendered (PRD FR-73): its `SKILL.md` and any
// supporting Markdown file, as the Available Skills modal shows them.
// Rendered to React elements, never as HTML: HTML written in the Markdown
// is shown as text, links open outside AI Office, and images are not
// fetched (their text is shown), so opening a Skill reaches nowhere. Its
// headings start at h3, under the modal's own title.

const shift = { h1: "h3", h2: "h4", h3: "h5", h4: "h6", h5: "h6", h6: "h6" };

/** Its props without react-markdown's `node`, which is no attribute. */
export function withoutNode<Props extends { node?: unknown }>(
  props: Props,
): Omit<Props, "node"> {
  const rest = { ...props };
  delete rest.node;
  return rest;
}

const components: Components = {
  ...Object.fromEntries(
    Object.entries(shift).map(([from, to]) => [
      from,
      (props: ComponentProps<"h1"> & { node?: unknown }) => {
        const Heading = to as "h3";
        return <Heading {...withoutNode(props)} />;
      },
    ]),
  ),
  a: (props) => <a {...withoutNode(props)} target="_blank" rel="noreferrer" />,
  img: ({ alt }) => (
    <span>
      {alt === undefined || alt === "" ? "(image)" : `(image: ${alt})`}
    </span>
  ),
};

export function SkillMarkdown({
  text,
  label,
}: {
  text: string;
  /** What the rendered text is, for a screen reader. */
  label: string;
}) {
  return (
    <section
      aria-label={label}
      className="skill-markdown text-sm leading-relaxed"
    >
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </section>
  );
}
