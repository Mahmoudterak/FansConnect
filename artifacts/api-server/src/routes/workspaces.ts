import { Router, type IRouter, type Response } from "express";
import { count, eq } from "drizzle-orm";
import {
  appointments,
  assistantConfigs,
  autoReplyRules,
  businessProfiles,
  contacts,
  conversations,
  db,
  faqItems,
  leads,
  messages,
  onboardingStates,
  orders,
  trainingExamples,
  workspaces,
} from "@workspace/db";
import { getAuth } from "../lib/auth";

const router: IRouter = Router();

const currentWorkspaceId = (res: Response) =>
  (res.locals.workspaceId as string) || getAuth(res).workspaceId;

async function workspaceCounts(workspaceId: string) {
  const scalar = async (query: Promise<{ value: number }[]>) => Number((await query)[0]?.value || 0);
  const [contactCount, conversationCount, messageCount, leadCount, appointmentCount, orderCount, faqCount, autoReplyCount, trainingCount] = await Promise.all([
    scalar(db.select({ value: count() }).from(contacts).where(eq(contacts.workspaceId, workspaceId))),
    scalar(db.select({ value: count() }).from(conversations).where(eq(conversations.workspaceId, workspaceId))),
    scalar(db.select({ value: count() }).from(messages).innerJoin(conversations, eq(messages.conversationId, conversations.id)).where(eq(conversations.workspaceId, workspaceId))),
    scalar(db.select({ value: count() }).from(leads).where(eq(leads.workspaceId, workspaceId))),
    scalar(db.select({ value: count() }).from(appointments).where(eq(appointments.workspaceId, workspaceId))),
    scalar(db.select({ value: count() }).from(orders).where(eq(orders.workspaceId, workspaceId))),
    scalar(db.select({ value: count() }).from(faqItems).where(eq(faqItems.workspaceId, workspaceId))),
    scalar(db.select({ value: count() }).from(autoReplyRules).where(eq(autoReplyRules.workspaceId, workspaceId))),
    scalar(db.select({ value: count() }).from(trainingExamples).where(eq(trainingExamples.workspaceId, workspaceId))),
  ]);
  return {
    contacts: contactCount,
    conversations: conversationCount,
    messages: messageCount,
    leads: leadCount,
    appointments: appointmentCount,
    orders: orderCount,
    faq: faqCount,
    autoReplies: autoReplyCount,
    trainingExamples: trainingCount,
    unreadConversations: 0,
  };
}

router.get("/workspaces/:workspaceId", async (_req, res) => {
  const workspaceId = currentWorkspaceId(res);
  const auth = getAuth(res);
  const [workspace] = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!workspace) return res.status(404).json({ error: "WORKSPACE_NOT_FOUND", message: "Workspace not found." });
  const [profile] = await db.select().from(businessProfiles).where(eq(businessProfiles.workspaceId, workspaceId)).limit(1);
  const [assistant] = await db.select().from(assistantConfigs).where(eq(assistantConfigs.workspaceId, workspaceId)).limit(1);
  const [onboarding] = await db.select().from(onboardingStates).where(eq(onboardingStates.workspaceId, workspaceId)).limit(1);
  return res.json({
    workspace: { id: workspace.id, name: profile?.businessName || workspace.name || "" },
    user: { id: auth.userId, email: auth.email, emailVerified: auth.emailVerified, role: auth.role },
    profile: profile || null,
    assistant: assistant || null,
    onboarding: onboarding || null,
    counts: await workspaceCounts(workspaceId),
  });
});

router.get("/workspaces/:workspaceId/dashboard", async (_req, res) => {
  const workspaceId = currentWorkspaceId(res);
  const [assistant] = await db.select({ status: assistantConfigs.status }).from(assistantConfigs).where(eq(assistantConfigs.workspaceId, workspaceId)).limit(1);
  return res.json({ counts: await workspaceCounts(workspaceId), assistantStatus: assistant?.status || "PAUSED" });
});

router.get("/workspaces/:workspaceId/profile", async (_req, res) => {
  const workspaceId = currentWorkspaceId(res);
  const [profile] = await db.select().from(businessProfiles).where(eq(businessProfiles.workspaceId, workspaceId)).limit(1);
  return res.json({ profile: profile || null });
});

router.put("/workspaces/:workspaceId/profile", async (req, res) => {
  const workspaceId = currentWorkspaceId(res);
  const businessName = typeof req.body?.businessName === "string" ? req.body.businessName.trim().slice(0, 120) : "";
  const activityType = typeof req.body?.activityType === "string" ? req.body.activityType.trim().slice(0, 120) : "";
  const country = typeof req.body?.country === "string" ? req.body.country.trim().slice(0, 120) : "";
  const [profile] = await db
    .insert(businessProfiles)
    .values({ workspaceId, businessName, activityType, country })
    .onConflictDoUpdate({
      target: businessProfiles.workspaceId,
      set: { businessName, activityType, country, updatedAt: new Date() },
    })
    .returning();
  await db.update(workspaces).set({ name: businessName }).where(eq(workspaces.id, workspaceId));
  return res.json({ profile });
});

router.post("/workspaces/:workspaceId/onboarding/complete", async (_req, res) => {
  const workspaceId = currentWorkspaceId(res);
  const completedAt = new Date();
  const [state] = await db
    .insert(onboardingStates)
    .values({ workspaceId, currentStep: 3, completedSteps: [1, 2, 3], completedAt })
    .onConflictDoUpdate({
      target: onboardingStates.workspaceId,
      set: { currentStep: 3, completedSteps: [1, 2, 3], completedAt, updatedAt: completedAt },
    })
    .returning();
  return res.json({ onboarding: state });
});

export default router;