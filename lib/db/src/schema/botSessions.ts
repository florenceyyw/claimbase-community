import { pgTable, bigint, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const botSessionsTable = pgTable("bot_sessions", {
  telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
  step: text("step").notNull(),
  data: jsonb("data").notNull().default({}),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
