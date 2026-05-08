import fs from "fs";
import path from "path";
import { cert, getApps, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { config } from "../config";

function readServiceAccountFromFile(filePath: string): ServiceAccount {
  const full = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(full, "utf8");
  return JSON.parse(raw) as ServiceAccount;
}

function resolveFirebaseInitOptions(): { credential?: ReturnType<typeof cert>; projectId?: string } {
  const hasEnvServiceAccount =
    Boolean(config.firebaseProjectId) &&
    Boolean(config.firebaseClientEmail) &&
    Boolean(config.firebasePrivateKey);
  if (hasEnvServiceAccount) {
    const serviceAccount: ServiceAccount = {
      projectId: config.firebaseProjectId,
      clientEmail: config.firebaseClientEmail,
      privateKey: config.firebasePrivateKey,
    };
    return {
      credential: cert(serviceAccount),
      projectId: config.firebaseProjectId,
    };
  }

  if (config.isProduction) {
    const missing: string[] = [];
    if (!config.firebaseProjectId) missing.push("FIREBASE_PROJECT_ID");
    if (!config.firebaseClientEmail) missing.push("FIREBASE_CLIENT_EMAIL");
    if (!config.firebasePrivateKey) missing.push("FIREBASE_PRIVATE_KEY");
    if (missing.length > 0) {
      throw new Error(`Firebase Admin env credentials are required in production. Missing: ${missing.join(", ")}`);
    }
  }

  const serviceAccountPath = config.firebaseServiceAccountPath?.trim();
  if (serviceAccountPath && !config.isProduction) {
    const serviceAccount = readServiceAccountFromFile(serviceAccountPath);
    return {
      credential: cert(serviceAccount),
      projectId: (serviceAccount.projectId ?? (serviceAccount as { project_id?: string }).project_id ?? "").trim() || undefined,
    };
  }
  if (config.firebaseProjectId) {
    return { projectId: config.firebaseProjectId };
  }
  return {};
}

export function getFirebaseAdminAuth() {
  if (getApps().length === 0) {
    const initOptions = resolveFirebaseInitOptions();
    initializeApp(initOptions);
  }
  return getAuth();
}
