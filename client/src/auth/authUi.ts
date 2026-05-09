import {
  cleanupEmailLinkLandingUrl,
  confirmPasswordResetFlow,
  getAuthReadableStatus,
  loginWithEmailPassword,
  loginWithGoogle,
  logoutFlow,
  nextTraceId,
  sendPasswordResetEmailFlow,
  signupWithEmailPassword,
} from "./authFlows";
import {
  FahemProviderLinkError,
  isFahemProviderLinkError,
  readFirebaseErrorCode,
  userFacingAuthMessage,
} from "./authErrors";
import { getAuthState } from "./authStore";
import { signInGoogleThenLinkPendingPassword, signInPasswordThenLinkPendingGoogle } from "./linkingFlows";

type AuthUiStep = "method_select" | "email_auth" | "forgot" | "link" | "reset_password";

export type OpenAuthModalOptions = {
  /** عند العودة من بريد إعادة تعيين كلمة المرور (oobCode من Firebase). */
  passwordResetOobCode?: string;
  onCompleted?: () => void;
};

/** Escape: إغلاق كامل للمربع (وليس خطوة للخلف) — تجنّب اعتماد مفتاح واحد لتسلسل خطوتين لتبسيط الوصولية. */

function googleSignInSvg(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "auth-google-svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  const paths: Array<{ fill: string; d: string }> = [
    {
      fill: "#EA4335",
      d: "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z",
    },
    {
      fill: "#4285F4",
      d: "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6C43.94 39.51 46.98 32.71 46.98 24.55z",
    },
    {
      fill: "#FBBC05",
      d: "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z",
    },
    {
      fill: "#34A853",
      d: "M24 46c6.27 0 11.53-2.06 15.41-5.91l-7.73-6c-2.15 1.45-4.93 2.37-7.69 2.37-6.26 0-11.56-4.04-13.43-9.71l-7.97 6.19C6.51 42.62 14.62 48 24 48z",
    },
  ];
  for (const { fill, d } of paths) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("fill", fill);
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

function googleBrandedButton(id: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = id;
  btn.className = "auth-google-btn";
  btn.setAttribute("aria-label", "المتابعة بحساب Google");
  btn.appendChild(googleSignInSvg());
  const label = document.createElement("span");
  label.className = "auth-google-label";
  label.textContent = "المتابعة بحساب Google";
  btn.appendChild(label);
  return btn;
}

function mailOutlineSvg(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "auth-email-method-svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute(
    "d",
    "M4 6h16v12H4V6zm2 0 6 4 6-4H6zm-2 2.2V18h16V8.2l-8 5.3-8-5.3z",
  );
  p.setAttribute("fill", "currentColor");
  svg.appendChild(p);
  return svg;
}

function emailMethodButton(id: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = id;
  btn.className = "auth-email-method-btn";
  btn.setAttribute("aria-label", "المتابعة بالبريد الإلكتروني وكلمة المرور");
  btn.appendChild(mailOutlineSvg());
  const label = document.createElement("span");
  label.className = "auth-email-method-label";
  label.textContent = "البريد الإلكتروني وكلمة المرور";
  btn.appendChild(label);
  return btn;
}

export function openAuthModal(options: OpenAuthModalOptions = {}): void {
  const existing = document.querySelector<HTMLElement>("#auth-modal-overlay");
  if (existing) existing.remove();

  const passwordResetOob = String(options.passwordResetOobCode ?? "").trim();

  let step: AuthUiStep = passwordResetOob ? "reset_password" : "method_select";
  let pendingLink: InstanceType<typeof FahemProviderLinkError> | null = null;
  let emailSignupMode = false;
  /** يُنسَخ إلى حقل «نسيت كلمة المرور» عند الانتقال من مسار الاسترداد السريع */
  let forgotEmailPrefill = "";

  const state = getAuthState();

  const overlay = document.createElement("div");
  overlay.id = "auth-modal-overlay";
  overlay.className = "auth-modal-overlay";

  const dialog = document.createElement("div");
  dialog.className = "auth-modal";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "auth-modal-title");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "auth-modal-close";
  closeBtn.id = "auth-modal-close";
  closeBtn.setAttribute("aria-label", "إغلاق");
  closeBtn.textContent = "×";

  const titleEl = document.createElement("h2");
  titleEl.id = "auth-modal-title";
  titleEl.className = "auth-modal-title";
  titleEl.textContent = "الحساب";

  const subtitleEl = document.createElement("p");
  subtitleEl.className = "auth-modal-subtitle";
  subtitleEl.textContent = `الحالة الحالية: ${getAuthReadableStatus()}`;

  const errorEl = document.createElement("p");
  errorEl.id = "auth-modal-error";
  errorEl.className = "auth-modal-error";
  errorEl.setAttribute("aria-live", "polite");

  const dynamicRoot = document.createElement("div");
  dynamicRoot.id = "auth-modal-dynamic";
  dynamicRoot.className = "auth-modal-panel";

  overlay.appendChild(dialog);
  dialog.appendChild(closeBtn);
  dialog.appendChild(titleEl);
  dialog.appendChild(subtitleEl);
  dialog.appendChild(errorEl);
  dialog.appendChild(dynamicRoot);

  const setErrorMsg = (message: string): void => {
    errorEl.textContent = message ?? "";
  };

  const closeModal = (): void => {
    window.removeEventListener("keydown", onEscapeDown);
    overlay.remove();
  };

  function onEscapeDown(ev: KeyboardEvent): void {
    if (ev.key === "Escape" && document.body.contains(overlay)) closeModal();
  }
  window.addEventListener("keydown", onEscapeDown);

  const handleMaybeLinkError = (error: unknown): string => {
    if (isFahemProviderLinkError(error)) {
      pendingLink = error;
      step = "link";
      renderDynamic();
      return userFacingAuthMessage(error);
    }
    return userFacingAuthMessage(error);
  };

  const restoreEmailSubmitAppearance = (button: HTMLButtonElement): void => {
    if (!button.classList.contains("auth-modal-email-submit")) return;
    button.textContent = emailSignupMode ? "إنشاء الحساب" : "تسجيل الدخول";
    button.id = emailSignupMode ? "auth-modal-signup" : "auth-modal-login";
    button.setAttribute("aria-label", emailSignupMode ? "إنشاء حساب جديد" : "تسجيل الدخول");
  };

  const withLoading = async (
    button: HTMLButtonElement | null,
    action: () => Promise<void>,
    actionOptions: { closeOnSuccess?: boolean; successMessage?: string; loadingLabel?: string } = {},
  ): Promise<void> => {
    if (!button) return;
    const prev = button.textContent ?? "";
    button.disabled = true;
    button.textContent = actionOptions.loadingLabel ?? "جاري التنفيذ...";
    setErrorMsg("");
    try {
      await action();
      if (actionOptions.successMessage) setErrorMsg(actionOptions.successMessage);
      if (actionOptions.closeOnSuccess !== false) {
        options.onCompleted?.();
        closeModal();
      }
    } catch (error) {
      setErrorMsg(handleMaybeLinkError(error));
    } finally {
      if (document.body.contains(overlay)) {
        button.disabled = false;
        if (button.classList.contains("auth-modal-email-submit")) {
          restoreEmailSubmitAppearance(button);
        } else {
          button.textContent = prev;
        }
      }
    }
  };

  const withLoadingStrict = async (
    button: HTMLButtonElement | null,
    action: () => Promise<void>,
    actionOptions: { closeOnSuccess?: boolean; successMessage?: string; loadingLabel?: string } = {},
  ): Promise<void> => {
    if (!button) return;
    const prev = button.textContent ?? "";
    button.disabled = true;
    button.textContent = actionOptions.loadingLabel ?? "جاري التنفيذ...";
    setErrorMsg("");
    try {
      await action();
      if (actionOptions.successMessage) setErrorMsg(actionOptions.successMessage);
      if (actionOptions.closeOnSuccess !== false) {
        options.onCompleted?.();
        closeModal();
      }
    } catch (error) {
      setErrorMsg(userFacingAuthMessage(error));
    } finally {
      if (document.body.contains(overlay)) {
        button.disabled = false;
        if (button.classList.contains("auth-modal-email-submit")) {
          restoreEmailSubmitAppearance(button);
        } else {
          button.textContent = prev;
        }
      }
    }
  };

  let emailInputRef: HTMLInputElement | null = null;
  let passwordInputRef: HTMLInputElement | null = null;
  let newPasswordRef: HTMLInputElement | null = null;
  let newPasswordConfirmRef: HTMLInputElement | null = null;

  const requireEmail = (): string => {
    const value = String(emailInputRef?.value ?? "").trim();
    if (!value) throw new Error("auth/invalid-email");
    return value;
  };

  const requirePassword = (): string => {
    const value = String(passwordInputRef?.value ?? "").trim();
    if (!value) throw new Error("missing_password");
    return value;
  };

  function backButton(container: HTMLElement): void {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ui-btn ui-btn--ghost w-full py-2 auth-modal-back";
    b.textContent = "← رجوع";
    b.addEventListener("click", () => {
      setErrorMsg("");
      if (pendingLink && step === "link") pendingLink = null;
      if (passwordResetOob && step === "reset_password") {
        closeModal();
        return;
      }
      step = "method_select";
      renderDynamic();
    });
    container.appendChild(b);
  }

  function renderDynamic(): void {
    emailInputRef = null;
    passwordInputRef = null;
    newPasswordRef = null;
    newPasswordConfirmRef = null;
    dynamicRoot.replaceChildren();
    dynamicRoot.classList.remove("auth-modal-panel--enter");
    void dynamicRoot.offsetWidth;
    dynamicRoot.classList.add("auth-modal-panel--enter");

    if (state.status === "authenticated" && state.user) {
      const card = document.createElement("div");
      card.className = "auth-user-card";
      const p1 = document.createElement("p");
      p1.className = "m-0 text-sm";
      p1.append("مسجل كـ: ");
      const strong = document.createElement("strong");
      strong.textContent = state.user.displayName ?? state.user.email ?? "مستخدم";
      p1.appendChild(strong);
      const p2 = document.createElement("p");
      p2.className = "m-0 text-xs text-slate-400";
      p2.textContent = state.user.email ?? "بدون بريد";
      card.appendChild(p1);
      card.appendChild(p2);
      const logoutBtn = document.createElement("button");
      logoutBtn.type = "button";
      logoutBtn.className = "ui-btn ui-btn--ghost w-full py-2";
      logoutBtn.id = "auth-modal-logout";
      logoutBtn.textContent = "تسجيل خروج";
      logoutBtn.addEventListener("click", () => {
        void withLoading(logoutBtn, () => logoutFlow(), { loadingLabel: "جاري تسجيل الخروج..." });
      });
      dynamicRoot.appendChild(card);
      dynamicRoot.appendChild(logoutBtn);
      return;
    }

    if (step === "method_select") {
      const wrap = document.createElement("div");
      wrap.className = "auth-modal-step-grid";
      const intro = document.createElement("p");
      intro.className = "auth-modal-step-intro";
      intro.textContent = "اختر طريقة التسجيل أو الدخول:";
      wrap.appendChild(intro);

      const gMain = googleBrandedButton("auth-modal-google-main");
      gMain.addEventListener("click", () => {
        void withLoading(gMain, () => loginWithGoogle(), { loadingLabel: "جاري تسجيل الدخول..." });
      });
      wrap.appendChild(gMain);

      const btnEmail = emailMethodButton("auth-modal-email-method");
      btnEmail.addEventListener("click", () => {
        step = "email_auth";
        renderDynamic();
      });
      wrap.appendChild(btnEmail);

      const forgot = document.createElement("button");
      forgot.type = "button";
      forgot.className = "auth-modal-text-link";
      forgot.textContent = "نسيت كلمة المرور؟";
      forgot.addEventListener("click", () => {
        step = "forgot";
        renderDynamic();
      });
      wrap.appendChild(forgot);

      dynamicRoot.appendChild(wrap);
      return;
    }

    if (step === "email_auth") {
      const wrap = document.createElement("div");
      wrap.className = "auth-modal-form auth-modal-step-section";
      wrap.id = "auth-panel-email";
      wrap.setAttribute("role", "tabpanel");
      wrap.setAttribute("aria-label", "نموذج البريد وكلمة المرور");
      backButton(wrap);

      const tablist = document.createElement("div");
      tablist.className = "auth-auth-tablist";
      tablist.setAttribute("role", "tablist");
      tablist.setAttribute("aria-label", "تسجيل الدخول أو إنشاء حساب");

      const tabLogin = document.createElement("button");
      tabLogin.type = "button";
      tabLogin.className = "auth-auth-tab";
      tabLogin.setAttribute("role", "tab");
      tabLogin.id = "auth-tab-login";
      tabLogin.setAttribute("aria-controls", "auth-panel-email");
      tabLogin.textContent = "تسجيل الدخول";

      const tabSignup = document.createElement("button");
      tabSignup.type = "button";
      tabSignup.className = "auth-auth-tab";
      tabSignup.setAttribute("role", "tab");
      tabSignup.id = "auth-tab-signup";
      tabSignup.setAttribute("aria-controls", "auth-panel-email");
      tabSignup.textContent = "إنشاء حساب";

      tablist.appendChild(tabLogin);
      tablist.appendChild(tabSignup);
      wrap.appendChild(tablist);

      const lblE = document.createElement("label");
      lblE.className = "auth-modal-label";
      lblE.htmlFor = "auth-modal-email";
      lblE.textContent = "البريد الإلكتروني";
      const inpE = document.createElement("input");
      inpE.id = "auth-modal-email";
      inpE.type = "email";
      inpE.className = "app-input w-full px-3 py-2";
      inpE.autocomplete = "email";
      emailInputRef = inpE;

      const lblP = document.createElement("label");
      lblP.className = "auth-modal-label";
      lblP.htmlFor = "auth-modal-password";
      lblP.textContent = "كلمة المرور";
      const inpP = document.createElement("input");
      inpP.id = "auth-modal-password";
      inpP.type = "password";
      inpP.className = "app-input w-full px-3 py-2";
      inpP.autocomplete = emailSignupMode ? "new-password" : "current-password";
      passwordInputRef = inpP;

      wrap.appendChild(lblE);
      wrap.appendChild(inpE);
      wrap.appendChild(lblP);
      wrap.appendChild(inpP);

      const actions = document.createElement("div");
      actions.className = "auth-modal-actions auth-modal-actions--stack";
      const submit = document.createElement("button");
      submit.type = "button";
      submit.className = "ui-btn ui-btn--cta py-2 auth-modal-email-submit";
      submit.id = emailSignupMode ? "auth-modal-signup" : "auth-modal-login";

      const loginRecoveryRow = document.createElement("div");
      loginRecoveryRow.className = "auth-modal-login-recovery";
      loginRecoveryRow.style.display = "none";
      const forgotQuick = document.createElement("button");
      forgotQuick.type = "button";
      forgotQuick.className = "auth-modal-recovery-btn";
      forgotQuick.textContent = "نسيت كلمة المرور؟ إرسال رابط الاسترداد";
      forgotQuick.addEventListener("click", () => {
        forgotEmailPrefill = String(inpE.value ?? "").trim();
        step = "forgot";
        setErrorMsg("");
        renderDynamic();
      });
      loginRecoveryRow.appendChild(forgotQuick);

      const syncTabsAndSubmit = (): void => {
        const signup = emailSignupMode;
        tabLogin.setAttribute("aria-selected", signup ? "false" : "true");
        tabSignup.setAttribute("aria-selected", signup ? "true" : "false");
        tabLogin.setAttribute("tabindex", signup ? "-1" : "0");
        tabSignup.setAttribute("tabindex", signup ? "0" : "-1");
        wrap.setAttribute("aria-labelledby", signup ? "auth-tab-signup" : "auth-tab-login");
        tabLogin.classList.toggle("auth-auth-tab--active", !signup);
        tabSignup.classList.toggle("auth-auth-tab--active", signup);
        submit.id = signup ? "auth-modal-signup" : "auth-modal-login";
        submit.textContent = signup ? "إنشاء الحساب" : "تسجيل الدخول";
        submit.setAttribute("aria-label", signup ? "إنشاء حساب جديد" : "تسجيل الدخول");
        inpP.autocomplete = signup ? "new-password" : "current-password";
        if (signup) {
          loginRecoveryRow.style.display = "none";
        }
      };

      syncTabsAndSubmit();

      const focusTabForMode = (): void => {
        (emailSignupMode ? tabSignup : tabLogin).focus();
      };

      tabLogin.addEventListener("click", () => {
        if (emailSignupMode) {
          emailSignupMode = false;
          setErrorMsg("");
          loginRecoveryRow.style.display = "none";
          syncTabsAndSubmit();
        }
      });
      tabSignup.addEventListener("click", () => {
        if (!emailSignupMode) {
          emailSignupMode = true;
          setErrorMsg("");
          loginRecoveryRow.style.display = "none";
          syncTabsAndSubmit();
        }
      });

      tablist.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft" && ev.key !== "Home" && ev.key !== "End") return;
        ev.preventDefault();
        if (ev.key === "Home") {
          emailSignupMode = false;
        } else if (ev.key === "End") {
          emailSignupMode = true;
        } else {
          const isRtl = document.documentElement.getAttribute("dir") === "rtl";
          const forward = isRtl ? ev.key === "ArrowLeft" : ev.key === "ArrowRight";
          if (forward) {
            emailSignupMode = true;
          } else {
            emailSignupMode = false;
          }
        }
        setErrorMsg("");
        loginRecoveryRow.style.display = "none";
        syncTabsAndSubmit();
        focusTabForMode();
      });

      submit.addEventListener("click", () => {
        if (emailSignupMode) {
          void withLoading(
            submit,
            async () => {
              await signupWithEmailPassword(requireEmail(), requirePassword());
            },
            { loadingLabel: "جاري إنشاء الحساب..." },
          );
          return;
        }
        void (async () => {
          submit.disabled = true;
          tabLogin.disabled = true;
          tabSignup.disabled = true;
          submit.textContent = "جاري تسجيل الدخول...";
          setErrorMsg("");
          loginRecoveryRow.style.display = "none";
          try {
            await loginWithEmailPassword(requireEmail(), requirePassword());
            options.onCompleted?.();
            closeModal();
          } catch (error) {
            setErrorMsg(handleMaybeLinkError(error));
            const code = readFirebaseErrorCode(error);
            if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
              loginRecoveryRow.style.display = "flex";
            }
          } finally {
            if (document.body.contains(overlay)) {
              submit.disabled = false;
              tabLogin.disabled = false;
              tabSignup.disabled = false;
              syncTabsAndSubmit();
            }
          }
        })();
      });
      actions.appendChild(submit);
      wrap.appendChild(actions);
      wrap.appendChild(loginRecoveryRow);

      dynamicRoot.appendChild(wrap);
      return;
    }

    if (step === "forgot") {
      const wrap = document.createElement("div");
      wrap.className = "auth-modal-form auth-modal-step-section";
      backButton(wrap);

      const hint = document.createElement("p");
      hint.className = "auth-modal-step-intro";
      hint.textContent = "أدخل البريد لاستلام رابط إعادة التعيين.";

      const lbl = document.createElement("label");
      lbl.className = "auth-modal-label";
      lbl.htmlFor = "auth-modal-forgot-email";
      lbl.textContent = "البريد الإلكتروني";
      const inp = document.createElement("input");
      inp.id = "auth-modal-forgot-email";
      inp.type = "email";
      inp.className = "app-input w-full px-3 py-2";
      inp.autocomplete = "email";
      if (forgotEmailPrefill) {
        inp.value = forgotEmailPrefill;
        forgotEmailPrefill = "";
      }
      emailInputRef = inp;

      const sendBtn = document.createElement("button");
      sendBtn.type = "button";
      sendBtn.className = "ui-btn ui-btn--cta w-full py-2";
      sendBtn.textContent = "إرسال رابط الاسترداد";
      sendBtn.addEventListener("click", () => {
        void withLoadingStrict(sendBtn, () => sendPasswordResetEmailFlow(requireEmail()), {
          closeOnSuccess: false,
          loadingLabel: "جاري إرسال الرابط...",
          successMessage: "إن وُجد حساب لهذا البريد سيصلُك رابط إعادة التعيين. راجع أيضًا مجلد الرسائل غير المرغوبة.",
        });
      });

      wrap.appendChild(hint);
      wrap.appendChild(lbl);
      wrap.appendChild(inp);
      wrap.appendChild(sendBtn);
      dynamicRoot.appendChild(wrap);
      return;
    }

    if (step === "link") {
      if (!pendingLink) {
        step = "method_select";
        renderDynamic();
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = "auth-modal-form auth-modal-step-section";
      backButton(wrap);

      const msg = document.createElement("p");
      msg.className = "auth-modal-link-msg";
      msg.textContent = userFacingAuthMessage(pendingLink);

      wrap.appendChild(msg);

      if (pendingLink.scenario === "signup_requires_google_link" && pendingLink.passwordForLinking) {
        const note = document.createElement("p");
        note.className = "auth-modal-step-intro text-xs text-slate-400";
        note.textContent = `البريد: ${pendingLink.email}`;
        wrap.appendChild(note);
        const doGoogle = googleBrandedButton("auth-modal-link-google-brand");
        doGoogle.addEventListener("click", () => {
          void withLoadingStrict(
            doGoogle,
            () =>
              signInGoogleThenLinkPendingPassword(
                pendingLink!.email,
                pendingLink!.passwordForLinking!,
                nextTraceId("ui-link-goog-pw"),
              ),
            { loadingLabel: "جاري تسجيل الدخول..." },
          );
        });
        wrap.appendChild(doGoogle);
      } else if (pendingLink.scenario === "google_requires_password_link" && pendingLink.pendingGoogleOAuthCredential) {
        const lblE = document.createElement("label");
        lblE.className = "auth-modal-label";
        lblE.textContent = "البريد";
        const disp = document.createElement("div");
        disp.className = "auth-modal-readonly-email";
        disp.textContent = pendingLink.email;

        const lblP = document.createElement("label");
        lblP.className = "auth-modal-label";
        lblP.htmlFor = "auth-modal-link-password";
        lblP.textContent = "كلمة المرور";
        const inpP = document.createElement("input");
        inpP.type = "password";
        inpP.id = "auth-modal-link-password";
        inpP.className = "app-input w-full px-3 py-2";
        inpP.autocomplete = "current-password";
        passwordInputRef = inpP;

        wrap.appendChild(lblE);
        wrap.appendChild(disp);
        wrap.appendChild(lblP);
        wrap.appendChild(inpP);

        const linkBtn = document.createElement("button");
        linkBtn.type = "button";
        linkBtn.className = "ui-btn ui-btn--cta w-full py-2";
        linkBtn.textContent = "ربط Google بحسابي";
        linkBtn.addEventListener("click", () => {
          void withLoadingStrict(
            linkBtn,
            () =>
              signInPasswordThenLinkPendingGoogle(
                pendingLink!.email,
                requirePassword(),
                pendingLink!.pendingGoogleOAuthCredential!,
                nextTraceId("ui-link-pw-goog"),
              ),
            { loadingLabel: "جاري ربط الحساب..." },
          );
        });
        wrap.appendChild(linkBtn);
      } else if (pendingLink.scenario === "signup_use_login") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn ui-btn--cta w-full py-2";
        btn.textContent = "تسجيل الدخول بالبريد";
        btn.addEventListener("click", () => {
          emailSignupMode = false;
          pendingLink = null;
          step = "email_auth";
          renderDynamic();
        });
        wrap.appendChild(btn);
      } else if (pendingLink.scenario === "login_suggest_google_only") {
        const gOnly = googleBrandedButton("auth-modal-google-link-hint");
        gOnly.addEventListener("click", () => {
          void withLoading(gOnly, () => loginWithGoogle(), { loadingLabel: "جاري تسجيل الدخول..." });
        });
        wrap.appendChild(gOnly);
      } else {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn ui-btn--cta w-full py-2";
        btn.textContent = "إغلاق وإعادة المحاولة";
        btn.addEventListener("click", () => closeModal());
        wrap.appendChild(btn);
      }

      dynamicRoot.appendChild(wrap);
      return;
    }

    if (step === "reset_password" && passwordResetOob) {
      const wrap = document.createElement("div");
      wrap.className = "auth-modal-form auth-modal-step-section";

      const closeReset = (): void => {
        cleanupEmailLinkLandingUrl();
        closeModal();
      };

      const b = document.createElement("button");
      b.type = "button";
      b.className = "ui-btn ui-btn--ghost w-full py-2 auth-modal-back";
      b.textContent = "إلغاء";
      b.addEventListener("click", () => closeReset());
      wrap.appendChild(b);

      const intro = document.createElement("p");
      intro.className = "auth-modal-step-intro";
      intro.textContent = "حدّد كلمة المرور الجديدة لحسابك.";
      wrap.appendChild(intro);

      const l1 = document.createElement("label");
      l1.className = "auth-modal-label";
      l1.htmlFor = "auth-modal-new-password";
      l1.textContent = "كلمة المرور الجديدة";
      const p1 = document.createElement("input");
      p1.type = "password";
      p1.id = "auth-modal-new-password";
      p1.className = "app-input w-full px-3 py-2";
      p1.autocomplete = "new-password";
      newPasswordRef = p1;

      const l2 = document.createElement("label");
      l2.className = "auth-modal-label";
      l2.htmlFor = "auth-modal-new-password-2";
      l2.textContent = "تأكيد كلمة المرور";
      const p2 = document.createElement("input");
      p2.type = "password";
      p2.id = "auth-modal-new-password-2";
      p2.className = "app-input w-full px-3 py-2";
      p2.autocomplete = "new-password";
      newPasswordConfirmRef = p2;

      wrap.appendChild(l1);
      wrap.appendChild(p1);
      wrap.appendChild(l2);
      wrap.appendChild(p2);

      const save = document.createElement("button");
      save.type = "button";
      save.className = "ui-btn ui-btn--cta w-full py-2";
      save.textContent = "حفظ كلمة المرور";
      save.addEventListener("click", () => {
        const a = String(newPasswordRef?.value ?? "").trim();
        const b2 = String(newPasswordConfirmRef?.value ?? "").trim();
        if (!a) {
          setErrorMsg(userFacingAuthMessage(new Error("missing_password")));
          return;
        }
        if (!b2) {
          setErrorMsg(userFacingAuthMessage(new Error("missing_password_confirm")));
          return;
        }
        if (a !== b2) {
          setErrorMsg(userFacingAuthMessage(new Error("password_mismatch")));
          return;
        }
        void withLoadingStrict(
          save,
          async () => {
            await confirmPasswordResetFlow(passwordResetOob, a);
            cleanupEmailLinkLandingUrl();
            options.onCompleted?.();
            closeModal();
          },
          { loadingLabel: "جاري حفظ كلمة المرور..." },
        );
      });

      wrap.appendChild(save);
      dynamicRoot.appendChild(wrap);
    }
  }

  closeBtn.addEventListener("click", () => closeModal());
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) closeModal();
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

  document.body.appendChild(overlay);

  if (state.status === "authenticated" && state.user) {
    renderDynamic();
    closeBtn.focus();
  } else {
    renderDynamic();
    const focusAfterOpen: HTMLElement | null =
      emailInputRef ?? newPasswordRef ?? overlay.querySelector<HTMLElement>("#auth-modal-google-main");
    focusAfterOpen?.focus();
  }
}
