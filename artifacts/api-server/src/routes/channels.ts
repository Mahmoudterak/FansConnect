import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { Router, type IRouter, type Request } from "express";

type ChannelName = "whatsapp" | "instagram";
type ChannelStatus =
  | "setup_required"
  | "connecting"
  | "connected"
  | "degraded"
  | "failed"
  | "disconnected";

type ChannelRecord = {
  channel: ChannelName;
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
  from: "customer" | "team" | "assistant";
  text: string;
  timestamp: string;
  deliveryStatus?: "queued" | "sent" | "delivered" | "read" | "failed";
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
const channelsByWorkspace = new Map<string, Map<ChannelName, ChannelRecord>>();
const conversationsByWorkspace = new Map<string, ConversationRecord[]>();

const channelLabels: Record<ChannelName, string> = {
  whatsapp: "WhatsApp Business",
  instagram: "Instagram Direct",
};

function normalizeChannel(value: string): ChannelName | null {
  if (value === "whatsapp" || value === "whatsapp-business") return "whatsapp";
  if (value === "instagram" || value === "instagram-direct") return "instagram";
  return null;
}

function workspaceIdFromRequest(req: Request): string {
  const pathWorkspaceId = req.params.workspaceId;
  return (typeof pathWorkspaceId === "string" && pathWorkspaceId) ||
    req.header("x-workspace-id") ||
    "current";
}

function canManageWorkspace(req: Request): boolean {
  const role = req.header("x-workspace-role");
  return !role || role === "owner";
}

function workspaceChannels(workspaceId: string): Map<ChannelName, ChannelRecord> {
  let channels = channelsByWorkspace.get(workspaceId);
  if (!channels) {
    channels = new Map([
      ["whatsapp", { channel: "whatsapp", status: "setup_required" }],
      ["instagram", { channel: "instagram", status: "setup_required" }],
    ]);
    channelsByWorkspace.set(workspaceId, channels);
  }
  return channels;
}

function healthFor(record: ChannelRecord) {
  if (record.status === "connected") {
    return {
      state: "healthy",
      verified: true,
      message: "Provider credentials verified and webhooks are ready.",
      action: null,
    };
  }
  if (record.status === "failed") {
    return {
      state: "failed",
      verified: false,
      message: record.failureReason || "Provider verification failed.",
      action: "Reconnect and verify the provider credentials.",
    };
  }
  if (record.status === "connecting") {
    return {
      state: "connecting",
      verified: false,
      message: "Waiting for provider authorization to finish.",
      action: "Complete authorization in the provider window.",
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
  return {
    state: "setup_required",
    verified: false,
    message: "Provider setup is required before this channel can receive messages.",
    action: "Configure Meta provider credentials, then connect this channel.",
  };
}

function serializeChannel(record: ChannelRecord) {
  return {
    channel: record.channel,
    name: channelLabels[record.channel],
    status: record.status,
    verified: record.status === "connected",
    providerAccountId: record.providerAccountId || null,
    displayName: record.displayName || null,
    connectedAt: record.connectedAt || null,
    lastVerifiedAt: record.lastVerifiedAt || null,
    failureReason: record.failureReason || null,
    failureCode: record.failureCode || null,
    health: healthFor(record),
  };
}

function providerConfig() {
  return {
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    redirectUri: process.env.META_REDIRECT_URI,
    graphUrl: (process.env.META_GRAPH_URL || "https://graph.facebook.com/v21.0").replace(
      /\/$/,
      "",
    ),
  };
}

function setupResponse(channel: ChannelRecord) {
  const config = providerConfig();
  const result: {
    channel: ReturnType<typeof serializeChannel>;
    connectUrl: string | null;
    message: string;
  } = {
    channel: serializeChannel(channel),
    connectUrl: null,
    message:
      "Meta provider setup is required. Add META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI to start authorization.",
  };

  if (config.appId && config.appSecret && config.redirectUri) {
    const state = randomUUID();
    channel.status = "connecting";
    channel.oauthState = state;
    channel.failureReason = undefined;
    const scopes =
      channel.channel === "whatsapp"
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

async function graphGet(
  graphUrl: string,
  path: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const url = new URL(`${graphUrl}/${path.replace(/^\//, "")}`);
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url);
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok || payload.error) {
    const error = payload.error as { message?: string; code?: number } | undefined;
    throw new Error(error?.message || `Meta verification returned ${response.status}.`);
  }
  return payload;
}

async function verifyMetaConnection(
  channel: ChannelName,
  accessToken: string,
  providerAccountId?: string,
) {
  const config = providerConfig();
  if (!config.appId || !config.appSecret || !config.redirectUri) {
    throw new Error(
      "Meta provider is not configured. Add META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI.",
    );
  }

  const account = await graphGet(config.graphUrl, "me?fields=id,name", accessToken);
  let id = providerAccountId || (typeof account.id === "string" ? account.id : undefined);
  let displayName = typeof account.name === "string" ? account.name : undefined;

  if (channel === "whatsapp") {
    const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
    if (!phoneNumberId) throw new Error("Meta did not return a WhatsApp account.");
    const phone = await graphGet(
      config.graphUrl,
      `${phoneNumberId}?fields=id,display_phone_number,verified_name`,
      accessToken,
    );
    id = typeof phone.id === "string" ? phone.id : phoneNumberId;
    displayName =
      (typeof phone.verified_name === "string" && phone.verified_name) ||
      (typeof phone.display_phone_number === "string" && phone.display_phone_number) ||
      displayName;
  } else {
    const instagram = await graphGet(
      config.graphUrl,
      `${id || "me"}?fields=id,name,instagram_business_account`,
      accessToken,
    );
    const businessAccount = instagram.instagram_business_account as
      | { id?: string }
      | undefined;
    id = businessAccount?.id || id;
    displayName = typeof instagram.name === "string" ? instagram.name : displayName;
  }

  if (!id) throw new Error("Meta verification did not return a provider account.");
  return { id, displayName };
}

async function exchangeCode(code: string) {
  const config = providerConfig();
  if (!config.appId || !config.appSecret || !config.redirectUri) {
    throw new Error(
      "Meta provider is not configured. Add META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI.",
    );
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

async function connectChannel(
  record: ChannelRecord,
  code?: string,
  providerAccountId?: string,
  state?: string,
) {
  if (!code) return setupResponse(record);
  if (!record.oauthState || state !== record.oauthState) {
    throw new Error("Invalid provider authorization state.");
  }
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
  return {
    channel: serializeChannel(record),
    connectUrl: null,
    message: "Provider credentials verified. The channel is ready for webhooks and messages.",
  };
}

function channelOr404(workspaceId: string, channelValue: string): ChannelRecord | null {
  const channel = normalizeChannel(channelValue);
  if (!channel) return null;
  return workspaceChannels(workspaceId).get(channel) || null;
}

function verifiedChannel(workspaceId: string, channelValue: string) {
  const channel = channelOr404(workspaceId, channelValue);
  if (!channel || channel.status !== "connected" || !channel.accessToken) return null;
  return channel;
}

function conversationList(workspaceId: string) {
  let list = conversationsByWorkspace.get(workspaceId);
  if (!list) {
    list = [];
    conversationsByWorkspace.set(workspaceId, list);
  }
  return list;
}

function providerAccountIdsFromPayload(payload: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  if (typeof payload.object === "string" && Array.isArray(payload.entry)) {
    for (const entry of payload.entry as Array<Record<string, unknown>>) {
      if (typeof entry.id === "string") ids.add(entry.id);
      for (const change of (entry.changes || []) as Array<Record<string, unknown>>) {
        const value = (change.value || {}) as Record<string, unknown>;
        const metadata = value.metadata as Record<string, unknown> | undefined;
        if (typeof metadata?.phone_number_id === "string") ids.add(metadata.phone_number_id);
      }
    }
  }
  return [...ids];
}

function workspaceForProviderPayload(
  channelValue: string,
  payload: Record<string, unknown>,
): string | null {
  const channel = normalizeChannel(channelValue);
  if (!channel) return null;
  const ids = providerAccountIdsFromPayload(payload);
  for (const [workspaceId, channels] of channelsByWorkspace) {
    const record = channels.get(channel);
    if (record?.status === "connected" && record.providerAccountId && ids.includes(record.providerAccountId)) {
      return workspaceId;
    }
  }
  return null;
}

async function sendProviderMessage(
  record: ChannelRecord,
  conversation: ConversationRecord,
  text: string,
) {
  if (!record.accessToken || !record.providerAccountId) {
    throw new Error("The channel is not verified for outbound messages.");
  }
  const config = providerConfig();
  const recipient = conversation.contactAddress;
  const url =
    record.channel === "whatsapp"
      ? `${config.graphUrl}/${process.env.META_WHATSAPP_PHONE_NUMBER_ID || record.providerAccountId}/messages`
      : `${config.graphUrl}/${record.providerAccountId}/messages`;
  const body =
    record.channel === "whatsapp"
      ? { messaging_product: "whatsapp", to: recipient, type: "text", text: { body: text } }
      : { recipient: { id: recipient }, message: { text } };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${record.accessToken}`,
      "content-type": "application/json",
    },
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

function assertWebhookSignature(req: Request): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true;
  const signature = req.header("x-hub-signature-256") || req.header("x-webhook-signature");
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!signature || !rawBody) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    provided.length === expectedBuffer.length &&
    timingSafeEqual(provided, expectedBuffer)
  );
}

function eventChannel(
  workspaceId: string,
  value: string,
): ChannelName | null {
  return normalizeChannel(value) || null;
}

function normalizeProviderPayload(
  channelValue: string,
  payload: Record<string, unknown>,
): Record<string, unknown>[] {
  if (Array.isArray(payload.events)) {
    return payload.events as Record<string, unknown>[];
  }
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
        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const message of messages as Array<Record<string, unknown>>) {
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
      const messages = Array.isArray(entry.messaging) ? entry.messaging : [];
      for (const messaging of messages as Array<Record<string, unknown>>) {
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

function ingestEvent(
  workspaceId: string,
  channelValue: string,
  event: Record<string, unknown>,
) {
  const channel = eventChannel(workspaceId, channelValue);
  if (!channel) throw new Error("Unsupported channel.");
  const channelRecord = verifiedChannel(workspaceId, channel);
  if (!channelRecord) throw new Error(`${channelLabels[channel]} is not verified.`);

  const eventType = typeof event.event === "string" ? event.event : "message.received";
  const providerMessageId =
    typeof event.providerMessageId === "string" ? event.providerMessageId : undefined;
  const conversations = conversationList(workspaceId);

  if (eventType === "message.received") {
    const contactAddress =
      typeof event.from === "string" ? event.from : typeof event.senderId === "string" ? event.senderId : "";
    const text = typeof event.text === "string" ? event.text.trim() : "";
    if (!contactAddress || !text) throw new Error("Inbound message requires from and text.");
    const now = typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString();
    let conversation = conversations.find(
      (item) =>
        item.channel === channel &&
        item.contactAddress === contactAddress &&
        item.status !== "resolved",
    );
    if (!conversation) {
      conversation = {
        id: randomUUID(),
        channel,
        providerConversationId:
          typeof event.providerConversationId === "string"
            ? event.providerConversationId
            : undefined,
        contactName:
          typeof event.contactName === "string" && event.contactName
            ? event.contactName
            : contactAddress,
        contactAddress,
        status: "open",
        handoff: "assistant",
        updatedAt: now,
        messages: [],
      };
      conversations.unshift(conversation);
    }
    conversation.messages.push({
      id: randomUUID(),
      providerMessageId,
      from: "customer",
      text,
      timestamp: now,
    });
    conversation.updatedAt = now;
    return conversation;
  }

  const deliveryStatus =
    eventType.endsWith("delivered") ? "delivered" : eventType.endsWith("read") ? "read" : "failed";
  const message = conversations
    .flatMap((conversation) => conversation.messages)
    .find((item) => item.providerMessageId === providerMessageId);
  if (message) {
    message.deliveryStatus = deliveryStatus;
    if (deliveryStatus === "failed" && typeof event.error === "string") {
      message.failureReason = event.error;
    }
  }
  if (deliveryStatus === "failed") {
    channelRecord.status = "failed";
    channelRecord.failureReason =
      typeof event.error === "string" ? event.error : "The provider reported a delivery failure.";
    channelRecord.failureCode = "provider_delivery_failed";
  }
  return null;
}

async function handleWebhook(req: Request, workspaceId: string, channelValue: string) {
  if (!assertWebhookSignature(req)) {
    return { status: 401, body: { error: "invalid_webhook_signature" } };
  }
  const payload = req.body as Record<string, unknown>;
  const payloadWorkspace = workspaceForProviderPayload(channelValue, payload);
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
      ingestEvent(workspaceId, channelValue, event as Record<string, unknown>);
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

router.get("/workspaces/:workspaceId/channels", (req, res) => {
  const channels = [...workspaceChannels(workspaceIdFromRequest(req)).values()].map(serializeChannel);
  res.json({ channels });
});

router.post("/workspaces/:workspaceId/channels/:channel/connect", async (req, res) => {
  const workspaceId = workspaceIdFromRequest(req);
  if (!canManageWorkspace(req)) return res.status(403).json({ error: "workspace_owner_required" });
  const channel = channelOr404(workspaceId, req.params.channel);
  if (!channel) return res.status(404).json({ error: "unsupported_channel" });
  try {
    return res.json(
      await connectChannel(
        channel,
        typeof req.body?.code === "string" ? req.body.code : undefined,
        typeof req.body?.providerAccountId === "string"
          ? req.body.providerAccountId
          : undefined,
        typeof req.body?.state === "string" ? req.body.state : undefined,
      ),
    );
  } catch (error) {
    channel.status = "failed";
    channel.failureReason = error instanceof Error ? error.message : "Provider verification failed.";
    channel.failureCode = "provider_verification_failed";
    return res.status(502).json({
      error: channel.failureCode,
      message: channel.failureReason,
      channel: serializeChannel(channel),
    });
  }
});

router.get("/workspaces/:workspaceId/channels/:channel/callback", async (req, res) => {
  const workspaceId = workspaceIdFromRequest(req);
  const channel = channelOr404(workspaceId, req.params.channel);
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  if (!channel) return res.status(404).json({ error: "unsupported_channel" });
  if (!code) return res.status(400).json({ error: "provider_code_required" });
  try {
    return res.json(await connectChannel(channel, code, undefined, state));
  } catch (error) {
    channel.status = "failed";
    channel.failureReason = error instanceof Error ? error.message : "Provider verification failed.";
    channel.failureCode = "provider_verification_failed";
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
  for (const channels of channelsByWorkspace.values()) {
    const channel = [...channels.values()].find((item) => item.oauthState === state);
    if (!channel) continue;
    try {
      return res.json(await connectChannel(channel, code, undefined, state));
    } catch (error) {
      channel.status = "failed";
      channel.failureReason = error instanceof Error ? error.message : "Provider verification failed.";
      channel.failureCode = "provider_verification_failed";
      return res.status(502).json({
        error: channel.failureCode,
        message: channel.failureReason,
        channel: serializeChannel(channel),
      });
    }
  }
  return res.status(400).json({ error: "invalid_provider_state" });
});

router.delete("/workspaces/:workspaceId/channels/:channel", (req, res) => {
  const workspaceId = workspaceIdFromRequest(req);
  if (!canManageWorkspace(req)) return res.status(403).json({ error: "workspace_owner_required" });
  const channel = channelOr404(workspaceId, req.params.channel);
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
  return res.status(204).send();
});

router.get("/workspaces/:workspaceId/conversations", (req, res) => {
  const workspaceId = workspaceIdFromRequest(req);
  const channel = typeof req.query.channel === "string" ? normalizeChannel(req.query.channel) : null;
  const conversations = conversationList(workspaceId)
    .filter((item) => !channel || item.channel === channel)
    .map((item) => ({ ...item, messages: item.messages.map((message) => ({ ...message })) }));
  res.json({ conversations });
});

router.post("/workspaces/:workspaceId/conversations/:conversationId/replies", async (req, res) => {
  const workspaceId = workspaceIdFromRequest(req);
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ error: "message_text_required" });
  const conversation = conversationList(workspaceId).find(
    (item) => item.id === req.params.conversationId,
  );
  if (!conversation) return res.status(404).json({ error: "conversation_not_found" });
  const channel = verifiedChannel(workspaceId, conversation.channel);
  if (!channel) {
    return res.status(409).json({
      error: "channel_not_ready",
      message: `${channelLabels[conversation.channel]} must be verified before replying.`,
    });
  }
  try {
    const providerMessageId = await sendProviderMessage(channel, conversation, text);
    const message: MessageRecord = {
      id: randomUUID(),
      providerMessageId,
      from: "team",
      text,
      timestamp: new Date().toISOString(),
      deliveryStatus: "sent",
    };
    conversation.messages.push(message);
    conversation.updatedAt = message.timestamp;
    conversation.handoff = "team";
    return res.status(201).json({ message, conversation });
  } catch (error) {
    channel.status = "failed";
    channel.failureReason = error instanceof Error ? error.message : "Provider rejected the message.";
    channel.failureCode = "provider_send_failed";
    return res.status(502).json({
      error: "provider_send_failed",
      message: error instanceof Error ? error.message : "Provider rejected the message.",
      action: "Check channel credentials and provider permissions.",
    });
  }
});

router.post("/workspaces/:workspaceId/conversations/:conversationId/handoff", async (req, res) => {
  const workspaceId = workspaceIdFromRequest(req);
  const conversation = conversationList(workspaceId).find(
    (item) => item.id === req.params.conversationId,
  );
  if (!conversation) return res.status(404).json({ error: "conversation_not_found" });
  if (!verifiedChannel(workspaceId, conversation.channel)) {
    return res.status(409).json({
      error: "channel_not_ready",
      message: `${channelLabels[conversation.channel]} must be verified before handoff.`,
    });
  }
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (text) {
    const channel = verifiedChannel(workspaceId, conversation.channel)!;
    try {
      const providerMessageId = await sendProviderMessage(channel, conversation, text);
      const message: MessageRecord = {
        id: randomUUID(),
        providerMessageId,
        from: "assistant",
        text,
        timestamp: new Date().toISOString(),
        deliveryStatus: "sent",
      };
      conversation.messages.push(message);
      conversation.updatedAt = message.timestamp;
    } catch (error) {
      channel.status = "failed";
      channel.failureReason = error instanceof Error ? error.message : "Provider rejected the handoff message.";
      channel.failureCode = "provider_send_failed";
      return res.status(502).json({
        error: "provider_send_failed",
        message: error instanceof Error ? error.message : "Provider rejected the handoff message.",
        action: "Check channel credentials and provider permissions.",
      });
    }
  }
  conversation.handoff = "team";
  conversation.status = "open";
  return res.json({ conversation });
});

router.get("/webhooks/:channel", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (
    mode === "subscribe" &&
    typeof token === "string" &&
    token === process.env.META_WEBHOOK_VERIFY_TOKEN &&
    typeof challenge === "string"
  ) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Webhook verification failed.");
});

router.post("/workspaces/:workspaceId/webhooks/:channel", async (req, res) => {
  const result = await handleWebhook(req, workspaceIdFromRequest(req), req.params.channel);
  res.status(result.status).json(result.body);
});

router.post("/webhooks/:channel", async (req, res) => {
  const workspaceId =
    workspaceForProviderPayload(req.params.channel, req.body as Record<string, unknown>) ||
    "current";
  const result = await handleWebhook(req, workspaceId, req.params.channel);
  res.status(result.status).json(result.body);
});

export default router;