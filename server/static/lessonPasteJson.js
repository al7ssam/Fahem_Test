/**
 * نسخة متصفح مطابقة لمنطق shared/lessonJsonParse.ts — للقوالب غير المجمّعة (لوحة الإدارة).
 * يعتمد على jsonrepair عبر العامّ JSONRepair (انظر /vendor/jsonrepair.min.js).
 */
(function (global) {
  var LESSON_JSON_PARSE_HINT_AR =
    'تعذر تحليل JSON. السبب الشائع: علامات تنصيص مزدوجة (") داخل نصوص مثل studyBody أو prompt دون الهروب — استخدم علامات «» أو أضف \\ قبل كل علامة " داخل النص.';

  function normalizePastedJsonForParse(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    s = s.replace(/^\uFEFF/, "");
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
    s = s.replace(/^\s*```(?:json)?\s*\r?\n?/i, "");
    s = s.replace(/\s*```\s*$/i, "");
    s = s.trim();
    s = s.replace(/\u201C/g, '"').replace(/\u201D/g, '"').replace(/\u201E/g, '"').replace(/\u2033/g, '"');
    return s.trim();
  }

  function extractFirstJsonObject(s) {
    var start = s.indexOf("{");
    if (start < 0) return null;
    var depth = 0;
    var inString = false;
    var escape = false;
    for (var i = start; i < s.length; i++) {
      var c = s[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (c === "\\") {
          escape = true;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return null;
  }

  function stripTrailingCommasOnce(s) {
    return s.replace(/,(\s*[}\]])/g, "$1");
  }

  function parseJsonLenient(s) {
    var cur = s;
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        return JSON.parse(cur);
      } catch (_e) {
        var next = stripTrailingCommasOnce(cur);
        if (next === cur) break;
        cur = next;
      }
    }
    return null;
  }

  function tryRepair(src) {
    try {
      var jr = global.JSONRepair && global.JSONRepair.jsonrepair;
      if (typeof jr !== "function") return null;
      var repaired = jr(src);
      return parseJsonLenient(repaired);
    } catch (_e) {
      return null;
    }
  }

  function parseLessonPastedJson(raw) {
    var normalized = normalizePastedJsonForParse(raw);
    if (!normalized) {
      return { ok: false, detail: "الصق JSON الدرس أولاً." };
    }
    var extracted = extractFirstJsonObject(normalized);
    var candidate = extracted != null ? extracted : normalized;

    var value = parseJsonLenient(candidate);
    if (value != null) return { ok: true, value: value };

    if (extracted != null && extracted !== normalized) {
      value = parseJsonLenient(normalized);
      if (value != null) return { ok: true, value: value };
    }

    value = tryRepair(candidate);
    if (value != null) return { ok: true, value: value };

    if (candidate !== normalized) {
      value = tryRepair(normalized);
      if (value != null) return { ok: true, value: value };
    }

    return { ok: false, detail: LESSON_JSON_PARSE_HINT_AR };
  }

  global.normalizePastedJsonForParse = normalizePastedJsonForParse;
  global.parseLessonPastedJson = parseLessonPastedJson;
})(typeof globalThis !== "undefined" ? globalThis : window);
