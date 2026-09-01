import { logger } from "./logger";

type AuthEmailType = "email_verification" | "password_reset";

const htmlEscape = (value: string) =>
  value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] || character);

export async function sendAuthEmail(input: {
  to: string;
  actionUrl: string;
  type: AuthEmailType;
}) {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.AUTH_EMAIL_DELIVERY_IN_DEV !== "true"
  ) {
    logger.info(
      { type: input.type },
      "Skipped external auth email delivery in development"
    );
    return;
  }

  const resendApiKey = process.env.RESEND_API_KEY;

  if (!resendApiKey) {
    throw new Error("RESEND_API_KEY must be set");
  }

  const verification = input.type === "email_verification";

  const subject = verification
    ? "Verify your FansConnect email"
    : "Reset your FansConnect password";

  const heading = verification
    ? "Verify your email"
    : "Reset your password";

  const description = verification
    ? "Confirm your email address to finish setting up your FansConnect workspace."
    : "Use this secure link to choose a new password. If you did not request this, you can ignore this email.";

  const button = verification
    ? "Verify email"
    : "Reset password";

  const actionUrl = htmlEscape(input.actionUrl);

  const from =
    process.env.AUTH_EMAIL_FROM ||
    "FansConnect <notifications@mtuaefans.com>";

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#173f36">
        <h1 style="font-size:28px">${heading}</h1>
        <p style="line-height:1.7;color:#557269">${description}</p>
        <a href="${actionUrl}" style="display:inline-block;margin:18px 0;padding:13px 20px;border-radius:10px;background:#235d51;color:#fff;text-decoration:none;font-weight:700">${button}</a>
        <p style="font-size:12px;color:#82938b">This link expires in 24 hours and can be used once.</p>
      </div>`,
      text: `${heading}

${description}

${input.actionUrl}

This link expires in 24 hours and can be used once.`,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");

    throw new Error(
      `Resend rejected auth email delivery (${response.status})${
        detail ? `: ${detail.slice(0, 300)}` : ""
      }`
    );
  }

  logger.info(
    {
      type: input.type,
      to: input.to,
    },
    "Auth email sent successfully"
  );
}
