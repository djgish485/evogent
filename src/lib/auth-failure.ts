export const AUTH_REQUIRED_MESSAGE = "You don't have permission to do this. Sign in to continue.";

export function isAuthFailure(response: Response | null, error: unknown): boolean {
  return error instanceof TypeError || response?.status === 401 || response?.status === 403;
}
