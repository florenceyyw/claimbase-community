import { pgTable, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

export const bulkQueuesTable = pgTable("bulk_queues", {
  id: text("id").primaryKey(),
  telegramId: integer("telegram_id").notNull(),
  dbUserId: integer("db_user_id").notNull(),
  items: jsonb("items").notNull().default([]),
  currentIndex: integer("current_index").notNull().default(0),
  savedCount: integer("saved_count").notNull().default(0),
  transferCount: integer("transfer_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
