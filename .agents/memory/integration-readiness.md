---
name: Integration readiness boundary
description: Product surfaces distinguish preview configuration from connected production services.
---

Connected-channel, billing, admin, and analytics states must never imply live data until the corresponding service is actually connected. Customer pages use product-level states such as not connected, connecting, connected, paused, or error.

**Why:** The product must remain trustworthy and avoid presenting seeded demo metrics, fake channel health, or simulated payment status as live workspace data. Internal provider configuration and credential names are platform concerns and must not leak to customers.

**How to apply:** Show generic customer-safe errors when platform setup is unavailable; keep detailed causes in server logs or masked Super Admin status. Only show verified provider data and live metrics after backend verification.