---
name: Cookie request origins
description: Cross-origin request boundary for cookie-authenticated API mutations on shared hosting domains.
---

Cookie-authenticated unsafe API requests must validate the browser `Origin` against the exact server-configured application origin. Do not reflect arbitrary CORS origins while allowing credentials.

**Why:** On shared hosting domains, an attacker-controlled sibling can be same-site for cookie policy while still cross-origin. SameSite cookies alone are therefore not a complete CSRF boundary, and credentialed reflected CORS can also expose authenticated responses.

**How to apply:** Keep the web app and API same-origin where possible, omit unnecessary credentialed CORS, normalize both configured and request origins with URL parsing, and fail closed for missing, malformed, or mismatched origins in production.