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
  const serviceAccountPath = config.firebaseServiceAccountPath?.trim();
  if (serviceAccountPath) {
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
