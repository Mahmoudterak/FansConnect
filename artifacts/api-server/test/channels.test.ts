import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import express, { type Request } from "express";
import { eq, inArray } from "drizzle-orm";
import { assistantConfigs, autoReplyRules, channels, contacts, db, faqItems, workspaces } from "@workspace/db";
import channelsRouter from "../src/routes/channels";

type Json = Record<string, unknown>;
type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

const originalEnv = new Map<string, string | undefined>();
const metaEnvKeys = [
  "META_APP_ID",
  "META_APP_SECRET",
  "META_REDIRECT_URI",
  "META_GRAPH_URL",
  "META_WEBHOOK_VERIFY_TOKEN",
  "META_WHATSAPP_PHONE_NUMBER_ID",
  "gupshupAPPKAY",
  "GUPSHUP_EMBEDDED_SIGNUP_URL",
  "GUPSHUP_EMBEDDED_SIGNUP_CALLBACK_URL",
  "GUPSHUP_PARTNER_TOKEN",
  "GUPSHUP_PARTNER_API_BASE",
  "GUPSHUP_WEBHOOK_SECRET",
];

let server: Server;
let baseUrl: string;
const workspaceIds = new Map<string, string>();
const app = express();

app.use(
  express.json({
    verify: (req, _res, buffer) => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }),
);
app.use("/api/workspaces/:workspaceId", (req, res, next) => {
  res.locals.workspaceId = req.params.workspaceId;
  res.locals.auth = {
    userId: "test-user",
    workspaceId: req.params.workspaceId,
    email: "test@example.com",
    emailVerified: true,
    role: req.header("x-workspace-role")?.toUpperCase() || "OWNER",
  };
  next();
});
app.use("/api", channelsRouter);

function jsonResponse(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function request(path: string, options: RequestOptions = {}): Promise<{
  status: number;
  body: string;
  json: Json;
}> {
  const body =
    options.body === undefined
      ? ""
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  let resolvedPath = path;
  for (const [label, id] of workspaceIds) {
    resolvedPath = resolvedPath.replace(`/workspaces/${label}`, `/workspaces/${id}`);
  }
  const url = new URL(resolvedPath, baseUrl);
  return new Promise((resolve, reject) => {
    const requestOptions = {
      method: options.method || "GET",
      hostname: url.hostname,
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      headers: {
        ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
        ...(options.headers || {}),
      },
    };
    const outgoing = httpRequest(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf8");
        let json: Json = {};
        try {
          json = JSON.parse(responseBody) as Json;
        } catch {
          // Verification endpoints intentionally return a plain challenge.
        }
        resolve({ status: response.statusCode || 0, body: responseBody, json });
      });
    });
    outgoing.on("error", reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

async function ensureWorkspace(label: string): Promise<string> {
  const existing = workspaceIds.get(label);
  if (existing) return existing;
  const id = randomUUID();
  await db.insert(workspaces).values({ id, name: `Channel test ${label}` });
  workspaceIds.set(label, id);
  return id;
}

function signature(body: string): string {
  return `sha256=${createHmac("sha256", process.env.META_APP_SECRET || "").update(body).digest("hex")}`;
}

function signedWebhook(path: string, payload: Json, extraHeaders: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  return request(path, {
    method: "POST",
    body,
    headers: { "x-hub-signature-256": signature(body), ...extraHeaders },
  });
}

async function beginConnect(workspaceId: string, channel: "whatsapp" | "instagram") {
  const id = await ensureWorkspace(workspaceId);
  await db.insert(channels).values({
    workspaceId: id,
    type: channel.toUpperCase(),
    provider: "META",
    status: "NOT_CONNECTED",
  }).onConflictDoUpdate({
    target: [channels.workspaceId, channels.type],
    set: { provider: "META", status: "NOT_CONNECTED", providerData: {} },
  });
  const response = await request(`/api/workspaces/${workspaceId}/channels/${channel}/connect`, {
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.channel && (response.json.channel as Json).status, "connecting");
  const connectUrl = new URL(String(response.json.connectUrl));
  return connectUrl.searchParams.get("state") as string;
}

async function connectChannel(
  workspaceId: string,
  channel: "whatsapp" | "instagram",
  providerAccountId: string,
) {
  if (channel === "whatsapp") {
    process.env.META_WHATSAPP_PHONE_NUMBER_ID = providerAccountId;
  }
  const state = await beginConnect(workspaceId, channel);
  (globalThis as { fetch: typeof fetch }).fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/oauth/access_token")) {
      return jsonResponse({ access_token: `access-token-${workspaceId}` });
    }
    if (url.pathname.endsWith("/me")) {
      return jsonResponse({
        id: `page-${workspaceId}`,
        name: `${channel} ${workspaceId}`,
      });
    }
    if (channel === "whatsapp" && url.pathname.endsWith(`/${providerAccountId}`)) {
      return jsonResponse({
        id: providerAccountId,
        verified_name: `WhatsApp ${workspaceId}`,
      });
    }
    if (channel === "instagram" && url.pathname.endsWith(`/page-${workspaceId}`)) {
      return jsonResponse({
        id: `page-${workspaceId}`,
        name: `Instagram ${workspaceId}`,
        instagram_business_account: { id: providerAccountId },
      });
    }
    throw new Error(`Unexpected Meta request: ${url}`);
  };
  const response = await request(`/api/workspaces/${workspaceId}/channels/${channel}/connect`, {
    method: "POST",
    body: { code: `code-${workspaceId}`, state },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.channel && (response.json.channel as Json).status, "connected");
  return response;
}

function whatsappPayload(
  providerAccountId: string,
  from: string,
  messageId: string,
  text = "Hello from WhatsApp",
): Json {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: `business-${providerAccountId}`,
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: providerAccountId },
              contacts: [{ wa_id: from, profile: { name: "WhatsApp customer" } }],
              messages: [
                {
                  id: messageId,
                  from,
                  timestamp: "1710000000",
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function instagramPayload(providerAccountId: string, senderId: string, messageId: string): Json {
  return {
    object: "instagram",
    entry: [
      {
        id: providerAccountId,
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: providerAccountId },
            timestamp: 1710000000000,
            message: { mid: messageId, text: "Hello from Instagram" },
          },
        ],
      },
    ],
  };
}

before(async () => {
  for (const key of metaEnvKeys) originalEnv.set(key, process.env[key]);
  process.env.META_APP_ID = "test-meta-app";
  process.env.META_APP_SECRET = "test-meta-secret";
  process.env.META_REDIRECT_URI = "https://example.test/api/oauth/meta/callback";
  process.env.META_GRAPH_URL = "https://meta.test/v21.0";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "test-webhook-token";
  process.env.gupshupAPPKAY = "test-gupshup-key";
  process.env.GUPSHUP_EMBEDDED_SIGNUP_URL = "https://partner.gupshup.test/embedded-signup";
  process.env.GUPSHUP_EMBEDDED_SIGNUP_CALLBACK_URL = "https://example.test/api/oauth/gupshup/callback";
  process.env.GUPSHUP_PARTNER_TOKEN = "test-partner-token";
  process.env.GUPSHUP_PARTNER_API_BASE = "https://partner.gupshup.test";
  process.env.GUPSHUP_WEBHOOK_SECRET = "test-gupshup-webhook-secret";
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  process.env.META_WHATSAPP_PHONE_NUMBER_ID = "test-phone";
});

after(async () => {
  for (const key of metaEnvKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (workspaceIds.size > 0) {
    await db.delete(workspaces).where(inArray(workspaces.id, [...workspaceIds.values()]));
  }
});

describe("Meta channel connection safety", () => {
  it("completes OAuth through the callback and consumes the authorization state", async () => {
    const state = await beginConnect("oauth-success", "whatsapp");
    process.env.META_WHATSAPP_PHONE_NUMBER_ID = "oauth-phone";
    (globalThis as { fetch: typeof fetch }).fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/oauth/access_token")) return jsonResponse({ access_token: "oauth-token" });
      if (url.pathname.endsWith("/me")) return jsonResponse({ id: "oauth-page", name: "OAuth business" });
      if (url.pathname.endsWith("/oauth-phone")) return jsonResponse({ id: "oauth-phone", verified_name: "Verified line" });
      throw new Error(`Unexpected Meta request: ${url}`);
    };

    const callback = await request(`/api/oauth/meta/callback?code=oauth-code&state=${encodeURIComponent(state)}`);
    assert.equal(callback.status, 200);
    assert.equal((callback.json.channel as Json).status, "connected");
    assert.equal((callback.json.channel as Json).providerAccountId, "oauth-phone");

    const replay = await request(`/api/oauth/meta/callback?code=oauth-code&state=${encodeURIComponent(state)}`);
    assert.equal(replay.status, 400);
    assert.equal(replay.json.error, "invalid_provider_state");
  });

  it("rejects an invalid OAuth state and records the failed connection", async () => {
    const state = await beginConnect("oauth-invalid-state", "whatsapp");
    const response = await request("/api/workspaces/oauth-invalid-state/channels/whatsapp/connect", {
      method: "POST",
      body: { code: "code", state: `${state}-wrong` },
    });
    assert.equal(response.status, 502);
    assert.equal(response.json.error, "provider_verification_failed");
    assert.equal(response.json.message, "Unable to connect WhatsApp right now. Please try again later.");
    assert.equal((response.json.channel as Json).status, "failed");
  });

  it("surfaces provider verification failures as failed channel health", async () => {
    const state = await beginConnect("oauth-provider-failure", "instagram");
    (globalThis as { fetch: typeof fetch }).fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/oauth/access_token")) return jsonResponse({ access_token: "bad-token" });
      return jsonResponse({ error: { message: "Token was rejected by Meta" } }, 401);
    };
    const response = await request("/api/workspaces/oauth-provider-failure/channels/instagram/connect", {
      method: "POST",
      body: { code: "code", state },
    });
    assert.equal(response.status, 502);
    assert.equal(response.json.error, "provider_verification_failed");
    assert.equal((response.json.channel as Json).status, "failed");
    assert.equal((response.json.channel as Json).failureReason, "Unable to use this channel right now.");
  });

  it("allows only an owner to disconnect a channel and clears its credentials", async () => {
    await connectChannel("disconnect", "whatsapp", "disconnect-phone");
    const forbidden = await request("/api/workspaces/disconnect/channels/whatsapp", {
      method: "DELETE",
      headers: { "x-workspace-role": "member" },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.error, "workspace_owner_required");

    const disconnected = await request("/api/workspaces/disconnect/channels/whatsapp", {
      method: "DELETE",
      headers: { "x-workspace-role": "owner" },
    });
    assert.equal(disconnected.status, 204);
    const channels = await request("/api/workspaces/disconnect/channels");
    const whatsapp = (channels.json.channels as Json[]).find((item) => item.channel === "whatsapp") as Json;
    assert.equal(whatsapp.status, "disconnected");
    assert.equal(whatsapp.verified, false);
  });
});

describe("Meta webhook ingestion", () => {
  it("maps a native WhatsApp payload into a workspace conversation and message", async () => {
    await connectChannel("whatsapp-inbound", "whatsapp", "whatsapp-phone");
    const response = await signedWebhook(
      "/api/webhooks/whatsapp",
      whatsappPayload("whatsapp-phone", "971500000001", "wamid-whatsapp"),
    );
    assert.equal(response.status, 202, JSON.stringify(response.json));
    assert.equal(response.json.accepted, 1);
    const duplicate = await signedWebhook(
      "/api/webhooks/whatsapp",
      whatsappPayload("whatsapp-phone", "971500000001", "wamid-whatsapp"),
    );
    assert.equal(duplicate.status, 202);

    const conversations = await request("/api/workspaces/whatsapp-inbound/conversations?channel=whatsapp");
    const conversation = (conversations.json.conversations as Json[])[0];
    assert.equal((conversations.json.conversations as Json[]).length, 1);
    assert.equal((conversation.messages as Json[]).length, 1);
    assert.equal(conversation.contactName, "WhatsApp customer");
    assert.equal(conversation.contactAddress, "971500000001");
    assert.equal((conversation.messages as Json[])[0].providerMessageId, "wamid-whatsapp");
    assert.equal((conversation.messages as Json[])[0].text, "Hello from WhatsApp");
  });

  it("maps a native Instagram payload into a workspace conversation and message", async () => {
    await connectChannel("instagram-inbound", "instagram", "instagram-business");
    const response = await signedWebhook(
      "/api/webhooks/instagram",
      instagramPayload("instagram-business", "instagram-user", "ig-mid"),
    );
    assert.equal(response.status, 202);
    assert.equal(response.json.accepted, 1);

    const conversations = await request("/api/workspaces/instagram-inbound/conversations?channel=instagram");
    const conversation = (conversations.json.conversations as Json[])[0];
    assert.equal(conversation.contactAddress, "instagram-user");
    assert.equal((conversation.messages as Json[])[0].providerMessageId, "ig-mid");
    assert.equal((conversation.messages as Json[])[0].text, "Hello from Instagram");
  });

  it("downgrades channel health on delivery failure and blocks later outbound sends", async () => {
    await connectChannel("delivery-failure", "whatsapp", "delivery-phone");
    const inbound = await signedWebhook(
      "/api/webhooks/whatsapp",
      whatsappPayload("delivery-phone", "971500000002", "wamid-inbound"),
    );
    assert.equal(inbound.status, 202);
    const conversations = await request("/api/workspaces/delivery-failure/conversations");
    const conversationId = String((conversations.json.conversations as Json[])[0].id);

    (globalThis as { fetch: typeof fetch }).fetch = async () =>
      jsonResponse({ messages: [{ id: "wamid-outbound" }] });
    const reply = await request(`/api/workspaces/delivery-failure/conversations/${conversationId}/replies`, {
      method: "POST",
      body: { text: "A team reply" },
    });
    assert.equal(reply.status, 201);

    const failurePayload: Json = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "business-delivery-phone",
          changes: [
            {
              value: {
                metadata: { phone_number_id: "delivery-phone" },
                statuses: [
                  {
                    id: "wamid-outbound",
                    status: "failed",
                    errors: [{ title: "Recipient blocked messages" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const failure = await signedWebhook("/api/webhooks/whatsapp", failurePayload);
    assert.equal(failure.status, 202);
    assert.equal(failure.json.accepted, 1);

    const channels = await request("/api/workspaces/delivery-failure/channels");
    const channel = (channels.json.channels as Json[]).find((item) => item.channel === "whatsapp") as Json;
    assert.equal(channel.status, "failed");
    assert.equal(channel.failureCode, "provider_delivery_failed");
    assert.equal(channel.failureReason, "Unable to use this channel right now.");

    const blocked = await request(`/api/workspaces/delivery-failure/conversations/${conversationId}/replies`, {
      method: "POST",
      body: { text: "This must not be sent" },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error, "channel_not_ready");
  });

  it("requires webhook verification, rejects bad signatures, and isolates workspaces", async () => {
    const verified = await request(
      "/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-webhook-token&hub.challenge=challenge-123",
    );
    assert.equal(verified.status, 200);
    assert.equal(verified.body, "challenge-123");
    const unverified = await request(
      "/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123",
    );
    assert.equal(unverified.status, 403);

    await connectChannel("isolation-a", "whatsapp", "isolation-phone-a");
    await connectChannel("isolation-b", "whatsapp", "isolation-phone-b");
    const payload = whatsappPayload("isolation-phone-a", "971500000003", "wamid-isolated");
    const body = JSON.stringify(payload);
    const badSignature = await request("/api/webhooks/whatsapp", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": "sha256=invalid" },
    });
    assert.equal(badSignature.status, 401);
    assert.equal(badSignature.json.error, "invalid_webhook_signature");
    const configuredSecret = process.env.META_APP_SECRET;
    delete process.env.META_APP_SECRET;
    const missingSecret = await request("/api/webhooks/whatsapp", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": signature(body) },
    });
    process.env.META_APP_SECRET = configuredSecret;
    assert.equal(missingSecret.status, 401);
    assert.equal(missingSecret.json.error, "invalid_webhook_signature");

    const accepted = await signedWebhook(
      "/api/webhooks/whatsapp",
      payload,
      { "x-workspace-id": "isolation-b" },
    );
    assert.equal(accepted.status, 202);
    const workspaceA = await request("/api/workspaces/isolation-a/conversations");
    const workspaceB = await request("/api/workspaces/isolation-b/conversations");
    assert.equal((workspaceA.json.conversations as Json[]).length, 1);
    assert.equal((workspaceB.json.conversations as Json[]).length, 0);

    const crossWorkspace = await signedWebhook(
      "/api/workspaces/isolation-b/webhooks/whatsapp",
      payload,
    );
    assert.equal(crossWorkspace.status, 409);
    assert.equal(crossWorkspace.json.error, "workspace_channel_mismatch");
    const afterCrossWorkspace = await request("/api/workspaces/isolation-b/conversations");
    assert.equal((afterCrossWorkspace.json.conversations as Json[]).length, 0);
  });
});

describe("Gupshup WhatsApp provider", () => {
  it("verifies the app, resolves the tenant, sends a persisted FAQ reply, and suppresses duplicates", async () => {
    const workspaceId = await ensureWorkspace("gupshup-faq");
    await db.insert(channels).values({
      workspaceId,
      type: "WHATSAPP",
      provider: "GUPSHUP",
      status: "NOT_CONNECTED",
    }).onConflictDoUpdate({
      target: [channels.workspaceId, channels.type],
      set: { provider: "GUPSHUP", status: "NOT_CONNECTED", providerData: {} },
    });
    await db.insert(faqItems).values({
      workspaceId,
      question: "كم سعر تنظيف الأسنان؟",
      answer: "تنظيف وتلميع الأسنان بسعر 199 درهم.",
      enabled: true,
      priority: 100,
    });
    await db.insert(autoReplyRules).values({
      workspaceId,
      name: "Appointment request",
      keywords: ["موعد"],
      response: "أرسل لنا الوقت المناسب وسيتابع الفريق معك.",
      enabled: true,
      priority: 90,
    });
    await db.insert(assistantConfigs).values({
      workspaceId,
      status: "ACTIVE",
    }).onConflictDoUpdate({
      target: assistantConfigs.workspaceId,
      set: { status: "ACTIVE" },
    });

    let outboundCalls = 0;
    (globalThis as { fetch: typeof fetch }).fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(init?.headers && new Headers(init.headers).get("apikey"), "test-gupshup-key");
      if (url.pathname === "/partner/app/gupshup-app-id/details") {
        assert.equal(init?.headers && new Headers(init.headers).get("token"), "test-partner-token");
        return jsonResponse({
          status: "success",
          app: {
            id: "gupshup-app-id",
            name: "fansconnect-test",
            phone: "971500000010",
            live: true,
            stopped: false,
            embedAllowed: true,
          },
        });
      }
      if (url.pathname === "/sm/api/v1/msg") {
        outboundCalls += 1;
        assert.match(String(init?.headers && new Headers(init.headers).get("content-type")), /application\/x-www-form-urlencoded/);
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get("channel"), "whatsapp");
        assert.equal(form.get("source"), "971500000010");
        assert.equal(form.get("destination"), "971500000011");
        assert.equal(form.get("src.name"), "fansconnect-test");
        assert.deepEqual(JSON.parse(String(form.get("message"))), {
          type: "text",
          text: outboundCalls === 1
            ? "تنظيف وتلميع الأسنان بسعر 199 درهم."
            : "أرسل لنا الوقت المناسب وسيتابع الفريق معك.",
        });
        return jsonResponse({ status: "submitted", messageId: `gupshup-outbound-${outboundCalls}` });
      }
      throw new Error(`Unexpected Gupshup request: ${url}`);
    };

    const connected = await request("/api/workspaces/gupshup-faq/channels/whatsapp/connect", {
      method: "POST",
      body: {},
    });
    assert.equal(connected.status, 202, JSON.stringify(connected.json));
    const connectUrl = new URL(String(connected.json.connectUrl));
    const state = connectUrl.searchParams.get("state");
    assert(state);
    assert.equal(connectUrl.searchParams.get("redirect_uri"), process.env.GUPSHUP_EMBEDDED_SIGNUP_CALLBACK_URL);
    const callback = await request(`/api/oauth/gupshup/callback?state=${encodeURIComponent(state)}&appId=gupshup-app-id`);
    assert.equal(callback.status, 200, JSON.stringify(callback.json));
    assert.equal((callback.json.channel as Json).provider, "Gupshup");
    assert.equal((callback.json.channel as Json).status, "connected");
    assert.equal(JSON.stringify(callback.json).includes("test-gupshup-key"), false);
    const replayedCallback = await request(`/api/oauth/gupshup/callback?state=${encodeURIComponent(state)}&appId=gupshup-app-id`);
    assert.equal(replayedCallback.status, 400);
    assert.equal(replayedCallback.json.error, "invalid_provider_state");

    const webhookPayload: Json = {
      app: "fansconnect-test",
      timestamp: 1788180000000,
      version: 2,
      type: "message",
      payload: {
        id: "gupshup-inbound-1",
        source: "971500000011",
        type: "text",
        payload: { text: "كم سعر تنظيف الأسنان؟" },
        sender: { phone: "971500000011", name: "محمد" },
      },
      tenantId: "must-not-be-trusted",
    };
    const first = await request("/api/webhook/gupshup", {
      method: "POST",
      body: webhookPayload,
      headers: { "x-gupshup-webhook-token": "test-gupshup-webhook-secret" },
    });
    assert.equal(first.status, 202, JSON.stringify(first.json));
    assert.equal(first.json.automatedReplies, 1);
    assert.equal(first.json.duplicates, 0);

    const duplicate = await request("/api/webhook/gupshup", {
      method: "POST",
      body: webhookPayload,
      headers: { "x-gupshup-webhook-token": "test-gupshup-webhook-secret" },
    });
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.json.automatedReplies, 0);
    assert.equal(duplicate.json.duplicates, 1);
    assert.equal(outboundCalls, 1);

    const autoReply = await request("/api/webhook/gupshup", {
      method: "POST",
      body: {
        ...webhookPayload,
        payload: {
          ...(webhookPayload.payload as Json),
          id: "gupshup-inbound-2",
          payload: { text: "أريد موعد" },
        },
      },
      headers: { "x-gupshup-webhook-token": "test-gupshup-webhook-secret" },
    });
    assert.equal(autoReply.status, 202);
    assert.equal(autoReply.json.automatedReplies, 1, JSON.stringify(autoReply.json));
    assert.equal(outboundCalls, 2);

    const inbox = await request("/api/workspaces/gupshup-faq/conversations?channel=whatsapp");
    const conversation = (inbox.json.conversations as Json[])[0];
    assert.equal((inbox.json.conversations as Json[]).length, 1);
    assert.equal(conversation.contactName, "محمد");
    assert.equal((conversation.messages as Json[]).length, 4);
    assert.deepEqual(
      new Set((conversation.messages as Json[]).map((message) => message.providerMessageId)),
      new Set(["gupshup-inbound-1", "gupshup-outbound-1", "gupshup-inbound-2", "gupshup-outbound-2"]),
    );
    const storedContacts = await db.select().from(contacts).where(inArray(contacts.workspaceId, [workspaceId]));
    assert.equal(storedContacts.length, 1);
    assert.equal(storedContacts[0].name, "محمد");

    await db.update(assistantConfigs)
      .set({ status: "PAUSED" })
      .where(eq(assistantConfigs.workspaceId, workspaceId));
    const whilePaused = await request("/api/webhook/gupshup", {
      method: "POST",
      body: {
        ...webhookPayload,
        payload: {
          ...(webhookPayload.payload as Json),
          id: "gupshup-inbound-while-paused",
          payload: { text: "كم سعر تنظيف الأسنان؟" },
        },
      },
      headers: { "x-gupshup-webhook-token": "test-gupshup-webhook-secret" },
    });
    assert.equal(whilePaused.status, 202);
    assert.equal(whilePaused.json.automatedReplies, 0);
    assert.equal(outboundCalls, 2);
  });

  it("returns a generic customer-safe error when platform authentication is unavailable", async () => {
    await ensureWorkspace("gupshup-missing-key");
    const workspaceId = workspaceIds.get("gupshup-missing-key")!;
    await db.insert(channels).values({
      workspaceId,
      type: "WHATSAPP",
      provider: "GUPSHUP",
      status: "NOT_CONNECTED",
    }).onConflictDoUpdate({
      target: [channels.workspaceId, channels.type],
      set: { provider: "GUPSHUP", status: "NOT_CONNECTED", providerData: {} },
    });
    const configured = process.env.gupshupAPPKAY;
    delete process.env.gupshupAPPKAY;
    const response = await request("/api/workspaces/gupshup-missing-key/channels/whatsapp/connect", {
      method: "POST",
      body: { appId: "app-id", appName: "app-name", source: "971500000010" },
    });
    process.env.gupshupAPPKAY = configured;
    assert.equal(response.status, 503);
    assert.equal(response.json.error, "channel_connection_unavailable");
    assert.equal(JSON.stringify(response.json).includes("gupshupAPPKAY"), false);
    assert.equal(JSON.stringify(response.json).includes("API"), false);
  });
});