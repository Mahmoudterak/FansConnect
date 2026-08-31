import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { authTokens, db, sessions, users, workspaceMembers } from "@workspace/db";

const SESSION_COOKIE = "fc_session";
const SESSION_DAYS = 30;
const ACTION_TOKEN_HOURS = 24;

export type AuthTokenType = "email_verification" | "password_reset";

export type AuthContext = {
  userId: string;
  workspaceId: string;
  email: string;
  emailVerified: boolean;
  role: string;
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
};

export const verifyPassword = (password: string, stored: string) => {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
};

export const createAuthToken = async (userId: string, type: AuthTokenType) => {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ACTION_TOKEN_HOURS * 60 * 60 * 1000);
  await db.delete(authTokens).where(and(eq(authTokens.userId, userId), eq(authTokens.type, type)));
  await db.insert(authTokens).values({ tokenHash: digest(token), userId, type, expiresAt });
  return token;
};

export const consumeAuthToken = async (token: string, type: AuthTokenType) => {
  const [match] = await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(and(
      eq(authTokens.tokenHash, digest(token)),
      eq(authTokens.type, type),
      isNull(authTokens.usedAt),
      gt(authTokens.expiresAt, new Date()),
    ))
    .returning({ userId: authTokens.userId });
  return match?.userId || null;
};

export const consumeLatestAuthToken = async (userId: string, type: AuthTokenType) => {
  const [match] = await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(and(
      eq(authTokens.userId, userId),
      eq(authTokens.type, type),
      isNull(authTokens.usedAt),
      gt(authTokens.expiresAt, new Date()),
    ))
    .returning({ userId: authTokens.userId });
  return match?.userId || null;
};

export const setSessionCookie = async (res: Response, userId: string) => {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ tokenHash: digest(token), userId, expiresAt });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });
};

export const clearSessionCookie = async (req: Request, res: Response) => {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, digest(token)));
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
};

export const getAuthFromRequest = async (req: Request): Promise<AuthContext | null> => {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token) return null;
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .where(and(eq(sessions.tokenHash, digest(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const session = rows[0];
  return session
    ? {
        userId: session.userId,
        workspaceId: session.workspaceId,
        email: session.email,
        emailVerified: Boolean(session.emailVerifiedAt),
        role: session.role,
      }
    : null;
};

export const authRequired = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!token) return res.status(401).json({ error: "AUTH_REQUIRED", message: "Please sign in to continue." });

    const auth = await getAuthFromRequest(req);
    if (!auth) {
      res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
      return res.status(401).json({ error: "SESSION_EXPIRED", message: "Your session has expired. Please sign in again." });
    }

    res.locals.auth = auth;
    return next();
  } catch (error) {
    return next(error);
  }
};

export const getAuth = (res: Response) => res.locals.auth as AuthContext;

export const workspaceAccessRequired = (req: Request, res: Response, next: NextFunction) => {
  const auth = getAuth(res);
  const requested = req.params.workspaceId;
  if (requested !== "current" && requested !== auth.workspaceId) {
    return res.status(403).json({ error: "WORKSPACE_ACCESS_DENIED", message: "You do not have access to this workspace." });
  }
  res.locals.workspaceId = auth.workspaceId;
  return next();
};