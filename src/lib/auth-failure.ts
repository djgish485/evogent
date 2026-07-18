export const AUTH_REQUIRED_MESSAGE = "You don't have permission to do this. Sign in to continue.";

export function isAuthFailure(response: Response | null, _error: unknown): boolean {
  // Only a literal 401/403 is an auth failure. A fetch TypeError is a transient NETWORK error —
  // showing "sign in to continue" for those (as this used to) is nonsense on deployments that
  // have no sign-in at all; callers' own fallback messages ("Unable to …, try again") apply.
  return response?.status === 401 || response?.status === 403;
}
