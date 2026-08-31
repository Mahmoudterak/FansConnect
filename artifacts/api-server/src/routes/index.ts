import { Router, type IRouter } from "express";
import healthRouter from "./health";
import plansRouter from "./plans";

const router: IRouter = Router();

router.use(healthRouter);
router.use(plansRouter);

export default router;
