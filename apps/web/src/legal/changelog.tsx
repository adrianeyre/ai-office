import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// The root CHANGELOG.md, which semantic-release writes on every release,
// bundled into the app when it is built.
import changelog from "../../../../CHANGELOG.md?raw";
import { withoutNode } from "../skill-markdown.tsx";

// Rendered to React elements, never as HTML, like a Skill's Markdown. Each
// release's heading (`##`) is an h3 under the dialog's own title, and its
// sections (`###`) h4s; links open in a new tab.
const components: Components = {
  h1: (props) => <h3 {...withoutNode(props)} />,
  h2: (props) => <h3 {...withoutNode(props)} />,
  h3: (props) => <h4 {...withoutNode(props)} />,
  h4: (props) => <h5 {...withoutNode(props)} />,
  h5: (props) => <h6 {...withoutNode(props)} />,
  h6: (props) => <h6 {...withoutNode(props)} />,
  a: (props) => (
    <a {...withoutNode(props)} target="_blank" rel="noopener noreferrer" />
  ),
  img: ({ alt }) => <span>{alt}</span>,
};

/** The changelog's text, shown in its dialog from the footer's version. */
export function Changelog({ text = changelog }: { text?: string }) {
  return (
    <div className="skill-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}
