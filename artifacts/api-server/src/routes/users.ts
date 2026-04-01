import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, requireInternalAuth, verifyUserOwnership } from "../lib/authMiddleware";
import { validateTelegramInitData, validateTelegramLoginWidget } from "../lib/telegramAuth";
import { createSessionToken } from "../lib/session";
import { createOtp, verifyOtp, sendOtpViaTelegram } from "../lib/otp";

const router: IRouter = Router();

router.get("/auth/me", requireAuth, async (req, res) => {
  res.json(req.authUser);
});

router.post("/auth/telegram-login", async (req, res) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    res.status(500).json({ error: "Bot token not configured" });
    return;
  }

  const widgetData = req.body as Record<string, string>;
  if (!widgetData || !widgetData.hash || !widgetData.id) {
    res.status(400).json({ error: "Invalid login data" });
    return;
  }

  const result = validateTelegramLoginWidget(widgetData, botToken);
  if (!result.valid || !result.telegramId) {
    res.status(401).json({ error: "Invalid Telegram login" });
    return;
  }

  let user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, result.telegramId),
  });

  if (!user) {
    const [newUser] = await db.insert(usersTable).values({
      telegramId: result.telegramId,
      name: result.firstName || "User",
      timezone: "+00:00",
    }).returning();
    user = newUser;
  }

  const token = createSessionToken(result.telegramId);
  res.json({ token, user });
});

router.post("/auth/webapp-login", async (req, res) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    res.status(500).json({ error: "Bot token not configured" });
    return;
  }

  const { initData } = req.body as { initData?: string };
  if (!initData) {
    res.status(400).json({ error: "initData is required" });
    return;
  }

  const result = validateTelegramInitData(initData, botToken);
  if (!result.valid || !result.telegramId) {
    res.status(401).json({ error: "Invalid Telegram init data" });
    return;
  }

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, result.telegramId),
  });

  if (!user) {
    res.status(401).json({ error: "User not found. Please register via @claimbase_bot first." });
    return;
  }

  const token = createSessionToken(result.telegramId);
  res.json({ token, user });
});

router.post("/auth/request-otp", async (req, res) => {
  const { telegramUsername } = req.body as { telegramUsername?: string };
  if (!telegramUsername) {
    res.status(400).json({ error: "Telegram username is required" });
    return;
  }

  const input = telegramUsername.trim().replace(/^@/, "").toLowerCase();
  if (!input) {
    res.status(400).json({ error: "Telegram username is required" });
    return;
  }

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramUsername, input),
  });

  if (!user) {
    res.status(404).json({
      error: "No account found. Please start @claimbase_bot on Telegram first to register."
    });
    return;
  }

  const result = createOtp(input, user.telegramId);
  if ("error" in result) {
    res.status(429).json({ error: result.error });
    return;
  }

  const sent = await sendOtpViaTelegram(user.telegramId, result.code);
  if (!sent) {
    res.status(500).json({
      error: "Could not send verification code. Make sure you have started a chat with @claimbase_bot on Telegram."
    });
    return;
  }

  res.json({ success: true, message: "Verification code sent to your Telegram." });
});

router.post("/auth/verify-otp", async (req, res) => {
  const { telegramUsername, code } = req.body as { telegramUsername?: string; code?: string };
  if (!telegramUsername || !code) {
    res.status(400).json({ error: "Username and code are required" });
    return;
  }

  const input = telegramUsername.trim().replace(/^@/, "").toLowerCase();
  const result = verifyOtp(input, code.trim());

  if (!result.valid) {
    res.status(401).json({ error: result.error });
    return;
  }

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, result.telegramId!),
  });

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const token = createSessionToken(user.telegramId);
  res.json({ token, user });
});

router.post("/auth/register", async (req, res) => {
  const initData = req.headers["x-telegram-init-data"] as string | undefined;
  if (!initData) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  let telegramId: string | null = null;
  let firstName = "User";

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    const result = validateTelegramInitData(initData, botToken);
    if (result.valid && result.telegramId) {
      telegramId = result.telegramId;
      const params = new URLSearchParams(initData);
      const userStr = params.get("user");
      if (userStr) {
        try { firstName = JSON.parse(userStr).first_name || firstName; } catch {}
      }
    }
  }

  if (!telegramId && process.env.NODE_ENV === "development") {
    const params = new URLSearchParams(initData);
    if (params.get("hash") === "mock") {
      const userStr = params.get("user");
      if (userStr) {
        try {
          const user = JSON.parse(userStr);
          if (user.id) {
            telegramId = String(user.id);
            firstName = user.first_name || firstName;
          }
        } catch {}
      }
    }
  }

  if (!telegramId) {
    res.status(401).json({ error: "Invalid authentication data" });
    return;
  }

  const existing = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (existing) {
    res.json(existing);
    return;
  }

  const name = req.body?.name || firstName;
  const [user] = await db.insert(usersTable).values({
    telegramId,
    name,
    timezone: req.body?.timezone || "+00:00",
  }).returning();
  res.status(201).json(user);
});

router.get("/users/telegram/:telegramId", requireInternalAuth, async (req, res) => {
  const telegramId = String(req.params.telegramId);
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json(user);
});

router.post("/users", requireInternalAuth, async (req, res) => {
  const { telegramId, name, timezone } = req.body;
  if (!telegramId || !name) {
    res.status(400).json({ error: "telegramId and name are required" });
    return;
  }
  const existing = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (existing) {
    res.json(existing);
    return;
  }
  const [user] = await db.insert(usersTable).values({
    telegramId,
    name,
    timezone: timezone || "+00:00",
  }).returning();
  res.status(201).json(user);
});

router.get("/users/:userId", requireAuth, verifyUserOwnership, async (req, res) => {
  const userId = parseInt(String(req.params.userId), 10);
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, userId),
  });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json(user);
});

router.put("/users/:userId", requireAuth, verifyUserOwnership, async (req, res) => {
  const userId = parseInt(String(req.params.userId), 10);
  const updates: Record<string, unknown> = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.timezone !== undefined) updates.timezone = req.body.timezone;
  if (req.body.dashboardCurrency !== undefined) updates.dashboardCurrency = req.body.dashboardCurrency;
  updates.updatedAt = new Date();

  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, userId))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json(updated);
});

export default router;
