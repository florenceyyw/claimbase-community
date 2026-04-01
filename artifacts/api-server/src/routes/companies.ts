import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { companiesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, verifyUserOwnership, verifyCompanyOwnership } from "../lib/authMiddleware";

const router: IRouter = Router();

router.get("/users/:userId/companies", requireAuth, verifyUserOwnership, async (req, res) => {
  const userId = parseInt(String(req.params.userId), 10);
  const companies = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.userId, userId));
  res.json(companies);
});

router.post("/users/:userId/companies", requireAuth, verifyUserOwnership, async (req, res) => {
  const userId = parseInt(String(req.params.userId), 10);
  const { name, baseCurrency, cutoffDay, cutoffTime, cutoffMonthOffset } = req.body;
  const [company] = await db
    .insert(companiesTable)
    .values({
      userId,
      name,
      baseCurrency: baseCurrency || "USD",
      cutoffDay: cutoffDay || 31,
      cutoffTime: cutoffTime || "23:59",
      cutoffMonthOffset: cutoffMonthOffset !== undefined ? cutoffMonthOffset : 1,
    })
    .returning();
  res.status(201).json(company);
});

router.put("/companies/:companyId", requireAuth, verifyCompanyOwnership, async (req, res) => {
  const companyId = parseInt(String(req.params.companyId), 10);
  const updates: Record<string, unknown> = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.baseCurrency !== undefined) updates.baseCurrency = req.body.baseCurrency;
  if (req.body.cutoffDay !== undefined) updates.cutoffDay = req.body.cutoffDay;
  if (req.body.cutoffTime !== undefined) updates.cutoffTime = req.body.cutoffTime;
  if (req.body.cutoffMonthOffset !== undefined) updates.cutoffMonthOffset = req.body.cutoffMonthOffset;
  updates.updatedAt = new Date();

  const [updated] = await db
    .update(companiesTable)
    .set(updates)
    .where(eq(companiesTable.id, companyId))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Company not found" });
    return;
  }
  res.json(updated);
});

router.delete("/companies/:companyId", requireAuth, verifyCompanyOwnership, async (req, res) => {
  const companyId = parseInt(String(req.params.companyId), 10);
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  res.status(204).send();
});

export default router;
