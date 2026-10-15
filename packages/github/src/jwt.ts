import { createSign } from "node:crypto";

// A GitHub App proves who it is with a JSON Web Token signed by its private
// key (RS256), and exchanges it for installation tokens. GitHub accepts a
// JWT for at most ten minutes, and allows for clock drift by backdating
// `iat`.

const base64url = (value: string | Buffer): string =>
  Buffer.from(value).toString("base64url");

/** How long each JWT is valid: under GitHub's ten-minute limit. */
export const appJwtLifetimeSeconds = 9 * 60;

/** Signs a JWT for the App `appId`, valid from a minute before `now`. */
export function appJwt(options: {
  readonly appId: string;
  readonly privateKey: string;
  readonly now: Date;
}): string {
  const issuedAt = Math.floor(options.now.getTime() / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: issuedAt,
      exp: issuedAt + 60 + appJwtLifetimeSeconds,
      iss: options.appId,
    }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(options.privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}
