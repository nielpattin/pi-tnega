import type { RaftTypeError } from "./runtime/type-checker.js";

const PROMISE_ALL_PATTERN = /\bPromise\.all\s*\(/;
const TUPLE_ARITY_PATTERN = /Tuple type .* of length '[0-9]+' has no element at index '[0-9]+'/;

/**
 * Recovery hint for the type errors that orchestration code still produces.
 * Returns undefined when no known pattern matches.
 */
export const typeErrorRecoveryHint = (
  code: string,
  errors: RaftTypeError[],
): string | undefined => {
  if (
    PROMISE_ALL_PATTERN.test(code) &&
    errors.some((error) => TUPLE_ARITY_PATTERN.test(error.message))
  ) {
    return "Recovery hint: match `Promise.all` destructuring one binding per promise; remove the extra binding or add the missing call.";
  }
  return undefined;
};
