import app from "./app";
import { logger } from "./lib/logger";
import { createBot } from "./bot";
import { startScheduler } from "./lib/scheduler";
import { seedDefaultCategories } from "./lib/seed";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

seedDefaultCategories().catch((err) => {
  logger.error({ err }, "Failed to seed default categories");
});

const botToken = process.env["TELEGRAM_BOT_TOKEN"];

if (botToken) {
  const bot = createBot();

  bot.launch().then(() => {
    logger.info("Telegram bot started (polling mode)");
  }).catch((err) => {
    logger.error({ err }, "Failed to start Telegram bot");
  });

  startScheduler(bot);

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
} else {
  logger.warn("TELEGRAM_BOT_TOKEN not set — bot and scheduler disabled, API-only mode");
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
