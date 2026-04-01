import { pgTable, serial, integer, varchar, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { receiptsTable } from "./receipts";

export const resolvedFlagsTable = pgTable("resolved_flags", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  receiptId: integer("receipt_id").notNull().references(() => receiptsTable.id, { onDelete: "cascade" }),
  flagType: varchar("flag_type", { length: 20 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("resolved_flags_user_receipt_flag_idx").on(table.userId, table.receiptId, table.flagType),
]);
