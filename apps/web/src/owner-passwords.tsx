import {
  addOwnerPasswordRequestSchema,
  defaultTimeZone,
  greeting,
  ownerPasswordInfoSchema,
  ownerPasswordListSchema,
  ownerPasswordSettingsSchema,
  passwordProblems,
  type OwnerPasswordInfo,
  type OwnerPasswordSettings,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

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
import { Badge } from "@/components/ui/badge.tsx";
import { selectClass } from "@/lib/utils.ts";

import {
  getJson,
  postJson,
  readApiError,
  sendDelete,
  sendJson,
} from "./api.ts";
import { Problems, problemsIn, problemsOf } from "./gateway-keys-card.tsx";
import { OwnerProofFields, useOwnerProof } from "./owner-proof.tsx";
import { ownerProfileQuery } from "./people.ts";
import { timeZoneLabel, timeZones } from "./time-zones.ts";
import { sessionQuery } from "./session.ts";

// The Owner's passwords in API Key Management: one for each person who
// signs in to AI Office. Each has a name, and the nickname and time zone
// (British time until set) the lobby's receptionist greets them by. The
// first, set at setup, cannot be removed; removing another signs it out
// everywhere. Any can be changed (A1-9), which signs the old one out
// everywhere.

/** The Owner's passwords (`GET /api/owner-passwords`), never the passwords. */
export const ownerPasswordsQuery = queryOptions({
  queryKey: ["owner-passwords"],
  queryFn: async () =>
    (await getJson("/api/owner-passwords", ownerPasswordListSchema)).passwords,
});

function PasswordSettingsForm({ password }: { password: OwnerPasswordInfo }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const valuesOf = (from: OwnerPasswordInfo): OwnerPasswordSettings => ({
    name: from.name,
    nickname: from.nickname,
    timeZone: from.timeZone,
  });
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { isDirty, isSubmitting },
  } = useForm<OwnerPasswordSettings>({ defaultValues: valuesOf(password) });
  const values = useWatch({ control });
  const id = (field: string) => `password-${password.id}-${field}`;
  const zones = timeZones();
  if (!zones.includes(password.timeZone)) {
    zones.push(password.timeZone);
  }

  const onSubmit = async (submitted: OwnerPasswordSettings) => {
    setSaved(false);
    const parsed = ownerPasswordSettingsSchema.safeParse(submitted);
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      `/api/owner-passwords/${encodeURIComponent(password.id)}`,
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      setProblems(await problemsOf(response, "The password was not saved."));
      return;
    }
    const updated = ownerPasswordInfoSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(valuesOf(updated));
    queryClient.setQueryData(ownerPasswordsQuery.queryKey, (passwords) =>
      passwords?.map((each) => (each.id === updated.id ? updated : each)),
    );
    if (password.first) {
      await queryClient.invalidateQueries(ownerProfileQuery);
    }
  };

  const preview = greeting(
    {
      forename: values.name ?? "",
      surname: "",
      nickname: values.nickname ?? "",
      timeZone: values.timeZone ?? defaultTimeZone,
    },
    new Date(),
  );

  return (
    <form
      noValidate
      aria-label={`${password.name}'s password settings`}
      className="space-y-3"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor={id("name")}>Name</Label>
          <Input id={id("name")} autoComplete="off" {...register("name")} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("nickname")}>Nickname</Label>
          <Input
            id={id("nickname")}
            autoComplete="off"
            {...register("nickname")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("time-zone")}>Time zone</Label>
          <select
            id={id("time-zone")}
            className={selectClass}
            {...register("timeZone")}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {timeZoneLabel(zone)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        The receptionist says: <q>{preview}</q>
      </p>
      <Problems problems={problems} />
      {saved && !isDirty && (
        <p role="status" className="text-sm">
          Saved.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        size="sm"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : `Save ${password.name}`}
      </Button>
    </form>
  );
}

/**
 * Replaces a password, the first's included, so a leaked one stops signing
 * in (A1-9). It needs that password itself, and a code when TOTP is on, and
 * signs out every session it began, this one too if it did.
 */
function ChangePassword({ password }: { password: OwnerPasswordInfo }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const proof = useOwnerProof();
  const [open, setOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [changed, setChanged] = useState(false);
  const [sending, setSending] = useState(false);
  const id = (field: string) => `password-${password.id}-change-${field}`;

  const change = async () => {
    setChanged(false);
    const weak = passwordProblems(replacement);
    if (weak.length > 0) {
      setProblems(weak);
      return;
    }
    setProblems([]);
    if (!proof.ready()) {
      return;
    }
    setSending(true);
    const response = await sendJson(
      "PUT",
      `/api/owner-passwords/${encodeURIComponent(password.id)}`,
      {
        name: password.name,
        nickname: password.nickname,
        timeZone: password.timeZone,
        password: replacement,
        ...proof.proof,
      },
      session?.csrfToken,
    );
    setSending(false);
    if (!response.ok) {
      const error = await readApiError(response);
      if (!proof.refused(error)) {
        setProblems(problemsIn(error, "The password was not changed."));
      }
      return;
    }
    proof.reset();
    setReplacement("");
    setChanged(true);
    setOpen(false);
    await queryClient.invalidateQueries(ownerPasswordsQuery);
    // Changing the password this session signed in with ends it.
    await queryClient.invalidateQueries(sessionQuery);
  };

  if (!open) {
    return (
      <div className="space-y-2">
        {changed && (
          <p role="status" className="text-sm">
            Changed {password.name}&apos;s password. It signs in with the new
            one, and every session the old one began is signed out.
          </p>
        )}
        <Button
          size="sm"
          variant="outline"
          aria-label={`Change ${password.name}'s password`}
          onClick={() => {
            setOpen(true);
          }}
        >
          <KeyRound aria-hidden />
          Change password
        </Button>
      </div>
    );
  }
  return (
    <form
      noValidate
      aria-label={`Change ${password.name}'s password`}
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void change();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={id("new")}>New password</Label>
        <Input
          id={id("new")}
          type="password"
          autoComplete="new-password"
          aria-describedby={id("new-hint")}
          value={replacement}
          onChange={(event) => {
            setReplacement(event.target.value);
          }}
        />
        <p id={id("new-hint")} className="text-xs text-muted-foreground">
          At least 12 characters, unlike every Owner password. Every session the
          old one began is signed out.
        </p>
      </div>
      <OwnerProofFields
        id={id("proof")}
        reason={`Confirm with ${password.name}'s password as it is now: the one you are replacing.`}
        state={proof}
      />
      <Problems problems={problems} />
      <div className="flex flex-wrap gap-2">
        <Button
          pending={sending}
          type="submit"
          size="sm"
          disabled={sending || session === undefined || !proof.canProve}
        >
          {sending ? "Changing…" : `Change ${password.name}'s password`}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            proof.reset();
            setReplacement("");
            setProblems([]);
            setOpen(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Removes a further password, once the Owner confirms. */
function RemovePassword({ password }: { password: OwnerPasswordInfo }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [confirming, setConfirming] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const remove = async () => {
    const response = await sendDelete(
      `/api/owner-passwords/${encodeURIComponent(password.id)}`,
      session?.csrfToken,
    );
    if (!response.ok) {
      setProblems(await problemsOf(response, "The password was not removed."));
      return;
    }
    await queryClient.invalidateQueries(ownerPasswordsQuery);
    // Removing the password this session signed in with ends it.
    await queryClient.invalidateQueries(sessionQuery);
  };
  return confirming ? (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="destructive"
        disabled={session === undefined}
        onClick={() => void remove()}
      >
        Remove {password.name}&apos;s password
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setConfirming(false);
        }}
      >
        Cancel
      </Button>
      <Problems problems={problems} />
    </div>
  ) : (
    <Button
      size="sm"
      variant="outline"
      aria-label={`Remove ${password.name}'s password`}
      onClick={() => {
        setConfirming(true);
      }}
    >
      <Trash2 aria-hidden />
      Remove
    </Button>
  );
}

function PasswordCard({ password }: { password: OwnerPasswordInfo }) {
  const { data: session } = useQuery(sessionQuery);
  const signedInWith =
    session?.gatewayKeyId === null &&
    (session.passwordId ?? null) === (password.first ? null : password.id);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <h3>{password.name}</h3>
          <Badge>
            {password.first ? "Owner password, the first" : "Owner password"}
          </Badge>
          <Badge tone="primary">UI only</Badge>
          {signedInWith && (
            <Badge tone="outline">You are signed in with it</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {password.createdAt === null
            ? "Set at setup; it cannot be removed, but it can be changed."
            : `Added ${new Date(password.createdAt).toLocaleDateString()} · ${
                password.lastUsedAt === null
                  ? "Never signed in"
                  : `Last signed in ${new Date(password.lastUsedAt).toLocaleString()}`
              }`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <PasswordSettingsForm password={password} />
        <ChangePassword password={password} />
        {!password.first && <RemovePassword password={password} />}
      </CardContent>
    </Card>
  );
}

interface AddValues {
  name: string;
  nickname: string;
  timeZone: string;
  password: string;
}

/** A new password's time zone to start from: this browser's, if known. */
const browserTimeZone = (): string => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timeZones().includes(zone) ? zone : defaultTimeZone;
};

const emptyAddValues = (): AddValues => ({
  name: "",
  nickname: "",
  timeZone: browserTimeZone(),
  password: "",
});

/**
 * Adds a password for another person who signs in to AI Office: a new way
 * to sign in, so it needs a fresh proof of the Owner (A1-3).
 */
function AddPasswordForm() {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const proof = useOwnerProof();
  const [problems, setProblems] = useState<string[]>([]);
  const [added, setAdded] = useState<string>();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<AddValues>({ defaultValues: emptyAddValues() });

  const onSubmit = async (values: AddValues) => {
    setAdded(undefined);
    const weak = passwordProblems(values.password);
    const parsed = addOwnerPasswordRequestSchema.safeParse(values);
    if (!parsed.success) {
      setProblems(
        weak.length > 0
          ? weak
          : parsed.error.issues.map(({ message }) => message),
      );
      return;
    }
    setProblems([]);
    if (!proof.ready()) {
      return;
    }
    const response = await postJson(
      "/api/owner-passwords",
      { ...parsed.data, ...proof.proof },
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      if (!proof.refused(error)) {
        setProblems(problemsIn(error, "The password was not added."));
      }
      return;
    }
    const password = ownerPasswordInfoSchema.parse(await response.json());
    setProblems([]);
    proof.reset();
    reset(emptyAddValues());
    setAdded(
      `Added ${password.name}'s password. They sign in with it on the sign-in page.`,
    );
    await queryClient.invalidateQueries(ownerPasswordsQuery);
  };

  return (
    <form
      noValidate
      aria-label="Add an Owner password"
      className="space-y-3"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="new-password-name">Name</Label>
          <Input
            id="new-password-name"
            autoComplete="off"
            placeholder="Who signs in with it"
            {...register("name")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-password-nickname">Nickname</Label>
          <Input
            id="new-password-nickname"
            autoComplete="off"
            placeholder="What the receptionist calls them"
            {...register("nickname")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-password-time-zone">Time zone</Label>
          <select
            id="new-password-time-zone"
            className={selectClass}
            {...register("timeZone")}
          >
            {timeZones().map((zone) => (
              <option key={zone} value={zone}>
                {timeZoneLabel(zone)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-password">Password</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            aria-describedby="new-password-hint"
            {...register("password")}
          />
          <p id="new-password-hint" className="text-xs text-muted-foreground">
            At least 12 characters, unlike every other Owner password.
          </p>
        </div>
      </div>
      <OwnerProofFields
        id="new-password-proof"
        reason="A new password is a new way to sign in, so confirm it with the password you sign in with."
        state={proof}
      />
      <Problems problems={problems} />
      {added !== undefined && (
        <p role="status" className="text-sm">
          {added}
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={isSubmitting || session === undefined || !proof.canProve}
      >
        <KeyRound aria-hidden />
        {isSubmitting ? "Adding…" : "Add password"}
      </Button>
    </form>
  );
}

/** Every Owner password, and a form to add one. */
export function OwnerPasswords() {
  const { data: passwords, isError } = useQuery(ownerPasswordsQuery);
  return (
    <section aria-labelledby="owner-passwords" className="space-y-4">
      <div className="space-y-1">
        <h2 id="owner-passwords" className="text-lg font-semibold">
          Owner passwords
        </h2>
        <p className="text-sm text-muted-foreground">
          One for each person who signs in to AI Office. They sign in to the web
          app only, with a code from the authenticator app when two-factor
          sign-in is on; they never call models.
        </p>
      </div>
      {isError && (
        <p role="alert" className="text-sm text-destructive">
          The Owner passwords could not be loaded.
        </p>
      )}
      {passwords?.map((password) => (
        <PasswordCard key={password.id} password={password} />
      ))}
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Add an Owner password</h3>
          </CardTitle>
          <CardDescription>
            For someone else who signs in to AI Office.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AddPasswordForm />
        </CardContent>
      </Card>
    </section>
  );
}
