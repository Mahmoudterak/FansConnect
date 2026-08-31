import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import {
  autoReplyRules,
  channels,
  contacts,
  conversations,
  db,
  faqItems,
  messages,
} from "@workspace/db";
import { getAuth } from "../lib/auth";
import {
  gupshupAppName,
  gupshupIsConfigured,
  normalizeGupshupPayload,
  parseGupshupChannelData,
  sendGupshupText,
  verifyGupshupChannel,
  type GupshupChannelData,
} from "../providers/gupshup";

type ChannelName = "whatsapp" | "instagram";
type ChannelStatus =
  | "setup_required"
  | "connecting"
  | "connected"
  | "degraded"
  | "failed"
  | "paused"
  | "disconnected";
type MessageFrom = "customer" | "team" | "assistant";
type DeliveryStatus = "queued" | "sent" | "delivered" | "read" | "failed";
type ChannelProvider = "GUPSHUP" | "META" | "SENDS_BOT";

type ChannelRecord = {
  id: string;
  channel: ChannelName;
  provider: ChannelProvider;
  providerData: Record<string, unknown>;
  status: ChannelStatus;
  providerAccountId?: string;
  displayName?: string;
  accessToken?: string;
  connectedAt?: string;
  lastVerifiedAt?: string;
  failureReason?: string;
  failureCode?: string;
  oauthState?: string;
};

type MessageRecord = {
  id: string;
  providerMessageId?: string;
  from: MessageFrom;
  text: string;
  timestamp: string;
  deliveryStatus?: DeliveryStatus;
  failureReason?: string;
};

type ConversationRecord = {
  id: string;
  channel: ChannelName;
  providerConversationId?: string;
  contactName: string;
  contactAddress: string;
  status: "open" | "pending" | "resolved";
  handoff: "assistant" | "team";
  updatedAt: string;
  messages: MessageRecord[];
};

const router: IRouter = Router();
const CUSTOMER_CONNECTION_ERROR = "Unable to connect WhatsApp right now. Please try again later.";
const CUSTOMER_SEND_ERROR = "The message could not be sent right now. Please try again later.";

const channelLabels: Record<ChannelName, string> = {
  whatsapp: "WhatsApp Business",
  instagram: "Instagram Direct",
};

function normalizeChannel(value: string): ChannelName | null {
  if (value.toLowerCase() === "whatsapp" || value.toLowerCase() === "whatsapp-business") return "whatsapp";
  if (value.toLowerCase() === "instagram" || value.toLowerCase() === "instagram-direct") return "instagram";
  return null;
}

function workspaceIdFromRequest(res: Response): string {
  return (res.locals.workspaceId as string | undefined) || getAuth(res).workspaceId;
}

function canManageWorkspace(res: Response): boolean {
  const role = getAuth(res).role.toUpperCase();
  return role === "OWNER" || role === "ADMIN";
}

function normalizeStatus(value: string): ChannelStatus {
  switch (value.toLowerCase()) {
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "degraded":
      return "degraded";
    case "failed":
    case "error":
      return "failed";
    case "paused":
      return "paused";
    case "disconnected":
      return "disconnected";
    case "not_connected":
      return "disconnected";
    case "setup_required":
    default:
      return value.toLowerCase() === "setup_required" ? "setup_required" : "disconnected";
  }
}

function channelFromRow(row: typeof channels.$inferSelect): ChannelRecord {
  const channel = normalizeChannel(row.type);
  if (!channel) throw new Error(`Unsupported persisted channel type: ${row.type}`);
  const accessToken = row.accessTokenEncrypted ? decryptAccessToken(row.accessTokenEncrypted) : undefined;
  const credentialsUnavailable = Boolean(row.accessTokenEncrypted && !accessToken);
  return {
    id: row.id,
    channel,
    provider: (row.provider || (channel === "whatsapp" ? "GUPSHUP" : "META")).toUpperCase() as ChannelProvider,
    providerData:
      row.providerData && typeof row.providerData === "object"
        ? row.providerData as Record<string, unknown>
        : {},
    status: credentialsUnavailable ? "failed" : normalizeStatus(row.status),
    providerAccountId: row.providerAccountId || undefined,
    displayName: row.displayName || undefined,
    accessToken,
    connectedAt: row.connectedAt?.toISOString(),
    lastVerifiedAt: row.lastVerifiedAt?.toISOString(),
    failureReason: credentialsUnavailable
      ? "Stored provider credentials could not be decrypted."
      : row.failureReason || undefined,
    failureCode: credentialsUnavailable ? "provider_credentials_unavailable" : row.failureCode || undefined,
    oauthState: row.oauthState || undefined,
  };
}

async function workspaceChannels(workspaceId: string): Promise<ChannelRecord[]> {
  await db
    .insert(channels)
    .values([
      { workspaceId, type: "WHATSAPP", provider: "GUPSHUP", status: "NOT_CONNECTED" },
      { workspaceId, type: "INSTAGRAM", provider: "META", status: "NOT_CONNECTED" },
    ])
    .onConflictDoNothing({ target: [channels.workspaceId, channels.type] });
  const rows = await db.select().from(channels).where(eq(channels.workspaceId, workspaceId));
  return rows.map(channelFromRow);
}

async function channelOr404(workspaceId: string, channelValue: string): Promise<ChannelRecord | null> {
  const channel = normalizeChannel(channelValue);
  if (!channel) return null;
  const records = await workspaceChannels(workspaceId);
  return records.find((record) => record.channel === channel) || null;
}

async function verifiedChannel(workspaceId: string, channelValue: string): Promise<ChannelRecord | null> {
  const channel = await channelOr404(workspaceId, channelValue);
  if (!channel || channel.status !== "connected") return null;
  if (channel.provider === "GUPSHUP") {
    return gupshupIsConfigured() && parseGupshupChannelData(channel.providerData) ? channel : null;
  }
  if (!channel.accessToken) return null;
  return channel;
}

function healthFor(record: ChannelRecord) {
  if (record.status === "connected") {
    return {
      state: "healthy",
      verified: true,
      message: "The channel is verified and ready for messages.",
      action: null,
    };
  }
  if (record.status === "failed") {
    return {
      state: "failed",
      verified: false,
      message: "Unable to use this channel right now.",
      action: "Try connecting again later.",
    };
  }
  if (record.status === "connecting") {
    return {
      state: "connecting",
      verified: false,
      message: "The connection is being verified.",
      action: "Please wait for verification to finish.",
    };
  }
  if (record.status === "disconnected") {
    return {
      state: "disconnected",
      verified: false,
      message: "This channel is disconnected.",
      action: "Connect the provider to receive and send messages.",
    };
  }
  if (record.status === "paused") {
    return {
      state: "paused",
      verified: false,
      message: "This channel is paused.",
      action: "Reconnect the channel when you are ready.",
    };
  }
  return {
    state: "setup_required",
    verified: false,
    message: "This channel is not connected.",
    action: "Connect the channel to receive and send messages.",
  };
}

function serializeChannel(record: ChannelRecord) {
  return {
    channel: record.channel,
    name: channelLabels[record.channel],
    provider: record.provider === "GUPSHUP"
      ? "Gupshup"
      : record.provider === "SENDS_BOT"
        ? "Sends Bot"
        : "WhatsApp Cloud API",
    status: record.status,
    verified: record.status === "connected",
    providerAccountId: record.providerAccountId || null,
    displayName: record.displayName || null,
    connectedAt: record.connectedAt || null,
    lastVerifiedAt: record.lastVerifiedAt || null,
    failureReason: record.status === "failed" ? "Unable to use this channel right now." : null,
    failureCode: record.failureCode || null,
    health: healthFor(record),
  };
}

function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required to store provider credentials securely.");
  return createHash("sha256").update(`channel-access-token:${secret}`).digest();
}

function encryptAccessToken(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptAccessToken(value: string): string | undefined {
  try {
    const [ivValue, tagValue, encryptedValue] = value.split(".");
    if (!ivValue || !tagValue || !encryptedValue) return undefined;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return undefined;
  }
}

async function persistChannel(workspaceId: string, record: ChannelRecord) {
  const persistedStatus =
    record.status === "connected" ? "CONNECTED" :
    record.status === "connecting" ? "CONNECTING" :
    record.status === "paused" ? "PAUSED" :
    record.status === "failed" || record.status === "degraded" ? "ERROR" :
    "NOT_CONNECTED";
  await db
    .update(channels)
    .set({
      status: persistedStatus,
      provider: record.provider,
      providerData: record.providerData,
      providerAccountId: record.providerAccountId || null,
      displayName: record.displayName || null,
      accessTokenEncrypted: record.accessToken ? encryptAccessToken(record.accessToken) : null,
      failureReason: record.failureReason || null,
      failureCode: record.failureCode || null,
      oauthState: record.oauthState || null,
      connectedAt: record.connectedAt ? new Date(record.connectedAt) : null,
      lastVerifiedAt: record.lastVerifiedAt ? new Date(record.lastVerifiedAt) : null,
      updatedAt: new Date(),
    })
    .where(and(eq(channels.id, record.id), eq(channels.workspaceId, workspaceId)));
}

function providerConfig() {
  return {
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    redirectUri: process.env.META_REDIRECT_URI,
    graphUrl: (process.env.META_GRAPH_URL || "https://graph.facebook.com/v21.0").replace(/\/$/, ""),
  };
}

async function setupResponse(workspaceId: string, channel: ChannelRecord) {
  const config = providerConfig();
  const result: {
    channel: ReturnType<typeof serializeChannel>;
    connectUrl: string | null;
    message: string;
  } = {
    channel: serializeChannel(channel),
    connectUrl: null,
    message: "Meta provider setup is required. Add META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI to start authorization.",
  };

  if (config.appId && config.appSecret && config.redirectUri) {
    const state = randomUUID();
    channel.status = "connecting";
    channel.oauthState = state;
    channel.failureReason = undefined;
    channel.failureCode = undefined;
    await persistChannel(workspaceId, channel);
    const scopes = channel.channel === "whatsapp"
      ? "business_management,whatsapp_business_management,whatsapp_business_messaging"
      : "business_management,instagram_basic,instagram_manage_messages,pages_manage_metadata";
    const params = new URLSearchParams({
      client_id: config.appId,
      redirect_uri: config.redirectUri,
      state,
      response_type: "code",
      scope: scopes,
    });
    result.connectUrl = `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
    result.channel = serializeChannel(channel);
    result.message = "Continue authorization in the provider window.";
  }
  return result;
}

async function graphGet(graphUrl: string, path: string, accessToken: string): Promise<Record<string, unknown>> {
  const url = new URL(`${graphUrl}/${path.replace(/^\//, "")}`);
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url);
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || payload.error) {
    const error = payload.error as { message?: string; code?: number } | undefined;
    throw new Error(error?.message || `Meta verification returned ${response.status}.`);
  }
  return payload;
}

async function verifyMetaConnection(channel: ChannelName, accessToken: string, providerAccountId?: string) {
  const config = providerConfig();
  if (!config.appId || !config.appSecret || !config.redirectUri) {
    throw new Error("Meta provider is not configured. Add META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI.");
  }

  const account = await graphGet(config.graphUrl, "me?fields=id,name", accessToken);
  let id = providerAccountId || (typeof account.id === "string" ? account.id : undefined);
  let displayName = typeof account.name === "string" ? account.name : undefined;

  if (channel === "whatsapp") {
    const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
    if (!phoneNumberId) throw new Error("Meta did not return a WhatsApp account.");
    const phone = await graphGet(config.graphUrl, `${phoneNumberId}?fields=id,display_phone_number,verified_name`, accessToken);
    id = typeof phone.id === "string" ? phone.id : phoneNumberId;
    displayName =
      (typeof phone.verified_name === "string" && phone.verified_name) ||
      (typeof phone.display_phone_number === "string" && phone.display_phone_number) ||
      displayName;
  } else {
    const instagram = await graphGet(config.graphUrl, `${id || "me"}?fields=id,name,instagram_business_account`, accessToken);
    const businessAccount = instagram.instagram_business_account as { id?: string } | undefined;
    id = businessAccount?.id || id;
    displayName = typeof instagram.name === "string" ? instagram.name : displayName;
  }

  if (!id) throw new Error("Meta verification did not return a provider account.");
  return { id, displayName };
}

async function exchangeCode(code: string) {
  const config = providerConfig();
  if (!config.appId || !config.appSecret || !config.redirectUri) {
    throw new Error("Meta provider is not configured. Add META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI.");
  }
  const url = new URL(`${config.graphUrl}/oauth/access_token`);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("client_secret", config.appSecret);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("code", code);
  const response = await fetch(url);
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: { message?: string };
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error?.message || "Meta authorization code could not be exchanged.");
  }
  return payload.access_token;
}

async function connectChannel(workspaceId: string, record: ChannelRecord, code?: string, providerAccountId?: string, state?: string) {
  if (!code) return setupResponse(workspaceId, record);
  if (!record.oauthState || state !== record.oauthState) throw new Error("Invalid provider authorization state.");
  const accessToken = await exchangeCode(code);
  const verified = await verifyMetaConnection(record.channel, accessToken, providerAccountId);
  record.accessToken = accessToken;
  record.providerAccountId = verified.id;
  record.displayName = verified.displayName;
  record.status = "connected";
  record.connectedAt = new Date().toISOString();
  record.lastVerifiedAt = record.connectedAt;
  record.failureReason = undefined;
  record.failureCode = undefined;
  record.oauthState = undefined;
  await persistChannel(workspaceId, record);
  return {
    channel: serializeChannel(record),
    connectUrl: null,
    message: "Provider credentials verified. The channel is ready for webhooks and messages.",
  };
}

async function connectGupshupChannel(
  workspaceId: string,
  record: ChannelRecord,
  input: unknown,
) {
  const supplied = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  const data = parseGupshupChannelData({
    appId: supplied.appId ?? record.providerData.appId,
    appName: supplied.appName ?? record.providerData.appName,
    source: supplied.source ?? record.providerData.source,
  });
  if (!data) {
    return {
      status: 400,
      body: {
        error: "gupshup_app_details_required",
        message: "Enter the WhatsApp app details to continue.",
        channel: serializeChannel(record),
      },
    };
  }
  if (!gupshupIsConfigured()) {
    return {
      status: 503,
      body: {
        error: "channel_connection_unavailable",
        message: CUSTOMER_CONNECTION_ERROR,
        channel: serializeChannel(record),
      },
    };
  }

  record.provider = "GUPSHUP";
  record.providerData = data;
  record.status = "connecting";
  record.failureReason = undefined;
  record.failureCode = undefined;
  await persistChannel(workspaceId, record);

  const verified = await verifyGupshupChannel(data);
  const now = new Date().toISOString();
  record.providerAccountId = verified.providerAccountId;
  record.displayName = verified.displayName;
  record.status = "connected";
  record.connectedAt = now;
  record.lastVerifiedAt = now;
  await persistChannel(workspaceId, record);
  return {
    status: 200,
    body: {
      channel: serializeChannel(record),
      connectUrl: null,
      message: "WhatsApp Business is connected.",
    },
  };
}

function assertWebhookSignature(req: Request): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return false;
  const signature = req.header("x-hub-signature-256") || req.header("x-webhook-signature");
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!signature || !rawBody) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return provided.length === expectedBuffer.length && timingSafeEqual(provided, expectedBuffer);
}

function eventChannel(value: string): ChannelName | null {
  return normalizeChannel(value);
}

function normalizeProviderPayload(channelValue: string, payload: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(payload.events)) return payload.events as Record<string, unknown>[];
  const channel = normalizeChannel(channelValue);
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  if (!channel || entries.length === 0) return [payload];

  const events: Record<string, unknown>[] = [];
  for (const entry of entries as Array<Record<string, unknown>>) {
    if (channel === "whatsapp") {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes as Array<Record<string, unknown>>) {
        const value = (change.value || {}) as Record<string, unknown>;
        const contacts = Array.isArray(value.contacts) ? value.contacts : [];
        const profile = (contacts[0] || {}) as Record<string, unknown>;
        const profileData = (profile.profile || {}) as Record<string, unknown>;
        const messagesInPayload = Array.isArray(value.messages) ? value.messages : [];
        for (const message of messagesInPayload as Array<Record<string, unknown>>) {
          const textData = (message.text || message.button || {}) as Record<string, unknown>;
          const seconds = Number(message.timestamp);
          events.push({
            event: "message.received",
            providerMessageId: message.id,
            providerConversationId: (value.metadata as Record<string, unknown> | undefined)?.phone_number_id,
            from: message.from,
            contactName: profileData.name || profile.wa_id || message.from,
            text: textData.body || textData.text,
            timestamp: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined,
          });
        }
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const status of statuses as Array<Record<string, unknown>>) {
          const statusName = status.status === "delivered" || status.status === "read"
            ? `message.${status.status}`
            : "message.failed";
          events.push({
            event: statusName,
            providerMessageId: status.id,
            error: (status.errors as Array<Record<string, unknown>> | undefined)?.[0]?.title,
          });
        }
      }
    } else {
      const messagesInPayload = Array.isArray(entry.messaging) ? entry.messaging : [];
      for (const messaging of messagesInPayload as Array<Record<string, unknown>>) {
        const message = (messaging.message || {}) as Record<string, unknown>;
        if (message.is_echo) continue;
        const seconds = Number(messaging.timestamp);
        events.push({
          event: "message.received",
          providerMessageId: message.mid,
          providerConversationId: (messaging.recipient as Record<string, unknown> | undefined)?.id,
          from: (messaging.sender as Record<string, unknown> | undefined)?.id,
          contactName: (messaging.sender as Record<string, unknown> | undefined)?.id,
          text: message.text,
          timestamp: Number.isFinite(seconds) ? new Date(seconds).toISOString() : undefined,
        });
      }
    }
  }
  return events;
}

async function workspaceForProviderPayload(
  channelValue: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const channel = normalizeChannel(channelValue);
  if (!channel) return null;
  const providerIds = providerAccountIdsFromPayload(payload);
  if (providerIds.length === 0) return null;
  const matches = await db
    .select({ workspaceId: channels.workspaceId })
    .from(channels)
    .where(and(
      eq(channels.type, channel.toUpperCase()),
      eq(channels.status, "CONNECTED"),
      inArray(channels.providerAccountId, providerIds),
    ))
    .limit(2);
  return matches.length === 1 ? matches[0].workspaceId : null;
}

function providerAccountIdsFromPayload(payload: Record<string, unknown>): string[] {
  const providerIds = new Set<string>();
  if (typeof payload.object === "string" && Array.isArray(payload.entry)) {
    for (const entry of payload.entry as Array<Record<string, unknown>>) {
      if (typeof entry.id === "string") providerIds.add(entry.id);
      for (const change of (entry.changes || []) as Array<Record<string, unknown>>) {
        const value = (change.value || {}) as Record<string, unknown>;
        const metadata = value.metadata as Record<string, unknown> | undefined;
        if (typeof metadata?.phone_number_id === "string") providerIds.add(metadata.phone_number_id);
      }
    }
  }
  return [...providerIds];
}

function dateFromValue(value: unknown): Date {
  const date = typeof value === "string" ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function serializeMessage(row: typeof messages.$inferSelect): MessageRecord {
  return {
    id: row.id,
    providerMessageId: row.providerMessageId || undefined,
    from: row.from as MessageFrom,
    text: row.text,
    timestamp: row.timestamp.toISOString(),
    deliveryStatus: row.deliveryStatus ? row.deliveryStatus as DeliveryStatus : undefined,
    failureReason: row.failureReason || undefined,
  };
}

async function loadConversation(workspaceId: string, conversationId: string): Promise<ConversationRecord | null> {
  const rows = await db
    .select({ conversation: conversations, channel: channels, message: messages })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)))
    .orderBy(asc(messages.timestamp));
  const first = rows[0];
  if (!first) return null;
  return {
    id: first.conversation.id,
    channel: normalizeChannel(first.channel.type) || "whatsapp",
    providerConversationId: first.conversation.providerConversationId || undefined,
    contactName: first.conversation.contactName,
    contactAddress: first.conversation.contactAddress,
    status: first.conversation.status.toLowerCase() as ConversationRecord["status"],
    handoff: first.conversation.handoff.toLowerCase() as ConversationRecord["handoff"],
    updatedAt: first.conversation.updatedAt.toISOString(),
    messages: rows.flatMap((row) => row.message ? [serializeMessage(row.message)] : []),
  };
}

async function listConversations(workspaceId: string, channel?: ChannelName): Promise<ConversationRecord[]> {
  const rows = await db
    .select({ conversation: conversations, channel: channels, message: messages })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(channel
      ? and(eq(conversations.workspaceId, workspaceId), eq(channels.type, channel.toUpperCase()))
      : eq(conversations.workspaceId, workspaceId))
    .orderBy(desc(conversations.updatedAt), asc(messages.timestamp));
  const grouped = new Map<string, ConversationRecord>();
  for (const row of rows) {
    let conversation = grouped.get(row.conversation.id);
    if (!conversation) {
      conversation = {
        id: row.conversation.id,
        channel: normalizeChannel(row.channel.type) || "whatsapp",
        providerConversationId: row.conversation.providerConversationId || undefined,
        contactName: row.conversation.contactName,
        contactAddress: row.conversation.contactAddress,
        status: row.conversation.status.toLowerCase() as ConversationRecord["status"],
        handoff: row.conversation.handoff.toLowerCase() as ConversationRecord["handoff"],
        updatedAt: row.conversation.updatedAt.toISOString(),
        messages: [],
      };
      grouped.set(row.conversation.id, conversation);
    }
    if (row.message) conversation.messages.push(serializeMessage(row.message));
  }
  return [...grouped.values()];
}

type IngestResult = {
  conversation: ConversationRecord | null;
  duplicate: boolean;
};

async function ingestEvent(
  workspaceId: string,
  channelValue: string,
  event: Record<string, unknown>,
): Promise<IngestResult> {
  const channel = eventChannel(channelValue);
  if (!channel) throw new Error("Unsupported channel.");
  const channelRecord = await verifiedChannel(workspaceId, channel);
  if (!channelRecord) throw new Error(`${channelLabels[channel]} is not verified.`);

  const eventType = typeof event.event === "string" ? event.event : "message.received";
  const providerMessageId = typeof event.providerMessageId === "string" ? event.providerMessageId : undefined;

  if (eventType === "message.received") {
    const contactAddress =
      typeof event.from === "string" ? event.from : typeof event.senderId === "string" ? event.senderId : "";
    const text = typeof event.text === "string" ? event.text.trim() : "";
    if (!contactAddress || !text) throw new Error("Inbound message requires from and text.");
    const now = dateFromValue(event.timestamp);
    const stored = await db.transaction(async (tx) => {
      if (providerMessageId) {
        const [duplicate] = await tx.select({ conversationId: messages.conversationId })
          .from(messages)
          .innerJoin(conversations, eq(conversations.id, messages.conversationId))
          .where(and(eq(messages.providerMessageId, providerMessageId), eq(conversations.workspaceId, workspaceId)))
          .limit(1);
        if (duplicate) return { conversationId: duplicate.conversationId, duplicate: true };
      }
      const contactName =
        typeof event.contactName === "string" && event.contactName
          ? event.contactName
          : contactAddress;
      const [createdContact] = await tx.insert(contacts).values({
        workspaceId,
        name: contactName,
        phone: contactAddress,
      }).onConflictDoUpdate({
        target: [contacts.workspaceId, contacts.phone],
        set: { name: contactName },
      }).returning({ id: contacts.id });
      const [contact] = createdContact
        ? [createdContact]
        : await tx.select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.phone, contactAddress)))
          .limit(1);
      const [existing] = await tx.select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.channelId, channelRecord.id), eq(conversations.contactAddress, contactAddress), ne(conversations.status, "RESOLVED")))
        .orderBy(desc(conversations.updatedAt))
        .limit(1);
      let id = existing?.id;
      if (!id) {
        const [created] = await tx.insert(conversations).values({
          workspaceId,
          channelId: channelRecord.id,
          contactId: contact?.id || null,
          providerConversationId: typeof event.providerConversationId === "string" ? event.providerConversationId : null,
          contactName,
          contactAddress,
          status: "OPEN",
          handoff: "ASSISTANT",
          updatedAt: now,
        }).onConflictDoNothing({ target: [conversations.workspaceId, conversations.channelId, conversations.contactAddress] }).returning({ id: conversations.id });
        id = created?.id;
        if (!id) {
          const [retried] = await tx.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.channelId, channelRecord.id), eq(conversations.contactAddress, contactAddress))).limit(1);
          id = retried?.id;
        }
      }
      if (!id) throw new Error("Conversation could not be created.");
      await tx.insert(messages).values({ conversationId: id, providerMessageId: providerMessageId || null, from: "customer", text, timestamp: now }).onConflictDoNothing({ target: messages.providerMessageId });
      await tx.update(conversations).set({ updatedAt: now }).where(and(eq(conversations.id, id), eq(conversations.workspaceId, workspaceId)));
      return { conversationId: id, duplicate: false };
    });
    return {
      conversation: await loadConversation(workspaceId, stored.conversationId),
      duplicate: stored.duplicate,
    };
  }

  const deliveryStatus: DeliveryStatus = eventType.endsWith("delivered")
    ? "delivered"
    : eventType.endsWith("read") ? "read" : "failed";
  await db.transaction(async (tx) => {
    if (providerMessageId) {
      const [match] = await tx
        .select({ message: messages })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(
          eq(conversations.workspaceId, workspaceId),
          eq(conversations.channelId, channelRecord.id),
          eq(messages.providerMessageId, providerMessageId),
        ))
        .limit(1);
      if (match) {
        await tx.update(messages)
          .set({
            deliveryStatus,
            failureReason: deliveryStatus === "failed" && typeof event.error === "string" ? event.error : null,
          })
          .where(eq(messages.id, match.message.id));
      }
    }
    if (deliveryStatus === "failed") {
      const failureReason = typeof event.error === "string" ? event.error : "The provider reported a delivery failure.";
      await tx.update(channels).set({
        status: "FAILED",
        failureReason,
        failureCode: "provider_delivery_failed",
        updatedAt: new Date(),
      }).where(and(eq(channels.id, channelRecord.id), eq(channels.workspaceId, workspaceId)));
    }
  });
  return { conversation: null, duplicate: false };
}

async function handleWebhook(req: Request, workspaceId: string, channelValue: string) {
  if (!assertWebhookSignature(req)) return { status: 401, body: { error: "invalid_webhook_signature" } };
  const payload = req.body as Record<string, unknown>;
  const payloadWorkspace = await workspaceForProviderPayload(channelValue, payload);
  const providerAccountIds = providerAccountIdsFromPayload(payload);
  if (
    providerAccountIds.length > 0 &&
    (!payloadWorkspace || payloadWorkspace !== workspaceId)
  ) {
    return {
      status: 409,
      body: {
        error: "workspace_channel_mismatch",
        message: "The webhook payload does not belong to this workspace.",
      },
    };
  }
  const events = normalizeProviderPayload(channelValue, payload);
  let accepted = 0;
  try {
    for (const event of events) {
      await ingestEvent(workspaceId, channelValue, event);
      accepted += 1;
    }
  } catch (error) {
    return {
      status: 409,
      body: {
        error: "channel_not_ready",
        message: error instanceof Error ? error.message : "Channel is not ready.",
      },
    };
  }
  return { status: 202, body: { accepted } };
}

function normalizedKnowledgeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[؟?!.,،؛:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function automatedResponseFor(workspaceId: string, customerText: string): Promise<string | null> {
  const normalized = normalizedKnowledgeText(customerText);
  const faqRows = await db.select()
    .from(faqItems)
    .where(and(eq(faqItems.workspaceId, workspaceId), eq(faqItems.enabled, true)))
    .orderBy(desc(faqItems.priority), asc(faqItems.createdAt));
  const faq = faqRows.find((item) => normalizedKnowledgeText(item.question) === normalized);
  if (faq) return faq.answer;

  const rules = await db.select()
    .from(autoReplyRules)
    .where(and(eq(autoReplyRules.workspaceId, workspaceId), eq(autoReplyRules.enabled, true)))
    .orderBy(desc(autoReplyRules.priority), asc(autoReplyRules.createdAt));
  for (const rule of rules) {
    const matches = rule.keywords.some((keyword) => {
      const candidate = normalizedKnowledgeText(keyword);
      if (!candidate) return false;
      if (rule.matchType === "exact") return normalized === candidate;
      if (rule.matchType === "starts_with") return normalized.startsWith(candidate);
      return normalized.includes(candidate);
    });
    if (matches) return rule.response;
  }
  return null;
}

async function sendAndPersistAutomatedResponse(
  workspaceId: string,
  channel: ChannelRecord,
  conversation: ConversationRecord,
  text: string,
) {
  const timestamp = new Date();
  try {
    const providerMessageId = await sendProviderMessage(channel, conversation, text);
    await db.insert(messages).values({
      conversationId: conversation.id,
      providerMessageId,
      from: "assistant",
      text,
      timestamp,
      deliveryStatus: "sent",
    });
  } catch (error) {
    await db.insert(messages).values({
      conversationId: conversation.id,
      from: "assistant",
      text,
      timestamp,
      deliveryStatus: "failed",
      failureReason: CUSTOMER_SEND_ERROR,
    });
    throw error;
  } finally {
    await db.update(conversations)
      .set({ updatedAt: timestamp })
      .where(and(eq(conversations.id, conversation.id), eq(conversations.workspaceId, workspaceId)));
  }
}

async function workspaceForGupshupPayload(
  payload: Record<string, unknown>,
): Promise<{ workspaceId: string; channel: ChannelRecord } | null> {
  const appName = gupshupAppName(payload);
  if (!appName) return null;
  const rows = await db.select()
    .from(channels)
    .where(and(
      eq(channels.type, "WHATSAPP"),
      eq(channels.provider, "GUPSHUP"),
      eq(channels.status, "CONNECTED"),
    ));
  const matches = rows.filter((row) => {
    const data = parseGupshupChannelData(row.providerData);
    return data?.appName === appName;
  });
  if (matches.length !== 1) return null;
  return {
    workspaceId: matches[0].workspaceId,
    channel: channelFromRow(matches[0]),
  };
}

export async function gupshupWebhookHandler(req: Request, res: Response) {
  const payload =
    req.body && typeof req.body === "object"
      ? req.body as Record<string, unknown>
      : {};
  const owner = await workspaceForGupshupPayload(payload);
  if (!owner) {
    return res.status(409).json({
      error: "webhook_workspace_not_resolved",
      message: "The connected WhatsApp workspace could not be resolved.",
    });
  }

  const events = normalizeGupshupPayload(payload);
  if (events.length === 0) return res.status(202).json({ accepted: 0, duplicates: 0 });
  let accepted = 0;
  let duplicates = 0;
  let automatedReplies = 0;
  try {
    for (const event of events) {
      const result = await ingestEvent(
        owner.workspaceId,
        "whatsapp",
        event as unknown as Record<string, unknown>,
      );
      accepted += 1;
      if (result.duplicate) {
        duplicates += 1;
        continue;
      }
      if (event.event !== "message.received" || !result.conversation || !event.text) continue;
      const response = await automatedResponseFor(owner.workspaceId, event.text);
      if (!response) continue;
      await sendAndPersistAutomatedResponse(
        owner.workspaceId,
        owner.channel,
        result.conversation,
        response,
      );
      automatedReplies += 1;
    }
    return res.status(202).json({ accepted, duplicates, automatedReplies });
  } catch (error) {
    req.log?.error(
      { err: error, workspaceId: owner.workspaceId, provider: "GUPSHUP" },
      "Gupshup webhook processing failed",
    );
    return res.status(202).json({
      accepted,
      duplicates,
      automatedReplies,
      warning: "The incoming message was stored, but an automated reply could not be completed.",
    });
  }
}

async function sendProviderMessage(record: ChannelRecord, conversation: ConversationRecord, text: string) {
  if (record.provider === "GUPSHUP") {
    const data = parseGupshupChannelData(record.providerData);
    if (!data || !gupshupIsConfigured()) throw new Error("The channel is not verified for outbound messages.");
    return sendGupshupText(data, conversation.contactAddress, text);
  }
  if (!record.accessToken || !record.providerAccountId) throw new Error("The channel is not verified for outbound messages.");
  const config = providerConfig();
  const url = record.channel === "whatsapp"
    ? `${config.graphUrl}/${process.env.META_WHATSAPP_PHONE_NUMBER_ID || record.providerAccountId}/messages`
    : `${config.graphUrl}/${record.providerAccountId}/messages`;
  const body = record.channel === "whatsapp"
    ? { messaging_product: "whatsapp", to: conversation.contactAddress, type: "text", text: { body: text } }
    : { recipient: { id: conversation.contactAddress }, message: { text } };
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${record.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    message_id?: string;
    error?: { message?: string; code?: string | number };
  };
  if (!response.ok || payload.error) {
    const error = payload.error;
    throw Object.assign(
      new Error(error?.message || `Provider rejected the message (${response.status}).`),
      { code: error?.code ? String(error.code) : "provider_rejected" },
    );
  }
  return payload.messages?.[0]?.id || payload.message_id || randomUUID();
}

async function persistFailedOutboundMessage(
  workspaceId: string,
  conversation: ConversationRecord,
  text: string,
  from: MessageFrom,
  error: unknown,
) {
  const timestamp = new Date();
  await db.insert(messages).values({
    conversationId: conversation.id,
    from,
    text,
    timestamp,
    deliveryStatus: "failed",
    failureReason: error instanceof Error ? error.message : "Provider rejected the message.",
  });
  await db.update(conversations)
    .set({ updatedAt: timestamp })
    .where(and(eq(conversations.id, conversation.id), eq(conversations.workspaceId, workspaceId)));
}

async function persistChannelFailure(workspaceId: string, channel: ChannelRecord, error: unknown, code: string) {
  channel.status = "failed";
  channel.failureReason = error instanceof Error ? error.message : "Provider rejected the message.";
  channel.failureCode = code;
  await persistChannel(workspaceId, channel);
}

router.get("/workspaces/:workspaceId/channels", async (req, res) => {
  const records = await workspaceChannels(workspaceIdFromRequest(res));
  res.json({ channels: records.map(serializeChannel) });
});

router.post("/workspaces/:workspaceId/channels/:channel/connect", async (req, res) => {
  const workspaceId = workspaceIdFromRequest(res);
  if (!canManageWorkspace(res)) return res.status(403).json({ error: "workspace_owner_required" });
  const channel = await channelOr404(workspaceId, req.params.channel);
  if (!channel) return res.status(404).json({ error: "unsupported_channel" });
  try {
    if (channel.channel === "whatsapp" && channel.provider === "GUPSHUP") {
      const result = await connectGupshupChannel(workspaceId, channel, req.body);
      return res.status(result.status).json(result.body);
    }
    return res.json(await connectChannel(
      workspaceId,
      channel,
      typeof req.body?.code === "string" ? req.body.code : undefined,
      typeof req.body?.providerAccountId === "string" ? req.body.providerAccountId : undefined,
      typeof req.body?.state === "string" ? req.body.state : undefined,
    ));
  } catch (error) {
    req.log?.error(
      { err: error, workspaceId, provider: channel.provider },
      "Channel verification failed",
    );
    await persistChannelFailure(
      workspaceId,
      channel,
      new Error(CUSTOMER_CONNECTION_ERROR),
      "provider_verification_failed",
    );
    return res.status(502).json({
      error: channel.failureCode,
      message: CUSTOMER_CONNECTION_ERROR,
      channel: serializeChannel(channel),
    });
  }
});

router.get("/workspaces/:workspaceId/channels/:channel/callback", async (req, res) => {
  const workspaceId = workspaceIdFromRequest(res);
  const channel = await channelOr404(workspaceId, req.params.channel);
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  if (!channel) return res.status(404).json({ error: "unsupported_channel" });
  if (!code) return res.status(400).json({ error: "provider_code_required" });
  try {
    return res.json(await connectChannel(workspaceId, channel, code, undefined, state));
  } catch (error) {
    req.log?.error({ err: error, workspaceId, provider: channel.provider }, "Channel callback failed");
    await persistChannelFailure(workspaceId, channel, error, "provider_verification_failed");
    return res.status(502).json({
      error: channel.failureCode,
      message: channel.failureReason,
      channel: serializeChannel(channel),
    });
  }
});

router.get("/oauth/meta/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  if (!code || !state) return res.status(400).json({ error: "provider_code_and_state_required" });
  const [row] = await db.select().from(channels).where(eq(channels.oauthState, state)).limit(1);
  if (!row) return res.status(400).json({ error: "invalid_provider_state" });
  const workspaceId = row.workspaceId;
  const channel = channelFromRow(row);
  try {
    return res.json(await connectChannel(workspaceId, channel, code, undefined, state));
  } catch (error) {
    await persistChannelFailure(workspaceId, channel, error, "provider_verification_failed");
    return res.status(502).json({
      error: channel.failureCode,
      message: channel.failureReason,
      channel: serializeChannel(channel),
    });
  }
});

router.delete("/workspaces/:workspaceId/channels/:channel", async (req, res) => {
  const workspaceId = workspaceIdFromRequest(res);
  if (!canManageWorkspace(res)) return res.status(403).json({ error: "workspace_owner_required" });
  const channel = await channelOr404(workspaceId, req.params.channel);
  if (!channel) return res.status(404).json({ error: "unsupported_channel" });
  channel.status = "disconnected";
  channel.providerAccountId = undefined;
  channel.displayName = undefined;
  channel.accessToken = undefined;
  channel.connectedAt = undefined;
  channel.lastVerifiedAt = undefined;
  channel.oauthState = undefined;
  channel.failureReason = undefined;
  channel.failureCode = undefined;
  await persistChannel(workspaceId, channel);
  return res.status(204).send();
});

router.get("/workspaces/:workspaceId/conversations", async (req, res) => {
  const workspaceId = workspaceIdFromRequest(res);
  const channel = typeof req.query.channel === "string" ? normalizeChannel(req.query.channel) : undefined;
  res.json({ conversations: await listConversations(workspaceId, channel || undefined) });
});

router.post("/workspaces/:workspaceId/conversations/:conversationId/replies", async (req, res) => {
  const workspaceId = workspaceIdFromRequest(res);
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ error: "message_text_required" });
  const conversation = await loadConversation(workspaceId, req.params.conversationId);
  if (!conversation) return res.status(404).json({ error: "conversation_not_found" });
  const channel = await verifiedChannel(workspaceId, conversation.channel);
  if (!channel) {
    return res.status(409).json({
      error: "channel_not_ready",
      message: `${channelLabels[conversation.channel]} must be verified before replying.`,
    });
  }
  try {
    const providerMessageId = await sendProviderMessage(channel, conversation, text);
    const timestamp = new Date();
    const [storedMessage] = await db.insert(messages).values({
      conversationId: conversation.id,
      providerMessageId,
      from: "team",
      text,
      timestamp,
      deliveryStatus: "sent",
    }).returning({ id: messages.id });
    await db.update(conversations)
      .set({ updatedAt: timestamp, handoff: "TEAM" })
      .where(and(eq(conversations.id, conversation.id), eq(conversations.workspaceId, workspaceId)));
    return res.status(201).json({
      message: {
        id: storedMessage.id,
        providerMessageId,
        from: "team",
        text,
        timestamp: timestamp.toISOString(),
        deliveryStatus: "sent",
      },
      conversation: await loadConversation(workspaceId, conversation.id),
    });
  } catch (error) {
    req.log?.error({ err: error, workspaceId, provider: channel.provider }, "Outbound reply failed");
    await persistFailedOutboundMessage(workspaceId, conversation, text, "team", new Error(CUSTOMER_SEND_ERROR));
    await persistChannelFailure(workspaceId, channel, new Error(CUSTOMER_SEND_ERROR), "provider_send_failed");
    return res.status(502).json({
      error: "provider_send_failed",
      message: CUSTOMER_SEND_ERROR,
      action: "Try again later.",
    });
  }
});

router.post("/workspaces/:workspaceId/conversations/:conversationId/handoff", async (req, res) => {
  const workspaceId = workspaceIdFromRequest(res);
  const conversation = await loadConversation(workspaceId, req.params.conversationId);
  if (!conversation) return res.status(404).json({ error: "conversation_not_found" });
  const channel = await verifiedChannel(workspaceId, conversation.channel);
  if (!channel) {
    return res.status(409).json({
      error: "channel_not_ready",
      message: `${channelLabels[conversation.channel]} must be verified before handoff.`,
    });
  }
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (text) {
    try {
      const providerMessageId = await sendProviderMessage(channel, conversation, text);
      const timestamp = new Date();
      await db.insert(messages).values({
        conversationId: conversation.id,
        providerMessageId,
        from: "assistant",
        text,
        timestamp,
        deliveryStatus: "sent",
      });
      await db.update(conversations)
        .set({ updatedAt: timestamp })
        .where(and(eq(conversations.id, conversation.id), eq(conversations.workspaceId, workspaceId)));
    } catch (error) {
      req.log?.error({ err: error, workspaceId, provider: channel.provider }, "Outbound handoff failed");
      await persistFailedOutboundMessage(workspaceId, conversation, text, "assistant", new Error(CUSTOMER_SEND_ERROR));
      await persistChannelFailure(workspaceId, channel, new Error(CUSTOMER_SEND_ERROR), "provider_send_failed");
      return res.status(502).json({
        error: "provider_send_failed",
        message: CUSTOMER_SEND_ERROR,
        action: "Try again later.",
      });
    }
  }
  await db.update(conversations)
    .set({ handoff: "TEAM", status: "OPEN" })
    .where(and(eq(conversations.id, conversation.id), eq(conversations.workspaceId, workspaceId)));
  return res.json({ conversation: await loadConversation(workspaceId, conversation.id) });
});

router.get("/webhooks/:channel", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && typeof token === "string" && token === process.env.META_WEBHOOK_VERIFY_TOKEN && typeof challenge === "string") {
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Webhook verification failed.");
});

router.post("/webhook/gupshup", gupshupWebhookHandler);

router.post("/workspaces/:workspaceId/webhooks/:channel", async (req, res) => {
  const result = await handleWebhook(req, workspaceIdFromRequest(res), req.params.channel);
  res.status(result.status).json(result.body);
});

router.post("/webhooks/:channel", async (req, res) => {
  const workspaceId = await workspaceForProviderPayload(
    req.params.channel,
    req.body as Record<string, unknown>,
  );
  if (!workspaceId) {
    return res.status(409).json({
      error: "webhook_workspace_not_resolved",
      message: "The provider account is not connected to exactly one workspace.",
    });
  }
  const result = await handleWebhook(req, workspaceId, req.params.channel);
  return res.status(result.status).json(result.body);
});

export default router;