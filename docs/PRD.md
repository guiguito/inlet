# Inlet — Product Requirements

The unified PRD was split on 16 September 2026 into a Foundations page and one page per
capability. The Notion pages are the working documents; these files are their mirrors,
kept so the requirements travel with the code. If the two disagree, Notion is newer.

| Page | Covers |
| --- | --- |
| [Foundations](prd/foundations.md) ([Notion](https://app.notion.com/p/3ddd33dfffca813c87daf018eec9aeb4)) | Accounts, roles, projects, typed databases, API keys, notifications, export, deletion, deployment, brand, SDK and MCP conventions (`FR-xxx` platform rows, `FD-xxx`) |
| [Feedback Collection](prd/feedback-collection.md) ([Notion](https://app.notion.com/p/3ddd33dfffca81c98977df8dac6975b0)) | Forms, intents, submissions, screenshots, hosted forms, reviewing responses (`FR-xxx`) |
| [Crash Reports](prd/crash-reports.md) ([Notion](https://app.notion.com/p/3ddd33dfffca81129df2c8a1e4af25cb)) | Crash databases, ingest, grouping, regressions, MCP, `inlet-sdk/crash` (`CR-xxx`) |
| [UX Analytics](prd/ux-analytics.md) ([Notion](https://app.notion.com/p/3ddd33dfffca813bb4ffc83baa908d65)) | Analytics databases, event ingest, Overview, trends, funnels, cohorts, profiles, data health, MCP, `inlet-sdk/analytics` and the shared SDK identity (`AN-xxx`); Release 8, specified, events stored in ClickHouse, an optional bundled service |
| [Remote Config](prd/remote-config.md) ([Notion](https://app.notion.com/p/3e7d33dfffca8163b374d2ee2bf50dd7)) | Config databases, parameters and conditions, targeting, draft, publish and rollback, the fetch route, splits, MCP, `inlet-sdk/config` (`RC-xxx`); Release 9, specified, ships before Release 8 |

Section numbers inside Foundations and Feedback Collection are preserved from the unified
PRD so that `FR-xxx` citations in the source, the tests and [DECISIONS.md](DECISIONS.md)
still resolve. A gap in the numbering means that section lives on the other page.
