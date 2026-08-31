---
name: Integration readiness boundary
description: Product surfaces distinguish preview configuration from connected production services.
---

Connected-channel, billing, admin, and analytics states should be explicit about setup or unavailable production data until the corresponding service is actually connected.

**Why:** The product must remain trustworthy and avoid presenting seeded demo metrics, fake channel health, or simulated payment status as live workspace data.

**How to apply:** Preserve setup-required and service-error states in new workspace modules; only replace them with live metrics after the backend and provider connection are verified.