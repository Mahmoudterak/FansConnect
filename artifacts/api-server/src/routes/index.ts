import { Router, type IRouter } from "express";
import healthRouter from "./health";
import plansRouter from "./plans";
import channelsRouter from "./channels";

const router: IRouter = Router();

router.use(healthRouter);
router.use(plansRouter);
router.use(channelsRouter);

export default router;
