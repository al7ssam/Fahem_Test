/**
 * Official model discovery for the Gemini Developer API (Google AI Studio key).
 *
 * The npm package `@google/generative-ai` (v0.24.x) does not expose a public
 * `listModels()` on `GoogleGenerativeAI`. This script calls the same REST endpoint
 * the API documents: ListModels on Generative Language API.
 *
 * @see https://ai.google.dev/api/rest/v1beta/models/list
 *
 * Usage: GEMINI_API_KEY=... npm run list-gemini-models
 */
import "dotenv/config";

const BASE = "https://generativelanguage.googleapis.com";

type ListModelsResponse = {
  models?: Array<{
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
  }>;
  nextPageToken?: string;
};

async function fetchAllModels(apiKey: string, apiVersion: "v1" | "v1beta"): Promise<ListModelsResponse["models"]> {
  const out: NonNullable<ListModelsResponse["models"]> = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(`${BASE}/${apiVersion}/models`);
    u.searchParams.set("key", apiKey);
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await fetch(u.toString());
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`ListModels ${apiVersion} HTTP ${res.status}: ${t.slice(0, 400)}`);
    }
    const body = (await res.json()) as ListModelsResponse;
    if (body.models?.length) out.push(...body.models);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out;
}

function shortName(fullName: string): string {
  return fullName.startsWith("models/") ? fullName.slice("models/".length) : fullName;
}

async function main(): Promise<void> {
  const apiKey = String(process.env.GEMINI_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("Missing GEMINI_API_KEY. Set it in the environment, then run: npm run list-gemini-models");
    process.exit(1);
  }

  for (const ver of ["v1beta", "v1"] as const) {
    console.log(`\n========== ListModels (${ver}) ==========\n`);
    const models = await fetchAllModels(apiKey, ver);
    const withGenerate = (models ?? []).filter((m) =>
      (m.supportedGenerationMethods ?? []).includes("generateContent"),
    );
    console.log(`Total models: ${models?.length ?? 0} | with generateContent: ${withGenerate.length}\n`);
    for (const m of withGenerate) {
      const name = m.name ?? "";
      console.log(`${shortName(name)}  <--  model.name: ${name}`);
    }
  }

  console.log("\nDone.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
