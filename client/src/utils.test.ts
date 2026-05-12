/**
 * اختبارات الدوال المساعدة — لا تحتاج DOM حقيقي.
 * للتشغيل: npx vitest run
 */
import { describe, expect, it } from "vitest";
import { escapeHtml } from "./utils";

describe("escapeHtml", () => {
  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("returns plain text unchanged", () => {
    expect(escapeHtml("مرحباً")).toBe("مرحباً");
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("escapes all special characters combined", () => {
    expect(escapeHtml('<a href="x & y">')).toBe(
      "&lt;a href=&quot;x &amp; y&quot;&gt;",
    );
  });
});
