import { Telegraf, Markup, Context } from "telegraf";
import { db } from "@workspace/db";
import {
  usersTable,
  companiesTable,
  categoriesTable,
  receiptsTable,
  claimPeriodsTable,
  botSessionsTable,
  bulkQueuesTable,
} from "@workspace/db/schema";
import { eq, and, or, gte, lte, sql, isNull } from "drizzle-orm";
import { parseReceiptImage, parseReceiptImageMulti, parseReceiptPdf, parseReceiptPdfMulti, type ParsedReceipt } from "../lib/ai";
import { getExchangeRate } from "../lib/currency";
import { generatePDF, generateExcel } from "../lib/claimGenerator";
import { logger } from "../lib/logger";
import { uploadFromUrlToStorage, uploadBufferToStorage } from "../lib/storageUpload";

function getWebAppUrl(): string | null {
  const domains = process.env["REPLIT_DOMAINS"];
  if (domains) {
    const domainList = domains.split(",").map(d => d.trim()).filter(Boolean);
    const prodDomain = domainList.find(d => d.endsWith(".replit.app")) || domainList[0];
    if (prodDomain) return `https://${prodDomain}`;
  }
  const devDomain = process.env["REPLIT_DEV_DOMAIN"];
  if (devDomain) return `https://${devDomain}`;
  return null;
}

interface SessionData {
  step: string;
  data: Record<string, unknown>;
}

const sessionCache = new Map<number, SessionData>();

interface PendingReceiptData {
  parsedItems: ParsedReceipt[];
  imageUrl: string;
  userId: number;
  createdAt: number;
  userCaption?: string;
}

const pendingReceipts = new Map<string, PendingReceiptData>();
const pendingBulkReceipts = new Map<string, Array<{ imageUrl: string; parsed: ParsedReceipt }>>();

interface BulkReceiptQueue {
  dbUserId: number;
  telegramId: number;
  items: Array<{ imageUrl: string; parsed: ParsedReceipt }>;
  currentIndex: number;
  savedCount: number;
  transferCount: number;
}

function makeBulkQueueId(telegramId: number): string {
  return `bq_${telegramId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

async function saveBulkQueue(queueId: string, queue: BulkReceiptQueue): Promise<void> {
  try {
    await db
      .insert(bulkQueuesTable)
      .values({
        id: queueId,
        telegramId: queue.telegramId,
        dbUserId: queue.dbUserId,
        items: queue.items,
        currentIndex: queue.currentIndex,
        savedCount: queue.savedCount,
        transferCount: queue.transferCount,
      })
      .onConflictDoUpdate({
        target: bulkQueuesTable.id,
        set: {
          items: queue.items,
          currentIndex: queue.currentIndex,
          savedCount: queue.savedCount,
          transferCount: queue.transferCount,
        },
      });
  } catch (e) {
    logger.error({ error: e }, "Failed to persist bulk queue");
  }
}

async function loadBulkQueue(queueId: string): Promise<BulkReceiptQueue | null> {
  try {
    const row = await db.query.bulkQueuesTable.findFirst({
      where: eq(bulkQueuesTable.id, queueId),
    });
    if (!row) return null;
    const createdMs = row.createdAt.getTime();
    if (Date.now() - createdMs > 60 * 60 * 1000) {
      await db.delete(bulkQueuesTable).where(eq(bulkQueuesTable.id, queueId));
      return null;
    }
    return {
      dbUserId: row.dbUserId,
      telegramId: row.telegramId,
      items: row.items as BulkReceiptQueue["items"],
      currentIndex: row.currentIndex,
      savedCount: row.savedCount,
      transferCount: row.transferCount,
    };
  } catch (e) {
    logger.error({ error: e }, "Failed to load bulk queue");
    return null;
  }
}

async function deleteBulkQueue(queueId: string): Promise<void> {
  try {
    await db.delete(bulkQueuesTable).where(eq(bulkQueuesTable.id, queueId));
  } catch (e) {
    logger.error({ error: e }, "Failed to delete bulk queue");
  }
}

async function showNextBulkReceiptPrompt(
  ctx: Context,
  queueId: string,
  companies: Array<{ id: number; name: string }>,
  editExisting?: boolean,
) {
  const queue = await loadBulkQueue(queueId);
  if (!queue) return;

  if (queue.currentIndex >= queue.items.length) {
    await deleteBulkQueue(queueId);
    const webAppUrl = getWebAppUrl();
    let resultMsg = `✅ *${queue.savedCount} of ${queue.items.length} receipts saved!*`;
    if (queue.transferCount > 0) {
      resultMsg += `\n⚠️ ${queue.transferCount} bank transfer(s) may need category assignment.`;
    }
    const buttons: any[][] = [];
    if (webAppUrl) {
      buttons.push([Markup.button.url("Review in Portal", webAppUrl)]);
    }
    if (editExisting) {
      await ctx.editMessageText(resultMsg, {
        parse_mode: "Markdown",
        ...(buttons.length > 0 ? Markup.inlineKeyboard(buttons) : {}),
      });
    } else {
      await ctx.reply(resultMsg, {
        parse_mode: "Markdown",
        ...(buttons.length > 0 ? Markup.inlineKeyboard(buttons) : {}),
      });
    }
    return;
  }

  const item = queue.items[queue.currentIndex]!;
  const desc = item.parsed.description || "Expense receipt";
  const amt = item.parsed.amount ? `${item.parsed.currency || "?"} ${item.parsed.amount}` : "Amount unclear";
  const dateStr = item.parsed.date ? ` | ${item.parsed.date}` : "";

  const msg = `📝 *Receipt ${queue.currentIndex + 1} of ${queue.items.length}:*\n` +
    `${desc} — ${amt}${dateStr}\n\n` +
    `Which company?`;

  const companyButtons = companies.map((c) => [
    Markup.button.callback(c.name, `bqco_${queueId}_${c.id}`),
  ]);

  if (editExisting) {
    await ctx.editMessageText(msg, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(companyButtons),
    });
  } else {
    await ctx.reply(msg, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(companyButtons),
    });
  }
}

function addPendingReceipt(telegramId: number, data: PendingReceiptData): string {
  const pendingId = `${telegramId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  pendingReceipts.set(pendingId, data);
  setTimeout(() => pendingReceipts.delete(pendingId), 30 * 60 * 1000);
  return pendingId;
}

interface PendingPhoto {
  fileId: string;
  telegramImageUrl: string;
}

const mediaGroupBuffer = new Map<string, {
  userId: number;
  dbUserId: number;
  photos: PendingPhoto[];
  timer: ReturnType<typeof setTimeout>;
}>();

async function getSession(telegramId: number): Promise<SessionData | undefined> {
  const cached = sessionCache.get(telegramId);
  if (cached) return cached;
  try {
    const row = await db.query.botSessionsTable.findFirst({
      where: eq(botSessionsTable.telegramId, telegramId),
    });
    if (row) {
      const session: SessionData = { step: row.step, data: row.data as Record<string, unknown> };
      sessionCache.set(telegramId, session);
      return session;
    }
  } catch (e) {
    logger.error({ error: e }, "Failed to read bot session from DB");
  }
  return undefined;
}

async function setSession(telegramId: number, session: SessionData) {
  sessionCache.set(telegramId, session);
  try {
    await db
      .insert(botSessionsTable)
      .values({ telegramId, step: session.step, data: session.data, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: botSessionsTable.telegramId,
        set: { step: session.step, data: session.data, updatedAt: new Date() },
      });
  } catch (e) {
    logger.error({ error: e }, "Failed to persist bot session to DB");
  }
}

async function clearSession(telegramId: number) {
  sessionCache.delete(telegramId);
  try {
    await db.delete(botSessionsTable).where(eq(botSessionsTable.telegramId, telegramId));
  } catch (e) {
    logger.error({ error: e }, "Failed to clear bot session from DB");
  }
}

function formatCutoffText(day: number, time: string, monthOffset: number = 1): string {
  const monthLabel = monthOffset === 0 ? "the same month" : "the following month";
  if (day === 31) return `Last day of ${monthLabel} at ${time}`;
  return `Day ${day} of ${monthLabel} at ${time}`;
}

export function createBot(): Telegraf {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const bot = new Telegraf(token, {
    telegram: {
      apiRoot: "https://api.telegram.org",
      agent: undefined,
      webhookReply: false,
    },
  });

  bot.catch((err, ctx) => {
    logger.error({ err, updateType: ctx.updateType }, "Unhandled bot error");
    if (ctx.updateType === "callback_query") {
      ctx.answerCbQuery("Something went wrong. Please try sending the receipt again.").catch(() => {});
    } else {
      ctx.reply("An error occurred. Please try again or use /cancel to reset.").catch(() => {});
    }
  });

  bot.command("start", async (ctx) => {
    const telegramId = String(ctx.from.id);
    const username = ctx.from.username?.toLowerCase() || null;
    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.telegramId, telegramId),
    });

    if (user) {
      if (username && user.telegramUsername !== username) {
        await db.update(usersTable).set({ telegramUsername: username, updatedAt: new Date() }).where(eq(usersTable.id, user.id));
      }
      const webAppUrl = getWebAppUrl();
      const buttons: string[][] = [
        ["Submit Receipt", "My Receipts"],
        ["Companies", "Categories"],
        ["Claim Forms", "Settings"],
        ["Launch Portal", "Help"],
      ];
      await ctx.reply(
        `Welcome back, ${user.name}!\n\nUse the menu below to manage your claims:`,
        Markup.keyboard(buttons).resize()
      );
      if (webAppUrl) {
        await ctx.reply("Access your full dashboard:", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Launch Mini App", web_app: { url: webAppUrl } }],
              [{ text: "Launch Portal", url: webAppUrl }],
            ],
          },
        });
      }
    } else {
      const username = ctx.from.username ? `@${ctx.from.username}` : "";
      await ctx.reply(
        "Welcome to Claimbase!\n\n" +
        "I'll help you manage your expense claims — submit receipts, track spending, and generate claim forms.\n\n" +
        "Let's set up your account first.\n\n" +
        (username
          ? `Once registered, you can also use your Telegram username (${username}) to log in on the web portal, or launch the Mini App directly from the menu.\n\n`
          : "Once registered, you can also launch the Mini App from the menu for a full dashboard experience.\n\n") +
        "What is your full name?"
      );
      await setSession(ctx.from.id, { step: "register_name", data: {} });
    }
  });

  const countryTimezones: Record<string, string> = {
    MYR: "+08:00",
    SGD: "+08:00",
    USD: "-05:00",
    GBP: "+00:00",
    EUR: "+01:00",
    JPY: "+09:00",
    THB: "+07:00",
    IDR: "+07:00",
    INR: "+05:30",
    AUD: "+10:00",
    CNY: "+08:00",
    KRW: "+09:00",
    PHP: "+08:00",
    VND: "+07:00",
    AED: "+04:00",
    CAD: "-05:00",
  };

  bot.action("country_OTHER", async (ctx) => {
    const session = await getSession(ctx.from!.id);
    if (!session || session.step !== "register_country") {
      await ctx.answerCbQuery("Session expired.");
      return;
    }
    await ctx.answerCbQuery();
    session.step = "register_country_custom";
    await setSession(ctx.from!.id, session);
    await ctx.editMessageText(
      "Enter your country's 3-letter currency code (e.g., NZD, HKD, BRL, ZAR):"
    );
  });

  bot.action(/^country_(.+)$/, async (ctx) => {
    const currency = ctx.match[1]!;
    const session = await getSession(ctx.from!.id);
    if (!session || session.step !== "register_country") {
      await ctx.answerCbQuery("Session expired.");
      return;
    }
    await ctx.answerCbQuery();
    session.data.dashboardCurrency = currency;
    session.data.timezone = countryTimezones[currency] || "+00:00";
    session.step = "register_company_name";
    await setSession(ctx.from!.id, session);
    await ctx.editMessageText(
      `✅ Currency set to *${currency}* · Timezone *GMT${session.data.timezone}*\n\nNow let's add your first company.\nEnter the company name:`,
      { parse_mode: "Markdown" }
    );
  });

  bot.action(/^cutoff_month_(\d)$/, async (ctx) => {
    const offset = parseInt(ctx.match[1]!, 10);
    const session = await getSession(ctx.from!.id);
    if (!session || session.step !== "register_company_cutoff_month") {
      await ctx.answerCbQuery("Session expired.");
      return;
    }
    await ctx.answerCbQuery();
    session.data.cutoffMonthOffset = offset;
    session.step = "register_company_cutoff_day";
    await setSession(ctx.from!.id, session);
    const monthLabel = offset === 0 ? "same month" : "following month";
    await ctx.editMessageText(
      `✅ Cut-off month: *${monthLabel}*\n\n` +
      "By what day should claims be submitted?\n" +
      "Enter a day (1-31).\n\n" +
      (offset === 0
        ? "e.g. Day 25 = March claims due by March 25th"
        : "e.g. Day 7 = March claims due by April 7th"),
      { parse_mode: "Markdown" }
    );
  });

  bot.action(/^edit_cutoff_month_(\d)_(\d+)$/, async (ctx) => {
    const offset = parseInt(ctx.match[1]!, 10);
    const companyId = parseInt(ctx.match[2]!, 10);
    const session = await getSession(ctx.from!.id);
    if (!session || session.step !== "edit_company_cutoff_month") {
      await ctx.answerCbQuery("Session expired.");
      return;
    }
    await ctx.answerCbQuery();
    session.data.cutoffMonthOffset = offset;
    session.step = "edit_company_cutoff_day";
    await setSession(ctx.from!.id, session);
    const monthLabel = offset === 0 ? "same month" : "following month";
    await ctx.editMessageText(
      `✅ Cut-off month: *${monthLabel}*\n\nEnter the cut-off day (1-31):`,
      { parse_mode: "Markdown" }
    );
  });

  bot.action(/^add_co_cutoff_month_(\d)$/, async (ctx) => {
    const offset = parseInt(ctx.match[1]!, 10);
    const session = await getSession(ctx.from!.id);
    if (!session || session.step !== "add_company_cutoff_month") {
      await ctx.answerCbQuery("Session expired.");
      return;
    }
    await ctx.answerCbQuery();
    session.data.cutoffMonthOffset = offset;
    session.step = "add_company_cutoff_day";
    await setSession(ctx.from!.id, session);
    const monthLabel = offset === 0 ? "same month" : "following month";
    await ctx.editMessageText(
      `✅ Cut-off month: *${monthLabel}*\n\n` +
      "By what day should claims be submitted?\n" +
      "Enter a day (1-31).\n\n" +
      (offset === 0
        ? "e.g. Day 25 = March claims due by March 25th"
        : "e.g. Day 7 = March claims due by April 7th"),
      { parse_mode: "Markdown" }
    );
  });

  bot.command("help", async (ctx) => {
    await sendHelp(ctx);
  });

  bot.command("cancel", async (ctx) => {
    await clearSession(ctx.from.id);
    await ctx.reply("Operation cancelled. What would you like to do?");
  });

  bot.command("receipts", async (ctx) => {
    await handleMyReceipts(ctx);
  });

  bot.command("companies", async (ctx) => {
    await handleCompanies(ctx);
  });

  bot.command("categories", async (ctx) => {
    await handleCategories(ctx);
  });

  bot.command("claims", async (ctx) => {
    await handleClaimForms(ctx);
  });

  bot.command("download", async (ctx) => {
    await handleDownload(ctx);
  });

  bot.command("settings", async (ctx) => {
    await handleSettings(ctx);
  });

  bot.hears(/^(📸\s*)?Submit Receipt$/i, async (ctx) => {
    await startReceiptSubmission(ctx);
  });

  bot.hears(/^(📋\s*)?My Receipts$/i, async (ctx) => {
    await handleMyReceipts(ctx);
  });

  bot.hears(/^(🏢\s*)?Companies$/i, async (ctx) => {
    await handleCompanies(ctx);
  });

  bot.hears(/^(📁\s*)?Categories$/i, async (ctx) => {
    await handleCategories(ctx);
  });

  bot.hears(/^(📊\s*)?Claim Forms$/i, async (ctx) => {
    await handleClaimForms(ctx);
  });

  bot.hears(/^(⚙️\s*)?Settings$/i, async (ctx) => {
    await handleSettings(ctx);
  });

  bot.hears(/^(❓\s*)?Help$/i, async (ctx) => {
    await sendHelp(ctx);
  });

  bot.hears(/^Launch Portal$/i, async (ctx) => {
    const webAppUrl = getWebAppUrl();
    if (webAppUrl) {
      await ctx.reply("Open Claimbase in your browser:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Launch Portal", url: webAppUrl }],
          ],
        },
      });
    } else {
      await ctx.reply("Portal is not available at this time.");
    }
  });

  bot.on("photo", async (ctx) => {
    const telegramId = String(ctx.from.id);
    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.telegramId, telegramId),
    });

    if (!user) {
      await ctx.reply("Please /start first to set up your account.");
      return;
    }

    const photos = ctx.message.photo;
    const largestPhoto = photos[photos.length - 1]!;
    const fileLink = await ctx.telegram.getFileLink(largestPhoto.file_id);
    const telegramImageUrl = fileLink.toString();
    const userCaption = ctx.message.caption?.trim() || "";

    const mediaGroupId = (ctx.message as any).media_group_id as string | undefined;

    if (mediaGroupId) {
      const existing = mediaGroupBuffer.get(mediaGroupId);
      if (existing) {
        existing.photos.push({ fileId: largestPhoto.file_id, telegramImageUrl });
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => processBulkPhotos(ctx, mediaGroupId), 1500);
      } else {
        const timer = setTimeout(() => processBulkPhotos(ctx, mediaGroupId), 1500);
        mediaGroupBuffer.set(mediaGroupId, {
          userId: ctx.from.id,
          dbUserId: user.id,
          photos: [{ fileId: largestPhoto.file_id, telegramImageUrl }],
          timer,
        });
        await ctx.reply(`📸 Receiving multiple receipts... I'll process them all shortly.`);
      }
      return;
    }

    const companies = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.userId, user.id));

    if (companies.length === 0) {
      await ctx.reply(
        "You need to add at least one company first.\nUse Companies to add one."
      );
      return;
    }

    await ctx.reply("📷 Analyzing your receipt...");
    const parsedItems = await parseReceiptImageMulti(telegramImageUrl);

    const receiptImagePath = `receipts/${user.id}/${Date.now()}_${largestPhoto.file_id}.jpg`;
    const imageUrl = await uploadFromUrlToStorage(telegramImageUrl, receiptImagePath, "image/jpeg");

    if (parsedItems.length > 1) {
      await ctx.reply(`📋 Detected *${parsedItems.length} separate items* in this image.`, { parse_mode: "Markdown" });
    }

    if (companies.length === 1) {
      for (const parsed of parsedItems) {
        await autoSaveReceipt(ctx, user, companies[0]!, parsed, imageUrl, userCaption);
      }
    } else if (parsedItems.length === 1) {
      const pendingId = addPendingReceipt(ctx.from.id, {
        parsedItems,
        imageUrl,
        userId: user.id,
        createdAt: Date.now(),
        userCaption,
      });

      const shortDesc = (userCaption || parsedItems[0]!.description || "receipt").substring(0, 30);

      const companyButtons = companies.map((c) => [
        Markup.button.callback(c.name, `rcpt_co_${pendingId}_${c.id}`),
      ]);
      await ctx.reply(
        `Which company is this receipt for?\n📝 _${shortDesc}_`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard(companyButtons) }
      );
    } else {
      const allItems = parsedItems.map(parsed => ({ imageUrl, parsed }));
      const queueId = makeBulkQueueId(ctx.from.id);
      const queue: BulkReceiptQueue = {
        dbUserId: user.id,
        telegramId: ctx.from.id,
        items: allItems,
        currentIndex: 0,
        savedCount: 0,
        transferCount: 0,
      };
      await saveBulkQueue(queueId, queue);

      await showNextBulkReceiptPrompt(ctx, queueId, companies);
    }
  });

  bot.on("document", async (ctx) => {
    const doc = ctx.message.document;
    if (!doc) return;

    const mimeType = doc.mime_type || "";
    const isImage = mimeType.startsWith("image/");
    const isPdf = mimeType === "application/pdf";

    if (!isImage && !isPdf) {
      await ctx.reply("📎 I can only process receipt images and PDF files.\n\nSupported formats: JPG, JPEG, PNG, HEIC, PDF\n\nPlease send a photo or attach a file.");
      return;
    }

    const MAX_FILE_SIZE = 10 * 1024 * 1024;
    if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
      await ctx.reply("📎 File is too large (max 10 MB). Please send a smaller file.");
      return;
    }

    const telegramId = String(ctx.from.id);
    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.telegramId, telegramId),
    });

    if (!user) {
      await ctx.reply("Please /start first to set up your account.");
      return;
    }

    const companies = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.userId, user.id));

    if (companies.length === 0) {
      await ctx.reply("You need to add at least one company first.\nUse Companies to add one.");
      return;
    }

    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const fileUrl = fileLink.toString();
    const docCaption = ctx.message.caption?.trim() || "";

    await ctx.reply(isPdf ? "📄 Analyzing your PDF receipt..." : "📷 Analyzing your receipt...");

    let parsedItems: ParsedReceipt[];
    let imageUrl: string;
    const ext = isPdf ? "pdf" : (doc.file_name?.split(".").pop() || "jpg");
    const storagePath = `receipts/${user.id}/${Date.now()}_${doc.file_id}.${ext}`;

    if (isPdf) {
      const response = await fetch(fileUrl);
      const arrayBuffer = await response.arrayBuffer();
      const pdfBuffer = Buffer.from(arrayBuffer);
      parsedItems = await parseReceiptPdfMulti(pdfBuffer);
      imageUrl = await uploadBufferToStorage(pdfBuffer, storagePath, "application/pdf");
    } else {
      parsedItems = await parseReceiptImageMulti(fileUrl);
      imageUrl = await uploadFromUrlToStorage(fileUrl, storagePath, mimeType || "image/jpeg");
    }

    if (parsedItems.length > 1) {
      await ctx.reply(`📋 Detected *${parsedItems.length} separate items* in this file.`, { parse_mode: "Markdown" });
    }

    if (companies.length === 1) {
      for (const parsed of parsedItems) {
        await autoSaveReceipt(ctx, user, companies[0]!, parsed, imageUrl, docCaption);
      }
    } else if (parsedItems.length === 1) {
      const pendingId = addPendingReceipt(ctx.from.id, {
        parsedItems,
        imageUrl,
        userId: user.id,
        createdAt: Date.now(),
        userCaption: docCaption,
      });

      const shortDesc = (docCaption || parsedItems[0]!.description || "receipt").substring(0, 30);

      const companyButtons = companies.map((c) => [
        Markup.button.callback(c.name, `rcpt_co_${pendingId}_${c.id}`),
      ]);
      await ctx.reply(
        `Which company is this receipt for?\n📝 _${shortDesc}_`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard(companyButtons) }
      );
    } else {
      const allItems = parsedItems.map(parsed => ({ imageUrl, parsed }));
      const queueId = makeBulkQueueId(ctx.from.id);
      const queue: BulkReceiptQueue = {
        dbUserId: user.id,
        telegramId: ctx.from.id,
        items: allItems,
        currentIndex: 0,
        savedCount: 0,
        transferCount: 0,
      };
      await saveBulkQueue(queueId, queue);

      await showNextBulkReceiptPrompt(ctx, queueId, companies);
    }
  });

  bot.action(/^rcpt_co_(.+)_(\d+)$/, async (ctx) => {
    const pendingId = ctx.match[1]!;
    const companyId = parseInt(ctx.match[2]!, 10);

    const pending = pendingReceipts.get(pendingId);
    if (!pending) {
      await ctx.answerCbQuery("This receipt has already been saved or expired. Please resend it.");
      return;
    }

    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }

    const company = await db.query.companiesTable.findFirst({
      where: eq(companiesTable.id, companyId),
    });
    if (!company || company.userId !== user.id) { await ctx.answerCbQuery("Company not found."); return; }

    pendingReceipts.delete(pendingId);
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ Saving to *${company.name}*...`, { parse_mode: "Markdown" });

    for (const parsed of pending.parsedItems) {
      await autoSaveReceipt(ctx, user, company, parsed, pending.imageUrl, pending.userCaption);
    }
  });

  bot.action(/^receipt_company_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("This button has expired. Please resend the receipt.");
  });

  bot.action(/^bulk_company_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("This button has expired. Please resend the receipts.");
  });

  bot.action(/^bulk_co_(.+)_(\d+)$/, async (ctx) => {
    const pendingId = ctx.match[1]!;
    const companyId = parseInt(ctx.match[2]!, 10);

    const bulkItems = pendingBulkReceipts.get(pendingId);
    if (!bulkItems) {
      await ctx.answerCbQuery("These receipts have already been saved or expired. Please resend them.");
      return;
    }

    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }

    const company = await db.query.companiesTable.findFirst({
      where: eq(companiesTable.id, companyId),
    });
    if (!company || company.userId !== user.id) { await ctx.answerCbQuery("Company not found."); return; }

    pendingBulkReceipts.delete(pendingId);
    pendingReceipts.delete(pendingId);
    await ctx.answerCbQuery("Saving receipts...");
    await ctx.editMessageText(`✅ Saving ${bulkItems.length} receipts to *${company.name}*...`, { parse_mode: "Markdown" });

    let savedCount = 0;
    let transferCount = 0;
    for (const r of bulkItems) {
      try {
        await autoSaveReceipt(ctx, user, company, r.parsed, r.imageUrl);
        savedCount++;
        if (r.parsed.receiptType === "transfer") transferCount++;
      } catch (err) {
        logger.error({ err }, "Failed to save bulk receipt");
      }
    }

    const webAppUrl = getWebAppUrl();
    let resultMsg = `✅ *${savedCount} receipts saved to ${company.name}!*\n\n`;
    if (transferCount > 0) {
      resultMsg += `⚠️ ${transferCount} bank transfer(s) may need category assignment.\n`;
    }
    resultMsg += `Descriptions were auto-generated from receipt contents. You can review and edit them in the portal.`;

    const buttons: any[][] = [];
    if (webAppUrl) {
      buttons.push([Markup.button.url("Review in Portal", webAppUrl)]);
    }

    await ctx.editMessageText(resultMsg, {
      parse_mode: "Markdown",
      ...(buttons.length > 0 ? Markup.inlineKeyboard(buttons) : {}),
    });
  });

  bot.action(/^bqco_(.+)_(\d+)$/, async (ctx) => {
    const queueId = ctx.match[1]!;
    const companyId = parseInt(ctx.match[2]!, 10);

    const queue = await loadBulkQueue(queueId);
    if (!queue) {
      await ctx.answerCbQuery("Session expired. Please resend the receipts.");
      return;
    }

    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }

    const company = await db.query.companiesTable.findFirst({
      where: eq(companiesTable.id, companyId),
    });
    if (!company || company.userId !== user.id) { await ctx.answerCbQuery("Company not found."); return; }

    const item = queue.items[queue.currentIndex]!;
    await ctx.answerCbQuery(`Saving to ${company.name}...`);

    try {
      await autoSaveReceipt(ctx, user, company, item.parsed, item.imageUrl);
      queue.savedCount++;
      if (item.parsed.receiptType === "transfer") queue.transferCount++;
    } catch (err) {
      logger.error({ err }, "Failed to save bulk queue receipt");
      await ctx.reply("⚠️ Failed to save that receipt.");
    }

    queue.currentIndex++;
    await saveBulkQueue(queueId, queue);

    const companies = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.userId, user.id));

    await showNextBulkReceiptPrompt(ctx, queueId, companies, true);
  });

  bot.action(/^receipt_category_(\d+)$/, async (ctx) => {
    const categoryId = parseInt(ctx.match[1]!, 10);
    const session = await getSession(ctx.from!.id);
    if (!session || session.step !== "receipt_select_category") {
      await ctx.answerCbQuery("Session expired.");
      return;
    }

    session.data.categoryId = categoryId;

    const receiptCurrency = (session.data.currency as string || "").toUpperCase();
    const baseCurrency = (session.data.baseCurrency as string || "").toUpperCase();

    if (receiptCurrency && baseCurrency && receiptCurrency !== baseCurrency) {
      session.step = "receipt_conversion_rate";
      await setSession(ctx.from!.id, session);

      const { rate, source } = await getExchangeRate(receiptCurrency, baseCurrency);
      session.data.suggestedRate = rate;
      await setSession(ctx.from!.id, session);

      await ctx.answerCbQuery();
      await ctx.editMessageText(
        `💱 *Currency Conversion*\n\n` +
        `Receipt: *${receiptCurrency}*\n` +
        `Base Currency: *${baseCurrency}*\n` +
        `Suggested rate: *${rate.toFixed(6)}* (${source})\n\n` +
        `Enter conversion rate or send "ok" to use the suggested rate:`,
        { parse_mode: "Markdown" }
      );
    } else {
      await finalizeReceipt(ctx, session);
    }
  });

  bot.action(/^transfer_cat_(\d+)$/, async (ctx) => {
    const categoryId = parseInt(ctx.match[1]!, 10);
    const session = await getSession(ctx.from!.id);
    if (!session || session.step !== "transfer_select_category") {
      await ctx.answerCbQuery("Session expired.");
      return;
    }

    await ctx.answerCbQuery();

    const data = session.data;
    const amount = parseFloat(data.amount as string) || 0;

    const [receipt] = await db
      .insert(receiptsTable)
      .values({
        userId: data.userId as number,
        companyId: data.companyId as number,
        categoryId,
        description: data.description as string,
        receiptDate: data.date as string,
        currency: data.currency as string,
        amount: amount.toFixed(2),
        conversionRate: (data.conversionRate as number).toFixed(6),
        convertedAmount: data.convertedAmount as string,
        imageUrl: data.imageUrl as string,
      })
      .returning();

    await clearSession(ctx.from!.id);

    const category = await db.query.categoriesTable.findFirst({ where: eq(categoriesTable.id, categoryId) });
    const convRate = data.conversionRate as number;

    const msg =
      `✅ *Receipt saved!*\n\n` +
      `📝 ${data.description}\n` +
      `💰 ${data.currency} ${amount.toFixed(2)}` +
      (convRate !== 1 ? ` → ${data.baseCurrency} ${data.convertedAmount}` : "") + `\n` +
      `📅 ${data.date}\n` +
      (category ? `🏷️ ${category.name}\n` : "") +
      `🏢 ${data.companyName}\n\n` +
      `#${receipt!.id}`;

    const webAppUrl = getWebAppUrl();
    const editButtons: any[][] = [
      [
        Markup.button.callback("✏️ Edit", `quick_edit_${receipt!.id}`),
        Markup.button.callback("🗑️ Delete", `quick_delete_${receipt!.id}`),
      ],
    ];
    if (webAppUrl) {
      editButtons.push([Markup.button.url("Open Portal", webAppUrl)]);
    }

    await ctx.editMessageText(msg, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(editButtons),
    });
  });

  bot.action(/^quick_edit_(\d+)$/, async (ctx) => {
    const receiptId = parseInt(ctx.match[1]!, 10);
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }
    const receipt = await db.query.receiptsTable.findFirst({ where: eq(receiptsTable.id, receiptId) });
    if (!receipt || receipt.userId !== user.id) { await ctx.answerCbQuery("Receipt not found."); return; }

    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [
          Markup.button.callback("📝 Description", `edit_field_desc_${receiptId}`),
          Markup.button.callback("💰 Amount", `edit_field_amt_${receiptId}`),
        ],
        [
          Markup.button.callback("💱 Currency", `edit_field_cur_${receiptId}`),
          Markup.button.callback("📅 Date", `edit_field_date_${receiptId}`),
        ],
        [
          Markup.button.callback("🏷️ Category", `edit_field_cat_${receiptId}`),
          Markup.button.callback("🏢 Company", `edit_field_comp_${receiptId}`),
        ],
        [
          Markup.button.callback("« Back", `quick_back_${receiptId}`),
        ],
      ],
    });
  });

  bot.action(/^quick_back_(\d+)$/, async (ctx) => {
    const receiptId = parseInt(ctx.match[1]!, 10);
    await ctx.answerCbQuery();
    const webAppUrl = getWebAppUrl();
    const editButtons: any[][] = [
      [
        Markup.button.callback("✏️ Edit", `quick_edit_${receiptId}`),
        Markup.button.callback("🗑️ Delete", `quick_delete_${receiptId}`),
      ],
    ];
    if (webAppUrl) {
      editButtons.push([Markup.button.url("Open Portal", webAppUrl)]);
    }
    await ctx.editMessageReplyMarkup({ inline_keyboard: editButtons.map(row => row.map(b => b)) });
  });

  bot.action(/^quick_delete_(\d+)$/, async (ctx) => {
    const receiptId = parseInt(ctx.match[1]!, 10);
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }
    const receipt = await db.query.receiptsTable.findFirst({ where: eq(receiptsTable.id, receiptId) });
    if (!receipt || receipt.userId !== user.id) { await ctx.answerCbQuery("Not found."); return; }
    await db.delete(receiptsTable).where(eq(receiptsTable.id, receiptId));
    await ctx.answerCbQuery("Deleted!");
    await ctx.editMessageText("🗑️ Receipt deleted.");
  });

  bot.action(/^edit_field_(desc|amt|cur|date|cat|comp)_(\d+)$/, async (ctx) => {
    const field = ctx.match[1]!;
    const receiptId = parseInt(ctx.match[2]!, 10);
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }
    const receipt = await db.query.receiptsTable.findFirst({ where: eq(receiptsTable.id, receiptId) });
    if (!receipt || receipt.userId !== user.id) { await ctx.answerCbQuery("Not found."); return; }

    await ctx.answerCbQuery();

    if (field === "cat") {
      const categories = await db
        .select()
        .from(categoriesTable)
        .where(or(eq(categoriesTable.isSystem, true), eq(categoriesTable.userId, user.id)));

      await setSession(ctx.from!.id, { step: "edit_category", data: { receiptId } });
      const catButtons = categories.map((c) => [
        Markup.button.callback(c.name, `set_cat_${receiptId}_${c.id}`),
      ]);
      await ctx.reply("Select a new category:", Markup.inlineKeyboard(catButtons));
      return;
    }

    if (field === "comp") {
      const companies = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.userId, user.id));

      if (companies.length <= 1) {
        await ctx.reply("You only have one company. Add more companies first via /companies.");
        return;
      }

      const compButtons = companies.map((c) => [
        Markup.button.callback(`${c.id === receipt.companyId ? "✓ " : ""}${c.name}`, `set_comp_${receiptId}_${c.id}`),
      ]);
      await ctx.reply("Move receipt to which company?", Markup.inlineKeyboard(compButtons));
      return;
    }

    const stepMap: Record<string, { step: string; prompt: string }> = {
      desc: { step: "edit_description", prompt: `Current: ${receipt.description}\n\nEnter new description:` },
      amt: { step: "edit_amount", prompt: `Current: ${receipt.amount}\n\nEnter new amount:` },
      cur: { step: "edit_currency", prompt: `Current: ${receipt.currency}\n\nEnter new currency code (e.g., USD, MYR):` },
      date: { step: "edit_date", prompt: `Current: ${receipt.receiptDate}\n\nEnter new date (YYYY-MM-DD):` },
    };

    const info = stepMap[field]!;
    await setSession(ctx.from!.id, { step: info.step, data: { receiptId } });
    await ctx.reply(info.prompt);
  });

  bot.action(/^set_cat_(\d+)_(\d+)$/, async (ctx) => {
    const receiptId = parseInt(ctx.match[1]!, 10);
    const categoryId = parseInt(ctx.match[2]!, 10);
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }
    const receipt = await db.query.receiptsTable.findFirst({ where: eq(receiptsTable.id, receiptId) });
    if (!receipt || receipt.userId !== user.id) { await ctx.answerCbQuery("Not found."); return; }
    const cat = await db.query.categoriesTable.findFirst({
      where: and(
        eq(categoriesTable.id, categoryId),
        or(eq(categoriesTable.isSystem, true), eq(categoriesTable.userId, user.id))
      ),
    });
    if (!cat) { await ctx.answerCbQuery("Category not found."); return; }

    await db.update(receiptsTable).set({ categoryId, updatedAt: new Date() }).where(eq(receiptsTable.id, receiptId));
    await clearSession(ctx.from!.id);
    await ctx.answerCbQuery("Category updated!");
    await ctx.editMessageText(`✅ Category updated to ${cat.name}`);
    await showReceiptWithEditButtons(ctx, receiptId);
  });

  bot.action(/^set_comp_(\d+)_(\d+)$/, async (ctx) => {
    const receiptId = parseInt(ctx.match[1]!, 10);
    const companyId = parseInt(ctx.match[2]!, 10);
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }
    const receipt = await db.query.receiptsTable.findFirst({ where: eq(receiptsTable.id, receiptId) });
    if (!receipt || receipt.userId !== user.id) { await ctx.answerCbQuery("Not found."); return; }
    const company = await db.query.companiesTable.findFirst({ where: eq(companiesTable.id, companyId) });
    if (!company || company.userId !== user.id) { await ctx.answerCbQuery("Company not found."); return; }

    await db.update(receiptsTable).set({ companyId, updatedAt: new Date() }).where(eq(receiptsTable.id, receiptId));
    await ctx.answerCbQuery("Company updated!");
    await ctx.editMessageText(`✅ Receipt moved to ${company.name}`);
    await showReceiptWithEditButtons(ctx, receiptId);
  });

  bot.action(/^delete_receipt_(\d+)$/, async (ctx) => {
    const receiptId = parseInt(ctx.match[1]!, 10);
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }
    const receipt = await db.query.receiptsTable.findFirst({ where: eq(receiptsTable.id, receiptId) });
    if (!receipt || receipt.userId !== user.id) { await ctx.answerCbQuery("Receipt not found."); return; }
    await db.delete(receiptsTable).where(eq(receiptsTable.id, receiptId));
    await ctx.answerCbQuery("Receipt deleted!");
    await ctx.editMessageText("✅ Receipt deleted successfully.");
  });

  bot.action(/^edit_receipt_(\d+)$/, async (ctx) => {
    const receiptId = parseInt(ctx.match[1]!, 10);
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }
    const receipt = await db.query.receiptsTable.findFirst({ where: eq(receiptsTable.id, receiptId) });
    if (!receipt || receipt.userId !== user.id) { await ctx.answerCbQuery("Receipt not found."); return; }
    await setSession(ctx.from!.id, {
      step: "edit_receipt_field",
      data: { receiptId },
    });

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      "What would you like to edit?",
      Markup.inlineKeyboard([
        [Markup.button.callback("📝 Description", `edit_field_description_${receiptId}`)],
        [Markup.button.callback("💰 Amount", `edit_field_amount_${receiptId}`)],
        [Markup.button.callback("📅 Date", `edit_field_date_${receiptId}`)],
        [Markup.button.callback("💱 Currency & Rate", `edit_field_currency_${receiptId}`)],
        [Markup.button.callback("🏢 Company", `edit_field_comp_${receiptId}`)],
        [Markup.button.callback("❌ Cancel", "cancel_edit")],
      ])
    );
  });

  bot.action(/^edit_field_(\w+)_(\d+)$/, async (ctx) => {
    const field = ctx.match[1]!;
    const receiptId = parseInt(ctx.match[2]!, 10);

    await setSession(ctx.from!.id, {
      step: `edit_${field}`,
      data: { receiptId },
    });

    const prompts: Record<string, string> = {
      description: "Enter new description:",
      amount: "Enter new amount (number only):",
      date: "Enter new date (YYYY-MM-DD):",
      currency: "Enter new currency code (e.g., USD, MYR, SGD):",
    };

    await ctx.answerCbQuery();
    await ctx.editMessageText(prompts[field] || "Enter new value:");
  });

  bot.action("cancel_edit", async (ctx) => {
    await clearSession(ctx.from!.id);
    await ctx.answerCbQuery("Edit cancelled.");
    await ctx.editMessageText("Edit cancelled.");
  });

  bot.action(/^download_(pdf|excel)_(\d+)$/, async (ctx) => {
    const format = ctx.match[1]!;
    const periodId = parseInt(ctx.match[2]!, 10);
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }
    const periodCheck = await db.query.claimPeriodsTable.findFirst({ where: eq(claimPeriodsTable.id, periodId) });
    if (!periodCheck || periodCheck.userId !== user.id) { await ctx.answerCbQuery("Claim period not found."); return; }

    await ctx.answerCbQuery("Generating your file...");

    try {
      if (format === "pdf") {
        const buffer = await generatePDF(periodId);
        const period = periodCheck;
        const company = await db.query.companiesTable.findFirst({
          where: eq(companiesTable.id, period.companyId),
        });
        const filename = `Claim_${company?.name?.replace(/[^a-zA-Z0-9]/g, "_") || "Company"}_${period.periodLabel || "period"}.pdf`;

        await ctx.replyWithDocument({
          source: buffer,
          filename,
        });
      } else {
        const buffer = await generateExcel(periodId);
        const period = periodCheck;
        const company = await db.query.companiesTable.findFirst({
          where: eq(companiesTable.id, period.companyId),
        });
        const filename = `Claim_${company?.name?.replace(/[^a-zA-Z0-9]/g, "_") || "Company"}_${period.periodLabel || "period"}.xlsx`;

        await ctx.replyWithDocument({
          source: buffer,
          filename,
        });
      }
    } catch (error) {
      logger.error({ error }, "Failed to generate download");
      await ctx.reply("❌ Failed to generate file. Please try again.");
    }
  });

  bot.action(/^add_company$/, async (ctx) => {
    await setSession(ctx.from!.id, { step: "add_company_name", data: {} });
    await ctx.answerCbQuery();
    await ctx.editMessageText("Enter the company name:");
  });

  bot.action(/^add_category$/, async (ctx) => {
    await setSession(ctx.from!.id, { step: "add_category_name", data: {} });
    await ctx.answerCbQuery();
    await ctx.editMessageText("Enter the category name:");
  });

  bot.action(/^edit_category_(\d+)$/, async (ctx) => {
    const categoryId = parseInt(ctx.match[1]!, 10);
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }
    const category = await db.query.categoriesTable.findFirst({ where: eq(categoriesTable.id, categoryId) });
    if (!category || category.isSystem || category.userId !== user.id) {
      await ctx.answerCbQuery("Category not found or cannot be edited.");
      return;
    }
    await setSession(ctx.from!.id, { step: "edit_category_name", data: { categoryId } });
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Current name: *${category.name}*\n\nEnter the new name (or send 'skip' to keep):`, { parse_mode: "Markdown" });
  });

  bot.action(/^delete_category_(\d+)$/, async (ctx) => {
    const categoryId = parseInt(ctx.match[1]!, 10);
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }
    const category = await db.query.categoriesTable.findFirst({ where: eq(categoriesTable.id, categoryId) });
    if (!category || category.isSystem || category.userId !== user.id) {
      await ctx.answerCbQuery("Category not found or cannot be deleted.");
      return;
    }
    await db.update(receiptsTable).set({ categoryId: null }).where(eq(receiptsTable.categoryId, categoryId));
    await db.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
    await ctx.answerCbQuery("Category deleted.");
    await ctx.editMessageText(`🗑️ Category "${category.name}" has been deleted. Receipts using it have been uncategorized.\n\nUse /categories to view your categories.`);
  });

  bot.action(/^view_company_(\d+)$/, async (ctx) => {
    const companyId = parseInt(ctx.match[1]!, 10);
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }
    const company = await db.query.companiesTable.findFirst({
      where: eq(companiesTable.id, companyId),
    });
    if (!company || company.userId !== user.id) {
      await ctx.answerCbQuery("Company not found.");
      return;
    }

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `🏢 *${company.name}*\n\n` +
      `Base Currency: *${company.baseCurrency}*\n` +
      `Cut-off: *${formatCutoffText(company.cutoffDay, company.cutoffTime, company.cutoffMonthOffset)}*\n`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✏️ Edit Base Currency", `edit_company_currency_${companyId}`)],
          [Markup.button.callback("📅 Edit Cut-off", `edit_company_cutoff_${companyId}`)],
          [Markup.button.callback("🗑️ Delete", `delete_company_${companyId}`)],
          [Markup.button.callback("◀️ Back", "back_companies")],
        ]),
      }
    );
  });

  bot.action(/^edit_company_currency_(\d+)$/, async (ctx) => {
    const companyId = parseInt(ctx.match[1]!, 10);
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }
    const company = await db.query.companiesTable.findFirst({ where: eq(companiesTable.id, companyId) });
    if (!company || company.userId !== user.id) { await ctx.answerCbQuery("Company not found."); return; }
    await setSession(ctx.from!.id, { step: "edit_company_base_currency", data: { companyId } });
    await ctx.answerCbQuery();
    await ctx.editMessageText("Enter the new base currency code (e.g., USD, MYR, SGD):");
  });

  bot.action(/^edit_company_cutoff_(\d+)$/, async (ctx) => {
    const companyId = parseInt(ctx.match[1]!, 10);
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }
    const company = await db.query.companiesTable.findFirst({ where: eq(companiesTable.id, companyId) });
    if (!company || company.userId !== user.id) { await ctx.answerCbQuery("Company not found."); return; }
    await setSession(ctx.from!.id, { step: "edit_company_cutoff_month", data: { companyId } });
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      "When is the claim cut-off — same month or the following month?",
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Same month", callback_data: `edit_cutoff_month_0_${companyId}` },
              { text: "Following month", callback_data: `edit_cutoff_month_1_${companyId}` },
            ],
          ],
        },
      }
    );
  });

  bot.action(/^delete_company_(\d+)$/, async (ctx) => {
    const companyId = parseInt(ctx.match[1]!, 10);
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    if (!user) { await ctx.answerCbQuery("User not found."); return; }
    const company = await db.query.companiesTable.findFirst({ where: eq(companiesTable.id, companyId) });
    if (!company || company.userId !== user.id) { await ctx.answerCbQuery("Company not found."); return; }
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
    await ctx.answerCbQuery("Company deleted!");
    await ctx.editMessageText("✅ Company deleted.");
  });

  bot.action("back_companies", async (ctx) => {
    await ctx.answerCbQuery();
    await handleCompaniesInline(ctx);
  });

  bot.action("settings_edit_name", async (ctx) => {
    await setSession(ctx.from!.id, { step: "settings_name", data: {} });
    await ctx.answerCbQuery();
    await ctx.editMessageText("Enter your new name:");
  });

  bot.action("settings_edit_timezone", async (ctx) => {
    await setSession(ctx.from!.id, { step: "settings_timezone", data: {} });
    await ctx.answerCbQuery();
    await ctx.editMessageText("Enter your new timezone (e.g., +08:00, -05:00):");
  });

  bot.on("text", async (ctx) => {
    const session = await getSession(ctx.from.id);
    if (!session) {
      await ctx.reply(
        "Use the menu or /start to begin. Send a receipt photo to submit an expense.",
      );
      return;
    }

    const text = ctx.message.text.trim();

    switch (session.step) {
      case "receipt_enter_description": {
        if (text.length < 2) {
          await ctx.reply("Description is too short. Please type a meaningful description for this expense:");
          return;
        }
        await saveReceiptWithDescription(ctx, session, text);
        break;
      }

      case "register_name": {
        session.data.name = text;
        session.step = "register_country";
        await setSession(ctx.from.id, session);
        await ctx.reply(
          "🌍 What country are you based in?\n\n" +
          "This sets your default currency and timezone.",
          Markup.inlineKeyboard([
            [Markup.button.callback("🇲🇾 Malaysia (MYR)", "country_MYR"), Markup.button.callback("🇸🇬 Singapore (SGD)", "country_SGD")],
            [Markup.button.callback("🇺🇸 United States (USD)", "country_USD"), Markup.button.callback("🇬🇧 United Kingdom (GBP)", "country_GBP")],
            [Markup.button.callback("🇪🇺 Europe (EUR)", "country_EUR"), Markup.button.callback("🇯🇵 Japan (JPY)", "country_JPY")],
            [Markup.button.callback("🇹🇭 Thailand (THB)", "country_THB"), Markup.button.callback("🇮🇩 Indonesia (IDR)", "country_IDR")],
            [Markup.button.callback("🇮🇳 India (INR)", "country_INR"), Markup.button.callback("🇦🇺 Australia (AUD)", "country_AUD")],
            [Markup.button.callback("🇨🇳 China (CNY)", "country_CNY"), Markup.button.callback("🇰🇷 South Korea (KRW)", "country_KRW")],
            [Markup.button.callback("🇵🇭 Philippines (PHP)", "country_PHP"), Markup.button.callback("🇻🇳 Vietnam (VND)", "country_VND")],
            [Markup.button.callback("🇦🇪 UAE (AED)", "country_AED"), Markup.button.callback("🇨🇦 Canada (CAD)", "country_CAD")],
            [Markup.button.callback("🌐 Others", "country_OTHER")],
          ])
        );
        break;
      }

      case "register_country_custom": {
        const upper = text.toUpperCase();
        if (!/^[A-Z]{3}$/.test(upper)) {
          await ctx.reply("Please enter a valid 3-letter currency code (e.g., NZD, HKD, BRL):");
          return;
        }
        session.data.dashboardCurrency = upper;
        session.step = "register_country_custom_tz";
        await setSession(ctx.from.id, session);
        await ctx.reply(
          `Currency set to *${upper}*.\n\nNow enter your timezone as a GMT offset (e.g., +08:00, -05:00, +00:00):`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      case "register_country_custom_tz": {
        if (!/^[+-]\d{2}:\d{2}$/.test(text)) {
          await ctx.reply("Please enter a valid timezone offset, e.g.: +08:00, -05:00");
          return;
        }
        session.data.timezone = text;
        session.step = "register_company_name";
        await setSession(ctx.from.id, session);
        await ctx.reply(
          `✅ Currency set to *${session.data.dashboardCurrency}* · Timezone *GMT${text}*\n\nNow let's add your first company.\nEnter the company name:`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      case "register_company_name": {
        session.data.companyName = text;
        session.step = "register_company_currency";
        await setSession(ctx.from.id, session);
        await ctx.reply(
          "What is the base currency for this company?\n" +
          "Enter the 3-letter currency code (e.g., USD, MYR, SGD, EUR):"
        );
        break;
      }

      case "register_company_currency": {
        if (text.length < 3 || text.length > 5) {
          await ctx.reply("Please enter a valid currency code (e.g., USD, MYR, SGD):");
          return;
        }
        session.data.companyCurrency = text.toUpperCase();
        session.step = "register_company_cutoff_month";
        await setSession(ctx.from.id, session);
        await ctx.reply(
          "When is the claim cut-off — same month or the following month?\n\n" +
          "e.g. Same month: March claims due within March\n" +
          "Following month: March claims due in April",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Same month", callback_data: "cutoff_month_0" },
                  { text: "Following month", callback_data: "cutoff_month_1" },
                ],
              ],
            },
          }
        );
        break;
      }

      case "register_company_cutoff_day": {
        const day = parseInt(text, 10);
        if (isNaN(day) || day < 1 || day > 31) {
          await ctx.reply("Please enter a valid day (1-31):");
          return;
        }
        session.data.cutoffDay = day;
        const cutoffTime = "23:59";

        const telegramId = String(ctx.from.id);
        const telegramUsername = ctx.from.username?.toLowerCase() || null;
        const dashCurrency = (session.data.dashboardCurrency as string) || "MYR";
        const [user] = await db
          .insert(usersTable)
          .values({
            telegramId,
            telegramUsername,
            name: session.data.name as string,
            timezone: session.data.timezone as string,
            dashboardCurrency: dashCurrency,
          })
          .returning();

        const monthOffset = typeof session.data.cutoffMonthOffset === "number" ? session.data.cutoffMonthOffset : 1;
        await db.insert(companiesTable).values({
          userId: user!.id,
          name: session.data.companyName as string,
          baseCurrency: session.data.companyCurrency as string,
          cutoffDay: day,
          cutoffTime,
          cutoffMonthOffset: monthOffset,
        });

        await clearSession(ctx.from.id);

        await ctx.reply(
          `✅ Account created successfully!\n\n` +
          `Name: *${user!.name}*\n` +
          `Timezone: *${user!.timezone}*\n` +
          `Company: *${session.data.companyName}*\n` +
          `Base Currency: *${session.data.companyCurrency}*\n` +
          `Cut-off: *${formatCutoffText(day, cutoffTime, monthOffset)}*\n\n` +
          `You can add more companies later using Companies.\n` +
          `Send a receipt photo anytime to submit an expense!`,
          {
            parse_mode: "Markdown",
            ...Markup.keyboard([
              ["Submit Receipt", "My Receipts"],
              ["Companies", "Categories"],
              ["Claim Forms", "Settings"],
              ["Launch Portal", "Help"],
            ]).resize(),
          }
        );

        const onboardWebAppUrl = getWebAppUrl();
        if (onboardWebAppUrl) {
          await ctx.reply("Launch the full dashboard anytime:", {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Launch Mini App", web_app: { url: onboardWebAppUrl } }],
                [{ text: "Launch Portal", url: onboardWebAppUrl }],
              ],
            },
          });
        }
        break;
      }

      case "receipt_description": {
        session.data.description = text;
        session.step = "receipt_currency";
        await setSession(ctx.from.id, session);

        const prefilled = session.data.currency || "";
        await ctx.reply(
          `Enter the receipt currency (3-letter code)${prefilled ? ` [detected: ${prefilled}]` : ""}:\n` +
          `e.g., USD, MYR, SGD, EUR\n` +
          `${prefilled ? 'Send "ok" to use detected currency.' : ""}`
        );
        break;
      }

      case "receipt_currency": {
        let currency = text.toUpperCase();
        if (text.toLowerCase() === "ok" && session.data.currency) {
          currency = (session.data.currency as string).toUpperCase();
        }
        if (currency.length < 3 || currency.length > 5) {
          await ctx.reply("Please enter a valid currency code:");
          return;
        }
        session.data.currency = currency;
        session.step = "receipt_amount";
        await setSession(ctx.from.id, session);

        const prefilled = session.data.amount || "";
        await ctx.reply(
          `Enter the amount${prefilled ? ` [detected: ${prefilled}]` : ""}:\n` +
          `${prefilled ? 'Send "ok" to use detected amount.' : ""}`
        );
        break;
      }

      case "receipt_amount": {
        let amount = text;
        if (text.toLowerCase() === "ok" && session.data.amount) {
          amount = session.data.amount as string;
        }
        const parsed = parseFloat(amount);
        if (isNaN(parsed) || parsed <= 0) {
          await ctx.reply("Please enter a valid positive number:");
          return;
        }
        session.data.amount = parsed.toFixed(2);
        session.step = "receipt_date";
        await setSession(ctx.from.id, session);

        const prefilled = session.data.date || "";
        await ctx.reply(
          `Enter the receipt date (YYYY-MM-DD)${prefilled ? ` [detected: ${prefilled}]` : ""}:\n` +
          `${prefilled ? 'Send "ok" to use detected date.' : ""}`
        );
        break;
      }

      case "receipt_date": {
        let dateStr = text;
        if (text.toLowerCase() === "ok" && session.data.date) {
          dateStr = session.data.date as string;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          await ctx.reply("Please enter a valid date in YYYY-MM-DD format:");
          return;
        }
        session.data.date = dateStr;
        session.step = "receipt_select_category";
        await setSession(ctx.from.id, session);

        const userId = session.data.userId as number;
        const categories = await db
          .select()
          .from(categoriesTable)
          .where(
            or(
              eq(categoriesTable.isSystem, true),
              eq(categoriesTable.userId, userId)
            )
          );

        const catButtons = categories.map((c) => [
          Markup.button.callback(c.name, `receipt_category_${c.id}`),
        ]);

        await ctx.reply("Select a category:", Markup.inlineKeyboard(catButtons));
        break;
      }

      case "receipt_conversion_rate": {
        let rate: number;
        if (text.toLowerCase() === "ok") {
          rate = session.data.suggestedRate as number;
        } else {
          rate = parseFloat(text);
          if (isNaN(rate) || rate <= 0) {
            await ctx.reply("Please enter a valid positive number or 'ok':");
            return;
          }
        }
        session.data.conversionRate = rate;
        await finalizeReceipt(ctx, session);
        break;
      }

      case "edit_description": {
        const receiptId = session.data.receiptId as number;
        const telegramIdDesc = String(ctx.from.id);
        const descUser = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramIdDesc) });
        const descReceipt = await db.query.receiptsTable.findFirst({ where: eq(receiptsTable.id, receiptId) });
        if (!descUser || !descReceipt || descReceipt.userId !== descUser.id) {
          await clearSession(ctx.from.id); await ctx.reply("Access denied."); break;
        }
        await db.update(receiptsTable).set({ description: text, updatedAt: new Date() }).where(eq(receiptsTable.id, receiptId));
        await clearSession(ctx.from.id);
        await ctx.reply("✅ Description updated.");
        await showReceiptWithEditButtons(ctx, receiptId);
        break;
      }

      case "edit_amount": {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) {
          await ctx.reply("Please enter a valid amount:");
          return;
        }
        const receiptId = session.data.receiptId as number;
        const telegramIdAmt = String(ctx.from.id);
        const amtUser = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramIdAmt) });
        const receipt = await db.query.receiptsTable.findFirst({ where: eq(receiptsTable.id, receiptId) });
        if (!amtUser || !receipt || receipt.userId !== amtUser.id) {
          await clearSession(ctx.from.id); await ctx.reply("Access denied."); break;
        }
        const convRate = parseFloat(receipt.conversionRate);
        const converted = (amount * convRate).toFixed(2);
        await db.update(receiptsTable).set({
          amount: amount.toFixed(2),
          convertedAmount: converted,
          updatedAt: new Date(),
        }).where(eq(receiptsTable.id, receiptId));
        await clearSession(ctx.from.id);
        await ctx.reply("✅ Amount updated.");
        await showReceiptWithEditButtons(ctx, receiptId);
        break;
      }

      case "edit_date": {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
          await ctx.reply("Please enter a valid date (YYYY-MM-DD):");
          return;
        }
        const receiptId = session.data.receiptId as number;
        const telegramIdDate = String(ctx.from.id);
        const dateUser = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramIdDate) });
        const dateReceipt = await db.query.receiptsTable.findFirst({ where: eq(receiptsTable.id, receiptId) });
        if (!dateUser || !dateReceipt || dateReceipt.userId !== dateUser.id) {
          await clearSession(ctx.from.id); await ctx.reply("Access denied."); break;
        }
        await db.update(receiptsTable).set({ receiptDate: text, updatedAt: new Date() }).where(eq(receiptsTable.id, receiptId));
        await clearSession(ctx.from.id);
        await ctx.reply("✅ Date updated.");
        await showReceiptWithEditButtons(ctx, receiptId);
        break;
      }

      case "edit_currency": {
        const currency = text.toUpperCase();
        const receiptId = session.data.receiptId as number;
        const telegramIdCur = String(ctx.from.id);
        const curUser = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramIdCur) });
        const curReceipt = await db.query.receiptsTable.findFirst({ where: eq(receiptsTable.id, receiptId) });
        if (!curUser || !curReceipt || curReceipt.userId !== curUser.id) {
          await clearSession(ctx.from.id); await ctx.reply("Access denied."); break;
        }
        session.data.newCurrency = currency;
        session.step = "edit_currency_rate";
        await setSession(ctx.from.id, session);

        const receipt = curReceipt;
        if (receipt) {
          const company = await db.query.companiesTable.findFirst({ where: eq(companiesTable.id, receipt.companyId) });
          if (company && currency !== company.baseCurrency) {
            const { rate, source } = await getExchangeRate(currency, company.baseCurrency);
            session.data.suggestedRate = rate;
            await setSession(ctx.from.id, session);
            await ctx.reply(
              `Suggested rate for ${currency} → ${company.baseCurrency}: *${rate.toFixed(6)}* (${source})\n` +
              `Enter conversion rate or "ok" to use suggested:`,
              { parse_mode: "Markdown" }
            );
          } else {
            await db.update(receiptsTable).set({
              currency,
              conversionRate: "1.000000",
              convertedAmount: receipt.amount,
              updatedAt: new Date(),
            }).where(eq(receiptsTable.id, receiptId));
            await clearSession(ctx.from.id);
            await ctx.reply("✅ Currency updated (same as base currency, rate set to 1).");
            await showReceiptWithEditButtons(ctx, receiptId);
          }
        }
        break;
      }

      case "edit_currency_rate": {
        const receiptId = session.data.receiptId as number;
        let rate: number;
        if (text.toLowerCase() === "ok") {
          rate = session.data.suggestedRate as number || 1;
        } else {
          rate = parseFloat(text);
          if (isNaN(rate) || rate <= 0) {
            await ctx.reply("Please enter a valid rate or 'ok':");
            return;
          }
        }
        const telegramIdRate = String(ctx.from.id);
        const rateUser = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramIdRate) });
        const receipt = await db.query.receiptsTable.findFirst({ where: eq(receiptsTable.id, receiptId) });
        if (!rateUser || !receipt || receipt.userId !== rateUser.id) {
          await clearSession(ctx.from.id); await ctx.reply("Access denied."); break;
        }
        if (receipt) {
          const converted = (parseFloat(receipt.amount) * rate).toFixed(2);
          await db.update(receiptsTable).set({
            currency: session.data.newCurrency as string,
            conversionRate: rate.toFixed(6),
            convertedAmount: converted,
            updatedAt: new Date(),
          }).where(eq(receiptsTable.id, receiptId));
        }
        await clearSession(ctx.from.id);
        await ctx.reply("✅ Currency and conversion rate updated.");
        await showReceiptWithEditButtons(ctx, receiptId);
        break;
      }

      case "add_company_name": {
        session.data.companyName = text;
        session.step = "add_company_currency";
        await setSession(ctx.from.id, session);
        await ctx.reply("Enter the base currency for this company (e.g., USD, MYR, SGD):");
        break;
      }

      case "add_company_currency": {
        session.data.baseCurrency = text.toUpperCase();
        session.step = "add_company_cutoff_month";
        await setSession(ctx.from.id, session);
        await ctx.reply(
          "When is the claim cut-off — same month or the following month?",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Same month", callback_data: "add_co_cutoff_month_0" },
                  { text: "Following month", callback_data: "add_co_cutoff_month_1" },
                ],
              ],
            },
          }
        );
        break;
      }

      case "add_company_cutoff_day": {
        const day = parseInt(text, 10);
        if (isNaN(day) || day < 1 || day > 31) {
          await ctx.reply("Please enter a valid day (1-31):");
          return;
        }
        const addCutoffTime = "23:59";
        const addTelegramId = String(ctx.from.id);
        const addUser = await db.query.usersTable.findFirst({
          where: eq(usersTable.telegramId, addTelegramId),
        });
        if (!addUser) {
          await ctx.reply("User not found. Please /start first.");
          await clearSession(ctx.from.id);
          return;
        }

        const addMonthOffset = typeof session.data.cutoffMonthOffset === "number" ? session.data.cutoffMonthOffset : 1;
        await db.insert(companiesTable).values({
          userId: addUser.id,
          name: session.data.companyName as string,
          baseCurrency: session.data.baseCurrency as string,
          cutoffDay: day,
          cutoffTime: addCutoffTime,
          cutoffMonthOffset: addMonthOffset,
        });

        await clearSession(ctx.from.id);
        await ctx.reply(
          `✅ Company added successfully!\n\n` +
          `Company: *${session.data.companyName}*\n` +
          `Base Currency: *${session.data.baseCurrency}*\n` +
          `Cut-off: *${formatCutoffText(day, addCutoffTime, addMonthOffset)}*\n\n` +
          `Send a receipt photo anytime to submit an expense!`,
          { parse_mode: "Markdown" }
        );
        break;
      }

      case "add_category_name": {
        session.data.categoryName = text;
        session.step = "add_category_description";
        await setSession(ctx.from.id, session);
        await ctx.reply("Enter a description for this category (or send 'skip'):");
        break;
      }

      case "add_category_description": {
        const description = text.toLowerCase() === "skip" ? null : text;
        const telegramId = String(ctx.from.id);
        const user = await db.query.usersTable.findFirst({
          where: eq(usersTable.telegramId, telegramId),
        });
        if (!user) {
          await ctx.reply("User not found. Please /start first.");
          await clearSession(ctx.from.id);
          return;
        }

        await db.insert(categoriesTable).values({
          userId: user.id,
          name: session.data.categoryName as string,
          description,
          isSystem: false,
        });

        await clearSession(ctx.from.id);
        await ctx.reply(`✅ Category "${session.data.categoryName}" added!`);
        break;
      }

      case "edit_category_name": {
        const catId = session.data.categoryId as number;
        const newName = text.toLowerCase() === "skip" ? null : text;
        if (newName) {
          session.data.newCategoryName = newName;
        }
        session.step = "edit_category_description";
        await setSession(ctx.from.id, session);
        await ctx.reply("Enter the new description (or send 'skip' to keep current):");
        break;
      }

      case "edit_category_description": {
        const catId = session.data.categoryId as number;
        const newDesc = text.toLowerCase() === "skip" ? undefined : text;
        const updateData: Record<string, unknown> = {};
        if (session.data.newCategoryName) updateData.name = session.data.newCategoryName;
        if (newDesc !== undefined) updateData.description = newDesc;

        if (Object.keys(updateData).length > 0) {
          await db.update(categoriesTable).set(updateData).where(eq(categoriesTable.id, catId));
        }

        await clearSession(ctx.from.id);
        await ctx.reply("✅ Category updated! Use /categories to view your categories.");
        break;
      }

      case "edit_company_base_currency": {
        const companyId = session.data.companyId as number;
        const telegramId = String(ctx.from.id);
        const ownerUser = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
        const ownedCompany = await db.query.companiesTable.findFirst({ where: eq(companiesTable.id, companyId) });
        if (!ownerUser || !ownedCompany || ownedCompany.userId !== ownerUser.id) {
          await clearSession(ctx.from.id);
          await ctx.reply("Access denied.");
          break;
        }
        await db.update(companiesTable).set({
          baseCurrency: text.toUpperCase(),
          updatedAt: new Date(),
        }).where(eq(companiesTable.id, companyId));
        await clearSession(ctx.from.id);
        await ctx.reply(`✅ Base currency updated to ${text.toUpperCase()}.`);
        break;
      }

      case "edit_company_cutoff_day": {
        const day = parseInt(text, 10);
        if (isNaN(day) || day < 1 || day > 31) {
          await ctx.reply("Please enter a valid day (1-31):");
          return;
        }
        const editCompanyId = session.data.companyId as number;
        const editTelegramId = String(ctx.from.id);
        const editCutoffUser = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, editTelegramId) });
        const editCutoffCompany = await db.query.companiesTable.findFirst({ where: eq(companiesTable.id, editCompanyId) });
        if (!editCutoffUser || !editCutoffCompany || editCutoffCompany.userId !== editCutoffUser.id) {
          await clearSession(ctx.from.id);
          await ctx.reply("Access denied.");
          break;
        }
        const editMonthOffset = typeof session.data.cutoffMonthOffset === "number" ? session.data.cutoffMonthOffset : editCutoffCompany.cutoffMonthOffset;
        await db.update(companiesTable).set({
          cutoffDay: day,
          cutoffTime: "23:59",
          cutoffMonthOffset: editMonthOffset,
          updatedAt: new Date(),
        }).where(eq(companiesTable.id, editCompanyId));
        await clearSession(ctx.from.id);
        await ctx.reply(`✅ Cut-off updated: *${formatCutoffText(day, "23:59", editMonthOffset)}*`, { parse_mode: "Markdown" });
        break;
      }

      case "settings_name": {
        const telegramId = String(ctx.from.id);
        const user = await db.query.usersTable.findFirst({
          where: eq(usersTable.telegramId, telegramId),
        });
        if (user) {
          await db.update(usersTable).set({ name: text, updatedAt: new Date() }).where(eq(usersTable.id, user.id));
        }
        await clearSession(ctx.from.id);
        await ctx.reply(`✅ Name updated to "${text}".`);
        break;
      }

      case "settings_timezone": {
        if (!/^[+-]\d{2}:\d{2}$/.test(text)) {
          await ctx.reply("Please enter a valid timezone (e.g., +08:00):");
          return;
        }
        const telegramId = String(ctx.from.id);
        const user = await db.query.usersTable.findFirst({
          where: eq(usersTable.telegramId, telegramId),
        });
        if (user) {
          await db.update(usersTable).set({ timezone: text, updatedAt: new Date() }).where(eq(usersTable.id, user.id));
        }
        await clearSession(ctx.from.id);
        await ctx.reply(`✅ Timezone updated to ${text}.`);
        break;
      }

      default: {
        await clearSession(ctx.from.id);
        await ctx.reply("I didn't understand that. Use the menu or send a receipt photo.");
      }
    }
  });

  bot.telegram.setMyCommands([
    { command: "start", description: "Start or restart the bot" },
    { command: "help", description: "Show help and available commands" },
    { command: "receipts", description: "View your recent receipts" },
    { command: "companies", description: "Manage your companies" },
    { command: "categories", description: "Manage expense categories" },
    { command: "settings", description: "View and edit your profile" },
    { command: "cancel", description: "Cancel current operation" },
  ]).catch((err) => logger.error({ err }, "Failed to set bot commands"));

  const webAppUrl = getWebAppUrl();
  if (webAppUrl) {
    bot.telegram.setChatMenuButton({
      menuButton: {
        type: "web_app",
        text: "Launch Mini App",
        web_app: { url: webAppUrl },
      },
    }).catch((err) => logger.error({ err }, "Failed to set menu button"));
  }

  return bot;
}

async function processBulkPhotos(ctx: Context, mediaGroupId: string) {
  const group = mediaGroupBuffer.get(mediaGroupId);
  if (!group) return;
  mediaGroupBuffer.delete(mediaGroupId);

  const { dbUserId, photos } = group;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, dbUserId),
  });
  if (!user) return;

  const companies = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.userId, dbUserId));

  if (companies.length === 0) {
    await ctx.reply("You need to add at least one company first.\nUse Companies to add one.");
    return;
  }

  await ctx.reply(`📷 Processing ${photos.length} receipts with AI... This may take a moment.`);

  if (companies.length === 1) {
    const company = companies[0]!;
    for (const photo of photos) {
      try {
        const parsedItems = await parseReceiptImageMulti(photo.telegramImageUrl);
        const receiptImagePath = `receipts/${dbUserId}/${Date.now()}_${photo.fileId}.jpg`;
        const imageUrl = await uploadFromUrlToStorage(photo.telegramImageUrl, receiptImagePath, "image/jpeg");
        if (parsedItems.length > 1) {
          await ctx.reply(`📋 Detected *${parsedItems.length} separate items* in one image.`, { parse_mode: "Markdown" });
        }
        for (const parsed of parsedItems) {
          await autoSaveReceipt(ctx, user, company, parsed, imageUrl);
        }
      } catch (err) {
        logger.error({ err }, "Failed to process bulk photo");
        await ctx.reply("⚠️ Failed to process one of the receipts. Please try sending it again individually.");
      }
    }
  } else {
    const allItems: Array<{
      imageUrl: string;
      parsed: ParsedReceipt;
    }> = [];

    for (const photo of photos) {
      try {
        const parsedItems = await parseReceiptImageMulti(photo.telegramImageUrl);
        const receiptImagePath = `receipts/${dbUserId}/${Date.now()}_${photo.fileId}.jpg`;
        const imageUrl = await uploadFromUrlToStorage(photo.telegramImageUrl, receiptImagePath, "image/jpeg");
        for (const parsed of parsedItems) {
          allItems.push({ imageUrl, parsed });
        }
      } catch (err) {
        logger.error({ err }, "Failed to process bulk photo");
        await ctx.reply("⚠️ Failed to process one of the receipts. Please try sending it again individually.");
      }
    }

    if (allItems.length === 0) return;

    let summaryMsg = `✅ *Analyzed ${allItems.length} expense items from ${photos.length} image(s):*\n\n`;
    allItems.forEach((r, i) => {
      const desc = r.parsed.description || "Expense receipt";
      const amt = r.parsed.amount ? `${r.parsed.currency || "?"} ${r.parsed.amount}` : "Amount unclear";
      summaryMsg += `${i + 1}. ${desc} — ${amt}`;
      if (r.parsed.date) summaryMsg += ` | ${r.parsed.date}`;
      summaryMsg += `\n`;
    });
    await ctx.reply(summaryMsg, { parse_mode: "Markdown" });

    const queueId = makeBulkQueueId(group.userId);
    const queue: BulkReceiptQueue = {
      dbUserId,
      telegramId: group.userId,
      items: allItems,
      currentIndex: 0,
      savedCount: 0,
      transferCount: 0,
    };
    await saveBulkQueue(queueId, queue);

    await showNextBulkReceiptPrompt(ctx, queueId, companies);
  }
}

async function showReceiptWithEditButtons(ctx: Context, receiptId: number) {
  const receipt = await db.query.receiptsTable.findFirst({ where: eq(receiptsTable.id, receiptId) });
  if (!receipt) return;
  const company = await db.query.companiesTable.findFirst({ where: eq(companiesTable.id, receipt.companyId) });
  let categoryName: string | null = null;
  if (receipt.categoryId) {
    const cat = await db.query.categoriesTable.findFirst({ where: eq(categoriesTable.id, receipt.categoryId) });
    categoryName = cat?.name || null;
  }

  const companyName = company?.name || "Unknown";
  const convRate = parseFloat(receipt.conversionRate);
  const baseCurrency = company?.baseCurrency || receipt.currency;

  let msg = `📝 ${receipt.description}\n` +
    `💰 ${receipt.currency} ${receipt.amount}` +
    (convRate !== 1 ? ` → ${baseCurrency} ${receipt.convertedAmount}` : "") + `\n` +
    `📅 ${receipt.receiptDate}\n` +
    (categoryName ? `🏷️ ${categoryName}\n` : `🏷️ No category — please assign\n`) +
    `🏢 ${companyName}`;

  const webAppUrl = getWebAppUrl();
  const buttons: any[][] = [
    [
      Markup.button.callback("✏️ Edit", `quick_edit_${receiptId}`),
      Markup.button.callback("🗑️ Delete", `quick_delete_${receiptId}`),
    ],
  ];
  if (webAppUrl) {
    buttons.push([Markup.button.url("Open Portal", webAppUrl)]);
  }

  await ctx.reply(msg, Markup.inlineKeyboard(buttons));
}

async function autoSaveReceipt(
  ctx: Context,
  user: { id: number },
  company: { id: number; name: string; baseCurrency: string },
  parsed: ParsedReceipt,
  imageUrl: string,
  userCaption?: string
) {
  const rawAmount = parsed.amount ? parseFloat(parsed.amount) : 0;
  const amount = isNaN(rawAmount) ? 0 : rawAmount;
  const receiptCurrency = (parsed.currency || company.baseCurrency).toUpperCase();
  const receiptDate = parsed.date || new Date().toISOString().split("T")[0]!;

  let conversionRate = 1;
  if (receiptCurrency !== company.baseCurrency.toUpperCase()) {
    try {
      const rateResult = await getExchangeRate(receiptCurrency, company.baseCurrency);
      conversionRate = isNaN(rateResult.rate) ? 1 : rateResult.rate;
    } catch {}
  }
  const convertedAmount = (amount * conversionRate).toFixed(2);

  let categoryId: number | null = null;
  let categoryName: string | null = null;
  if (parsed.receiptType === "standard" && parsed.category) {
    const matchedCat = await db.query.categoriesTable.findFirst({
      where: and(
        eq(categoriesTable.name, parsed.category),
        or(eq(categoriesTable.isSystem, true), eq(categoriesTable.userId, user.id))
      ),
    });
    if (matchedCat) {
      categoryId = matchedCat.id;
      categoryName = matchedCat.name;
    }
  }

  const description = userCaption || parsed.description || "Expense receipt";

  let dupeWarning = "";
  try {
    const existing = await db
      .select({ id: receiptsTable.id })
      .from(receiptsTable)
      .where(
        and(
          eq(receiptsTable.userId, user.id),
          eq(receiptsTable.companyId, company.id),
          eq(receiptsTable.receiptDate, receiptDate),
          eq(receiptsTable.amount, amount.toFixed(2)),
          eq(receiptsTable.currency, receiptCurrency),
          eq(receiptsTable.description, description),
          imageUrl ? eq(receiptsTable.imageUrl, imageUrl) : undefined,
        )
      );
    if (existing.length > 0) {
      dupeWarning = "\n\n🔁 _Possible duplicate — a receipt with the same details already exists. Check the portal._";
    }
  } catch {}

  const [receipt] = await db
    .insert(receiptsTable)
    .values({
      userId: user.id,
      companyId: company.id,
      categoryId,
      description,
      receiptDate,
      currency: receiptCurrency,
      amount: amount.toFixed(2),
      conversionRate: conversionRate.toFixed(6),
      convertedAmount,
      imageUrl,
    })
    .returning();

  const isTransferNoCategory = parsed.receiptType === "transfer" && !categoryId;

  const msg =
    `✅ *Receipt saved!*\n\n` +
    `📝 ${description}\n` +
    `💰 ${receiptCurrency} ${amount.toFixed(2)}` +
    (conversionRate !== 1 ? ` → ${company.baseCurrency} ${convertedAmount}` : "") + `\n` +
    `📅 ${receiptDate}\n` +
    (categoryName ? `🏷️ ${categoryName}\n` : (isTransferNoCategory ? `🏷️ _No category — please assign_\n` : "")) +
    `🏢 ${company.name}` +
    dupeWarning;

  const webAppUrl = getWebAppUrl();
  const editButtons: any[][] = [
    [
      Markup.button.callback("✏️ Edit", `quick_edit_${receipt!.id}`),
      Markup.button.callback("🗑️ Delete", `quick_delete_${receipt!.id}`),
    ],
  ];
  if (webAppUrl) {
    editButtons.push([Markup.button.url("Open Portal", webAppUrl)]);
  }

  await ctx.reply(msg, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(editButtons),
  });
}

async function saveReceiptWithDescription(
  ctx: Context,
  session: SessionData,
  description: string
) {
  const userId = session.data.userId as number;
  const companyId = session.data.companyId as number;
  const companyName = session.data.companyName as string;
  const baseCurrency = session.data.baseCurrency as string;
  const imageUrl = session.data.imageUrl as string;
  const amount = session.data.amount as string;
  const currency = session.data.currency as string;
  const receiptDate = session.data.date as string;
  const conversionRate = session.data.conversionRate as number;
  const convertedAmount = session.data.convertedAmount as string;
  const categoryId = session.data.categoryId as number | null;
  const receiptType = session.data.receiptType as string;

  if (receiptType === "transfer" && !categoryId) {
    const categories = await db
      .select()
      .from(categoriesTable)
      .where(or(eq(categoriesTable.isSystem, true), eq(categoriesTable.userId, userId)));

    await setSession(ctx.from!.id, {
      step: "transfer_select_category",
      data: {
        ...session.data,
        description,
      },
    });

    const catButtons = categories.map((c) => [
      Markup.button.callback(c.name, `transfer_cat_${c.id}`),
    ]);

    await ctx.reply(
      `🏦 *Bank transfer detected*\n\n` +
      `💰 ${currency} ${amount}\n` +
      `📅 ${receiptDate}\n` +
      `📝 ${description}\n` +
      `🏢 ${companyName}\n\n` +
      `Please select a category for this expense:`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard(catButtons) }
    );
    return;
  }

  const [receipt] = await db
    .insert(receiptsTable)
    .values({
      userId,
      companyId,
      categoryId,
      description,
      receiptDate,
      currency,
      amount,
      conversionRate: conversionRate.toFixed(6),
      convertedAmount,
      imageUrl,
    })
    .returning();

  await clearSession(ctx.from!.id);

  const category = categoryId
    ? await db.query.categoriesTable.findFirst({ where: eq(categoriesTable.id, categoryId) })
    : null;

  const msg =
    `✅ *Receipt saved!*\n\n` +
    `📝 ${description}\n` +
    `💰 ${currency} ${amount}` +
    (conversionRate !== 1 ? ` → ${baseCurrency} ${convertedAmount}` : "") + `\n` +
    `📅 ${receiptDate}\n` +
    (category ? `🏷️ ${category.name}\n` : "") +
    `🏢 ${companyName}`;

  const webAppUrl = getWebAppUrl();
  const editButtons: any[][] = [
    [
      Markup.button.callback("✏️ Edit", `quick_edit_${receipt!.id}`),
      Markup.button.callback("🗑️ Delete", `quick_delete_${receipt!.id}`),
    ],
  ];
  if (webAppUrl) {
    editButtons.push([
      Markup.button.url("Open Portal", webAppUrl),
    ]);
  }

  await ctx.reply(msg, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(editButtons),
  });
}

async function finalizeReceipt(ctx: Context, session: SessionData) {
  const amount = parseFloat(session.data.amount as string);
  const conversionRate = (session.data.conversionRate as number) || 1;
  const convertedAmount = (amount * conversionRate).toFixed(2);

  const [receipt] = await db
    .insert(receiptsTable)
    .values({
      userId: session.data.userId as number,
      companyId: session.data.companyId as number,
      categoryId: (session.data.categoryId as number) || null,
      description: session.data.description as string,
      receiptDate: session.data.date as string,
      currency: (session.data.currency as string).toUpperCase(),
      amount: amount.toFixed(2),
      conversionRate: conversionRate.toFixed(6),
      convertedAmount,
      imageUrl: (session.data.imageUrl as string) || null,
    })
    .returning();

  const company = await db.query.companiesTable.findFirst({
    where: eq(companiesTable.id, session.data.companyId as number),
  });

  await clearSession(ctx.from!.id);

  const msg =
    `✅ *Receipt Saved!*\n\n` +
    `Company: *${company?.name}*\n` +
    `Description: ${session.data.description}\n` +
    `Date: ${session.data.date}\n` +
    `Amount: *${(session.data.currency as string).toUpperCase()} ${amount.toFixed(2)}*\n` +
    (conversionRate !== 1
      ? `Conversion Rate: ${conversionRate.toFixed(6)}\n` +
        `Converted: *${company?.baseCurrency} ${convertedAmount}*\n`
      : "") +
    `\nReceipt ID: #${receipt!.id}`;

  await ctx.reply(msg, { parse_mode: "Markdown" });
}

async function startReceiptSubmission(ctx: Context) {
  const telegramId = String(ctx.from!.id);
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });

  if (!user) {
    await ctx.reply("Please /start first to set up your account.");
    return;
  }

  const companies = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.userId, user.id));

  if (companies.length === 0) {
    await ctx.reply("You need to add at least one company first. Use Companies to add one.");
    return;
  }

  await ctx.reply(
    "📸 Send me your receipt and I'll analyze it automatically.\n\n" +
    "📎 Supported formats:\n" +
    "• Images: JPG, JPEG, PNG, HEIC\n" +
    "• Documents: PDF\n\n" +
    "You can send a photo directly or attach a file."
  );
}

async function handleMyReceipts(ctx: Context) {
  const telegramId = String(ctx.from!.id);
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });

  if (!user) {
    await ctx.reply("Please /start first.");
    return;
  }

  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const startDate = `${month}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const endDate = `${month}-${lastDay}`;

  const receipts = await db
    .select({
      id: receiptsTable.id,
      description: receiptsTable.description,
      receiptDate: receiptsTable.receiptDate,
      currency: receiptsTable.currency,
      amount: receiptsTable.amount,
      convertedAmount: receiptsTable.convertedAmount,
      companyName: companiesTable.name,
      categoryName: categoriesTable.name,
    })
    .from(receiptsTable)
    .leftJoin(companiesTable, eq(receiptsTable.companyId, companiesTable.id))
    .leftJoin(categoriesTable, eq(receiptsTable.categoryId, categoriesTable.id))
    .where(
      and(
        eq(receiptsTable.userId, user.id),
        gte(receiptsTable.receiptDate, startDate),
        lte(receiptsTable.receiptDate, endDate)
      )
    )
    .orderBy(receiptsTable.receiptDate);

  if (receipts.length === 0) {
    await ctx.reply(`No receipts for ${month}. Send a photo to submit one!`);
    return;
  }

  let msg = `📋 *Your Receipts (${month}):*\n\n`;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]!;
    const seq = i + 1;
    msg += `${seq}. ${r.receiptDate} | ${r.companyName}\n`;
    msg += `  ${r.description}\n`;
    msg += `  ${r.currency} ${parseFloat(r.amount).toFixed(2)}`;
    if (r.convertedAmount !== r.amount) {
      msg += ` → ${parseFloat(r.convertedAmount).toFixed(2)}`;
    }
    msg += `\n\n`;
  }
  msg += `Total: ${receipts.length} receipt(s)`;

  const buttons = receipts.slice(0, 10).map((r, i) => [
    Markup.button.callback(`✏️ #${i + 1}`, `edit_receipt_${r.id}`),
    Markup.button.callback(`🗑️ #${i + 1}`, `delete_receipt_${r.id}`),
  ]);

  await ctx.reply(msg, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
}

async function handleCompanies(ctx: Context) {
  const telegramId = String(ctx.from!.id);
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });

  if (!user) {
    await ctx.reply("Please /start first.");
    return;
  }

  const companies = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.userId, user.id));

  let msg = "🏢 *Your Companies:*\n\n";
  if (companies.length === 0) {
    msg += "No companies added yet.";
  } else {
    for (const c of companies) {
      msg += `• *${c.name}* — ${c.baseCurrency}\n  Cut-off: ${formatCutoffText(c.cutoffDay, c.cutoffTime, c.cutoffMonthOffset)}\n\n`;
    }
  }

  const buttons = companies.map((c) => [
    Markup.button.callback(`📋 ${c.name}`, `view_company_${c.id}`),
  ]);
  buttons.push([Markup.button.callback("➕ Add Company", "add_company")]);

  await ctx.reply(msg, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
}

async function handleCompaniesInline(ctx: Context) {
  const telegramId = String(ctx.from!.id);
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });

  if (!user) return;

  const companies = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.userId, user.id));

  let msg = "🏢 *Your Companies:*\n\n";
  for (const c of companies) {
    msg += `• *${c.name}* — ${c.baseCurrency}\n  Cut-off: ${formatCutoffText(c.cutoffDay, c.cutoffTime, c.cutoffMonthOffset)}\n\n`;
  }

  const buttons = companies.map((c) => [
    Markup.button.callback(`📋 ${c.name}`, `view_company_${c.id}`),
  ]);
  buttons.push([Markup.button.callback("➕ Add Company", "add_company")]);

  await ctx.editMessageText(msg, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
}

async function handleCategories(ctx: Context) {
  const telegramId = String(ctx.from!.id);
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });

  if (!user) {
    await ctx.reply("Please /start first.");
    return;
  }

  const categories = await db
    .select()
    .from(categoriesTable)
    .where(
      or(
        eq(categoriesTable.isSystem, true),
        eq(categoriesTable.userId, user.id)
      )
    );

  let msg = "📁 *Categories:*\n\n";
  const systemCats = categories.filter((c) => c.isSystem);
  const customCats = categories.filter((c) => !c.isSystem);

  msg += "*System Categories:*\n\n";
  for (const c of systemCats) {
    msg += `  • *${c.name}*\n`;
    if (c.examples) msg += `    _Examples: ${c.examples}_\n`;
    msg += "\n";
  }

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];

  if (customCats.length > 0) {
    msg += "*Your Custom Categories:*\n\n";
    for (const c of customCats) {
      msg += `  • *${c.name}*`;
      if (c.description) msg += ` — ${c.description}`;
      msg += "\n\n";
      buttons.push([
        Markup.button.callback(`✏️ Edit ${c.name}`, `edit_category_${c.id}`),
        Markup.button.callback(`🗑️ Delete ${c.name}`, `delete_category_${c.id}`),
      ]);
    }
  }

  buttons.push([Markup.button.callback("➕ Add Category", "add_category")]);

  await ctx.reply(msg, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
}

async function handleClaimForms(ctx: Context) {
  const telegramId = String(ctx.from!.id);
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });

  if (!user) {
    await ctx.reply("Please /start first.");
    return;
  }

  const companies = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.userId, user.id));

  if (companies.length === 0) {
    await ctx.reply("No companies found. Add a company first.");
    return;
  }

  const now = new Date();
  const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  let msg = "📊 *Claim Forms:*\n\n";
  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];

  for (const company of companies) {
    const period = await db.query.claimPeriodsTable.findFirst({
      where: and(
        eq(claimPeriodsTable.companyId, company.id),
        eq(claimPeriodsTable.periodLabel, currentPeriod)
      ),
    });

    const receiptCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(receiptsTable)
      .where(
        and(
          eq(receiptsTable.userId, user.id),
          eq(receiptsTable.companyId, company.id)
        )
      );

    msg += `*${company.name}* (${company.baseCurrency})\n`;
    msg += `  Receipts: ${receiptCount[0]?.count || 0}\n`;
    msg += `  Cut-off: ${formatCutoffText(company.cutoffDay, company.cutoffTime, company.cutoffMonthOffset)}\n`;

    if (period) {
      msg += `  Status: ${period.status}\n`;
      if (period.status === "completed") {
        buttons.push([
          Markup.button.callback(`📄 PDF - ${company.name}`, `download_pdf_${period.id}`),
          Markup.button.callback(`📊 Excel - ${company.name}`, `download_excel_${period.id}`),
        ]);
      }
    }
    msg += "\n";
  }

  if (buttons.length === 0) {
    msg += "_Claim forms will be generated at each company's cut-off date/time._";
  }

  await ctx.reply(msg, {
    parse_mode: "Markdown",
    ...(buttons.length > 0 ? Markup.inlineKeyboard(buttons) : {}),
  });
}

async function handleDownload(ctx: Context) {
  const telegramId = String(ctx.from!.id);
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });

  if (!user) {
    await ctx.reply("Please /start first.");
    return;
  }

  const periods = await db
    .select({
      id: claimPeriodsTable.id,
      periodLabel: claimPeriodsTable.periodLabel,
      status: claimPeriodsTable.status,
      baseCurrency: claimPeriodsTable.baseCurrency,
      companyName: companiesTable.name,
    })
    .from(claimPeriodsTable)
    .leftJoin(companiesTable, eq(claimPeriodsTable.companyId, companiesTable.id))
    .where(eq(claimPeriodsTable.userId, user.id))
    .orderBy(claimPeriodsTable.periodLabel);

  const completed = periods.filter((p) => p.status === "completed");

  if (completed.length === 0) {
    await ctx.reply("No completed claim forms available for download yet.");
    return;
  }

  const buttons = completed.flatMap((p) => [
    [
      Markup.button.callback(
        `📄 PDF - ${p.companyName} (${p.periodLabel})`,
        `download_pdf_${p.id}`
      ),
      Markup.button.callback(
        `📊 Excel - ${p.companyName} (${p.periodLabel})`,
        `download_excel_${p.id}`
      ),
    ],
  ]);

  await ctx.reply("📥 *Download Claim Forms:*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
}

async function handleSettings(ctx: Context) {
  const telegramId = String(ctx.from!.id);
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });

  if (!user) {
    await ctx.reply("Please /start first.");
    return;
  }

  await ctx.reply(
    `⚙️ *Settings*\n\n` +
    `Name: *${user.name}*\n` +
    `Timezone: *${user.timezone}*\n\n` +
    `What would you like to change?`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✏️ Edit Name", "settings_edit_name")],
        [Markup.button.callback("🕐 Edit Timezone", "settings_edit_timezone")],
      ]),
    }
  );
}

async function sendHelp(ctx: Context) {
  await ctx.reply(
    `❓ *Claimbase Bot Help*\n\n` +
    `*Submitting Receipts:*\n` +
    `📸 Send a photo or PDF of your receipt, and I'll extract the amount and date automatically. Then just fill in the details!\n` +
    `📎 Supported: JPG, JPEG, PNG, HEIC, PDF\n\n` +
    `*Commands:*\n` +
    `/start — Start or restart the bot\n` +
    `/receipts — View current month's receipts\n` +
    `/companies — Manage your companies\n` +
    `/categories — View and manage categories\n` +
    `/claims — View claim forms\n` +
    `/download — Download claim forms\n` +
    `/settings — Edit your profile\n` +
    `/cancel — Cancel current operation\n` +
    `/help — Show this help\n\n` +
    `*How it works:*\n` +
    `1. Send receipt photos or PDFs anytime during the month\n` +
    `2. Select company, enter details\n` +
    `3. At your company's cut-off date/time, I'll compile your claim form\n` +
    `4. Download as PDF or Excel\n`,
    { parse_mode: "Markdown" }
  );
}
