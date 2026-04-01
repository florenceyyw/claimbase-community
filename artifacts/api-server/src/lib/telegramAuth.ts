import { createHmac, createHash, timingSafeEqual } from "crypto";

const MAX_AUTH_AGE_SECONDS = 86400;

export function validateTelegramLoginWidget(
  data: Record<string, string>,
  botToken: string
): { valid: boolean; telegramId?: string; firstName?: string } {
  try {
    const { hash, ...rest } = data;
    if (!hash) return { valid: false };

    const authDate = parseInt(rest.auth_date, 10);
    if (!authDate) return { valid: false };
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > MAX_AUTH_AGE_SECONDS) return { valid: false };

    const checkString = Object.keys(rest)
      .sort()
      .map((key) => `${key}=${rest[key]}`)
      .join("\n");

    const secretKey = createHash("sha256").update(botToken).digest();
    const computedHash = createHmac("sha256", secretKey)
      .update(checkString)
      .digest("hex");

    const hashBuffer = Buffer.from(hash, "hex");
    const computedBuffer = Buffer.from(computedHash, "hex");
    if (hashBuffer.length !== computedBuffer.length || !timingSafeEqual(hashBuffer, computedBuffer)) {
      return { valid: false };
    }

    return { valid: true, telegramId: rest.id, firstName: rest.first_name };
  } catch {
    return { valid: false };
  }
}

export function validateTelegramInitData(initData: string, botToken: string): { valid: boolean; telegramId?: string } {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { valid: false };

    const authDateStr = params.get("auth_date");
    if (!authDateStr) return { valid: false };

    const authDate = parseInt(authDateStr, 10);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > MAX_AUTH_AGE_SECONDS) return { valid: false };

    params.delete("hash");
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
    const computedHash = createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    const hashBuffer = Buffer.from(hash, "hex");
    const computedBuffer = Buffer.from(computedHash, "hex");
    if (hashBuffer.length !== computedBuffer.length || !timingSafeEqual(hashBuffer, computedBuffer)) {
      return { valid: false };
    }

    const userParam = params.get("user");
    if (!userParam) return { valid: false };

    const user = JSON.parse(userParam);
    return { valid: true, telegramId: String(user.id) };
  } catch {
    return { valid: false };
  }
}
