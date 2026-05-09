import {
  EmailAuthProvider,
  GoogleAuthProvider,
  type AuthError,
  fetchSignInMethodsForEmail,
  getRedirectResult,
  linkWithCredential,
  sendPasswordResetEmail,
  confirmPasswordReset,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  createUserWithEmailAndPassword,
  signOut,
  type User,
  type UserCredential,
} from "firebase/auth";
import { beginAuthOperation, commitAuthOperation, getAuthState, setAuthState } from "./authStore";
import { buildPasswordResetContinueUrl, cleanupEmailLinkLandingUrl } from "./emailLinkUrl";
import { getFirebaseAuth, getGoogleProvider } from "./firebaseClient";
import { exchangeFirebaseToken, logout as backendLogout } from "./sessionClient";
import {
  FahemProviderLinkError,
  isFahemProviderLinkError,
  passwordResetRevealNotFound,
  readFirebaseErrorCode,
} from "./authErrors";

const GOOGLE_POPUP_REDIRECT_FALLBACK_CODES = new Set([
  "auth/popup-blocked",
  "auth/operation-not-supported-in-this-environment",
]);
const GOOGLE_NON_ERROR_CODES = new Set([
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
]);

let googleFlowInFlight = false;
let redirectBootstrapHandled = false;
let traceCounter = 0;

function nowIso(): string {
  return new Date().toISOString();
}

export function nextTraceId(prefix: string): string {
  traceCounter += 1;
  return `${prefix}-${Date.now()}-${traceCounter}`;
}

export function authTrace(traceId: string, stage: string, details: Record<string, unknown> = {}): void {
  const payload = {
    ts: nowIso(),
    traceId,
    stage,
    ...details,
  };
  const w = window as Window & { __fahemAuthTrace?: Array<Record<string, unknown>> };
  if (!Array.isArray(w.__fahemAuthTrace)) {
    w.__fahemAuthTrace = [];
  }
  w.__fahemAuthTrace.push(payload);
  if (w.__fahemAuthTrace.length > 300) {
    w.__fahemAuthTrace.splice(0, w.__fahemAuthTrace.length - 300);
  }
  console.info("[auth-trace]", payload);
}

/** قياس زمني خفيف في DevTools → Performance (يفشل صامتاً إن تعذّر). */
function perfAuthMark(name: string): void {
  try {
    if (typeof performance !== "undefined" && typeof performance.mark === "function") {
      performance.mark(`fahem-auth:${name}`);
    }
  } catch {
    /* ignore */
  }
}

function perfAuthMeasure(name: string, startName: string, endName: string): void {
  try {
    if (typeof performance !== "undefined" && typeof performance.measure === "function") {
      performance.measure(`fahem-auth:${name}`, `fahem-auth:${startName}`, `fahem-auth:${endName}`);
    }
  } catch {
    /* ignore */
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown_error";
}

async function syncBackendFromFirebaseUser(
  firebaseUser: User,
  traceId: string,
  instrumentation: "firebase" = "firebase",
): Promise<void> {
  perfAuthMark("sync-start");
  authTrace(traceId, "firebase_credential_received", {
    hasUser: true,
    uid: firebaseUser.uid,
    emailVerified: firebaseUser.emailVerified,
    flow: instrumentation,
  });

  const tokenStart = "firebase_get_id_token_start";
  const tokenSuccess = "firebase_get_id_token_success";

  authTrace(traceId, tokenStart);
  let idToken: string;
  try {
    idToken = await firebaseUser.getIdToken();
    authTrace(traceId, tokenSuccess, { tokenLength: idToken.length });
  } catch (error) {
    authTrace(traceId, "firebase_get_id_token_fail", {
      code: readFirebaseErrorCode(error),
      reason: asMessage(error),
    });
    throw error;
  }

  authTrace(traceId, "exchange_request_start");
  const { user } = await exchangeFirebaseToken({
    firebaseIdToken: idToken,
    clientType: "web",
    traceId,
    traceStagesFlow: "default",
  });
  authTrace(traceId, "exchange_request_success");

  authTrace(traceId, "session_user_ready", {
    userId: user.id,
    roles: user.roles.length,
    profileSource: "exchange",
  });
  perfAuthMark("sync-end");
  perfAuthMeasure("firebase-sync-total", "sync-start", "sync-end");
  setAuthState({ status: "authenticated", user, lastError: null });
}

async function syncBackendFromFirebaseCredential(
  credential: UserCredential,
  traceId: string,
  instrumentation: "firebase" = "firebase",
): Promise<void> {
  if (!credential.user) {
    throw new Error("google_missing_firebase_user");
  }
  await syncBackendFromFirebaseUser(credential.user, traceId, instrumentation);
}

/** بعد `linkWithCredential` أو أي تحديث لـ currentUser؛ يعيد الطلب وتزامن الخادم الداخلي. */
export async function syncBackendAfterCurrentUser(
  traceId: string,
  instrumentation: "firebase" = "firebase",
): Promise<void> {
  const auth = await getFirebaseAuth();
  if (!auth.currentUser) throw new Error("missing_current_user");
  await syncBackendFromFirebaseUser(auth.currentUser, traceId, instrumentation);
}

function signupConflictScenarioForMethods(
  traceId: string,
  methodsRaw: string[],
  emailNorm: string,
  password?: string,
): never {
  const methods = [...methodsRaw];
  authTrace(traceId, "provider_conflict_detected", {
    hasPasswordMethod: methods.includes("password"),
    hasGoogleMethod: methods.includes("google.com"),
    emailSuffix: emailNorm.includes("@") ? emailNorm.split("@")[1]?.toLowerCase() ?? "" : "",
  });
  if (methods.includes("password")) {
    throw new FahemProviderLinkError("signup_use_login", emailNorm, methods, password);
  }
  if (methods.includes("google.com")) {
    throw new FahemProviderLinkError("signup_requires_google_link", emailNorm, methods, password);
  }
  throw new FahemProviderLinkError("signup_use_login", emailNorm, methods, password);
}

export async function loginWithGoogle(): Promise<void> {
  const traceId = nextTraceId("google");
  authTrace(traceId, "google_login_click");
  if (googleFlowInFlight) {
    authTrace(traceId, "google_login_skipped_flow_in_flight");
    throw new Error("google_flow_in_progress");
  }
  googleFlowInFlight = true;
  const op = beginAuthOperation();
  authTrace(traceId, "auth_operation_started", { operationId: op });
  const auth = await getFirebaseAuth();
  try {
    authTrace(traceId, "google_popup_start");
    perfAuthMark("google-popup-open");
    const credential = await signInWithPopup(auth, getGoogleProvider());
    authTrace(traceId, "google_popup_success");
    perfAuthMark("google-popup-close");
    perfAuthMeasure("google-popup-ui", "google-popup-open", "google-popup-close");
    await syncBackendFromFirebaseCredential(credential, traceId, "firebase");
  } catch (error) {
    const code = readFirebaseErrorCode(error);
    const reason = asMessage(error);
    authTrace(traceId, "google_popup_failed", { code, reason });
    if (code === "auth/account-exists-with-different-credential") {
      const pendingGoogle = GoogleAuthProvider.credentialFromError(error as AuthError);
      const emailRaw = (error as AuthError).customData?.email;
      const conflictEmail = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
      authTrace(traceId, "provider_conflict_detected", {
        source: "google_popup",
        hasPendingGoogleCred: Boolean(pendingGoogle),
        hasConflictEmail: Boolean(conflictEmail),
      });
      if (conflictEmail && pendingGoogle) {
        const methods = await fetchSignInMethodsForEmail(auth, conflictEmail);
        authTrace(traceId, "provider_conflict_methods", {
          hasPasswordMethod: methods.includes("password"),
          hasGoogleMethod: methods.includes("google.com"),
        });
        if (methods.includes("password")) {
          commitAuthOperation(op, { status: "unauthenticated", user: null, lastError: "google_requires_password_link" });
          throw new FahemProviderLinkError("google_requires_password_link", conflictEmail, methods, undefined, pendingGoogle);
        }
      }
    }
    if (GOOGLE_POPUP_REDIRECT_FALLBACK_CODES.has(code)) {
      authTrace(traceId, "google_redirect_fallback_start", { code });
      await signInWithRedirect(auth, getGoogleProvider());
      return;
    }
    if (GOOGLE_NON_ERROR_CODES.has(code)) {
      commitAuthOperation(op, { status: "unauthenticated", user: null, lastError: code });
      return;
    }
    commitAuthOperation(op, { status: "error", user: null, lastError: code || reason || "google_sign_in_failed" });
    throw error;
  } finally {
    googleFlowInFlight = false;
    authTrace(traceId, "google_flow_end");
  }
}

export async function completeGoogleRedirectLogin(): Promise<boolean> {
  const traceId = nextTraceId("redirect");
  if (redirectBootstrapHandled) {
    authTrace(traceId, "redirect_bootstrap_skipped_already_handled");
    return false;
  }
  redirectBootstrapHandled = true;
  authTrace(traceId, "redirect_bootstrap_start");
  const auth = await getFirebaseAuth();
  try {
    const credential = await getRedirectResult(auth);
    if (!credential) {
      authTrace(traceId, "redirect_result_empty");
      return false;
    }
    authTrace(traceId, "redirect_result_success");
    beginAuthOperation();
    await syncBackendFromFirebaseCredential(credential, traceId, "firebase");
    return true;
  } catch (error) {
    const code = readFirebaseErrorCode(error);
    const reason = asMessage(error);
    authTrace(traceId, "redirect_result_failed", { code, reason });
    throw new Error(code || reason || "google_redirect_result_failed");
  }
}

export async function signupWithEmailPassword(email: string, password: string): Promise<void> {
  const traceId = nextTraceId("email-signup");
  authTrace(traceId, "email_signup_start");
  const op = beginAuthOperation();
  const auth = await getFirebaseAuth();
  const emailNorm = email.trim().toLowerCase();
  try {
    const credential = await createUserWithEmailAndPassword(auth, emailNorm, password);
    authTrace(traceId, "email_signup_success");
    await syncBackendFromFirebaseCredential(credential, traceId, "firebase");
  } catch (error) {
    if (isFahemProviderLinkError(error)) {
      commitAuthOperation(op, { status: "unauthenticated", user: null, lastError: error.scenario });
      throw error;
    }
    const code = readFirebaseErrorCode(error);
    if (code === "auth/email-already-in-use") {
      authTrace(traceId, "email_signup_conflict_fetch_methods", {});
      const methods = await fetchSignInMethodsForEmail(auth, emailNorm).catch(() => []);
      try {
        signupConflictScenarioForMethods(traceId, methods, emailNorm, password);
      } catch (e2) {
        if (isFahemProviderLinkError(e2)) {
          commitAuthOperation(op, { status: "unauthenticated", user: null, lastError: e2.scenario });
        }
        throw e2;
      }
    }
    authTrace(traceId, "email_signup_fail", { code, reason: asMessage(error) });
    commitAuthOperation(op, { status: "error", user: null, lastError: code || asMessage(error) });
    throw error;
  }
}

export async function loginWithEmailPassword(email: string, password: string): Promise<void> {
  const traceId = nextTraceId("email-login");
  authTrace(traceId, "email_login_start");
  const op = beginAuthOperation();
  const auth = await getFirebaseAuth();
  const emailNorm = email.trim().toLowerCase();
  try {
    const credential = await signInWithEmailAndPassword(auth, emailNorm, password);
    authTrace(traceId, "email_login_success");
    await syncBackendFromFirebaseCredential(credential, traceId, "firebase");
  } catch (error) {
    const code = readFirebaseErrorCode(error);
    if (code === "auth/account-exists-with-different-credential") {
      const methods = await fetchSignInMethodsForEmail(auth, emailNorm).catch(() => []);
      authTrace(traceId, "provider_conflict_detected", { source: "email_login", code });
      commitAuthOperation(op, { status: "unauthenticated", user: null, lastError: code });
      if (methods.includes("google.com") && !methods.includes("password")) {
        throw new FahemProviderLinkError("login_suggest_google_only", emailNorm, methods);
      }
    }
    if (code === "auth/invalid-credential") {
      const methods = await fetchSignInMethodsForEmail(auth, emailNorm).catch(() => []);
      authTrace(traceId, "email_login_invalid_credential_methods", {
        hasPasswordMethod: methods.includes("password"),
        hasGoogleMethod: methods.includes("google.com"),
      });
      if (!methods.includes("password") && methods.includes("google.com")) {
        commitAuthOperation(op, { status: "unauthenticated", user: null, lastError: code });
        throw new FahemProviderLinkError("login_suggest_google_only", emailNorm, methods);
      }
    }
    authTrace(traceId, "email_login_fail", { code, reason: asMessage(error) });
    commitAuthOperation(op, { status: "error", user: null, lastError: code || asMessage(error) });
    throw error;
  }
}

export async function sendPasswordResetEmailFlow(email: string): Promise<void> {
  const traceId = nextTraceId("pwd-reset-send");
  const auth = await getFirebaseAuth();
  const continueUrl = buildPasswordResetContinueUrl();
  authTrace(traceId, "password_reset_send_start", {
    continueUrlOrigin: continueUrl.origin,
    continueUrlPathname: continueUrl.pathname,
  });
  try {
    await sendPasswordResetEmail(auth, email.trim(), {
      url: continueUrl.toString(),
      handleCodeInApp: true,
    });
    authTrace(traceId, "password_reset_send_success", {});
  } catch (error) {
    const code = readFirebaseErrorCode(error);
    authTrace(traceId, "password_reset_send_fail", { code, reason: asMessage(error) });
    if (code === "auth/user-not-found" && !passwordResetRevealNotFound()) {
      authTrace(traceId, "password_reset_send_masked_success", {});
      return;
    }
    throw error;
  }
}

export async function confirmPasswordResetFlow(oobCode: string, newPassword: string): Promise<void> {
  const traceId = nextTraceId("pwd-reset-confirm");
  const auth = await getFirebaseAuth();
  authTrace(traceId, "password_reset_confirm_start", {});
  try {
    await confirmPasswordReset(auth, oobCode, newPassword);
    authTrace(traceId, "password_reset_confirm_success", {});
  } catch (error) {
    authTrace(traceId, "password_reset_confirm_fail", { code: readFirebaseErrorCode(error), reason: asMessage(error) });
    throw error;
  }
}

export async function linkPasswordToCurrentUser(email: string, password: string): Promise<void> {
  const auth = await getFirebaseAuth();
  if (!auth.currentUser) throw new Error("missing_current_user");
  const credential = EmailAuthProvider.credential(email, password);
  await linkWithCredential(auth.currentUser, credential);
}

export async function logoutFlow(): Promise<void> {
  beginAuthOperation();
  const auth = await getFirebaseAuth();
  await backendLogout().catch(() => {});
  await signOut(auth).catch(() => {});
  setAuthState({ status: "unauthenticated", user: null, lastError: null });
}

export function getAuthReadableStatus(): string {
  const s = getAuthState().status;
  if (s === "authenticated") return "مسجل الدخول";
  if (s === "loading") return "جاري التحقق";
  if (s === "error") return "خطأ مصادقة";
  return "غير مسجل";
}

export { cleanupEmailLinkLandingUrl } from "./emailLinkUrl";
