const cache = new Map<string, string>();

/** من `client/src/profile` إلى `node_modules` في جذر المشروع (وليس `client/src/node_modules`). */
const loaders = import.meta.glob(
  "../../../node_modules/country-flag-icons/string/3x2/*.js",
) as Record<string, () => Promise<{ default: string }>>;

function loaderKeyForCountryCode(code: string): string | undefined {
  const suffix = `/string/3x2/${code}.js`;
  const keys = Object.keys(loaders);
  return keys.find((k) => k.replace(/\\/g, "/").endsWith(suffix));
}

/** SVG كسلسلة من الحزمة المحلية (بدون طلبات شبكة). */
export async function getFlagSvgInnerHtml(alpha2: string): Promise<string> {
  const code = alpha2.trim().toUpperCase();
  const hit = cache.get(code);
  if (hit !== undefined) return hit;

  const path = loaderKeyForCountryCode(code);
  const load = path ? loaders[path] : undefined;
  if (!load) {
    cache.set(code, "");
    return "";
  }
  try {
    const mod = await load();
    const svg = mod.default ?? "";
    cache.set(code, svg);
    return svg;
  } catch {
    cache.set(code, "");
    return "";
  }
}
