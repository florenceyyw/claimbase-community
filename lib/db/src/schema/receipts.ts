import { pgTable, serial, integer, varchar, text, numeric, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { companiesTable } from "./companies";
import { categoriesTable } from "./categories";

export const receiptsTable = pgTable("receipts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  categoryId: integer("category_id").references(() => categoriesTable.id, { onDelete: "set null" }),
  claimPeriodId: integer("claim_period_id"),
  description: text("description").notNull(),
  receiptDate: date("receipt_date").notNull(),
  currency: varchar("currency", { length: 10 }).notNull(),
  amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
  conversionRate: numeric("conversion_rate", { precision: 15, scale: 6 }).notNull().default("1.000000"),
  convertedAmount: numeric("converted_amount", { precision: 15, scale: 2 }).notNull(),
  imageUrl: text("image_url"),
  claimMonth: varchar("claim_month", { length: 7 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertReceiptSchema = createInsertSchema(receiptsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertReceipt = z.infer<typeof insertReceiptSchema>;
export type Receipt = typeof receiptsTable.$inferSelect;
