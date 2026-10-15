import {
  configurationAreas,
  configurationPreviewSchema,
  configurationSchema,
  type Configuration,
  type ConfigurationArea,
  type ConfigurationPreview,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

import { postJson, readApiError } from "./api.ts";
import { sessionQuery } from "./session.ts";

// Configuration export and import (PRD FR-65): every setting as one JSON
// file without a credential, and such a file read back. An import is
// previewed first: what it adds and changes, and anything that stops it.

/** How each area is named in the preview. */
const areaNames: Record<ConfigurationArea, string> = {
  office: "Office settings",
  ai_provider: "AI Providers",
  model_price: "Model prices",
  office_memory: "Office-wide memory",
  skill: "Skills",
  role: "Role library",
  floor_template: "Floor Templates",
  floor: "Floors",
  agent: "Agents",
  issue_token_caps: "Issues' Token Caps",
  skill_toggle: "Floors' Skill settings",
  role_memory: "Role memory",
};

/** The file chosen, read and checked, or why it cannot be imported. */
type Chosen =
  | { readonly configuration: Configuration; readonly name: string }
  | { readonly problems: readonly string[] };

async function readConfiguration(file: File): Promise<Chosen> {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(await file.arrayBuffer()));
  } catch {
    return { problems: [`${file.name} is not JSON.`] };
  }
  const parsed = configurationSchema.safeParse(data);
  return parsed.success
    ? { configuration: parsed.data, name: file.name }
    : {
        problems: [
          ...new Set(parsed.error.issues.map(({ message }) => message)),
        ],
      };
}

function Problems({ problems }: { problems: readonly string[] }) {
  return problems.length === 0 ? null : (
    <div role="alert">
      <ul className="space-y-1 text-sm text-destructive">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </div>
  );
}

function PreviewList({ preview }: { preview: ConfigurationPreview }) {
  if (preview.changes.length === 0) {
    return (
      <p className="text-sm">Nothing to change: it is all here already.</p>
    );
  }
  return (
    <div className="space-y-3">
      {configurationAreas.map((area) => {
        const changes = preview.changes.filter(
          (change) => change.area === area,
        );
        return changes.length === 0 ? null : (
          <section key={area} aria-label={areaNames[area]}>
            <h3 className="text-sm font-medium">{areaNames[area]}</h3>
            <ul className="list-disc space-y-1 ps-5 text-sm">
              {changes.map((change, index) => (
                <li key={`${change.subject}-${String(index)}`}>
                  {change.action === "add" ? "Add" : "Change"}{" "}
                  <span className="font-medium">{change.subject}</span>
                  {change.fields.length > 0 && `: ${change.fields.join(", ")}`}
                  {change.note !== null && (
                    <span className="text-muted-foreground">
                      {" "}
                      {change.note}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Exports and imports the Office's configuration (PRD FR-65). */
export function ConfigurationCard() {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [chosen, setChosen] = useState<Chosen>();
  const [preview, setPreview] = useState<ConfigurationPreview>();
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [imported, setImported] = useState<number>();
  const [busy, setBusy] = useState(false);

  const choose = async (file: File | undefined) => {
    setPreview(undefined);
    setProblems([]);
    setImported(undefined);
    if (file === undefined) {
      setChosen(undefined);
      return;
    }
    const read = await readConfiguration(file);
    setChosen(read);
    if (!("configuration" in read)) {
      return;
    }
    setBusy(true);
    const response = await postJson(
      "/api/configuration/import/preview",
      read.configuration,
      session?.csrfToken,
    );
    if (response.ok) {
      setPreview(configurationPreviewSchema.parse(await response.json()));
    } else {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "The file could not be previewed."],
      );
    }
    setBusy(false);
  };

  const apply = async () => {
    if (chosen === undefined || !("configuration" in chosen)) {
      return;
    }
    setBusy(true);
    const response = await postJson(
      "/api/configuration/import",
      chosen.configuration,
      session?.csrfToken,
    );
    if (response.ok) {
      const applied = configurationPreviewSchema.parse(await response.json());
      setImported(applied.changes.length);
      setPreview(undefined);
      setChosen(undefined);
      // Everything the admin shows may have changed.
      await queryClient.invalidateQueries();
    } else {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [
          error.message ?? "The configuration was not imported.",
        ],
      );
    }
    setBusy(false);
  };

  const fileProblems =
    chosen !== undefined && "problems" in chosen ? chosen.problems : [];
  const blocked = (preview?.problems.length ?? 0) > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Configuration</h2>
        </CardTitle>
        <CardDescription>
          Every setting as one JSON file: the office&apos;s settings and the AI
          Gateway&apos;s in AI Settings, AI Providers, Token Caps, Model prices,
          Skills, memory, and each Floor with its Merge Policy and Agents. It
          holds no credential: AI Accounts, Gateway Keys and your password stay
          here. Importing a file shows what it adds and changes first; it never
          removes anything, and imported Skills wait for your review.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button asChild variant="outline">
          <a href="/api/configuration/export" download>
            Export configuration
          </a>
        </Button>
        <div className="space-y-2 sm:max-w-md">
          <Label htmlFor="configuration-import">Import a configuration</Label>
          <Input
            id="configuration-import"
            type="file"
            accept="application/json,.json"
            disabled={busy || session === undefined}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
        </div>
        <Problems problems={[...fileProblems, ...problems]} />
        {preview !== undefined && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium">
              What importing{" "}
              {chosen !== undefined && "name" in chosen ? chosen.name : "it"}{" "}
              would do
            </h3>
            {blocked ? (
              <>
                <p className="text-sm">
                  It cannot be imported until these are put right:
                </p>
                <Problems problems={preview.problems} />
              </>
            ) : (
              <PreviewList preview={preview} />
            )}
            <Button
              pending={busy}
              type="button"
              disabled={
                busy ||
                blocked ||
                preview.changes.length === 0 ||
                session === undefined
              }
              onClick={() => void apply()}
            >
              {busy ? "Importing…" : "Import these changes"}
            </Button>
          </div>
        )}
        {imported !== undefined && (
          <p role="status" className="text-sm">
            Imported: {imported} {imported === 1 ? "change" : "changes"}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
