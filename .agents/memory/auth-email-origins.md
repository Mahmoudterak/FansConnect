---
name: Authentication email origins
description: Security boundary for verification and password-reset action links sent by email.
---

Authentication emails must build verification and password-reset links from a server-configured canonical public origin. Never derive these links from `Host`, `X-Forwarded-Host`, or similar request headers.

**Why:** A forged host header can make the application email a valid one-time token inside an attacker-controlled URL, disclosing the token when the recipient follows the link.

**How to apply:** Any new emailed action link must parse the configured origin, use only its origin component, require HTTPS in production, and fail closed when the canonical origin is unavailable.