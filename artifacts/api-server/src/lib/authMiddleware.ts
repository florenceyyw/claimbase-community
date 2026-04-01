import { type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { usersTable, companiesTable, receiptsTable, claimPeriodsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { validateTelegramInitData } from "./telegramAuth";
import { verifySessionToken } from "./session";

declare global {
  namespace Express {
    interface Request {
      authUser?: {
        id: number;
        telegramId: string;
        name: string;
        timezone: string;
      };
    }
  }
}

function tryMockAuth(initData: string): string | null {
  if (process.env.NODE_ENV !== "development") return null;
  const params = new URLSearchParams(initData);
  if (params.get("hash") !== "mock") return null;
  const userStr = params.get("user");
  if (!userStr) return null;
  try {
    const user = JSON.parse(userStr);
    if (user.id) return String(user.id);
  } catch {}
  return null;
}

function extractTelegramId(req: Request): string | null {
  const initData = req.headers["x-telegram-init-data"] as string | undefined;
  if (initData) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      const result = validateTelegramInitData(initData, botToken);
      if (result.valid && result.telegramId) {
        return result.telegramId;
      }
    }
    const mockId = tryMockAuth(initData);
    if (mockId) return mockId;
    return null;
  }

  const authHeader = req.headers["authorization"] as string | undefined;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const session = verifySessionToken(token);
    if (session) return session.telegramId;
  }

  const queryToken = req.query?.token as string | undefined;
  if (queryToken) {
    const session = verifySessionToken(queryToken);
    if (session) return session.telegramId;
  }

  const internalKey = req.headers["x-internal-key"] as string | undefined;
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (internalKey && internalSecret && internalKey === internalSecret) {
    const telegramId = req.headers["x-telegram-id"] as string | undefined;
    return telegramId || null;
  }

  return null;
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const telegramId = extractTelegramId(req);
  if (telegramId) {
    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.telegramId, telegramId),
    });
    if (user) {
      req.authUser = {
        id: user.id,
        telegramId: user.telegramId,
        name: user.name,
        timezone: user.timezone,
      };
    }
  }
  next();
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const telegramId = extractTelegramId(req);
  if (!telegramId) {
    res.status(401).json({ error: "Authentication required. Provide valid Telegram Web App init data." });
    return;
  }
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }
  req.authUser = {
    id: user.id,
    telegramId: user.telegramId,
    name: user.name,
    timezone: user.timezone,
  };
  next();
}

export function requireInternalAuth(req: Request, res: Response, next: NextFunction) {
  const internalKey = req.headers["x-internal-key"] as string | undefined;
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!internalKey || !internalSecret || internalKey !== internalSecret) {
    res.status(401).json({ error: "Internal authentication required" });
    return;
  }
  next();
}

export async function verifyUserOwnership(req: Request, res: Response, next: NextFunction) {
  const userId = parseInt(String(req.params.userId), 10);
  if (req.authUser && req.authUser.id !== userId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
}

export async function verifyCompanyOwnership(req: Request, res: Response, next: NextFunction) {
  const companyId = parseInt(String(req.params.companyId), 10);
  if (!req.authUser) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const company = await db.query.companiesTable.findFirst({
    where: eq(companiesTable.id, companyId),
  });
  if (!company) {
    res.status(404).json({ error: "Company not found" });
    return;
  }
  if (company.userId !== req.authUser.id) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
}

export async function verifyReceiptOwnership(req: Request, res: Response, next: NextFunction) {
  const receiptId = parseInt(String(req.params.receiptId), 10);
  if (!req.authUser) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const receipt = await db.query.receiptsTable.findFirst({
    where: eq(receiptsTable.id, receiptId),
  });
  if (!receipt) {
    res.status(404).json({ error: "Receipt not found" });
    return;
  }
  if (receipt.userId !== req.authUser.id) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
}

export async function verifyClaimPeriodOwnership(req: Request, res: Response, next: NextFunction) {
  const periodId = parseInt(String(req.params.periodId), 10);
  if (!req.authUser) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const period = await db.query.claimPeriodsTable.findFirst({
    where: eq(claimPeriodsTable.id, periodId),
  });
  if (!period) {
    res.status(404).json({ error: "Claim period not found" });
    return;
  }
  if (period.userId !== req.authUser.id) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
}
