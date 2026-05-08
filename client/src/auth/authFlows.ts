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

async function syncBackendFromFirebaseCredential(credential: UserCredential): Promise<void> {
  const idToken = await credential.user.getIdToken(true);
  await exchangeFirebaseToken({ firebaseIdToken: idToken, clientType: "web" });
  const user = await fetchCurrentUser();
  setAuthState({ status: "authenticated", user, lastError: null });
}

function savePendingEmailLink(email: string): void {
  window.localStorage.setItem(EMAIL_LINK_KEY, email.trim().toLowerCase());
}

export function getPendingEmailLinkEmail(): string {
  return String(window.localStorage.getItem(EMAIL_LINK_KEY) ?? "").trim();
}

export async function loginWithGoogle(): Promise<void> {
  const op = beginAuthOperation();
  const auth = await getFirebaseAuth();
  try {
    const credential = await signInWithPopup(auth, getGoogleProvider());
    await syncBackendFromFirebaseCredential(credential);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "google_sign_in_failed";
    if (reason.includes("popup") || reason.includes("cancelled")) {
      await signInWithRedirect(auth, getGoogleProvider());
      return;
    }
    commitAuthOperation(op, { status: "error", user: null, lastError: reason });
    throw error;
  }
}

export async function completeGoogleRedirectLogin(): Promise<boolean> {
  const auth = await getFirebaseAuth();
  const credential = await getRedirectResult(auth);
  if (!credential) return false;
  beginAuthOperation();
  await syncBackendFromFirebaseCredential(credential);
  return true;
}

export async function signupWithEmailPassword(email: string, password: string): Promise<void> {
  beginAuthOperation();
  const auth = await getFirebaseAuth();
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  await syncBackendFromFirebaseCredential(credential);
}

export async function loginWithEmailPassword(email: string, password: string): Promise<void> {
  const op = beginAuthOperation();
  const auth = await getFirebaseAuth();
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    await syncBackendFromFirebaseCredential(credential);
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
  const auth = await getFirebaseAuth();
  if (!isSignInWithEmailLink(auth, window.location.href)) return false;
  const email = (emailInput ?? getPendingEmailLinkEmail() ?? "").trim();
  if (!email) throw new Error("missing_email_for_email_link");
  beginAuthOperation();
  const credential = await signInWithEmailLink(auth, email, window.location.href);
  window.localStorage.removeItem(EMAIL_LINK_KEY);
  await syncBackendFromFirebaseCredential(credential);
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
