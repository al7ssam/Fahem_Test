import type { AuthCredential } from "firebase/auth";

/** Read Firebase `auth/...` code from thrown values. */
export function readFirebaseErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: string }).code ?? "").trim();
  }
  return "";
}

/**
 * Raised when signup or sign-in requires a deliberate provider linking / recovery step.
 * Never log passwords; trace only scenario + coarse method flags.
 */
export class FahemProviderLinkError extends Error {
  constructor(
    public readonly scenario:
      | "signup_requires_google_link"
      | "signup_use_login"
      | "google_requires_password_link"
      | "login_suggest_google_only",
    public readonly email: string,
    public readonly signInMethods: string[],
    public readonly passwordForLinking?: string,
    public readonly pendingGoogleOAuthCredential?: AuthCredential | null,
  ) {
    super("FahemProviderLinkError");
    this.name = "FahemProviderLinkError";
  }
}

export function isFahemProviderLinkError(error: unknown): error is FahemProviderLinkError {
  return error instanceof FahemProviderLinkError;
}

export function userFacingAuthMessage(error: unknown): string {
  if (isFahemProviderLinkError(error)) {
    switch (error.scenario) {
      case "signup_requires_google_link":
        return "هذا البريد مرتبط بحساب Google. سجّل الدخول عبر Google مرة واحدة ثم نربط كلمة المرور التي اخترتها بنفس الحساب.";
      case "signup_use_login":
        return "هذا البريد مسجّل مسبقًا بكلمة مرور. استخدم «تسجيل الدخول» بدل إنشاء حساب.";
      case "google_requires_password_link":
        return "هذا البريد مسجّل بكلمة مرور. أدخل كلمة المرور أدناه لربط حساب Google بنفس الحساب.";
      case "login_suggest_google_only":
        return "تسجيل الدخول بهذا البريد يتم عبر Google. اختر «Google» من الخطوة السابقة.";
      default:
        return "يلزم إكمال ربط طريقة الدخول. اتبع التعليمات أو جرّب طريقة أخرى.";
    }
  }

  const firebaseCode = readFirebaseErrorCode(error);
  const raw = firebaseCode || (error instanceof Error ? error.message : "auth_unknown_error");

  const map: Record<string, string> = {
    "auth/invalid-email": "صيغة البريد الإلكتروني غير صحيحة.",
    "auth/invalid-action-code": "الرابط غير صالح أو منتهٍ. اطلب رابطًا جديدًا.",
    "auth/expired-action-code": "انتهت صلاحية الرابط. اطلب إعادة تعيين جديدة.",
    "auth/weak-password": "كلمة المرور ضعيفة. استخدم 6 أحرف أو أكثر مع تنويع أقوى.",
    "auth/user-disabled": "تم تعطيل هذا الحساب.",
    "auth/wrong-password": "كلمة المرور غير صحيحة.",
    "auth/user-not-found": "لا يوجد حساب بهذا البريد.",
    "auth/invalid-credential": "بيانات الدخول غير صحيحة.",
    "auth/too-many-requests": "محاولات كثيرة. حاول لاحقًا.",
    "auth/email-already-in-use": "هذا البريد مستخدم مسبقًا.",
    "auth/credential-already-in-use": "هذه البيانات مرتبطة بحساب آخر.",
    "auth/provider-already-linked": "طريقة الدخول هذه مربوطة بالفعل.",
    "auth/quota-exceeded": "تجاوز حد إرسال البريد في Firebase. حاول لاحقًا.",
    auth_email_exists_login: "استخدم تسجيل الدخول لأن البريد مسجّل بكلمة مرور.",
    auth_signup_use_login_instead: "استخدم تسجيل الدخول بدل إنشاء حساب.",
    missing_password: "أدخل كلمة المرور.",
    missing_password_confirm: "أكد كلمة المرور الجديدة.",
    password_mismatch: "كلمتا المرور غير متطابقتين.",
    missing_current_user: "يجب تسجيل الدخول أولاً.",
  };

  if (map[firebaseCode]) return map[firebaseCode];
  if (map[raw]) return map[raw];

  if (raw.includes("missing_vite_firebase")) return "إعدادات Firebase غير مكتملة في بيئة الواجهة.";
  if (raw.includes("google_flow_in_progress")) return "محاولة تسجيل دخول جارية. انتظر قليلًا.";
  if (raw.includes("auth_exchange_failed")) return "تعذر إنشاء جلسة داخلية. تحقق من الخادم.";
  if (raw.includes("FahemProviderLinkError")) return userFacingAuthMessage(new FahemProviderLinkError("signup_requires_google_link", "", []));

  return firebaseCode ? `خطأ: ${firebaseCode}` : "تعذر إكمال العملية. حاول مرة أخرى.";
}

/** If false (default), password reset acts as generic success on user-not-found (anti-enumeration). */
export function passwordResetRevealNotFound(): boolean {
  return String(import.meta.env.VITE_AUTH_PASSWORD_RESET_REVEAL_NOT_FOUND ?? "").trim() === "1";
}
