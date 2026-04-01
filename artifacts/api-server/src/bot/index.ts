import { Telegraf, Context } from "telegraf";
import { db } from "@workspace/db";
import {
  usersTable,
  companiesTable,
  botSessionsTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

interface SessionData {
  step: string;
  data: Record<string, unknown>;
}

const sessionCache = new Map<number, SessionData>();

async function getSession(telegramId: number): Promise<SessionData | undefined> {
  const cached = sessionCache.get(telegramId);
  if (cached) return cached;

  try {
    const row = await db.query.botSessionsTable.findFirst({
      where: eq(botSessionsTable.telegramId, telegramId),
    });

    if (row) {
      const session: SessionData = {
        step: row.step,
        data: row.data as Record<string, unknown>,
      };
      sessionCache.set(telegramId, session);
      return session;
    }
  } catch (e) {
    logger.error({ error: e }, "Failed to read bot session");
  }

  return undefined;
}

async function setSession(telegramId: number, session: SessionData) {
  sessionCache.set(telegramId, session);

  try {
    await db
      .insert(botSessionsTable)
      .values({
        telegramId,
        step: session.step,
        data: session.data,
      })
      .onConflictDoUpdate({
        target: botSessionsTable.telegramId,
        set: {
          step: session.step,
          data: session.data,
          updatedAt: new Date(),
        },
      });
  } catch (e) {
    logger.error({ error: e }, "Failed to persist bot session");
  }
}

async function clearSession(telegramId: number) {
  sessionCache.delete(telegramId);

  try {
    await db.delete(botSessionsTable).where(eq(botSessionsTable.telegramId, telegramId));
  } catch (e) {
    logger.error({ error: e }, "Failed to clear bot session");
  }
}

async function findUserByTelegramId(telegramId: number) {
  return db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, String(telegramId)),
  });
}

export function createBot(token: string) {
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const existingUser = await findUserByTelegramId(telegramId);
    if (existingUser) {
      await clearSession(telegramId);
      await ctx.reply(
        "Welcome back to Claimbase Community Edition.\n\nYou are already registered.\n\nUse the web portal for receipt management and CSV-based claim workflows.",
      );
      return;
    }

    await setSession(telegramId, {
      step: "register_name",
      data: {},
    });

    await ctx.reply(
      "Welcome to Claimbase Community Edition.\n\nPlease reply with your full name to begin registration.",
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "Claimbase Community Edition",
        "",
        "/start - Register or restart onboarding",
        "/help - Show this help message",
        "",
        "Community edition scope:",
        "- basic Telegram onboarding",
        "- simple self-hosted base",
        "- web portal + CSV workflows",
        "",
        "Advanced AI parsing, richer automations, and expanded claim workflows are part of Claimbase Pro.",
      ].join("\n"),
    );
  });

  bot.on("text", async (ctx: Context) => {
    const telegramId = ctx.from?.id;
    if (!telegramId || !("text" in ctx.message)) return;

    const text = ctx.message.text.trim();
    const session = await getSession(telegramId);
    if (!session) return;

    if (session.step === "register_name") {
      await setSession(telegramId, {
        step: "register_company_name",
        data: { name: text },
      });

      await ctx.reply("Thanks. Now reply with your company name.");
      return;
    }

    if (session.step === "register_company_name") {
      const name = String(session.data["name"] || "").trim();
      const companyName = text;

      if (!name) {
        await clearSession(telegramId);
        await ctx.reply("Session expired. Please send /start again.");
        return;
      }

      try {
        const insertedUsers = await db
          .insert(usersTable)
          .values({
            telegramId: String(telegramId),
            name,
            timezone: "+00:00",
            dashboardCurrency: "USD",
          })
          .returning();

        const user = insertedUsers[0];
        if (!user) {
          throw new Error("Failed to create user");
        }

        await db.insert(companiesTable).values({
          userId: user.id,
          name: companyName,
          baseCurrency: "USD",
          cutoffDay: 1,
          cutoffTime: "00:00",
          cutoffMonthOffset: 1,
        });

        await clearSession(telegramId);

        await ctx.reply(
          [
            "Registration complete.",
            "",
            `Name: ${name}`,
            `Company: ${companyName}`,
            "",
            "Defaults applied in community edition:",
            "- timezone: +00:00",
            "- dashboard currency: USD",
            "- company currency: USD",
            "- cutoff: day 1, 00:00, following month",
            "",
            "You can continue in the web portal and adjust settings there.",
          ].join("\n"),
        );
      } catch (e) {
        logger.error({ error: e }, "Failed to register user in community bot");
        await clearSession(telegramId);
        await ctx.reply("Something went wrong during registration. Please send /start and try again.");
      }
    }
  });

  bot.on("photo", async (ctx) => {
    await ctx.reply(
      [
        "Receipt photo received.",
        "",
        "In Claimbase Community Edition, receipt parsing is manual.",
        "Please use the web portal to enter receipt details and manage claims.",
      ].join("\n"),
    );
  });

  bot.catch((err) => {
    logger.error({ error: err }, "Telegram bot error");
  });

  return bot;
}
