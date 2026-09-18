# Inlet — UX Analytics PRD (TODO)

## Document Status
**Status:** Not started; Release 8, after Release 7 — SDK. Placeholder so the platform shape is visible.
**Product:** Inlet — UX Analytics capability
**Foundations:** Accounts, roles, keys, notifications, export, deletion, deployment, brand, SDK packaging and MCP conventions are on the Foundations PRD.
**Notion page:** https://app.notion.com/p/3ddd33dfffca813bb4ffc83baa908d65
**Repository mirror:** `docs/prd/ux-analytics.md`
**Last revised:** September 18, 2026 (renumbered to Release 8)

## Purpose
Answer "how is the product used" with the same stance as the other capabilities: self-hosted, privacy-first, content-free by construction, no session replay, no third party. Product usage events from an application, aggregated into counts and funnels a small team can read, operated through MCP.

## What Foundations already provides
- An `analytics` database type with a `adb_` ID, memberships, notifications, export, retention and deletion (FD-001 to FD-009).
- The project's publishable and secret keys; no new credential.
- A slot in `inlet-sdk` at `inlet-sdk/analytics` sharing the transport, queue and redaction hook (FD-010 to FD-014).
- MCP and rate-limit conventions (FD-020 to FD-031).

## Open questions, to brainstorm before writing this PRD
- Event schema: named events with bounded properties, or a fixed vocabulary (screen, action, outcome)?
- Identity: reuse the crash module's optional opaque user ID, and whether an anonymous install ID is acceptable under the privacy stance.
- Sessions: whether analytics and crash share a session concept so a crash-free rate per release becomes possible.
- Aggregation: which windows (day, week), which breakdowns (release, OS, country never), and whether raw events are retained at all or only rollups.
- Retention and sampling defaults within the Foundations retention setting.
- Reading interface: what a small team looks at weekly, in at most four tabs.
- Scale: event volume is orders of magnitude above crashes; rollup-at-ingest versus raw storage is the central design call.

## Non-goals, provisional
Session replay, heatmaps, A/B testing, marketing attribution, cross-site tracking, any identity the integrator did not supply.
