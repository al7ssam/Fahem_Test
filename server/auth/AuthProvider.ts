import type { ExternalIdentity } from "./types";

export interface AuthProvider {
  readonly name: string;
  verifyExternalToken(token: string): Promise<ExternalIdentity>;
}
