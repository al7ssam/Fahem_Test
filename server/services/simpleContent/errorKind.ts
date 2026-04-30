/**
 * تصنيف أخطاء مسار المحتوى البسيط للواجهة والـ API (تمييز إعدادات/برومبت مقابل المزود أو جودة المخرجات).
 */
export type SimpleContentErrorKind = "prompt_config" | "model_output" | "provider_or_network" | "unknown";

export function classifySimpleContentError(message: string | null | undefined): SimpleContentErrorKind {
  if (message == null || !String(message).trim()) return "unknown";
  const s = String(message);

  if (
    s === "simple_content_prompt_empty" ||
    s === "simple_content_invalid_preset" ||
    s === "simple_content_no_active_preset" ||
    s === "simple_content_commit_invalid" ||
    s === "simple_content_commit_empty"
  ) {
    return "prompt_config";
  }

  if (
    s.startsWith("simple_content_validation_errors:") ||
    s === "simple_content_no_valid_questions" ||
    s.includes("invalid_json_output") ||
    s.includes("layer_output_truncated_max_tokens")
  ) {
    return "model_output";
  }

  const lower = s.toLowerCase();
  if (
    lower.includes("econn") ||
    lower.includes("etimedout") ||
    lower.includes("socket") ||
    lower.includes("network") ||
    lower.includes("429") ||
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("fetch") ||
    lower.includes("api key") ||
    lower.includes("api_key") ||
    lower.includes("permission denied") ||
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("generativelanguage") ||
    lower.includes("google")
  ) {
    return "provider_or_network";
  }

  return "unknown";
}

export function simpleContentErrorKindHintAr(kind: SimpleContentErrorKind): string {
  switch (kind) {
    case "prompt_config":
      return "إجراء مقترح: راجع البرومبت المحفوظ، النموذج المفعّل، أو مسار التعميد (معاينة يدوية).";
    case "model_output":
      return "إجراء مقترح: عدّل الصعوبة أو حجم الدفعة أو صياغة المخرجات في البرومبت؛ قد تكون المشكلة في شكل JSON وليس في الاتصال.";
    case "provider_or_network":
      return "إجراء مقترح: تحقق من مفتاح المزود والحصة والاتصال؛ أعد المحاولة لاحقًا إن كان الخطأ من الخدمة.";
    default:
      return "راجع الرسالة التقنية أو سجلات الخادم للتفاصيل.";
  }
}
