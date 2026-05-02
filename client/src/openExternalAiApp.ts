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
 * أندرويد (كروم): intent:// مع package و S.browser_fallback_url — يفتح التطبيق إن وُجد وإلا الرابط في المتصفح.
 * @see https://developer.chrome.com/docs/android/intents
 */
function openAndroidIntentHttps(intentHostAndPath: string, packageName: string, fallbackHttps: string): void {
  const fallback = encodeURIComponent(fallbackHttps);
  window.location.href =
    `intent://${intentHostAndPath}#Intent;scheme=https;package=${packageName};S.browser_fallback_url=${fallback};end`;
}

/**
 * آي أو إس: محاولة مخطط التطبيق عبر iframe خفي؛ إن بقي الصفحة ظاهراً نفتح الويب في تاب جديد.
 * لا ضمان 100٪ — يعتمد على النظام والتطبيق.
 */
function tryIosAppSchemeThenWeb(appScheme: string, webUrl: string): void {
  let settled = false;
  const settle = (openedWeb: boolean): void => {
    if (settled) return;
    settled = true;
    if (openedWeb) openWebTab(webUrl);
  };

  const onVis = (): void => {
    if (document.visibilityState === "hidden") settle(false);
  };
  const onPageHide = (): void => settle(false);

  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("pagehide", onPageHide, { once: true });

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;border:0;opacity:0;";
  iframe.src = appScheme;
  document.body.appendChild(iframe);

  window.setTimeout(() => {
    document.removeEventListener("visibilitychange", onVis);
    iframe.remove();
    if (document.visibilityState === "visible") settle(true);
  }, 750);
}

export function openChatGptExternal(): void {
  const web = "https://chatgpt.com/";
  if (isAndroidUa()) {
    openAndroidIntentHttps("chatgpt.com", "com.openai.chatgpt", web);
    return;
  }
  if (isIosLike()) {
    tryIosAppSchemeThenWeb("com.openai.chat://", web);
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
    tryIosAppSchemeThenWeb("googlegemini://", web);
    return;
  }
  openWebTab(web);
}
