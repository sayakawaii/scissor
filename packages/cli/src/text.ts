/**
 * Keep the last `n` characters of a string, prefixing an ellipsis when it was
 * truncated. Shared by the verification loop and the self-update gate so their
 * error-detail formatting stays consistent.
 */
export function tail(s: string, n = 2000): string {
  return s.length > n ? "... " + s.slice(s.length - n) : s;
}
