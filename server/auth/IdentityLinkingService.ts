import type { ExternalIdentity } from "./types";
import { resolveOrCreateInternalUser } from "./repository";

/**
 * Centralized account-linking policy:
 * - Provider identity is authoritative for provider_user_id uniqueness.
 * - Email-based linking is allowed only for verified provider emails.
 */
export class IdentityLinkingService {
  async resolveUser(identity: ExternalIdentity): Promise<{ userId: string }> {
    if (identity.email && !identity.emailVerified) {
      // Keep unverified emails as profile data only; no email-based link trust.
      return resolveOrCreateInternalUser({
        ...identity,
        email: null,
      });
    }
    return resolveOrCreateInternalUser(identity);
  }
}

export const identityLinkingService = new IdentityLinkingService();
