import { Router, type IRouter } from "express";
import { getExchangeRate } from "../lib/currency";

const router: IRouter = Router();

router.get("/currency/rate", async (req, res) => {
  const from = req.query.from as string;
  const to = req.query.to as string;

  if (!from || !to) {
    res.status(400).json({ error: "Both 'from' and 'to' query parameters are required" });
    return;
  }

  const { rate, source } = await getExchangeRate(from, to);
  res.json({
    from: from.toUpperCase(),
    to: to.toUpperCase(),
    rate,
    source,
    timestamp: new Date().toISOString(),
  });
});

export default router;
