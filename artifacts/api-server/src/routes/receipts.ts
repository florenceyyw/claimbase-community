import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { receiptsTable, categoriesTable, companiesTable, resolvedFlagsTable } from "@workspace/db/schema";
import { eq, and, gte, lte } from "drizzle-orm";
import { parseReceiptImage } from "../lib/ai";
import { requireAuth, verifyUserOwnership, verifyReceiptOwnership } from "../lib/authMiddleware";

const router: IRouter = Router();

router.get("/users/:userId/receipts", requireAuth, verifyUserOwnership, async (req, res) => {
  const userId = parseInt(String(req.params.userId), 10);
  const companyId = req.query.companyId ? parseInt(req.query.companyId as string, 10) : null;
  const month = req.query.month as string | undefined;

  const conditions = [eq(receiptsTable.userId, userId)];
  if (companyId) {
    conditions.push(eq(receiptsTable.companyId, companyId));
  }
  if (month) {
    const [year, mon] = month.split("-").map(Number) as [number, number];
    const startDate = `${year}-${String(mon).padStart(2, "0")}-01`;
    const lastDay = new Date(year, mon, 0).getDate();
    const endDate = `${year}-${String(mon).padStart(2, "0")}-${lastDay}`;
    conditions.push(gte(receiptsTable.receiptDate, startDate));
    conditions.push(lte(receiptsTable.receiptDate, endDate));
  }

  const receipts = await db
    .select({
      id: receiptsTable.id,
      userId: receiptsTable.userId,
      companyId: receiptsTable.companyId,
      categoryId: receiptsTable.categoryId,
      claimPeriodId: receiptsTable.claimPeriodId,
      description: receiptsTable.description,
      receiptDate: receiptsTable.receiptDate,
      currency: receiptsTable.currency,
      amount: receiptsTable.amount,
      conversionRate: receiptsTable.conversionRate,
      convertedAmount: receiptsTable.convertedAmount,
      imageUrl: receiptsTable.imageUrl,
      claimMonth: receiptsTable.claimMonth,
      categoryName: categoriesTable.name,
      companyName: companiesTable.name,
      createdAt: receiptsTable.createdAt,
      updatedAt: receiptsTable.updatedAt,
    })
    .from(receiptsTable)
    .leftJoin(categoriesTable, eq(receiptsTable.categoryId, categoriesTable.id))
    .leftJoin(companiesTable, eq(receiptsTable.companyId, companiesTable.id))
    .where(and(...conditions))
    .orderBy(receiptsTable.receiptDate);

  res.json(receipts);
});

router.post("/users/:userId/receipts", requireAuth, verifyUserOwnership, async (req, res) => {
  const userId = parseInt(String(req.params.userId), 10);
  const {
    companyId,
    categoryId,
    description,
    receiptDate,
    currency,
    amount,
    conversionRate,
    convertedAmount,
    imageUrl,
    claimMonth,
  } = req.body;

  if (claimMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(claimMonth)) {
    res.status(400).json({ error: "claimMonth must be YYYY-MM format" });
    return;
  }

  const company = await db.query.companiesTable.findFirst({
    where: and(eq(companiesTable.id, companyId), eq(companiesTable.userId, userId)),
  });
  if (!company) {
    res.status(403).json({ error: "Company does not belong to this user" });
    return;
  }

  if (categoryId !== undefined && categoryId !== null) {
    const category = await db.query.categoriesTable.findFirst({
      where: eq(categoriesTable.id, categoryId),
    });
    if (!category) {
      res.status(404).json({ error: "Category not found" });
      return;
    }
    if (!category.isSystem && category.userId !== userId) {
      res.status(403).json({ error: "Category does not belong to this user" });
      return;
    }
  }

  const [receipt] = await db
    .insert(receiptsTable)
    .values({
      userId,
      companyId,
      categoryId: categoryId || null,
      description,
      receiptDate,
      currency,
      amount,
      conversionRate: conversionRate || "1.000000",
      convertedAmount,
      imageUrl: imageUrl || null,
      claimMonth: claimMonth || null,
    })
    .returning();

  res.status(201).json(receipt);
});

router.get("/receipts/:receiptId", requireAuth, verifyReceiptOwnership, async (req, res) => {
  const receiptId = parseInt(String(req.params.receiptId), 10);
  const results = await db
    .select({
      id: receiptsTable.id,
      userId: receiptsTable.userId,
      companyId: receiptsTable.companyId,
      categoryId: receiptsTable.categoryId,
      claimPeriodId: receiptsTable.claimPeriodId,
      description: receiptsTable.description,
      receiptDate: receiptsTable.receiptDate,
      currency: receiptsTable.currency,
      amount: receiptsTable.amount,
      conversionRate: receiptsTable.conversionRate,
      convertedAmount: receiptsTable.convertedAmount,
      imageUrl: receiptsTable.imageUrl,
      claimMonth: receiptsTable.claimMonth,
      categoryName: categoriesTable.name,
      companyName: companiesTable.name,
      createdAt: receiptsTable.createdAt,
      updatedAt: receiptsTable.updatedAt,
    })
    .from(receiptsTable)
    .leftJoin(categoriesTable, eq(receiptsTable.categoryId, categoriesTable.id))
    .leftJoin(companiesTable, eq(receiptsTable.companyId, companiesTable.id))
    .where(eq(receiptsTable.id, receiptId));

  if (results.length === 0) {
    res.status(404).json({ error: "Receipt not found" });
    return;
  }
  res.json(results[0]);
});

router.put("/receipts/:receiptId", requireAuth, verifyReceiptOwnership, async (req, res) => {
  const receiptId = parseInt(String(req.params.receiptId), 10);
  const userId = req.authUser!.id;

  if (req.body.companyId !== undefined) {
    const company = await db.query.companiesTable.findFirst({
      where: and(eq(companiesTable.id, req.body.companyId), eq(companiesTable.userId, userId)),
    });
    if (!company) {
      res.status(403).json({ error: "Company does not belong to this user" });
      return;
    }
  }

  if (req.body.categoryId !== undefined && req.body.categoryId !== null) {
    const category = await db.query.categoriesTable.findFirst({
      where: eq(categoriesTable.id, req.body.categoryId),
    });
    if (!category) {
      res.status(404).json({ error: "Category not found" });
      return;
    }
    if (!category.isSystem && category.userId !== userId) {
      res.status(403).json({ error: "Category does not belong to this user" });
      return;
    }
  }

  if (req.body.claimMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(req.body.claimMonth)) {
    res.status(400).json({ error: "claimMonth must be YYYY-MM format" });
    return;
  }

  const updates: Record<string, unknown> = {};
  const fields = ["companyId", "categoryId", "description", "receiptDate", "currency", "amount", "conversionRate", "convertedAmount", "imageUrl", "claimMonth"];
  for (const field of fields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }
  updates.updatedAt = new Date();

  const [updated] = await db
    .update(receiptsTable)
    .set(updates)
    .where(eq(receiptsTable.id, receiptId))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Receipt not found" });
    return;
  }
  res.json(updated);
});

router.delete("/receipts/:receiptId", requireAuth, verifyReceiptOwnership, async (req, res) => {
  const receiptId = parseInt(String(req.params.receiptId), 10);
  await db.delete(receiptsTable).where(eq(receiptsTable.id, receiptId));
  res.status(204).send();
});

router.post("/receipts/parse-image", requireAuth, async (req, res) => {
  const { imageUrl } = req.body;
  if (!imageUrl) {
    res.status(400).json({ error: "imageUrl is required" });
    return;
  }

  let resolvedUrl = imageUrl;
  let isPdf = false;
  let pdfBuffer: Buffer | null = null;

  if (imageUrl.startsWith("/objects/") || imageUrl.startsWith("objects/")) {
    try {
      const { ObjectStorageService } = await import("../lib/objectStorage");
      const storage = new ObjectStorageService();
      const file = await storage.getObjectEntityFile(
        imageUrl.startsWith("/") ? imageUrl : `/${imageUrl}`
      );
      const [buffer] = await file.download();
      const [metadata] = await file.getMetadata();
      const mime = (metadata.contentType as string) || "image/jpeg";

      if (mime === "application/pdf") {
        isPdf = true;
        pdfBuffer = buffer;
      } else {
        resolvedUrl = `data:${mime};base64,${buffer.toString("base64")}`;
      }
    } catch (err) {
      req.log.error({ err }, "Failed to download file for parsing");
      res.status(400).json({ error: "Could not access the uploaded file" });
      return;
    }
  }

  const { parseReceiptPdf: parsePdf } = await import("../lib/ai");
  const result = isPdf && pdfBuffer
    ? await parsePdf(pdfBuffer)
    : await parseReceiptImage(resolvedUrl);
  res.json(result);
});

router.get("/users/:userId/resolved-flags", requireAuth, verifyUserOwnership, async (req, res) => {
  const userId = parseInt(String(req.params.userId), 10);
  const flags = await db
    .select({ receiptId: resolvedFlagsTable.receiptId, flagType: resolvedFlagsTable.flagType })
    .from(resolvedFlagsTable)
    .where(eq(resolvedFlagsTable.userId, userId));
  res.json(flags);
});

router.post("/users/:userId/resolved-flags", requireAuth, verifyUserOwnership, async (req, res) => {
  const userId = parseInt(String(req.params.userId), 10);
  const { receiptId, flagType } = req.body;
  if (!receiptId || !flagType) return res.status(400).json({ error: "receiptId and flagType required" });
  const validFlagTypes = ["dupe", "purpose"];
  if (!validFlagTypes.includes(flagType)) return res.status(400).json({ error: "Invalid flagType" });
  const receipt = await db.select({ id: receiptsTable.id }).from(receiptsTable)
    .where(and(eq(receiptsTable.id, receiptId), eq(receiptsTable.userId, userId)));
  if (receipt.length === 0) return res.status(404).json({ error: "Receipt not found" });
  const existing = await db.select({ id: resolvedFlagsTable.id }).from(resolvedFlagsTable)
    .where(and(
      eq(resolvedFlagsTable.userId, userId),
      eq(resolvedFlagsTable.receiptId, receiptId),
      eq(resolvedFlagsTable.flagType, flagType),
    ));
  if (existing.length > 0) return res.json({ ok: true });
  await db.insert(resolvedFlagsTable).values({ userId, receiptId, flagType });
  res.json({ ok: true });
});

export default router;
