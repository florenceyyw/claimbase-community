import { randomInt } from "crypto";
import { logger } from "./logger";

interface OtpEntry {
  code: string;
  telegramId: string;
  expiresAt: number;
  attempts: number;
}

const otpStore = new Map<string, OtpEntry>();

const MAX_ATTEMPTS = 5;
const OTP_EXPIRY_MS = 5 * 60 * 1000;

const rateLimitStore = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 3;

function generateCode(): string {
  return String(randomInt(100000, 1000000));
}

function cleanExpired() {
  const now = Date.now();
  for (const [key, entry] of otpStore) {
    if (now > entry.expiresAt) otpStore.delete(key);
  }
}

function isRateLimited(username: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitStore.get(username) || [];
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  rateLimitStore.set(username, recent);
  return recent.length >= RATE_LIMIT_MAX;
}

function recordRateLimit(username: string) {
  const timestamps = rateLimitStore.get(username) || [];
  timestamps.push(Date.now());
  rateLimitStore.set(username, timestamps);
}

export function createOtp(username: string, telegramId: string): { code: string } | { error: string } {
  cleanExpired();

  if (isRateLimited(username)) {
    return { error: "Too many requests. Please wait a few minutes before trying again." };
  }

  const code = generateCode();
  otpStore.set(username.toLowerCase(), {
    code,
    telegramId,
    expiresAt: Date.now() + OTP_EXPIRY_MS,
    attempts: 0,
  });

  recordRateLimit(username);
  logger.info({ username }, "OTP created");
  return { code };
}

export function verifyOtp(username: string, code: string): { valid: boolean; telegramId?: string; error?: string } {
  cleanExpired();

  const key = username.toLowerCase();
  const entry = otpStore.get(key);

  if (!entry) {
    return { valid: false, error: "No verification code found. Please request a new one." };
  }

  if (Date.now() > entry.expiresAt) {
    otpStore.delete(key);
    return { valid: false, error: "Verification code expired. Please request a new one." };
  }

  if (entry.attempts >= MAX_ATTEMPTS) {
    otpStore.delete(key);
    return { valid: false, error: "Too many incorrect attempts. Please request a new code." };
  }

  entry.attempts++;

  if (entry.code !== code) {
    const remaining = MAX_ATTEMPTS - entry.attempts;
    return { valid: false, error: `Incorrect code. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.` };
  }

  otpStore.delete(key);
  return { valid: true, telegramId: entry.telegramId };
}

export async function sendOtpViaTelegram(telegramId: string, code: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    logger.error("Cannot send OTP: TELEGRAM_BOT_TOKEN not set");
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramId,
        text: `🔐 *Your Claimbase login code:*\n\n` +
          `\`${code}\`\n\n` +
          `This code expires in 5 minutes.\n` +
          `If you didn't request this, please ignore this message.`,
        parse_mode: "Markdown",
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      logger.error({ telegramId, err }, "Failed to send OTP via Telegram");
      return false;
    }

    return true;
  } catch (err) {
    logger.error({ err, telegramId }, "Error sending OTP via Telegram");
    return false;
  }
}
