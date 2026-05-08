import jwt from "jsonwebtoken";

async function main(): Promise<void> {
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || "local-dev-auth-secret";
  const { verifyAccessToken } = await import("../auth/token");
  const refresh = jwt.sign(
    {
      sub: "11111111-1111-1111-1111-111111111111",
      sid: "22222222-2222-2222-2222-222222222222",
      typ: "refresh",
    },
    process.env.AUTH_JWT_SECRET,
    {
      algorithm: "HS256",
      expiresIn: 3600,
      issuer: "fahem-auth",
      audience: "fahem-api",
    },
  );

  let threw = false;
  try {
    verifyAccessToken(refresh);
  } catch {
    threw = true;
  }

  if (!threw) {
    throw new Error("verifyAccessToken accepted refresh token");
  }

  console.log("[auth:token-type-smoke] OK");
}

void main();
