import { Router, type IRouter } from "express";
import healthRouter from "./health";
import plansRouter from "./plans";
import channelsRouter from "./channels";
import authRouter from "./auth";
import workspaceRouter from "./workspace";
import workspacesRouter from "./workspaces";
import { authRequired, workspaceAccessRequired } from "../lib/auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(plansRouter);
router.use(authRouter);
router.use("/workspaces/:workspaceId", authRequired, workspaceAccessRequired);
router.use(workspacesRouter);
router.use(channelsRouter);
router.use(authRouter);
router.use(workspaceRouter);

export default router;
