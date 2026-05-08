export type AuthErrorCode =
  | "unsupported_provider"
  | "session_not_found"
  | "session_revoked"
  | "session_expired"
  | "session_subject_mismatch"
  | "user_inactive"
  | "csrf_mismatch"
  | "refresh_token_reuse_detected"
  | "refresh_rotation_conflict"
  | "token_invalid_type"
  | "token_invalid_payload"
  | "unauthorized";

export class AuthError extends Error {
  public readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "AuthError";
  }
}

export function toAuthErrorCode(error: unknown, fallback: AuthErrorCode = "unauthorized"): AuthErrorCode {
  if (error instanceof AuthError) return error.code;
  if (error instanceof Error) {
    const code = error.message as AuthErrorCode;
    return code || fallback;
  }
  return fallback;
}
