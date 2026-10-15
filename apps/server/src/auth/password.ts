import { hash, verify, type Options } from "@node-rs/argon2";

// The Owner's password is stored only as an Argon2id hash (PRD FR-1), with
// OWASP's recommended parameters: 19 MiB of memory, 2 passes, 1 lane.
// Argon2id is the library's default algorithm; it is not named here because
// `Algorithm` is a const enum, which isolated modules cannot read. The tests
// and the `owner` table's check constraint both hold it to `$argon2id$`.
const options: Options = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** Hashes `password` with Argon2id and a fresh random salt (PHC string). */
export function hashPassword(password: string): Promise<string> {
  return hash(password, options);
}

/** Whether `password` matches `passwordHash`; false for a malformed hash. */
export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
