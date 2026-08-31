const GUPSHUP_API_BASE = "https://api.gupshup.io";
const GUPSHUP_SEND_URL = `${GUPSHUP_API_BASE}/sm/api/v1/msg`;

export type GupshupChannelData = {
  appId: string;
  appName: string;
  source: string;
};

export type GupshupInboundEvent = {
  event: "message.received" | "message.delivered" | "message.read" | "message.failed";
  providerMessageId?: string;
  from?: string;
  contactName?: string;
  text?: string;
  timestamp?: string;
  error?: string;
};

export type GupshupEmbeddedSignupConfig = {
  signupUrl: string;
  callbackUrl: string;
  returnUrl?: string;
};

function apiKey(): string {
  const value = process.env.gupshupAPPKAY?.trim();
  if (!value) throw new Error("Gupshup platform authentication is unavailable.");
  return value;
}

export function gupshupIsConfigured(): boolean {
  return Boolean(process.env.gupshupAPPKAY?.trim());
}

function configuredHttpsUrl(value: string | undefined): URL | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.hostname === "localhost")) return null;
    return url;
  } catch {
    return null;
  }
}

export function gupshupEmbeddedSignupConfig(): GupshupEmbeddedSignupConfig | null {
  const signupUrl = configuredHttpsUrl(process.env.GUPSHUP_EMBEDDED_SIGNUP_URL);
  const callbackUrl = configuredHttpsUrl(process.env.GUPSHUP_EMBEDDED_SIGNUP_CALLBACK_URL);
  const returnUrl = configuredHttpsUrl(process.env.GUPSHUP_EMBEDDED_SIGNUP_RETURN_URL);
  if (!signupUrl || !callbackUrl) return null;
  return {
    signupUrl: signupUrl.toString(),
    callbackUrl: callbackUrl.toString(),
    returnUrl: returnUrl?.toString(),
  };
}

export function gupshupEmbeddedSignupUrl(state: string): string | null {
  const config = gupshupEmbeddedSignupConfig();
  if (!config) return null;
  const url = new URL(config.signupUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  return url.toString();
}

export function parseGupshupChannelData(value: unknown): GupshupChannelData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const appId = typeof data.appId === "string" ? data.appId.trim() : "";
  const appName = typeof data.appName === "string" ? data.appName.trim() : "";
  const source = typeof data.source === "string" ? data.source.replace(/[^\d]/g, "") : "";
  return appId && appName && source ? { appId, appName, source } : null;
}

export async function verifyGupshupChannel(data: GupshupChannelData): Promise<{
  providerAccountId: string;
  displayName: string;
}> {
  const response = await fetch(
    `${GUPSHUP_API_BASE}/wa/app/${encodeURIComponent(data.appId)}/business`,
    {
      headers: {
        accept: "application/json",
        apikey: apiKey(),
      },
    },
  );
  const payload = (await response.json().catch(() => ({}))) as {
    status?: string;
    business?: { id?: string; name?: string };
  };
  if (!response.ok || payload.status !== "success" || !payload.business) {
    throw new Error("Gupshup app verification failed.");
  }
  const providerAccountId = String(payload.business.id || data.appId);
  if (providerAccountId !== data.appId) throw new Error("Gupshup app verification returned a different app.");
  return {
    providerAccountId,
    displayName: payload.business.name || data.appName,
  };
}

export async function sendGupshupText(
  data: GupshupChannelData,
  destination: string,
  text: string,
): Promise<string> {
  const body = new URLSearchParams({
    channel: "whatsapp",
    source: data.source,
    destination: destination.replace(/[^\d]/g, ""),
    "src.name": data.appName,
    message: JSON.stringify({ type: "text", text }),
  });
  const response = await fetch(GUPSHUP_SEND_URL, {
    method: "POST",
    headers: {
      apikey: apiKey(),
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    status?: string;
    messageId?: string;
  };
  if (!response.ok || payload.status !== "submitted" || !payload.messageId) {
    throw new Error("Gupshup rejected the outbound message.");
  }
  return payload.messageId;
}

export function gupshupAppName(payload: Record<string, unknown>): string | null {
  return typeof payload.app === "string" && payload.app.trim() ? payload.app.trim() : null;
}

export function normalizeGupshupPayload(payload: Record<string, unknown>): GupshupInboundEvent[] {
  const type = typeof payload.type === "string" ? payload.type : "";
  const data = payload.payload && typeof payload.payload === "object"
    ? payload.payload as Record<string, unknown>
    : {};
  const providerMessageId = typeof data.id === "string" ? data.id : undefined;
  const timestampNumber = Number(payload.timestamp);
  const timestamp = Number.isFinite(timestampNumber)
    ? new Date(timestampNumber).toISOString()
    : undefined;

  if (type === "message") {
    const messagePayload = data.payload && typeof data.payload === "object"
      ? data.payload as Record<string, unknown>
      : {};
    const sender = data.sender && typeof data.sender === "object"
      ? data.sender as Record<string, unknown>
      : {};
    const from =
      (typeof sender.phone === "string" && sender.phone) ||
      (typeof data.source === "string" && data.source) ||
      undefined;
    const text =
      (typeof messagePayload.text === "string" && messagePayload.text) ||
      (typeof data.text === "string" && data.text) ||
      undefined;
    if (!from || !text) return [];
    return [{
      event: "message.received",
      providerMessageId,
      from,
      contactName: typeof sender.name === "string" ? sender.name : from,
      text,
      timestamp,
    }];
  }

  if (type === "message-event") {
    const eventType = typeof data.type === "string" ? data.type.toLowerCase() : "";
    const event =
      eventType === "delivered" ? "message.delivered" :
      eventType === "read" ? "message.read" :
      eventType === "failed" ? "message.failed" :
      null;
    if (!event) return [];
    return [{
      event,
      providerMessageId:
        (typeof data.gsId === "string" && data.gsId) ||
        (typeof data.id === "string" && data.id) ||
        undefined,
      error: event === "message.failed" ? "The provider reported a delivery failure." : undefined,
      timestamp,
    }];
  }

  return [];
}