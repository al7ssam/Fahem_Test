import {
  EmailAuthProvider,
  fetchSignInMethodsForEmail,
  isSignInWithEmailLink,
  getRedirectResult,
  linkWithCredential,
  sendSignInLinkToEmail,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPopup,
  signInWithRedirect,
  createUserWithEmailAndPassword,
  signOut,
  type UserCredential,
} from "firebase/auth";
import { beginAuthOperation, commitAuthOperation, getAuthState, setAuthState } from "./authStore";
import { getFirebaseAuth, getFirebaseConfig, getGoogleProvider } from "./firebaseClient";
import { exchangeFirebaseToken, fetchCurrentUser, logout as backendLogout } from "./sessionClient";

const EMAIL_LINK_KEY = "fahem_email_link_signin_email";
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

function nextTraceId(prefix: string): string {
  traceCounter += 1;
  return `${prefix}-${Date.now()}-${traceCounter}`;
}

function authTrace(traceId: string, stage: string, details: Record<string, unknown> = {}): void {
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

function readFirebaseCode(error: unknown): string {
  const code = String((error as { code?: unknown })?.code ?? "").trim();
  return code;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown_error";
}

async function syncBackendFromFirebaseCredential(credential: UserCredential, traceId: string): Promise<void> {
  authTrace(traceId, "firebase_credential_received", {
    hasUser: Boolean(credential.user),
    uid: credential.user?.uid ?? null,
    emailVerified: credential.user?.emailVerified ?? null,
  });
  if (!credential.user) {
    throw new Error("google_missing_firebase_user");
  }
  authTrace(traceId, "firebase_get_id_token_start");
  const idToken = await credential.user.getIdToken(true);
  authTrace(traceId, "firebase_get_id_token_success", { tokenLength: idToken.length });
  authTrace(traceId, "exchange_request_start");
  await exchangeFirebaseToken({ firebaseIdToken: idToken, clientType: "web", traceId });
  authTrace(traceId, "exchange_request_success");
  const user = await fetchCurrentUser();
  authTrace(traceId, "fetch_current_user_success", { userId: user.id, roles: user.roles.length });
  setAuthState({ status: "authenticated", user, lastError: null });
}

function savePendingEmailLink(email: string): void {
  window.localStorage.setItem(EMAIL_LINK_KEY, email.trim().toLowerCase());
}

export function getPendingEmailLinkEmail(): string {
  return String(window.localStorage.getItem(EMAIL_LINK_KEY) ?? "").trim();
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
    const credential = await signInWithPopup(auth, getGoogleProvider());
    authTrace(traceId, "google_popup_success");
    await syncBackendFromFirebaseCredential(credential, traceId);
  } catch (error) {
    const code = readFirebaseCode(error);
    const reason = asMessage(error);
    authTrace(traceId, "google_popup_failed", { code, reason });
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
    await syncBackendFromFirebaseCredential(credential, traceId);
    return true;
  } catch (error) {
    const code = readFirebaseCode(error);
    const reason = asMessage(error);
    authTrace(traceId, "redirect_result_failed", { code, reason });
    throw new Error(code || reason || "google_redirect_result_failed");
  }
}

export async function signupWithEmailPassword(email: string, password: string): Promise<void> {
  const traceId = nextTraceId("email-signup");
  authTrace(traceId, "email_signup_start");
  beginAuthOperation();
  const auth = await getFirebaseAuth();
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  await syncBackendFromFirebaseCredential(credential, traceId);
}

export async function loginWithEmailPassword(email: string, password: string): Promise<void> {
  const traceId = nextTraceId("email-login");
  authTrace(traceId, "email_login_start");
  const op = beginAuthOperation();
  const auth = await getFirebaseAuth();
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    await syncBackendFromFirebaseCredential(credential, traceId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "email_sign_in_failed";
    if (reason.includes("account-exists-with-different-credential")) {
      const methods = await fetchSignInMethodsForEmail(auth, email);
      throw new Error(`account_exists_with_different_provider:${methods.join(",")}`);
    }
    commitAuthOperation(op, { status: "error", user: null, lastError: reason });
    throw error;
  }
}

export async function sendPasswordlessEmailLink(email: string): Promise<void> {
  const auth = await getFirebaseAuth();
  const cfg = getFirebaseConfig();
  const continueUrl = new URL(window.location.href);
  continueUrl.searchParams.set("authAction", "emailLinkComplete");
  await sendSignInLinkToEmail(auth, email, {
    url: continueUrl.toString(),
    handleCodeInApp: true,
    ...(cfg.linkDomain ? { linkDomain: cfg.linkDomain } : {}),
  });
  savePendingEmailLink(email);
}

export async function completePasswordlessEmailLink(emailInput?: string): Promise<boolean> {
  const traceId = nextTraceId("email-link");
  authTrace(traceId, "email_link_complete_start");
  const auth = await getFirebaseAuth();
  if (!isSignInWithEmailLink(auth, window.location.href)) return false;
  const email = (emailInput ?? getPendingEmailLinkEmail() ?? "").trim();
  if (!email) throw new Error("missing_email_for_email_link");
  beginAuthOperation();
  const credential = await signInWithEmailLink(auth, email, window.location.href);
  window.localStorage.removeItem(EMAIL_LINK_KEY);
  await syncBackendFromFirebaseCredential(credential, traceId);
  return true;
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
