import {
  EmailAuthProvider,
  GoogleAuthProvider,
  type AuthError,
  fetchSignInMethodsForEmail,
  isSignInWithEmailLink,
  getRedirectResult,
  linkWithCredential,
  sendPasswordResetEmail,
  confirmPasswordReset,
  sendSignInLinkToEmail,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPopup,
  signInWithRedirect,
  createUserWithEmailAndPassword,
  signOut,
  type User,
  type UserCredential,
} from "firebase/auth";
import { beginAuthOperation, commitAuthOperation, getAuthState, setAuthState } from "./authStore";
import {
  buildMagicLinkContinueUrl,
  buildPasswordResetContinueUrl,
  cleanupEmailLinkLandingUrl,
  readEmailLinkOobCode,
} from "./emailLinkUrl";
import { resolveEmailLinkActionCodeLinkDomain } from "./resolveEmailLinkHostingDomain";
import { getFirebaseAuth, getFirebaseConfig, getGoogleProvider } from "./firebaseClient";
import { exchangeFirebaseToken, fetchCurrentUser, logout as backendLogout } from "./sessionClient";
import {
  FahemProviderLinkError,
  isFahemProviderLinkError,
  passwordResetRevealNotFound,
  readFirebaseErrorCode,
} from "./authErrors";

const EMAIL_LINK_KEY = "fahem_email_link_signin_email";
const EMAIL_LINK_SESSION_KEY = "fahem_email_link_signin_email_sess";
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
let magicLinkCompletionInFlight = false;
let traceCounter = 0;

export type MagicLinkBootstrapResult =
  | { kind: "idle" }
  | { kind: "completed" }
  | { kind: "needs_modal"; reason: string; firebaseCode?: string };

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

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown_error";
}

function oobDoneStorageKey(oob: string): string {
  return `fahem_email_link_oob_done_${oob}`;
}

async function syncBackendFromFirebaseUser(
  firebaseUser: User,
  traceId: string,
  instrumentation: "firebase" | "magic_link" = "firebase",
): Promise<void> {
  authTrace(traceId, "firebase_credential_received", {
    hasUser: true,
    uid: firebaseUser.uid,
    emailVerified: firebaseUser.emailVerified,
    flow: instrumentation,
  });

  const tokenStart = instrumentation === "magic_link" ? "magic_link_get_token_start" : "firebase_get_id_token_start";
  const tokenSuccess = instrumentation === "magic_link" ? "magic_link_get_token_success" : "firebase_get_id_token_success";

  authTrace(traceId, tokenStart);
  let idToken: string;
  try {
    idToken = await firebaseUser.getIdToken(true);
    authTrace(traceId, tokenSuccess, { tokenLength: idToken.length });
  } catch (error) {
    if (instrumentation === "magic_link") {
      authTrace(traceId, "magic_link_get_token_fail", {
        code: readFirebaseErrorCode(error),
        reason: asMessage(error),
      });
    }
    throw error;
  }

  if (instrumentation === "firebase") {
    authTrace(traceId, "exchange_request_start");
  }
  await exchangeFirebaseToken({
    firebaseIdToken: idToken,
    clientType: "web",
    traceId,
    traceStagesFlow: instrumentation === "magic_link" ? "magic_link" : "default",
  });
  if (instrumentation === "firebase") {
    authTrace(traceId, "exchange_request_success");
  }

  const user = await fetchCurrentUser();
  authTrace(traceId, "fetch_current_user_success", { userId: user.id, roles: user.roles.length });
  setAuthState({ status: "authenticated", user, lastError: null });
}

async function syncBackendFromFirebaseCredential(
  credential: UserCredential,
  traceId: string,
  instrumentation: "firebase" | "magic_link" = "firebase",
): Promise<void> {
  if (!credential.user) {
    throw new Error(instrumentation === "magic_link" ? "magic_link_missing_firebase_user" : "google_missing_firebase_user");
  }
  await syncBackendFromFirebaseUser(credential.user, traceId, instrumentation);
}

/** بعد `linkWithCredential` أو أي تحديث لـ currentUser؛ يعيد الطلب وتزامن الخادم الداخلي. */
export async function syncBackendAfterCurrentUser(
  traceId: string,
  instrumentation: "firebase" | "magic_link" = "firebase",
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
    hasEmailLinkMethod: methods.includes("emailLink"),
    emailSuffix: emailNorm.includes("@") ? emailNorm.split("@")[1]?.toLowerCase() ?? "" : "",
  });
  if (methods.includes("password")) {
    throw new FahemProviderLinkError("signup_use_login", emailNorm, methods, password);
  }
  if (methods.includes("google.com")) {
    throw new FahemProviderLinkError("signup_requires_google_link", emailNorm, methods, password);
  }
  if (methods.includes("emailLink")) {
    throw new FahemProviderLinkError("signup_use_magic_link", emailNorm, methods, password);
  }
  throw new FahemProviderLinkError("signup_use_login", emailNorm, methods, password);
}

export function savePendingEmailLink(email: string): void {
  const canon = email.trim().toLowerCase();
  window.localStorage.setItem(EMAIL_LINK_KEY, canon);
  window.sessionStorage.setItem(EMAIL_LINK_SESSION_KEY, canon);
}

export function getPendingEmailLinkEmail(): string {
  const a = String(window.localStorage.getItem(EMAIL_LINK_KEY) ?? "").trim();
  if (a) return a;
  return String(window.sessionStorage.getItem(EMAIL_LINK_SESSION_KEY) ?? "").trim();
}

export function previewMagicLinkLandingQuery(): {
  authActionIntent: boolean;
  hasOob: boolean;
  hasModeSignIn: boolean;
} {
  const p = new URLSearchParams(window.location.search);
  return {
    authActionIntent: p.get("authAction") === "emailLinkComplete",
    hasOob: Boolean(p.get("oobCode")),
    hasModeSignIn: p.get("mode") === "signIn",
  };
}

/** Run after Google redirect bootstrap: auto-complete magic link when URL + stored email allow it. */
export async function bootstrapMagicLinkOnLoad(traceIdPrefix = "magic-boot"): Promise<MagicLinkBootstrapResult> {
  const traceId = nextTraceId(traceIdPrefix);
  const auth = await getFirebaseAuth();
  const href = window.location.href;
  const preview = previewMagicLinkLandingQuery();
  const isLink = isSignInWithEmailLink(auth, href);

  if (isLink) {
    authTrace(traceId, "magic_link_detected", {
      authActionIntent: preview.authActionIntent,
      hasOob: preview.hasOob,
      hasModeSignIn: preview.hasModeSignIn,
    });
  }

  if (!isLink && !preview.authActionIntent) {
    return { kind: "idle" };
  }

  if (!isLink && preview.authActionIntent) {
    authTrace(traceId, "magic_link_url_not_recognized", {
      hint: "Check Authorized domains / continue URL / Firebase email link provider",
      hasOob: preview.hasOob,
    });
    return { kind: "needs_modal", reason: "magic_link_invalid_url" };
  }

  const oob = readEmailLinkOobCode();
  if (oob && window.sessionStorage.getItem(oobDoneStorageKey(oob)) === "1") {
    authTrace(traceId, "magic_link_skipped_oob_already_completed", {});
    cleanupEmailLinkLandingUrl();
    return { kind: "completed" };
  }

  const emailStored = getPendingEmailLinkEmail();
  if (!emailStored.trim()) {
    authTrace(traceId, "magic_link_needs_modal_missing_email", {});
    return { kind: "needs_modal", reason: "missing_email_for_email_link" };
  }

  if (magicLinkCompletionInFlight) {
    authTrace(traceId, "magic_link_boot_skipped_in_flight");
    return { kind: "needs_modal", reason: "magic_link_already_in_progress" };
  }

  try {
    await completePasswordlessEmailLink(emailStored, traceId);
    if (oob) window.sessionStorage.setItem(oobDoneStorageKey(oob), "1");
    cleanupEmailLinkLandingUrl();
    authTrace(traceId, "magic_link_boot_auto_complete_success");
    return { kind: "completed" };
  } catch (error) {
    const code = readFirebaseErrorCode(error);
    authTrace(traceId, "magic_link_boot_auto_complete_fail", { code, reason: asMessage(error) });
    return { kind: "needs_modal", reason: asMessage(error), firebaseCode: code || undefined };
  }
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
          hasEmailLinkMethod: methods.includes("emailLink"),
        });
        if (methods.includes("password")) {
          commitAuthOperation(op, { status: "unauthenticated", user: null, lastError: "google_requires_password_link" });
          throw new FahemProviderLinkError("google_requires_password_link", conflictEmail, methods, undefined, pendingGoogle);
        }
        if (methods.includes("emailLink") && !methods.includes("password")) {
          commitAuthOperation(op, { status: "unauthenticated", user: null, lastError: "signup_use_magic_link" });
          throw new FahemProviderLinkError("signup_use_magic_link", conflictEmail, methods, undefined, pendingGoogle);
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
        hasEmailLinkMethod: methods.includes("emailLink"),
      });
      if (!methods.includes("password") && methods.includes("google.com")) {
        commitAuthOperation(op, { status: "unauthenticated", user: null, lastError: code });
        throw new FahemProviderLinkError("login_suggest_google_only", emailNorm, methods);
      }
      if (methods.includes("emailLink") && !methods.includes("password")) {
        commitAuthOperation(op, { status: "unauthenticated", user: null, lastError: code });
        throw new FahemProviderLinkError("signup_use_magic_link", emailNorm, methods);
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
  const cfg = getFirebaseConfig();
  const continueUrl = buildPasswordResetContinueUrl();
  const resolved = resolveEmailLinkActionCodeLinkDomain(cfg.linkDomain);
  const linkDomainToSend = resolved.hostname;
  authTrace(traceId, "password_reset_send_start", {
    continueUrlOrigin: continueUrl.origin,
    continueUrlPathname: continueUrl.pathname,
    linkDomainEffective: linkDomainToSend ?? null,
  });
  try {
    await sendPasswordResetEmail(auth, email.trim(), {
      url: continueUrl.toString(),
      handleCodeInApp: true,
      ...(linkDomainToSend ? { linkDomain: linkDomainToSend } : {}),
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

export async function sendPasswordlessEmailLink(email: string): Promise<void> {
  const traceId = nextTraceId("magic-send");
  const auth = await getFirebaseAuth();
  const cfg = getFirebaseConfig();
  const continueUrl = buildMagicLinkContinueUrl();
  const resolved = resolveEmailLinkActionCodeLinkDomain(cfg.linkDomain);
  const linkDomainToSend = resolved.hostname;
  authTrace(traceId, "magic_link_send_start", {
    continueUrlOrigin: continueUrl.origin,
    continueUrlPathname: continueUrl.pathname,
    linkDomainEnvSet: Boolean(cfg.linkDomain),
    linkDomainPassedToFirebase: Boolean(linkDomainToSend),
    linkDomainDroppedReason: resolved.droppedReason ?? null,
    linkDomainEffective: linkDomainToSend ?? null,
  });
  try {
    await sendSignInLinkToEmail(auth, email.trim(), {
      url: continueUrl.toString(),
      handleCodeInApp: true,
      ...(linkDomainToSend ? { linkDomain: linkDomainToSend } : {}),
    });
    savePendingEmailLink(email);
    authTrace(traceId, "magic_link_send_success", { emailDomain: email.includes("@") ? email.split("@")[1]?.toLowerCase() : "" });
  } catch (error) {
    authTrace(traceId, "magic_link_send_fail", { code: readFirebaseErrorCode(error), reason: asMessage(error) });
    throw error;
  }
}

/** Complete Firebase email link flow and internal session exchange. Throws on invalid URL or Firebase/backend errors (no silent false). */
export async function completePasswordlessEmailLink(emailInput?: string, reusedTraceId?: string): Promise<void> {
  const traceId = reusedTraceId ?? nextTraceId("email-link");
  if (magicLinkCompletionInFlight) {
    authTrace(traceId, "magic_link_complete_skipped_in_flight");
    throw new Error("magic_link_already_in_progress");
  }
  magicLinkCompletionInFlight = true;

  authTrace(traceId, "magic_link_complete_start", {
    hasEmailArg: Boolean(emailInput?.trim()),
    hasStoredEmail: Boolean(getPendingEmailLinkEmail()),
  });

  const op = beginAuthOperation();
  const auth = await getFirebaseAuth();

  try {
    if (!isSignInWithEmailLink(auth, window.location.href)) {
      const preview = previewMagicLinkLandingQuery();
      authTrace(traceId, "magic_link_complete_fail", {
        reason: "not_email_link_url",
        code: "magic_link_invalid_url",
        ...preview,
      });
      throw new Error(
        preview.authActionIntent && !preview.hasOob
          ? "magic_link_expired_or_stripped_query"
          : "magic_link_invalid_url",
      );
    }

    authTrace(traceId, "magic_link_detected");

    const email = (emailInput ?? getPendingEmailLinkEmail() ?? "").trim().toLowerCase();
    if (!email) {
      authTrace(traceId, "magic_link_complete_fail", { reason: "missing_email", code: "missing_email_for_email_link" });
      throw new Error("missing_email_for_email_link");
    }

    const credential = await signInWithEmailLink(auth, email, window.location.href);
    window.localStorage.removeItem(EMAIL_LINK_KEY);
    window.sessionStorage.removeItem(EMAIL_LINK_SESSION_KEY);
    await syncBackendFromFirebaseCredential(credential, traceId, "magic_link");
    const oob = readEmailLinkOobCode();
    if (oob) window.sessionStorage.setItem(oobDoneStorageKey(oob), "1");
    authTrace(traceId, "magic_link_complete_success");
    const u = getAuthState().user;
    if (u) {
      commitAuthOperation(op, { status: "authenticated", user: u, lastError: null });
    }
  } catch (error) {
    const code = readFirebaseErrorCode(error);
    const reason = asMessage(error);
    const alreadyLoggedFail =
      reason === "magic_link_invalid_url" || reason === "magic_link_expired_or_stripped_query";
    if (!alreadyLoggedFail) {
      authTrace(traceId, "magic_link_complete_fail", { code, reason });
    }
    commitAuthOperation(op, { status: "error", user: null, lastError: code || reason || "magic_link_failed" });
    throw error;
  } finally {
    magicLinkCompletionInFlight = false;
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
