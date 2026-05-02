/** فتح ChatGPT / Gemini: تفضيل التطبيق على الجوال عند الإمكان، ثم المتصفح */

function isAndroidUa(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

function isIosLike(): boolean {
  if (typeof navigator === "undefined") return false;
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

function openWebTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * أندرويد (كروم): intent:// مع package و S.browser_fallback_url
 * @see https://developer.chrome.com/docs/android/intents
 */
function openAndroidIntentHttps(intentHostAndPath: string, packageName: string, fallbackHttps: string): void {
  const fallback = encodeURIComponent(fallbackHttps);
  window.location.href =
    `intent://${intentHostAndPath}#Intent;scheme=https;package=${packageName};S.browser_fallback_url=${fallback};end`;
}

/**
 * تشغيل مخطط URL على iOS/Safari — يجب أن يحدث من إيماءة المستخدم مباشرة (click).
 * لا يستخدم iframe: سفاري غالباً يمنع/يتجاهل فتح التطبيق من iframe.
 *
 * يُجرَّب مخطط أساسي ثم احتياطي (مثلاً تطبيق مستقل ثم Google)، ثم فتح الويب إن لم يُلغَ الرجوع (blur/pagehide).
 */
function tryIosCustomSchemeThenWeb(primary: string, secondary: string | null, webUrl: string): void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cleanupAndClearTimer = (): void => {
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("blur", onBlur, true);
    window.removeEventListener("pagehide", onPageHide);
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    cleanupAndClearTimer();
  };

  const onVis = (): void => {
    if (document.visibilityState === "hidden") cancel();
  };
  const onBlur = (): void => cancel();
  const onPageHide = (): void => cancel();

  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("blur", onBlur, { capture: true });
  window.addEventListener("pagehide", onPageHide);

  const triggerScheme = (href: string): void => {
    const a = document.createElement("a");
    a.href = href;
    a.rel = "noopener noreferrer";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  triggerScheme(primary);

  if (secondary) {
    window.setTimeout(() => {
      if (!cancelled) triggerScheme(secondary);
    }, 280);
  }

  timer = window.setTimeout(() => {
    cleanupAndClearTimer();
    if (!cancelled && document.visibilityState === "visible") {
      openWebTab(webUrl);
    }
  }, 2400);
}

export function openChatGptExternal(): void {
  const web = "https://chatgpt.com/";
  if (isAndroidUa()) {
    openAndroidIntentHttps("chatgpt.com", "com.openai.chatgpt", web);
    return;
  }
  if (isIosLike()) {
    // مطابقة عنوان الويب — موصى به من مجتمع OpenAI ليدخل التطبيق من Safari
    tryIosCustomSchemeThenWeb(
      "chatgpt://chatgpt.com/",
      "com.openai.chat://chatgpt.com/",
      web,
    );
    return;
  }
  openWebTab(web);
}

export function openGeminiExternal(): void {
  const web = "https://gemini.google.com/app";
  if (isAndroidUa()) {
    openAndroidIntentHttps("gemini.google.com/app", "com.google.android.apps.bard", web);
    return;
  }
  if (isIosLike()) {
    // تطبيق Gemini؛ احتياط: فتح تبويب Gemini داخل تطبيق Google (googleapp://robin شائع في iOS)
    tryIosCustomSchemeThenWeb("googlegemini://", "googleapp://robin", web);
    return;
  }
  openWebTab(web);
}
