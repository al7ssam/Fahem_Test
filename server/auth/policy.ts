export type AuthClientType = "web" | "mobile";

export function shouldRequireCsrf(clientType: AuthClientType): boolean {
  return clientType === "web";
}
