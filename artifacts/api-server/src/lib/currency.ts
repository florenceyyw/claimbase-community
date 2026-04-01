import { logger } from "./logger";

interface RateCache {
  rate: number;
  timestamp: number;
}

const rateCache = new Map<string, RateCache>();
const CACHE_TTL = 3600000;

export async function getExchangeRate(from: string, to: string): Promise<{ rate: number; source: string }> {
  if (from.toUpperCase() === to.toUpperCase()) {
    return { rate: 1, source: "identity" };
  }

  const cacheKey = `${from.toUpperCase()}_${to.toUpperCase()}`;
  const cached = rateCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { rate: cached.rate, source: "cached" };
  }

  try {
    const response = await fetch(
      `https://api.exchangerate-api.com/v4/latest/${from.toUpperCase()}`
    );
    if (!response.ok) {
      throw new Error(`Exchange rate API returned ${response.status}`);
    }
    const data = await response.json() as { rates: Record<string, number> };
    const rate = data.rates[to.toUpperCase()];
    if (rate === undefined) {
      throw new Error(`Rate not found for ${to}`);
    }

    rateCache.set(cacheKey, { rate, timestamp: Date.now() });
    return { rate, source: "exchangerate-api.com" };
  } catch (error) {
    logger.error({ error, from, to }, "Failed to fetch exchange rate");

    if (cached) {
      return { rate: cached.rate, source: "cached (stale)" };
    }

    return { rate: 1, source: "fallback" };
  }
}
