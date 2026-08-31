import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import express, { type Request } from "express";
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
];

let server: Server;
let baseUrl: string;
const app = express();

app.use(
  express.json({
    verify: (req, _res, buffer) => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }),
);
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
  const url = new URL(path, baseUrl);
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
    assert.match(String(response.json.message), /Invalid provider authorization state/);
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
    assert.equal((response.json.channel as Json).failureReason, "Token was rejected by Meta");
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
    assert.equal(response.status, 202);
    assert.equal(response.json.accepted, 1);

    const conversations = await request("/api/workspaces/whatsapp-inbound/conversations?channel=whatsapp");
    const conversation = (conversations.json.conversations as Json[])[0];
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
    assert.equal(channel.failureReason, "Recipient blocked messages");

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