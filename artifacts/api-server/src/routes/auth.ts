import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, assistantConfigs, autoReplyRules, businessProfiles, channels, onboardingStates, users, workspaceMembers, workspaces } from "@workspace/db";
import { z } from "zod";
import { clearSessionCookie, getAuth, hashPassword, setSessionCookie, verifyPassword } from "../lib/auth";

const router: IRouter = Router();
const credentials = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(8),
});

const sessionPayload = (auth: ReturnType<typeof getAuth>) => ({
  user: { id: auth.userId, email: auth.email, emailVerified: auth.emailVerified },
  workspace: { id: auth.workspaceId },
});

router.post("/auth/register", async (req, res, next) => {
  try {
    const input = credentials.parse(req.body);
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
    if (existing.length) return res.status(409).json({ error: "EMAIL_EXISTS", message: "An account with this email already exists." });

    const created = await db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ email: input.email, passwordHash: hashPassword(input.password) }).returning();
      const [workspace] = await tx.insert(workspaces).values({ name: "" }).returning();
      await tx.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role: "OWNER" });
      await tx.insert(onboardingStates).values({ workspaceId: workspace.id, currentStep: 1, completedSteps: [] });
      await tx.insert(businessProfiles).values({ workspaceId: workspace.id, country: "" });
      await tx.insert(assistantConfigs).values({ workspaceId: workspace.id, status: "PAUSED", language: "ar" });
      await tx.insert(channels).values([
        { workspaceId: workspace.id, type: "WHATSAPP", provider: "", status: "NOT_CONNECTED" },
        { workspaceId: workspace.id, type: "INSTAGRAM", provider: "", status: "NOT_CONNECTED" },
      ]);
      return { user, workspace };
    });

    await setSessionCookie(res, created.user.id);
    return res.status(201).json({
      user: { id: created.user.id, email: created.user.email, emailVerified: false },
      workspace: { id: created.workspace.id },
      onboardingCompleted: false,
      requiresEmailVerification: true,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/auth/login", async (req, res, next) => {
  try {
    const input = credentials.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
    if (!user || !verifyPassword(input.password, user.passwordHash)) return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Email or password is incorrect." });
    await setSessionCookie(res, user.id);
    const [membership] = await db.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, user.id)).limit(1);
    if (!membership) return res.status(409).json({ error: "WORKSPACE_MISSING", message: "This account does not have a workspace." });
    return res.json({
      user: { id: user.id, email: user.email, emailVerified: Boolean(user.emailVerifiedAt) },
      workspace: { id: membership.workspaceId },
      onboardingCompleted: false,
      requiresEmailVerification: !user.emailVerifiedAt,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/auth/session", async (req, res, next) => {
  try {
    const fakeResponse = res;
    const token = req.cookies?.fc_session as string | undefined;
    if (!token) return res.json({ authenticated: false });
    const authRouter = await import("../lib/auth");
    const result = await new Promise<Response>((resolve) => {
      authRouter.authRequired(req, fakeResponse, () => resolve(fakeResponse));
    });
    if (result.statusCode !== 200) return res.json({ authenticated: false });
    const auth = authRouter.getAuth(res);
    const [state] = await db.select({ completedAt: onboardingStates.completedAt }).from(onboardingStates).where(eq(onboardingStates.workspaceId, auth.workspaceId)).limit(1);
    return res.json({ authenticated: true, ...sessionPayload(auth), onboardingCompleted: Boolean(state?.completedAt) });
  } catch (error) {
    return next(error);
  }
});

router.post("/auth/logout", async (req, res, next) => {
  try {
    await clearSessionCookie(req, res);
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

export default router;