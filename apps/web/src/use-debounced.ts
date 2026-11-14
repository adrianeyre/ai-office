import { useEffect, useState } from "react";

/**
 * `value` once it has stayed the same for `ms`: what is typed, asked of
 * the server only when the typing pauses rather than at every key.
 */
export function useDebounced<Value>(value: Value, ms: number): Value {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return settled;
}
