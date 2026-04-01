import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { categoriesTable } from "@workspace/db/schema";
import { eq, or } from "drizzle-orm";
import { requireAuth } from "../lib/authMiddleware";

const router: IRouter = Router();

router.get("/categories", requireAuth, async (req, res) => {
  const userId = req.authUser!.id;

  const categories = await db
    .select()
    .from(categoriesTable)
    .where(
      or(
        eq(categoriesTable.isSystem, true),
        eq(categoriesTable.userId, userId)
      )
    );

  res.json(categories);
});

router.post("/categories", requireAuth, async (req, res) => {
  const userId = req.authUser!.id;
  const { name, description, examples } = req.body;
  const [category] = await db
    .insert(categoriesTable)
    .values({
      userId,
      name,
      description: description || null,
      examples: examples || null,
      isSystem: false,
    })
    .returning();
  res.status(201).json(category);
});

router.put("/categories/:categoryId", requireAuth, async (req, res) => {
  const categoryId = parseInt(String(req.params.categoryId), 10);
  const existing = await db.query.categoriesTable.findFirst({
    where: eq(categoriesTable.id, categoryId),
  });
  if (!existing) {
    res.status(404).json({ error: "Category not found" });
    return;
  }
  if (existing.isSystem) {
    res.status(403).json({ error: "Cannot modify system categories" });
    return;
  }
  if (existing.userId !== req.authUser!.id) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.description !== undefined) updates.description = req.body.description;
  if (req.body.examples !== undefined) updates.examples = req.body.examples;

  const [updated] = await db
    .update(categoriesTable)
    .set(updates)
    .where(eq(categoriesTable.id, categoryId))
    .returning();
  res.json(updated);
});

router.delete("/categories/:categoryId", requireAuth, async (req, res) => {
  const categoryId = parseInt(String(req.params.categoryId), 10);
  const existing = await db.query.categoriesTable.findFirst({
    where: eq(categoriesTable.id, categoryId),
  });
  if (!existing) {
    res.status(404).json({ error: "Category not found" });
    return;
  }
  if (existing.isSystem) {
    res.status(403).json({ error: "Cannot delete system categories" });
    return;
  }
  if (existing.userId !== req.authUser!.id) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  await db.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
  res.status(204).send();
});

export default router;
