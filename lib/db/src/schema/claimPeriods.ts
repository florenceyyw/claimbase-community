import { pgTable, serial, integer, varchar, timestamp, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { companiesTable } from "./companies";

export const claimPeriodsTable = pgTable("claim_periods", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  periodLabel: varchar("period_label", { length: 50 }).notNull(),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("open"),
  pdfUrl: text("pdf_url"),
  excelUrl: text("excel_url"),
  baseCurrency: varchar("base_currency", { length: 10 }).notNull(),
  totalAmount: varchar("total_amount", { length: 50 }),
  downloadedAt: timestamp("downloaded_at"),
  submittedAt: timestamp("submitted_at"),
  receiptCount: integer("receipt_count"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertClaimPeriodSchema = createInsertSchema(claimPeriodsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertClaimPeriod = z.infer<typeof insertClaimPeriodSchema>;
export type ClaimPeriod = typeof claimPeriodsTable.$inferSelect;
