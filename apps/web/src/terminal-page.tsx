import { useQuery } from "@tanstack/react-query";

import { PageHeader } from "@/components/ui/page-header.tsx";

import { DirectChatPanel, directChatQuery } from "./direct-chat.tsx";

// The Terminal: the Owner talks with the AI itself, outside any Floor, as
// in a terminal. Each message asks the AI Provider's default Model the
// Owner chooses, through the AI Gateway with the Terminal's own key, so
// its tokens show in the request history as the Owner tool "Terminal".

const terminal = { kind: "terminal" } as const;

export function TerminalPage() {
  const { data } = useQuery(directChatQuery(terminal));
  return (
    <section className="flex h-full flex-col gap-4">
      <PageHeader
        title="Terminal"
        description={
          <>
            Chat with the AI directly: ask questions, draft and review code and
            text. It answers with the default Model of the AI Provider you
            choose, through the AI Gateway
            {data?.model === undefined || data.model === ""
              ? ""
              : `, ${data.aiProvider ?? ""} ${data.model} unless you choose another`}
            . To have work done on a repository, use a Floor&apos;s Manager
            chat.
          </>
        }
      />
      <DirectChatPanel place={terminal} terminal className="h-[70vh]" />
    </section>
  );
}
