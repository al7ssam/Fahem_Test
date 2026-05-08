import {
  EmailAuthProvider,
  linkWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type AuthCredential,
} from "firebase/auth";

import { authTrace, nextTraceId, syncBackendAfterCurrentUser } from "./authFlows";
import { readFirebaseErrorCode } from "./authErrors";
import { getFirebaseAuth, getGoogleProvider } from "./firebaseClient";

/** بعد التأكيد أن البريد مرتبط بـ Google: تسجيل دخول Google ثم ربط كلمة المرور التي اختارها المستخدم. */
export async function signInGoogleThenLinkPendingPassword(
  email: string,
  password: string,
  traceId?: string,
): Promise<void> {
  const tid = traceId ?? nextTraceId("link-google-pw");
  const auth = await getFirebaseAuth();
  authTrace(tid, "provider_link_start", { path: "google_popup_then_email_password" });
  try {
    const cr = await signInWithPopup(auth, getGoogleProvider());
    if (!cr.user) throw new Error("google_missing_firebase_user");
    await linkWithCredential(cr.user, EmailAuthProvider.credential(email.trim().toLowerCase(), password));
    authTrace(tid, "provider_link_success", { path: "google_popup_then_email_password" });
    await syncBackendAfterCurrentUser(tid);
  } catch (e) {
    authTrace(tid, "provider_link_fail", { code: readFirebaseErrorCode(e) });
    throw e;
  }
}

/** بيانات Google المعلقة من خطأ حساب موجود: تسجيل دخول بكلمة المرور ثم ربط Google. */
export async function signInPasswordThenLinkPendingGoogle(
  email: string,
  password: string,
  pendingGoogle: AuthCredential,
  traceId?: string,
): Promise<void> {
  const tid = traceId ?? nextTraceId("link-pw-google");
  const auth = await getFirebaseAuth();
  authTrace(tid, "credential_pending_link_start", {});
  if (auth.currentUser) await signOut(auth).catch(() => {});
  try {
    const userCred = await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
    await linkWithCredential(userCred.user, pendingGoogle);
    authTrace(tid, "credential_pending_link_success", {});
    await syncBackendAfterCurrentUser(tid);
  } catch (e) {
    authTrace(tid, "credential_pending_link_fail", { code: readFirebaseErrorCode(e) });
    throw e;
  }
}
