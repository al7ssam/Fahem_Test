export type SupportedAuthProvider = "firebase";

export type ExternalIdentity = {
  provider: SupportedAuthProvider;
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  pictureUrl: string | null;
  rawProfile: Record<string, unknown>;
};

export type AuthenticatedUser = {
  userId: string;
  sessionId: string;
  roles: string[];
};

export type AccessTokenPayload = {
  sub: string;
  sid: string;
  typ: "access";
  roles: string[];
};

export type RefreshTokenPayload = {
  sub: string;
  sid: string;
  typ: "refresh";
};
