import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, assistantConfigs, businessProfiles, channels, onboardingStates, sessions, users, workspaceMembers, workspaces } from "@workspace/db";
import {
  clearSessionCookie,
  consumeAuthToken,
  consumeLatestAuthToken,
  createAuthToken,
  getAuthFromRequest,
  hashPassword,
  setSessionCookie,
  verifyPassword,
} from "../lib/auth";
import { sendAuthEmail } from "../lib/email";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const normalizedEmail = (value: unknown) => {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
};

const credentialsFrom = (body: unknown) => {
  const value = body as Record<string, unknown> | null;
  const email = normalizedEmail(value?.email);
  const password = typeof value?.password === "string" ? value.password : "";
  return email && password.length >= 8 ? { email, password } : null;
};

const tokenFrom = (body: unknown) => {
  const value = body as Record<string, unknown> | null;
  return typeof value?.token === "string" && value.token.length >= 20 ? value.token : null;
};

const actionUrl = (path: string, token: string) => {
  const configuredOrigin = process.env.PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (!configuredOrigin) {
    if (process.env.NODE_ENV !== "production" && process.env.AUTH_EMAIL_DELIVERY_IN_DEV !== "true") {
      return `http://localhost${path}?token=${encodeURIComponent(token)}`;
    }
    throw new Error("PUBLIC_APP_URL is required for authentication email delivery.");
  }
  const origin = new URL(configuredOrigin);
  if (origin.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new Error("PUBLIC_APP_URL must use HTTPS in production.");
  }
  return `${origin.origin}${path}?token=${encodeURIComponent(token)}`;
};

const sessionPayload = (auth: NonNullable<Awaited<ReturnType<typeof getAuthFromRequest>>>) => ({
  user: { id: auth.userId, email: auth.email, emailVerified: auth.emailVerified },
  workspace: { id: auth.workspaceId },
});

router.post("/auth/register", async (req, res, next) => {
  try {
    const input = credentialsFrom(req.body);
    if (!input) return res.status(400).json({ error: "INVALID_REGISTRATION", message: "Enter a valid email and a password with at least 8 characters." });
    const businessName = typeof req.body?.businessName === "string" ? req.body.businessName.trim().slice(0, 120) : "";
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
    if (existing.length) return res.status(409).json({ error: "EMAIL_EXISTS", message: "An account with this email already exists." });

    const created = await db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ email: input.email, passwordHash: hashPassword(input.password) }).returning();
      const [workspace] = await tx.insert(workspaces).values({ name: businessName }).returning();
      await tx.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role: "OWNER" });
      await tx.insert(onboardingStates).values({ workspaceId: workspace.id, currentStep: 1, completedSteps: [] });
      await tx.insert(businessProfiles).values({ workspaceId: workspace.id, businessName, country: "" });
      await tx.insert(assistantConfigs).values({ workspaceId: workspace.id, status: "PAUSED", language: "ar" });
      await tx.insert(channels).values([
        { workspaceId: workspace.id, type: "WHATSAPP", provider: "", status: "NOT_CONNECTED" },
        { workspaceId: workspace.id, type: "INSTAGRAM", provider: "", status: "NOT_CONNECTED" },
      ]);
      return { user, workspace };
    });

    const token = await createAuthToken(created.user.id, "email_verification");
    try {
      await sendAuthEmail({
        to: created.user.email,
        type: "email_verification",
        actionUrl: actionUrl("/verify-email", token),
      });
    } catch (error) {
      await db.delete(users).where(eq(users.id, created.user.id));
      throw error;
    }
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
    const input = credentialsFrom(req.body);
    if (!input) return res.status(400).json({ error: "INVALID_LOGIN", message: "Enter a valid email and password." });
    const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
    if (!user || !verifyPassword(input.password, user.passwordHash)) return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Email or password is incorrect." });
    const [membership] = await db.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, user.id)).limit(1);
    if (!membership) return res.status(409).json({ error: "WORKSPACE_MISSING", message: "This account does not have a workspace." });
    await setSessionCookie(res, user.id);
    const [state] = await db.select({ completedAt: onboardingStates.completedAt }).from(onboardingStates).where(eq(onboardingStates.workspaceId, membership.workspaceId)).limit(1);
    return res.json({
      user: { id: user.id, email: user.email, emailVerified: Boolean(user.emailVerifiedAt) },
      workspace: { id: membership.workspaceId },
      onboardingCompleted: Boolean(state?.completedAt),
      requiresEmailVerification: !user.emailVerifiedAt,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/auth/session", async (req, res, next) => {
  try {
    const token = req.cookies?.fc_session as string | undefined;
    const auth = await getAuthFromRequest(req);
    if (!auth) {
      if (token) res.clearCookie("fc_session", { httpOnly: true, sameSite: "lax", path: "/" });
      return res.json({ authenticated: false, reason: token ? "SESSION_EXPIRED" : "AUTH_REQUIRED" });
    }
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

router.post("/auth/resend-verification", async (req, res, next) => {
  try {
    const auth = await getAuthFromRequest(req);
    if (!auth) return res.status(401).json({ error: "AUTH_REQUIRED", message: "Please sign in to continue." });
    const token = await createAuthToken(auth.userId, "email_verification");
    await sendAuthEmail({
      to: auth.email,
      type: "email_verification",
      actionUrl: actionUrl("/verify-email", token),
    });
    return res.json({
      message: "If this account needs verification, a new verification link has been sent.",
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/auth/verify-email", async (req, res, next) => {
  try {
    const token = tokenFrom(req.body);
    if (!token) return res.status(400).json({ error: "INVALID_VERIFICATION_TOKEN", message: "Enter a valid verification token." });
    const userId = await consumeAuthToken(token, "email_verification");
    if (!userId) return res.status(400).json({ error: "INVALID_VERIFICATION_TOKEN", message: "This verification link is invalid or has expired." });
    const [user] = await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId)).returning({ id: users.id, email: users.email, emailVerifiedAt: users.emailVerifiedAt });
    return res.json({ message: "Your email has been verified.", user: { id: user.id, email: user.email, emailVerified: Boolean(user.emailVerifiedAt) } });
  } catch (error) {
    return next(error);
  }
});

router.post("/auth/verify-email/dev", async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === "production") return res.status(404).json({ error: "NOT_FOUND", message: "Not found." });
    const auth = await getAuthFromRequest(req);
    if (!auth) return res.status(401).json({ error: "AUTH_REQUIRED", message: "Please sign in to continue." });
    if (auth.emailVerified) return res.json({ message: "Your email has already been verified." });
    const userId = await consumeLatestAuthToken(auth.userId, "email_verification");
    if (!userId) return res.status(400).json({ error: "INVALID_VERIFICATION_TOKEN", message: "No active verification request was found." });
    const [user] = await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId)).returning({ id: users.id, email: users.email, emailVerifiedAt: users.emailVerifiedAt });
    return res.json({ message: "Your email has been verified.", user: { id: user.id, email: user.email, emailVerified: Boolean(user.emailVerifiedAt) } });
  } catch (error) {
    return next(error);
  }
});

router.post("/auth/forgot-password", async (req, res, next) => {
  try {
    const email = normalizedEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: "INVALID_EMAIL", message: "Enter a valid email address." });
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (user) {
      const token = await createAuthToken(user.id, "password_reset");
      await sendAuthEmail({
        to: email,
        type: "password_reset",
        actionUrl: actionUrl("/reset-password", token),
      }).catch((error) => logger.error({ err: error }, "Password reset email delivery failed"));
    }
    return res.status(202).json({ message: "If an account exists for that email, a password reset link has been sent." });
  } catch (error) {
    return next(error);
  }
});

router.post("/auth/reset-password", async (req, res, next) => {
  try {
    const token = tokenFrom(req.body);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!token || password.length < 8) return res.status(400).json({ error: "INVALID_PASSWORD_RESET", message: "Enter a valid reset token and a password with at least 8 characters." });
    const userId = await consumeAuthToken(token, "password_reset");
    if (!userId) return res.status(400).json({ error: "INVALID_RESET_TOKEN", message: "This reset link is invalid or has expired." });
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: hashPassword(password) }).where(eq(users.id, userId));
      await tx.delete(sessions).where(eq(sessions.userId, userId));
    });
    await clearSessionCookie(req, res);
    return res.json({ message: "Your password has been reset. Please sign in again." });
  } catch (error) {
    return next(error);
  }
});

export default router;