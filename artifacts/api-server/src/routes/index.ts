import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import companiesRouter from "./companies";
import categoriesRouter from "./categories";
import receiptsRouter from "./receipts";
import currencyRouter from "./currencyRoute";
import claimsRouter from "./claims";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usersRouter);
router.use(companiesRouter);
router.use(categoriesRouter);
router.use(receiptsRouter);
router.use(currencyRouter);
router.use(claimsRouter);
router.use(storageRouter);

export default router;
