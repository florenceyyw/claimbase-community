import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { claimPeriodsTable, companiesTable, receiptsTable } from "@workspace/db/schema";
import { eq, and, sql, isNull, or } from "drizzle-orm";
import { generatePDF, generateExcel, generateReceiptProofsPDF } from "../lib/claimGenerator";
import { requireAuth, verifyUserOwnership, verifyClaimPeriodOwnership } from "../lib/authMiddleware";

const router: IRouter = Router();

router.get("/users/:userId/claim-periods", requireAuth, verifyUserOwnership, async (req, res) => {
  const userId = parseInt(String(req.params.userId), 10);
  const companyId = req.query.companyId ? parseInt(req.query.companyId as string, 10) : null;

  const conditions = [eq(claimPeriodsTable.userId, userId)];
  if (companyId) {
    conditions.push(eq(claimPeriodsTable.companyId, companyId));
  }

  const periods = await db
    .select({
      id: claimPeriodsTable.id,
      userId: claimPeriodsTable.userId,
      companyId: claimPeriodsTable.companyId,
      periodLabel: claimPeriodsTable.periodLabel,
      periodStart: claimPeriodsTable.periodStart,
      periodEnd: claimPeriodsTable.periodEnd,
      status: claimPeriodsTable.status,
      pdfUrl: claimPeriodsTable.pdfUrl,
      excelUrl: claimPeriodsTable.excelUrl,
      baseCurrency: claimPeriodsTable.baseCurrency,
      totalAmount: claimPeriodsTable.totalAmount,
      downloadedAt: claimPeriodsTable.downloadedAt,
      submittedAt: claimPeriodsTable.submittedAt,
      receiptCount: claimPeriodsTable.receiptCount,
      companyName: companiesTable.name,
      createdAt: claimPeriodsTable.createdAt,
      updatedAt: claimPeriodsTable.updatedAt,
    })
    .from(claimPeriodsTable)
    .leftJoin(companiesTable, eq(claimPeriodsTable.companyId, companiesTable.id))
    .where(and(...conditions))
    .orderBy(claimPeriodsTable.periodLabel);

  res.json(periods);
});

router.post("/users/:userId/claim-periods", requireAuth, verifyUserOwnership, async (req, res) => {
  const userId = parseInt(String(req.params.userId), 10);
  const { companyId, periodLabel, periodStart, periodEnd, rateOverrides, receiptIds } = req.body;

  if (!companyId || !periodLabel || !periodStart || !periodEnd) {
    res.status(400).json({ error: "companyId, periodLabel, periodStart, and periodEnd are required" });
    return;
  }

  const startDate = new Date(periodStart);
  const endDate = new Date(periodEnd);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    res.status(400).json({ error: "Invalid periodStart or periodEnd date" });
    return;
  }
  if (startDate >= endDate) {
    res.status(400).json({ error: "periodStart must be before periodEnd" });
    return;
  }

  const company = await db.query.companiesTable.findFirst({
    where: and(eq(companiesTable.id, companyId), eq(companiesTable.userId, userId)),
  });
  if (!company) {
    res.status(404).json({ error: "Company not found" });
    return;
  }

  try {
    const hasSpecificReceipts = Array.isArray(receiptIds) && receiptIds.length > 0;
    const targetReceiptIds: number[] = [];

    if (hasSpecificReceipts) {
      for (const rid of receiptIds) {
        const id = parseInt(String(rid), 10);
        if (isNaN(id)) continue;
        const r = await db.query.receiptsTable.findFirst({
          where: and(
            eq(receiptsTable.id, id),
            eq(receiptsTable.userId, userId),
            eq(receiptsTable.companyId, companyId),
            isNull(receiptsTable.claimPeriodId)
          ),
        });
        if (r) targetReceiptIds.push(id);
      }
      if (targetReceiptIds.length === 0) {
        res.status(400).json({ error: "No valid unclaimed receipts found for the selected IDs." });
        return;
      }
    } else {
      const unclaimed = await db
        .select({ id: receiptsTable.id })
        .from(receiptsTable)
        .where(
          and(
            eq(receiptsTable.userId, userId),
            eq(receiptsTable.companyId, companyId),
            isNull(receiptsTable.claimPeriodId),
            or(
              eq(receiptsTable.claimMonth, periodLabel),
              and(
                isNull(receiptsTable.claimMonth),
                sql`to_char(${receiptsTable.receiptDate}::timestamp, 'YYYY-MM') = ${periodLabel}`
              )
            )
          )
        );
      for (const r of unclaimed) targetReceiptIds.push(r.id);
      if (targetReceiptIds.length === 0) {
        res.status(400).json({ error: "No unclaimed receipts found. Upload receipts before generating a claim." });
        return;
      }
    }

    if (Array.isArray(rateOverrides) && rateOverrides.length > 0) {
      for (const override of rateOverrides) {
        const receiptId = parseInt(String(override.receiptId), 10);
        const rate = parseFloat(String(override.rate));
        if (isNaN(receiptId) || isNaN(rate) || rate <= 0) continue;
        if (!targetReceiptIds.includes(receiptId)) continue;

        const receipt = await db.query.receiptsTable.findFirst({
          where: and(eq(receiptsTable.id, receiptId), eq(receiptsTable.userId, userId)),
        });
        if (!receipt) continue;

        const amount = parseFloat(receipt.amount);
        const convertedAmount = (isNaN(amount) ? 0 : amount * rate).toFixed(2);
        await db
          .update(receiptsTable)
          .set({ conversionRate: rate.toFixed(6), convertedAmount })
          .where(eq(receiptsTable.id, receiptId));
      }
    }

    const [period] = await db
      .insert(claimPeriodsTable)
      .values({
        userId,
        companyId,
        periodLabel,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        status: "processing",
        baseCurrency: company.baseCurrency,
        receiptCount: targetReceiptIds.length,
      })
      .returning();

    await db
      .update(receiptsTable)
      .set({ claimPeriodId: period!.id, updatedAt: new Date() })
      .where(
        and(
          eq(receiptsTable.userId, userId),
          isNull(receiptsTable.claimPeriodId),
          sql`${receiptsTable.id} = ANY(${sql.raw(`ARRAY[${targetReceiptIds.join(",")}]`)})`
        )
      );

    try {
      await generatePDF(period!.id);
      await generateExcel(period!.id);

      const totalResult = await db
        .select({ total: sql<string>`COALESCE(SUM(${receiptsTable.convertedAmount}), 0)` })
        .from(receiptsTable)
        .where(eq(receiptsTable.claimPeriodId, period!.id));

      await db
        .update(claimPeriodsTable)
        .set({
          status: "completed",
          pdfUrl: `/api/claim-periods/${period!.id}/download/pdf`,
          excelUrl: `/api/claim-periods/${period!.id}/download/excel`,
          totalAmount: parseFloat(totalResult[0]?.total || "0").toFixed(2),
          updatedAt: new Date(),
        })
        .where(eq(claimPeriodsTable.id, period!.id));
    } catch (genError) {
      await db
        .update(claimPeriodsTable)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(claimPeriodsTable.id, period!.id));
      req.log.error({ genError }, "Claim form generation failed");
    }

    const result = await db
      .select({
        id: claimPeriodsTable.id,
        userId: claimPeriodsTable.userId,
        companyId: claimPeriodsTable.companyId,
        periodLabel: claimPeriodsTable.periodLabel,
        periodStart: claimPeriodsTable.periodStart,
        periodEnd: claimPeriodsTable.periodEnd,
        status: claimPeriodsTable.status,
        pdfUrl: claimPeriodsTable.pdfUrl,
        excelUrl: claimPeriodsTable.excelUrl,
        baseCurrency: claimPeriodsTable.baseCurrency,
        totalAmount: claimPeriodsTable.totalAmount,
        downloadedAt: claimPeriodsTable.downloadedAt,
        submittedAt: claimPeriodsTable.submittedAt,
        receiptCount: claimPeriodsTable.receiptCount,
        companyName: companiesTable.name,
        createdAt: claimPeriodsTable.createdAt,
        updatedAt: claimPeriodsTable.updatedAt,
      })
      .from(claimPeriodsTable)
      .leftJoin(companiesTable, eq(claimPeriodsTable.companyId, companiesTable.id))
      .where(eq(claimPeriodsTable.id, period!.id));

    res.status(201).json(result[0]);
  } catch (error) {
    req.log.error({ error }, "Failed to create claim period");
    res.status(500).json({ error: "Failed to create claim period" });
  }
});

router.post("/claim-periods/:periodId/generate", requireAuth, verifyClaimPeriodOwnership, async (req, res) => {
  const periodId = parseInt(String(req.params.periodId), 10);
  const { format, rateOverrides } = req.body;

  if (!["pdf", "excel", "both"].includes(format)) {
    res.status(400).json({ error: "Invalid format. Use 'pdf', 'excel', or 'both'" });
    return;
  }

  const period = await db.query.claimPeriodsTable.findFirst({
    where: eq(claimPeriodsTable.id, periodId),
  });

  if (!period) {
    res.status(404).json({ error: "Claim period not found" });
    return;
  }

  if (period.status !== "completed" && period.status !== "processing") {
    const company = await db.query.companiesTable.findFirst({
      where: eq(companiesTable.id, period.companyId),
    });
    if (company) {
      const now = new Date();
      const periodEnd = new Date(period.periodEnd);
      const [cutH, cutM] = (company.cutoffTime || "23:59").split(":").map(Number) as [number, number];
      periodEnd.setUTCHours(cutH, cutM, 0, 0);
      if (now < periodEnd) {
        res.status(400).json({ error: "Claim period has not reached cutoff yet. Forms can only be generated after the cut-off date." });
        return;
      }
    }
  }

  try {
    if (Array.isArray(rateOverrides) && rateOverrides.length > 0) {
      const claimedReceipts = await db
        .select({ id: receiptsTable.id })
        .from(receiptsTable)
        .where(eq(receiptsTable.claimPeriodId, periodId));
      const claimedIds = new Set(claimedReceipts.map(r => r.id));

      for (const override of rateOverrides) {
        const receiptId = parseInt(String(override.receiptId), 10);
        const rate = parseFloat(String(override.rate));
        if (isNaN(receiptId) || isNaN(rate) || rate <= 0) continue;
        if (!claimedIds.has(receiptId)) continue;

        const receipt = await db.query.receiptsTable.findFirst({
          where: eq(receiptsTable.id, receiptId),
        });
        if (!receipt) continue;

        const amount = parseFloat(receipt.amount);
        const convertedAmount = (amount * rate).toFixed(2);

        await db
          .update(receiptsTable)
          .set({
            conversionRate: rate.toString(),
            convertedAmount,
          })
          .where(eq(receiptsTable.id, receiptId));
      }
    }

    let pdfUrl = period.pdfUrl;
    let excelUrl = period.excelUrl;

    if (format === "pdf" || format === "both") {
      await generatePDF(periodId);
      pdfUrl = `/api/claim-periods/${periodId}/download/pdf`;
    }

    if (format === "excel" || format === "both") {
      await generateExcel(periodId);
      excelUrl = `/api/claim-periods/${periodId}/download/excel`;
    }

    await db
      .update(claimPeriodsTable)
      .set({ pdfUrl, excelUrl, status: "completed", updatedAt: new Date() })
      .where(eq(claimPeriodsTable.id, periodId));

    res.json({
      periodId,
      pdfUrl,
      excelUrl,
      status: "completed",
    });
  } catch (error) {
    req.log.error({ error }, "Failed to generate claim form");
    res.status(500).json({ error: "Failed to generate claim form" });
  }
});

router.get("/claim-periods/:periodId/download/receipt-proofs", requireAuth, verifyClaimPeriodOwnership, async (req, res) => {
  const periodId = parseInt(String(req.params.periodId), 10);

  const period = await db.query.claimPeriodsTable.findFirst({
    where: eq(claimPeriodsTable.id, periodId),
  });

  if (!period) {
    res.status(404).json({ error: "Claim period not found" });
    return;
  }

  const company = await db.query.companiesTable.findFirst({
    where: eq(companiesTable.id, period.companyId),
  });

  const companyName = company?.name?.replace(/[^a-zA-Z0-9]/g, "_") || "Company";
  const filename = `Receipt_Proofs_${companyName}_${period.periodLabel}`;

  try {
    const buffer = await generateReceiptProofsPDF(periodId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
    res.send(buffer);
  } catch (error: any) {
    if (error?.message?.includes("No receipt images") || error?.message?.includes("No receipt files")) {
      res.status(404).json({ error: "No receipt files found for this period" });
      return;
    }
    req.log.error({ error }, "Failed to download receipt proofs");
    res.status(500).json({ error: "Failed to generate receipt proofs" });
  }
});

router.get("/claim-periods/:periodId/download/:format", requireAuth, verifyClaimPeriodOwnership, async (req, res) => {
  const periodId = parseInt(String(req.params.periodId), 10);
  const format = String(req.params.format);

  const period = await db.query.claimPeriodsTable.findFirst({
    where: eq(claimPeriodsTable.id, periodId),
  });

  if (!period) {
    res.status(404).json({ error: "Claim period not found" });
    return;
  }

  if (period.status !== "completed") {
    res.status(400).json({ error: "Claim form not yet generated. Please wait for cut-off processing." });
    return;
  }

  const company = await db.query.companiesTable.findFirst({
    where: eq(companiesTable.id, period.companyId),
  });

  const companyName = company?.name?.replace(/[^a-zA-Z0-9]/g, "_") || "Company";
  const filename = `Claim_${companyName}_${period.periodLabel}`;

  try {
    if (!period.downloadedAt) {
      await db
        .update(claimPeriodsTable)
        .set({ downloadedAt: new Date(), updatedAt: new Date() })
        .where(eq(claimPeriodsTable.id, periodId));
    }

    if (format === "pdf") {
      const buffer = await generatePDF(periodId);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
      res.send(buffer);
    } else if (format === "excel") {
      const buffer = await generateExcel(periodId);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
      res.send(buffer);
    } else {
      res.status(400).json({ error: "Invalid format. Use 'pdf' or 'excel'" });
    }
  } catch (error) {
    req.log.error({ error }, "Failed to download claim form");
    res.status(500).json({ error: "Failed to generate claim form" });
  }
});

router.delete("/claim-periods/:periodId", requireAuth, verifyClaimPeriodOwnership, async (req, res) => {
  const periodId = parseInt(String(req.params.periodId), 10);

  const period = await db.query.claimPeriodsTable.findFirst({
    where: eq(claimPeriodsTable.id, periodId),
  });

  if (!period) {
    res.status(404).json({ error: "Claim period not found" });
    return;
  }

  await db
    .update(receiptsTable)
    .set({ claimPeriodId: null, updatedAt: new Date() })
    .where(eq(receiptsTable.claimPeriodId, periodId));

  await db
    .delete(claimPeriodsTable)
    .where(eq(claimPeriodsTable.id, periodId));

  res.json({ message: "Claim deleted and receipts released" });
});

router.post("/claim-periods/:periodId/submit", requireAuth, verifyClaimPeriodOwnership, async (req, res) => {
  const periodId = parseInt(String(req.params.periodId), 10);

  const period = await db.query.claimPeriodsTable.findFirst({
    where: eq(claimPeriodsTable.id, periodId),
  });

  if (!period) {
    res.status(404).json({ error: "Claim period not found" });
    return;
  }

  if (period.status !== "completed") {
    res.status(400).json({ error: "Claim must be completed before marking as submitted" });
    return;
  }

  const now = new Date();
  const isSubmitted = !!period.submittedAt;

  await db
    .update(claimPeriodsTable)
    .set({
      submittedAt: isSubmitted ? null : now,
      updatedAt: now,
    })
    .where(eq(claimPeriodsTable.id, periodId));

  res.json({ 
    periodId,
    submittedAt: isSubmitted ? null : now.toISOString(),
    message: isSubmitted ? "Claim unmarked as submitted" : "Claim marked as submitted"
  });
});

export default router;
