import { Router, type IRouter } from "express";
import { and, count, eq } from "drizzle-orm";
import {
  assistantConfigs,
  appointments,
  autoReplyRules,
  businessProfiles,
  channels,
  contacts,
  conversations,
  db,
  faqItems,
  leads,
  onboardingStates,
  orders,
  services,
  trainingExamples,
} from "@workspace/db";
import { z } from "zod";
import { authRequired, getAuth } from "../lib/auth";

const router: IRouter = Router();
router.use("/workspace", authRequired);

const profileInput = z.object({
  businessName: z.string().trim().min(1).max(120),
  activityType: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  phone: z.string().max(40).default(""),
  email: z.string().email().or(z.literal("")).default(""),
  city: z.string().max(80).default(""),
  country: z.string().max(80).default(""),
  workingHours: z.record(z.string(), z.unknown()).default({}),
  paymentMethods: z.array(z.string()).default([]),
});

const serviceInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(""),
  price: z.coerce.number().min(0).max(999999999),
  durationMinutes: z.coerce.number().int().min(0).max(1440).default(0),
});

const ruleInput = z.object({
  name: z.string().trim().min(1).max(120),
  keywords: z.array(z.string().trim().min(1)).min(1).max(30),
  matchType: z.enum(["contains", "exact", "starts_with"]).default("contains"),
  response: z.string().trim().min(1).max(3000),
  priority: z.number().int().min(0).max(1000).default(0),
  enabled: z.boolean().default(true),
});

const assistantInput = z.object({
  personality: z.string().max(80).default("PROFESSIONAL"),
  language: z.enum(["ar", "en"]).default("ar"),
  dialect: z.string().max(80).default("MODERN_STANDARD_ARABIC"),
  responseStyle: z.string().max(80).default("SHORT"),
  welcomeMessage: z.string().max(1000).default(""),
  outOfScopeResponse: z.string().max(1000).default(""),
  humanHandoffMessage: z.string().max(1000).default(""),
  aiFailureMessage: z.string().max(1000).default(""),
  businessInstructions: z.string().max(4000).default(""),
});

const trainingInput = z.object({
  customerMessage: z.string().trim().min(1).max(3000),
  businessResponse: z.string().trim().min(1).max(3000),
  botNote: z.string().max(1000).default(""),
  imageUrl: z.string().url().nullable().optional(),
});

const setup = async (workspaceId: string) => {
  const [state, profile, assistant, channelRows, serviceRows, ruleRows, faqRows, exampleRows] = await Promise.all([
    db.select().from(onboardingStates).where(eq(onboardingStates.workspaceId, workspaceId)).limit(1),
    db.select().from(businessProfiles).where(eq(businessProfiles.workspaceId, workspaceId)).limit(1),
    db.select().from(assistantConfigs).where(eq(assistantConfigs.workspaceId, workspaceId)).limit(1),
    db.select({ id: channels.id, type: channels.type, provider: channels.provider, status: channels.status, connectedAt: channels.connectedAt }).from(channels).where(eq(channels.workspaceId, workspaceId)),
    db.select().from(services).where(eq(services.workspaceId, workspaceId)),
    db.select().from(autoReplyRules).where(eq(autoReplyRules.workspaceId, workspaceId)),
    db.select().from(faqItems).where(eq(faqItems.workspaceId, workspaceId)),
    db.select().from(trainingExamples).where(eq(trainingExamples.workspaceId, workspaceId)),
  ]);
  return {
    onboarding: state[0] ?? { workspaceId, currentStep: 1, completedSteps: [], completedAt: null },
    profile: profile[0] ?? null,
    assistant: assistant[0] ?? null,
    channels: channelRows,
    services: serviceRows,
    autoReplies: ruleRows,
    faq: faqRows,
    trainingExamples: exampleRows,
  };
};

router.get("/workspace/setup", async (_req, res, next) => {
  try {
    return res.json(await setup(getAuth(res).workspaceId));
  } catch (error) {
    return next(error);
  }
});

router.get("/workspace/dashboard", async (_req, res, next) => {
  try {
    const workspaceId = getAuth(res).workspaceId;
    const [conversationCount, contactCount, leadCount, appointmentCount, orderCount, channelRows, state] = await Promise.all([
      db.select({ count: count() }).from(conversations).where(eq(conversations.workspaceId, workspaceId)),
      db.select({ count: count() }).from(contacts).where(eq(contacts.workspaceId, workspaceId)),
      db.select({ count: count() }).from(leads).where(eq(leads.workspaceId, workspaceId)),
      db.select({ count: count() }).from(appointments).where(eq(appointments.workspaceId, workspaceId)),
      db.select({ count: count() }).from(orders).where(eq(orders.workspaceId, workspaceId)),
      db.select({ type: channels.type, status: channels.status }).from(channels).where(eq(channels.workspaceId, workspaceId)),
      db.select({ completedAt: onboardingStates.completedAt }).from(onboardingStates).where(eq(onboardingStates.workspaceId, workspaceId)).limit(1),
    ]);
    return res.json({
      counts: {
        conversations: conversationCount[0]?.count ?? 0,
        contacts: contactCount[0]?.count ?? 0,
        leads: leadCount[0]?.count ?? 0,
        appointments: appointmentCount[0]?.count ?? 0,
        orders: orderCount[0]?.count ?? 0,
      },
      channels: channelRows,
      onboardingCompleted: Boolean(state[0]?.completedAt),
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/workspace/onboarding", async (req, res, next) => {
  try {
    const workspaceId = getAuth(res).workspaceId;
    const input = z.object({ currentStep: z.number().int().min(1).max(7), completedStep: z.number().int().min(1).max(7).optional() }).parse(req.body);
    const [current] = await db.select().from(onboardingStates).where(eq(onboardingStates.workspaceId, workspaceId)).limit(1);
    const completedSteps = Array.from(new Set([...(current?.completedSteps ?? []), ...(input.completedStep ? [input.completedStep] : [])])).sort((a, b) => a - b);
    const [updated] = await db.update(onboardingStates).set({ currentStep: input.currentStep, completedSteps, updatedAt: new Date() }).where(eq(onboardingStates.workspaceId, workspaceId)).returning();
    return res.json(updated);
  } catch (error) {
    return next(error);
  }
});

router.patch("/workspace/profile", async (req, res, next) => {
  try {
    const workspaceId = getAuth(res).workspaceId;
    const input = profileInput.parse(req.body);
    const [updated] = await db.update(businessProfiles).set({ ...input, updatedAt: new Date() }).where(eq(businessProfiles.workspaceId, workspaceId)).returning();
    if (!updated) return res.status(404).json({ error: "PROFILE_MISSING", message: "Business profile is not available." });
    return res.json(updated);
  } catch (error) {
    return next(error);
  }
});

router.post("/workspace/services", async (req, res, next) => {
  try {
    const workspaceId = getAuth(res).workspaceId;
    const input = serviceInput.parse(req.body);
    const [created] = await db.insert(services).values({ ...input, price: input.price.toFixed(2), currency: "AED", workspaceId }).returning();
    return res.status(201).json(created);
  } catch (error) {
    return next(error);
  }
});

router.patch("/workspace/services/:id", async (req, res, next) => {
  try {
    const input = serviceInput.partial().parse(req.body);
    const [updated] = await db.update(services).set({ ...input, price: input.price === undefined ? undefined : input.price.toFixed(2), updatedAt: new Date() }).where(and(eq(services.id, req.params.id), eq(services.workspaceId, getAuth(res).workspaceId))).returning();
    if (!updated) return res.status(404).json({ error: "SERVICE_NOT_FOUND", message: "Service not found." });
    return res.json(updated);
  } catch (error) {
    return next(error);
  }
});

router.delete("/workspace/services/:id", async (req, res, next) => {
  try {
    const deleted = await db.delete(services).where(and(eq(services.id, req.params.id), eq(services.workspaceId, getAuth(res).workspaceId))).returning({ id: services.id });
    if (!deleted.length) return res.status(404).json({ error: "SERVICE_NOT_FOUND", message: "Service not found." });
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

router.post("/workspace/auto-replies", async (req, res, next) => {
  try {
    const [created] = await db.insert(autoReplyRules).values({ ...ruleInput.parse(req.body), workspaceId: getAuth(res).workspaceId }).returning();
    return res.status(201).json(created);
  } catch (error) {
    return next(error);
  }
});

router.patch("/workspace/auto-replies/:id", async (req, res, next) => {
  try {
    const [updated] = await db.update(autoReplyRules).set({ ...ruleInput.partial().parse(req.body), updatedAt: new Date() }).where(and(eq(autoReplyRules.id, req.params.id), eq(autoReplyRules.workspaceId, getAuth(res).workspaceId))).returning();
    if (!updated) return res.status(404).json({ error: "RULE_NOT_FOUND", message: "Auto-reply rule not found." });
    return res.json(updated);
  } catch (error) {
    return next(error);
  }
});

router.delete("/workspace/auto-replies/:id", async (req, res, next) => {
  try {
    const deleted = await db.delete(autoReplyRules).where(and(eq(autoReplyRules.id, req.params.id), eq(autoReplyRules.workspaceId, getAuth(res).workspaceId))).returning({ id: autoReplyRules.id });
    if (!deleted.length) return res.status(404).json({ error: "RULE_NOT_FOUND", message: "Auto-reply rule not found." });
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

router.patch("/workspace/assistant", async (req, res, next) => {
  try {
    const [updated] = await db.update(assistantConfigs).set({ ...assistantInput.parse(req.body), updatedAt: new Date() }).where(eq(assistantConfigs.workspaceId, getAuth(res).workspaceId)).returning();
    if (!updated) return res.status(404).json({ error: "ASSISTANT_MISSING", message: "Assistant configuration is not available." });
    return res.json(updated);
  } catch (error) {
    return next(error);
  }
});

router.post("/workspace/training", async (req, res, next) => {
  try {
    const workspaceId = getAuth(res).workspaceId;
    const [{ count: existingCount }] = await db.select({ count: count() }).from(trainingExamples).where(eq(trainingExamples.workspaceId, workspaceId));
    if (existingCount >= 20) return res.status(409).json({ error: "TRAINING_LIMIT", message: "You can add up to 20 training examples." });
    const [created] = await db.insert(trainingExamples).values({ ...trainingInput.parse(req.body), workspaceId }).returning();
    return res.status(201).json(created);
  } catch (error) {
    return next(error);
  }
});

router.delete("/workspace/training/:id", async (req, res, next) => {
  try {
    const deleted = await db.delete(trainingExamples).where(and(eq(trainingExamples.id, req.params.id), eq(trainingExamples.workspaceId, getAuth(res).workspaceId))).returning({ id: trainingExamples.id });
    if (!deleted.length) return res.status(404).json({ error: "TRAINING_NOT_FOUND", message: "Training example not found." });
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

router.post("/workspace/activate", async (_req, res, next) => {
  try {
    const workspaceId = getAuth(res).workspaceId;
    const [profile] = await db.select().from(businessProfiles).where(eq(businessProfiles.workspaceId, workspaceId)).limit(1);
    const [whatsapp] = await db.select().from(channels).where(and(eq(channels.workspaceId, workspaceId), eq(channels.type, "WHATSAPP"))).limit(1);
    if (!profile?.businessName || !profile.activityType) return res.status(409).json({ error: "PROFILE_REQUIRED", message: "Complete your business information before activating." });
    if (whatsapp?.status !== "CONNECTED") return res.status(409).json({ error: "WHATSAPP_REQUIRED", message: "Connect and verify WhatsApp Business before activating the assistant." });
    await db.transaction(async (tx) => {
      await tx.update(assistantConfigs).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(assistantConfigs.workspaceId, workspaceId));
      await tx.update(onboardingStates).set({ currentStep: 7, completedSteps: [1, 2, 3, 4, 5, 6, 7], completedAt: new Date(), updatedAt: new Date() }).where(eq(onboardingStates.workspaceId, workspaceId));
    });
    return res.json({ activated: true });
  } catch (error) {
    return next(error);
  }
});

export default router;