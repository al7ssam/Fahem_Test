import { isSignInWithEmailLink } from "firebase/auth";
import {
  cleanupEmailLinkLandingUrl,
  completePasswordlessEmailLink,
  getAuthReadableStatus,
  getPendingEmailLinkEmail,
  loginWithEmailPassword,
  loginWithGoogle,
  logoutFlow,
  sendPasswordlessEmailLink,
  signupWithEmailPassword,
} from "./authFlows";
import { getFirebaseAuth } from "./firebaseClient";
import { getAuthState } from "./authStore";

type OpenAuthModalOptions = {
  forceEmailLinkCompletion?: boolean;
  magicLinkReasonCode?: string;
  magicLinkFirebaseCode?: string;
  onCompleted?: () => void;
};

function closeModal(root: HTMLElement): void {
  root.remove();
}

function magicLinkRecoverHint(reasonCode?: string): string | null {
  if (!reasonCode || reasonCode === "missing_email_for_email_link") {
    return "أدخل نفس عنوان البريد الذي طلبت الرابط له. إذا فتح الرابط على جهاز آخر، لن يكون البريد محفوظًا — أكمل الإدخال يدويًا ثم استخدم زر إكمال الرابط.";
  }
  if (reasonCode === "magic_link_invalid_url" || reasonCode === "magic_link_expired_or_stripped_query") {
    return "تأكد أن النطاق مضاف في Authorized domains وأن عنوان المتابعة (continue URL) يطابق مستضيفك؛ افتح الرابط مباشرة من الرسالة دون مانع أو قصّ لـ ? في المتصفح.";
  }
  if (reasonCode === "magic_link_already_in_progress") {
    return "هناك إكمال قائم الآن؛ انتظر قليلًا ثم جرّب مرة واحدة.";
  }
  return null;
}

function makeInitialMagicError(reasonCode?: string, firebaseCode?: string): string {
  if (firebaseCode) {
    const fake = Object.assign(new Error(""), { code: firebaseCode });
    return makeActionError(fake);
  }
  return reasonCode ? makeActionError(new Error(reasonCode)) : "";
}

function makeActionError(error: unknown): string {
  const firebaseCode = typeof (error as { code?: string })?.code === "string" ? String((error as { code: string }).code) : "";
  const raw = firebaseCode || (error instanceof Error ? error.message : "auth_unknown_error");

  const firebaseMessages: Record<string, string> = {
    "auth/invalid-email": "صيغة البريد الإلكتروني غير صحيحة.",
    "auth/invalid-action-code": "رابط الدخول غير صالح أو استُخدم مسبقًا. أعد طلب الرابط السحري.",
    "auth/expired-action-code": "انتهت صلاحية الرابط السحري. أعد الطلب وجرب الرابط الجديد خلال وقت معقول.",
    "auth/user-disabled": "تم تعطيل هذا الحساب.",
  };
  const appMessages: Record<string, string> = {
    magic_link_invalid_url: "هذه الصفحة لا تحتوي رابط تسجيل دخول سحريًا صالحًا من Firebase أو فقد المعاملات (مثل oobCode).",
    magic_link_expired_or_stripped_query: "وصلت إلى صفحة بلا معامل الرابط؛ أعد الطلب أو افتح الرابط من الرسالة مباشرة دون تجريد العنوان.",
    magic_link_already_in_progress: "عملية الإكمال جارية؛ انتظر قليلًا.",
    magic_link_missing_firebase_user: "فشل إنشاء جلسة Firebase بعد الرابط؛ أعد المحاولة.",
    missing_email_for_email_link: "أدخل البريد لإكمال الرابط السحري.",
    missing_password: "أدخل كلمة المرور.",
  };

  if (firebaseMessages[firebaseCode]) return firebaseMessages[firebaseCode];
  if (appMessages[raw]) return appMessages[raw];

  if (raw.includes("missing_vite_firebase")) return "إعدادات Firebase غير مكتملة في بيئة الواجهة.";
  if (raw.includes("missing_vite")) return "إعدادات Firebase غير مكتملة في ملف البيئة.";
  if (raw.includes("auth/popup-blocked")) return "المتصفح حظر نافذة Google. اسمح بالنوافذ المنبثقة ثم حاول مرة أخرى.";
  if (raw.includes("auth/popup-closed-by-user")) return "تم إغلاق نافذة Google قبل إكمال العملية.";
  if (raw.includes("auth/cancelled-popup-request")) return "تم إلغاء طلب تسجيل الدخول. أعد المحاولة.";
  if (raw.includes("auth/operation-not-supported-in-this-environment")) return "بيئة المتصفح لا تدعم Popup. سيتم استخدام redirect.";
  if (raw.includes("google_flow_in_progress")) return "محاولة تسجيل دخول جارية بالفعل. انتظر قليلًا.";
  if (raw.includes("google_missing_firebase_user")) return "تمت مصادقة Google لكن لم يتم الحصول على المستخدم. أعد المحاولة.";
  if (raw.includes("google_redirect_result_failed")) return "فشل استرجاع نتيجة تسجيل الدخول عبر redirect.";
  if (raw.includes("popup")) return "تعذر فتح نافذة Google. تحقق من مانع النوافذ وحاول مجددًا.";
  if (raw.includes("wrong-password")) return "كلمة المرور غير صحيحة.";
  if (raw.includes("user-not-found")) return "الحساب غير موجود.";
  if (raw.includes("email-already-in-use")) return "هذا البريد مستخدم مسبقًا. جرّب تسجيل الدخول.";
  if (raw.includes("too-many-requests")) return "محاولات كثيرة. حاول بعد قليل.";
  if (raw.includes("auth_exchange_failed")) return "تعذر إنشاء جلسة داخلية بعد نجاح Firebase. تحقق من الخادم والشبكة.";
  return firebaseCode ? `خطأ المصادقة (${firebaseCode}). أعد المحاولة أو اطلب رابطًا جديدًا.` : "تعذر إكمال عملية المصادقة. حاول مرة أخرى.";
}

export function openAuthModal(options: OpenAuthModalOptions = {}): void {
  const existing = document.querySelector<HTMLElement>("#auth-modal-overlay");
  if (existing) existing.remove();

  const hint = options.forceEmailLinkCompletion ? magicLinkRecoverHint(options.magicLinkReasonCode) : null;
  const initialErr = options.forceEmailLinkCompletion ? makeInitialMagicError(options.magicLinkReasonCode, options.magicLinkFirebaseCode) : "";

  const state = getAuthState();
  const overlay = document.createElement("div");
  overlay.id = "auth-modal-overlay";
  overlay.className = "auth-modal-overlay";
  overlay.innerHTML = `
    <div class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
      <button type="button" class="auth-modal-close" id="auth-modal-close" aria-label="إغلاق">×</button>
      <h2 id="auth-modal-title" class="auth-modal-title">الحساب</h2>
      <p class="auth-modal-subtitle">الحالة الحالية: ${getAuthReadableStatus()}</p>
      ${
        options.forceEmailLinkCompletion && hint
          ? `<p class="auth-modal-hint text-sm text-slate-500 m-2">${hint}</p>`
          : ""
      }
      <p id="auth-modal-error" class="auth-modal-error" aria-live="polite"></p>
      ${
        state.status === "authenticated" && state.user
          ? `
      <div class="auth-user-card">
        <p class="m-0 text-sm">مسجل كـ: <strong>${state.user.displayName ?? state.user.email ?? "مستخدم"}</strong></p>
        <p class="m-0 text-xs text-slate-400">${state.user.email ?? "بدون بريد"}</p>
      </div>
      <button type="button" class="ui-btn ui-btn--ghost w-full py-2" id="auth-modal-logout">تسجيل خروج</button>
      `
          : `
      <div class="auth-modal-grid">
        <button type="button" class="ui-btn ui-btn--ghost py-2" id="auth-modal-google">المتابعة عبر Google</button>
      </div>
      <div class="auth-modal-form">
        <label class="auth-modal-label" for="auth-modal-email">البريد الإلكتروني</label>
        <input id="auth-modal-email" type="email" class="app-input w-full px-3 py-2" autocomplete="email" />
        <label class="auth-modal-label" for="auth-modal-password">كلمة المرور</label>
        <input id="auth-modal-password" type="password" class="app-input w-full px-3 py-2" autocomplete="current-password" />
        <div class="auth-modal-actions">
          <button type="button" class="ui-btn ui-btn--cta py-2" id="auth-modal-login">تسجيل الدخول</button>
          <button type="button" class="ui-btn ui-btn--ghost py-2" id="auth-modal-signup">إنشاء حساب</button>
        </div>
        <button type="button" class="ui-btn ui-btn--ghost w-full py-2" id="auth-modal-email-link">${
          options.forceEmailLinkCompletion ? "إكمال الرابط السحري" : "إرسال رابط سحري"
        }</button>
      </div>
      `
      }
    </div>
  `;

  const errorEl = overlay.querySelector<HTMLParagraphElement>("#auth-modal-error");
  const setError = (message: string): void => {
    if (errorEl) errorEl.textContent = message ?? "";
  };
  if (errorEl && initialErr) errorEl.textContent = initialErr;

  const withLoading = async (
    button: HTMLButtonElement | null,
    action: () => Promise<void>,
    actionOptions: { closeOnSuccess?: boolean; successMessage?: string } = {},
  ): Promise<void> => {
    if (!button) return;
    const prev = button.textContent ?? "";
    button.disabled = true;
    button.textContent = "جاري التنفيذ...";
    setError("");
    try {
      await action();
      if (actionOptions.successMessage) setError(actionOptions.successMessage);
      if (actionOptions.closeOnSuccess !== false) {
        options.onCompleted?.();
        closeModal(overlay);
      }
    } catch (error) {
      setError(makeActionError(error));
    } finally {
      if (document.body.contains(overlay)) {
        button.disabled = false;
        button.textContent = prev;
      }
    }
  };

  overlay.querySelector<HTMLButtonElement>("#auth-modal-close")?.addEventListener("click", () => closeModal(overlay));
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) closeModal(overlay);
  });
  overlay.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab") return;
    const focusable = Array.from(
      overlay.querySelectorAll<HTMLElement>("button, input, [href], select, textarea, [tabindex]:not([tabindex='-1'])"),
    ).filter((el) => !el.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    } else if (ev.shiftKey && active === first) {
      ev.preventDefault();
      last.focus();
    }
  });
  window.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key === "Escape" && document.body.contains(overlay)) closeModal(overlay);
    },
    { once: true },
  );

  const emailInput = overlay.querySelector<HTMLInputElement>("#auth-modal-email");
  const passwordInput = overlay.querySelector<HTMLInputElement>("#auth-modal-password");
  emailInput!.value = getPendingEmailLinkEmail();

  const requireEmail = (): string => {
    const value = String(emailInput?.value ?? "").trim();
    if (!value) throw new Error("missing_email_for_email_link");
    return value;
  };
  const requirePassword = (): string => {
    const value = String(passwordInput?.value ?? "").trim();
    if (!value) throw new Error("missing_password");
    return value;
  };

  overlay.querySelector<HTMLButtonElement>("#auth-modal-google")?.addEventListener("click", () => {
    void withLoading(overlay.querySelector("#auth-modal-google"), () => loginWithGoogle());
  });

  overlay.querySelector<HTMLButtonElement>("#auth-modal-login")?.addEventListener("click", () => {
    void withLoading(overlay.querySelector("#auth-modal-login"), () => loginWithEmailPassword(requireEmail(), requirePassword()));
  });

  overlay.querySelector<HTMLButtonElement>("#auth-modal-signup")?.addEventListener("click", () => {
    void withLoading(overlay.querySelector("#auth-modal-signup"), () => signupWithEmailPassword(requireEmail(), requirePassword()));
  });

  overlay.querySelector<HTMLButtonElement>("#auth-modal-email-link")?.addEventListener("click", () => {
    if (options.forceEmailLinkCompletion) {
      void withLoading(overlay.querySelector("#auth-modal-email-link"), async () => {
        await completePasswordlessEmailLink(requireEmail());
      });
      return;
    }
    void withLoading(
      overlay.querySelector("#auth-modal-email-link"),
      () => sendPasswordlessEmailLink(requireEmail()),
      { closeOnSuccess: false, successMessage: "تم إرسال الرابط. افتح البريد واضغط الرابط لتكمل؛ إذا وُجهت لتسجيل الدخول أكمل الإيميل وأعد المحاولة." },
    );
  });

  overlay.querySelector<HTMLButtonElement>("#auth-modal-logout")?.addEventListener("click", () => {
    void withLoading(overlay.querySelector("#auth-modal-logout"), () => logoutFlow());
  });

  document.body.appendChild(overlay);
  emailInput?.focus();

  if (options.forceEmailLinkCompletion) {
    queueMicrotask(() => {
      void (async () => {
        const auth = await getFirebaseAuth();
        if (!isSignInWithEmailLink(auth, window.location.href)) return;
        const email = getPendingEmailLinkEmail().trim();
        if (!email || !overlay.isConnected || !emailInput?.value.trim()) return;
        const btn = overlay.querySelector<HTMLButtonElement>("#auth-modal-email-link");
        await withLoading(btn, async () => {
          await completePasswordlessEmailLink(email.trim().toLowerCase());
        });
      })();
    });
  }
}
