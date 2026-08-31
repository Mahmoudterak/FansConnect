import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("OWNER"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("workspace_members_workspace_user_idx").on(table.workspaceId, table.userId), index("workspace_members_user_idx").on(table.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

export const onboardingStates = pgTable("onboarding_states", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  currentStep: integer("current_step").notNull().default(1),
  completedSteps: integer("completed_steps").array().notNull().default(sql`ARRAY[]::integer[]`),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const businessProfiles = pgTable("business_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().unique().references(() => workspaces.id, { onDelete: "cascade" }),
  businessName: text("business_name").notNull().default(""),
  activityType: text("activity_type").notNull().default(""),
  description: text("description").notNull().default(""),
  phone: text("phone").notNull().default(""),
  email: text("email").notNull().default(""),
  city: text("city").notNull().default(""),
  country: text("country").notNull().default(""),
  workingHours: jsonb("working_hours").notNull().default(sql`'{}'::jsonb`),
  paymentMethods: jsonb("payment_methods").notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const services = pgTable(
  "services",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    price: numeric("price", { precision: 12, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("AED"),
    durationMinutes: integer("duration_minutes").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("services_workspace_idx").on(table.workspaceId)],
);

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull().default(""),
    status: text("status").notNull().default("NOT_CONNECTED"),
    providerData: jsonb("provider_data").notNull().default(sql`'{}'::jsonb`),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("channels_workspace_type_idx").on(table.workspaceId, table.type)],
);

export const autoReplyRules = pgTable(
  "auto_reply_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keywords: text("keywords").array().notNull(),
    matchType: text("match_type").notNull().default("contains"),
    response: text("response").notNull(),
    priority: integer("priority").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("auto_reply_rules_workspace_idx").on(table.workspaceId)],
);

export const faqItems = pgTable(
  "faq_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    category: text("category").notNull().default("General"),
    priority: integer("priority").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("faq_items_workspace_idx").on(table.workspaceId)],
);

export const assistantConfigs = pgTable("assistant_configs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().unique().references(() => workspaces.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("PAUSED"),
  personality: text("personality").notNull().default("PROFESSIONAL"),
  language: text("language").notNull().default("ar"),
  dialect: text("dialect").notNull().default("MODERN_STANDARD_ARABIC"),
  responseStyle: text("response_style").notNull().default("SHORT"),
  welcomeMessage: text("welcome_message").notNull().default(""),
  outOfScopeResponse: text("out_of_scope_response").notNull().default(""),
  humanHandoffMessage: text("human_handoff_message").notNull().default(""),
  aiFailureMessage: text("ai_failure_message").notNull().default(""),
  businessInstructions: text("business_instructions").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const trainingExamples = pgTable(
  "training_examples",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    customerMessage: text("customer_message").notNull(),
    businessResponse: text("business_response").notNull(),
    botNote: text("bot_note").notNull().default(""),
    imageUrl: text("image_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("training_examples_workspace_idx").on(table.workspaceId)],
);

export const contacts = pgTable("contacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  phone: text("phone").notNull().default(""),
  email: text("email").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("contacts_workspace_idx").on(table.workspaceId)]);

export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").references(() => channels.id, { onDelete: "set null" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  status: text("status").notNull().default("OPEN"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("conversations_workspace_idx").on(table.workspaceId)]);

export const leads = pgTable("leads", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  stage: text("stage").notNull().default("NEW"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("leads_workspace_idx").on(table.workspaceId)]);

export const appointments = pgTable("appointments", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  status: text("status").notNull().default("PENDING"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("appointments_workspace_idx").on(table.workspaceId)]);

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  status: text("status").notNull().default("DRAFT"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("orders_workspace_idx").on(table.workspaceId)]);

export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  message: text("message").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("notifications_workspace_idx").on(table.workspaceId)]);

export const insertUserSchema = createInsertSchema(users);
export const insertWorkspaceSchema = createInsertSchema(workspaces);
export const insertBusinessProfileSchema = createInsertSchema(businessProfiles);
export const insertServiceSchema = createInsertSchema(services);
export const insertAutoReplyRuleSchema = createInsertSchema(autoReplyRules);
export const insertFaqItemSchema = createInsertSchema(faqItems);
export const insertAssistantConfigSchema = createInsertSchema(assistantConfigs);
export const insertTrainingExampleSchema = createInsertSchema(trainingExamples);

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type BusinessProfile = typeof businessProfiles.$inferSelect;
export type Service = typeof services.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type AutoReplyRule = typeof autoReplyRules.$inferSelect;
export type FaqItem = typeof faqItems.$inferSelect;
export type AssistantConfig = typeof assistantConfigs.$inferSelect;
export type TrainingExample = typeof trainingExamples.$inferSelect;