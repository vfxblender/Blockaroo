export interface TesterSessionTokens {
  access_token: string;
  refresh_token: string;
}

export function normalizeAccountEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isTesterAccountEmail(value: string): boolean {
  const normalized = normalizeAccountEmail(value);
  const separator = normalized.lastIndexOf("@");
  return separator > 0
    && normalized.indexOf("@") === separator
    && normalized.slice(separator + 1) === "blockaroo.test";
}

export function parseTesterSession(value: unknown): TesterSessionTokens | null {
  if (!isRecord(value) || value.tester !== true || !isRecord(value.session)) return null;
  const accessToken = value.session.access_token;
  const refreshToken = value.session.refresh_token;
  if (typeof accessToken !== "string" || !accessToken) return null;
  if (typeof refreshToken !== "string" || !refreshToken) return null;
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
