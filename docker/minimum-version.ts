// package.json declares Node and pnpm as minimums (`>=26`, `>=12`), while
// the Dockerfiles pin exact versions so images are reproducible. This
// checks a pin against a minimum; any other kind of range is refused.
export const meetsMinimum = (version: string, range: string): boolean => {
  const minimum = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(range.trim())?.[1];
  if (minimum === undefined) {
    throw new Error(`Expected a ">=" range, got "${range}"`);
  }
  const wanted = minimum.split(".").map(Number);
  const actual = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const a = actual[i] ?? 0;
    const w = wanted[i] ?? 0;
    if (a !== w) return a > w;
  }
  return true;
};
