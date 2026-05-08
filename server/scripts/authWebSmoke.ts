const baseUrl = String(process.env.AUTH_SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");

async function expectStatus(path: string, init: RequestInit | undefined, expected: number): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (response.status !== expected) {
    const text = await response.text().catch(() => "");
    throw new Error(`Unexpected status for ${path}: ${response.status} (expected ${expected}) body=${text.slice(0, 180)}`);
  }
}

async function main(): Promise<void> {
  await expectStatus("/health", undefined, 200);
  await expectStatus("/api/auth/me", undefined, 401);
  await expectStatus("/admin", undefined, 401);
  await expectStatus("/api/admin/question-count", undefined, 401);
  await expectStatus(
    "/api/auth/refresh",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
    401,
  );
  await expectStatus(
    "/api/auth/logout",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
    401,
  );
  console.log("[auth:web-smoke] OK");
}

void main().catch((error) => {
  console.error("[auth:web-smoke] FAILED");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
