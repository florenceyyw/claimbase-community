import jwt from "jsonwebtoken";

function getJwtSecret(): string {
  const secret = process.env.INTERNAL_API_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "development") return "sera-dev-session-secret";
  throw new Error("INTERNAL_API_SECRET must be set in production");
}

const JWT_SECRET = getJwtSecret();
const SESSION_EXPIRY = "7d";

interface SessionPayload {
  telegramId: string;
}

export function createSessionToken(telegramId: string): string {
  return jwt.sign({ telegramId } as SessionPayload, JWT_SECRET, { expiresIn: SESSION_EXPIRY });
}

export function verifySessionToken(token: string): SessionPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as SessionPayload;
    if (payload.telegramId) return payload;
    return null;
  } catch {
    return null;
  }
}
