const cache = new Map<string, string>();

const loaders = import.meta.glob(
  "../node_modules/country-flag-icons/string/3x2/*.js",
) as Record<string, () => Promise<{ default: string }>>;

/** SVG كسلسلة من الحزمة المحلية (بدون طلبات شبكة). */
export async function getFlagSvgInnerHtml(alpha2: string): Promise<string> {
  const code = alpha2.trim().toUpperCase();
  const hit = cache.get(code);
  if (hit !== undefined) return hit;

  const suffix = `${code}.js`;
  const path = Object.keys(loaders).find((k) => k.endsWith(suffix));
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
