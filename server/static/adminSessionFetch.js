/**
 * طلبات fetch لصفحات الإدارة HTML: إعادة تحديث الجلسة عند 401 ثم إعادة المحاولة مرة واحدة
 * (مطابقة تقريبية لـ client/src/auth/apiClient.ts للاعتماد على الكوكيات).
 */
(function (global) {
  var refreshPromise = null;

  function readCookie(name) {
    try {
      var target = name + "=";
      var parts = document.cookie.split(";").map(function (x) {
        return x.trim();
      });
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p.indexOf(target) !== 0) continue;
        var raw = p.slice(target.length);
        try {
          return /%[0-9A-Fa-f]{2}/.test(raw) ? decodeURIComponent(raw) : raw;
        } catch (e) {
          return raw;
        }
      }
      return "";
    } catch (e) {
      return "";
    }
  }

  function mergeHeaders(raw) {
    var out = new Headers();
    if (!raw) return out;
    if (typeof Headers !== "undefined" && raw instanceof Headers) {
      raw.forEach(function (v, k) {
        out.set(k, v);
      });
      return out;
    }
    if (Array.isArray(raw)) {
      for (var j = 0; j < raw.length; j++) {
        var pair = raw[j];
        if (pair && pair.length >= 2) out.set(String(pair[0]), String(pair[1]));
      }
      return out;
    }
    Object.keys(raw).forEach(function (k) {
      if (raw[k] != null) out.set(k, String(raw[k]));
    });
    return out;
  }

  function tryRefreshTokens() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (function () {
      var csrfToken = readCookie("fahem_csrf_token");
      var h = { "Content-Type": "application/json" };
      if (csrfToken) h["X-CSRF-Token"] = csrfToken;
      return fetch("/api/auth/refresh", {
        method: "POST",
        headers: h,
        credentials: "same-origin",
        body: JSON.stringify({}),
      })
        .then(function (r) {
          if (!r.ok) return false;
          return r.json().then(function (body) {
            if (!body || !body.accessToken || !body.refreshToken) return false;
            try {
              localStorage.setItem("fahem_auth_access_token", body.accessToken);
              localStorage.setItem("fahem_auth_refresh_token", body.refreshToken);
            } catch (e) {
              /* الكوكيات تُحدَّث من الخادم حتى عند فشل التخزين المحلي */
            }
            try {
              global.dispatchEvent(new CustomEvent("fahem:auth-tokens-refreshed"));
            } catch (e) {}
            return true;
          });
        })
        .catch(function () {
          return false;
        })
        .finally(function () {
          refreshPromise = null;
        });
    })();
    return refreshPromise;
  }

  function fahemAdminFetch(input, init) {
    init = init || {};
    var method = String(init.method || "GET").toUpperCase();
    var headers = mergeHeaders(init.headers);
    if (method !== "GET" && method !== "HEAD") {
      var csrf = readCookie("fahem_csrf_token");
      if (csrf) headers.set("X-CSRF-Token", csrf);
    }
    var firstInit = Object.assign({}, init, {
      headers: headers,
      credentials: init.credentials || "same-origin",
    });
    return fetch(input, firstInit).then(function (res) {
      if (res.status !== 401) return res;
      return tryRefreshTokens().then(function (ok) {
        if (!ok) return res;
        var retryHeaders = mergeHeaders(init.headers);
        if (method !== "GET" && method !== "HEAD") {
          var csrf2 = readCookie("fahem_csrf_token");
          if (csrf2) retryHeaders.set("X-CSRF-Token", csrf2);
        }
        try {
          var at = localStorage.getItem("fahem_auth_access_token");
          if (at && String(at).trim()) retryHeaders.set("Authorization", "Bearer " + String(at).trim());
        } catch (e) {}
        var retryInit = Object.assign({}, init, {
          headers: retryHeaders,
          credentials: init.credentials || "same-origin",
        });
        return fetch(input, retryInit);
      });
    });
  }

  global.fahemAdminFetch = fahemAdminFetch;
})(typeof window !== "undefined" ? window : globalThis);
