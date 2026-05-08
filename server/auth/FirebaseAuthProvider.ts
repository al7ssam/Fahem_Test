import type { AuthProvider } from "./AuthProvider";
import type { ExternalIdentity } from "./types";
import { getFirebaseAdminAuth } from "./firebaseAdmin";

export class FirebaseAuthProvider implements AuthProvider {
  public readonly name = "firebase";

  async verifyExternalToken(token: string): Promise<ExternalIdentity> {
    const auth = getFirebaseAdminAuth();
    const decoded = await auth.verifyIdToken(token, true);
    return {
      provider: "firebase",
      providerUserId: decoded.uid,
      email: typeof decoded.email === "string" ? decoded.email : null,
      emailVerified: decoded.email_verified === true,
      displayName: typeof decoded.name === "string" ? decoded.name : null,
      pictureUrl: typeof decoded.picture === "string" ? decoded.picture : null,
      rawProfile: decoded as unknown as Record<string, unknown>,
    };
  }
}
