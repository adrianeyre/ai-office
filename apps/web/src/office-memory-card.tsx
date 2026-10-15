import {
  maxOfficeMemoryLength,
  officeMemorySchema,
  type OfficeMemory,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";

import { useAnchor } from "./anchor.ts";
import { getJson, readApiError, sendJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

// The office-wide memory in Admin (PRD FR-54, FR-56): the Owner's coding
// standards, preferred libraries and review rules, mounted read-only into
// every sandbox and quoted in every reviewer's prompt. The server refuses
// a save that looks like it holds a credential, naming the lines.

/** `GET /api/memory/office`. */
export const officeMemoryQuery = queryOptions({
  queryKey: ["memory", "office"],
  queryFn: () => getJson("/api/memory/office", officeMemorySchema),
});

function OfficeMemoryForm({ memory }: { memory: OfficeMemory }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [content, setContent] = useState(memory.content);
  const [saved, setSaved] = useState(memory.content);
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const changed = content !== saved;

  const save = async () => {
    setSaving(true);
    setDone(false);
    const response = await sendJson(
      "PUT",
      "/api/memory/office",
      { content },
      session?.csrfToken,
    );
    setSaving(false);
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems([
        error.message ?? "The office-wide memory was not saved.",
        ...(error.problems ?? []),
      ]);
      return;
    }
    const updated = officeMemorySchema.parse(await response.json());
    setProblems([]);
    setSaved(updated.content);
    setDone(true);
    queryClient.setQueryData(officeMemoryQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="Office-wide memory"
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="office-memory">Memory (Markdown)</Label>
        <textarea
          id="office-memory"
          rows={10}
          value={content}
          maxLength={maxOfficeMemoryLength}
          spellCheck
          aria-describedby="office-memory-hint"
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm"
          onChange={(event) => {
            setContent(event.target.value);
            setDone(false);
          }}
        />
        <p id="office-memory-hint" className="text-sm text-muted-foreground">
          {content.length.toLocaleString("en-GB")} of{" "}
          {maxOfficeMemoryLength.toLocaleString("en-GB")} characters. Never put
          a credential in it: a save that looks like it holds one is refused.
        </p>
      </div>
      {problems.length > 0 && (
        <div role="alert">
          <ul className="space-y-1 text-sm text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {done && !changed && (
        <p role="status" className="text-sm">
          Saved.
        </p>
      )}
      <Button
        pending={saving}
        type="submit"
        disabled={!changed || saving || session === undefined}
      >
        {saving ? "Saving…" : "Save office-wide memory"}
      </Button>
    </form>
  );
}

/** The office-wide memory every Agent is given (PRD FR-54). */
export function OfficeMemoryCard() {
  const { data: memory, isError } = useQuery(officeMemoryQuery);
  const anchor = useAnchor<HTMLDivElement>("office-wide-memory");
  return (
    <Card id="office-wide-memory" ref={anchor} className="scroll-mt-4">
      <CardHeader>
        <CardTitle>
          <h2>Office-wide memory</h2>
        </CardTitle>
        <CardDescription>
          What every Agent on every Floor should know, such as coding standards,
          preferred libraries and review rules. It is mounted read-only into
          every sandbox and quoted in every reviewer&apos;s prompt, as
          background rather than instructions. Each change is recorded in the
          Activity Feed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The office-wide memory could not be loaded.
          </p>
        )}
        {memory !== undefined && <OfficeMemoryForm memory={memory} />}
      </CardContent>
    </Card>
  );
}
