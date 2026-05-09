import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  setPersistence,
  type Auth,
} from "firebase/auth";

type FirebaseRuntimeConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  messagingSenderId?: string;
  measurementId?: string;
  useEmulator?: boolean;
};

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
let firebaseGoogleProvider: GoogleAuthProvider | null = null;
let firebaseConfigCache: FirebaseRuntimeConfig | null = null;

function readRequiredEnv(key: string): string {
  const value = String((import.meta.env as Record<string, unknown>)[key] ?? "").trim();
  if (!value) throw new Error(`missing_${key.toLowerCase()}`);
  return value;
}

export function getFirebaseConfig(): FirebaseRuntimeConfig {
  if (firebaseConfigCache) return firebaseConfigCache;
  firebaseConfigCache = {
    apiKey: readRequiredEnv("VITE_FIREBASE_API_KEY"),
    authDomain: readRequiredEnv("VITE_FIREBASE_AUTH_DOMAIN"),
    projectId: readRequiredEnv("VITE_FIREBASE_PROJECT_ID"),
    appId: readRequiredEnv("VITE_FIREBASE_APP_ID"),
    messagingSenderId: String(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "").trim() || undefined,
    measurementId: String(import.meta.env.VITE_FIREBASE_MEASUREMENT_ID ?? "").trim() || undefined,
    useEmulator: String(import.meta.env.VITE_FIREBASE_AUTH_EMULATOR ?? "").trim() === "1",
  };
  return firebaseConfigCache;
}

export async function getFirebaseAuth(): Promise<Auth> {
  if (firebaseAuth) return firebaseAuth;
  const cfg = getFirebaseConfig();
  firebaseApp = getApps().length > 0 ? getApp() : initializeApp(cfg);
  const auth = getAuth(firebaseApp);
  await setPersistence(auth, browserLocalPersistence);
  if (cfg.useEmulator) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  }
  firebaseAuth = auth;
  return auth;
}

export function getGoogleProvider(): GoogleAuthProvider {
  if (firebaseGoogleProvider) return firebaseGoogleProvider;
  const provider = new GoogleAuthProvider();
  firebaseGoogleProvider = provider;
  return provider;
}
