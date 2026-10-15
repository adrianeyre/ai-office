import { apiErrorSchema, csrfHeader, type ApiError } from "@ai-office/shared";

/**
 * Sends `body` as JSON, with the session's CSRF token when there is a
 * session. Resolves with the response, whatever its status.
 */
export function sendJson(
  method: "POST" | "PATCH" | "PUT",
  url: string,
  body: unknown,
  csrfToken?: string,
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(csrfToken === undefined ? {} : { [csrfHeader]: csrfToken }),
    },
    body: JSON.stringify(body),
  });
}

/** Sends a DELETE, with the session's CSRF token when there is a session. */
export function sendDelete(url: string, csrfToken?: string): Promise<Response> {
  return fetch(url, {
    method: "DELETE",
    headers: csrfToken === undefined ? {} : { [csrfHeader]: csrfToken },
  });
}

/** POSTs `body` as JSON; see `sendJson`. */
export function postJson(
  url: string,
  body: unknown,
  csrfToken?: string,
): Promise<Response> {
  return sendJson("POST", url, body, csrfToken);
}

/** A request the API refused, with what it said. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: ApiError;

  constructor(status: number, body: ApiError) {
    super(body.message ?? `The server answered ${String(status)}.`);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
}

/** GETs `url` and parses the body, or throws an `ApiRequestError`. */
export async function getJson<Body>(
  url: string,
  schema: { parse(data: unknown): Body },
): Promise<Body> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readApiError(response));
  }
  return schema.parse(await response.json());
}

/** The API error `response` carries, or a general one if it carries none. */
export async function readApiError(response: Response): Promise<ApiError> {
  const parsed = apiErrorSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  return parsed.success
    ? parsed.data
    : {
        error: "unexpected_response",
        message: `The server answered ${String(response.status)}.`,
      };
}

/** Full page loads, so the server decides where they land (tests stub it). */
export const browser = {
  load(url: string): void {
    window.location.assign(url);
  },
};
