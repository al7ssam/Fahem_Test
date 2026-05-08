import { beginAuthOperation, commitAuthOperation, getAuthState } from "./authStore";
import { fetchCurrentUser } from "./sessionClient";

export async function hydrateAuthSession(): Promise<void> {
  if (getAuthState().status === "loading") return;
  const op = beginAuthOperation();
  try {
    const user = await fetchCurrentUser();
    commitAuthOperation(op, { status: "authenticated", user, lastError: null });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "auth_hydration_failed";
    commitAuthOperation(op, {
      status: reason === "auth_unauthorized" ? "unauthenticated" : "error",
      user: null,
      lastError: reason,
    });
  }
}
