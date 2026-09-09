# Security policy

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through
[GitHub's private vulnerability reporting](https://github.com/OWNER/inlet/security/advisories/new),
or by email to the address on the maintainer's GitHub profile.

Useful things to include: what you did, what happened, what you expected, and the
version or commit. A proof of concept helps, but a clear description is enough — do not
feel you need to weaponise it first.

You will get an acknowledgement within a few days. This is a small project maintained
in spare time, so please be patient with fixes, and let us agree on disclosure timing
together.

## What is in scope

Inlet is self-hosted, so the interesting boundary is what an untrusted party can do to
someone else's instance. In scope:

- Anything letting an unauthenticated caller read, write or delete collected feedback
- Privilege escalation between the Admin, Creator and Viewer roles, or between projects
- A publishable client key doing anything beyond submitting feedback — it must never be
  able to read a collected response
- Escaping the form-definition or answer validation to store arbitrary data
- Anything a respondent can put in an answer, a screenshot or a hosted form field that
  affects another user — stored cross-site scripting, Slack mention injection, header
  injection, CSV formula injection
- Server-side request forgery through the Slack webhook allowlist
- Bypassing the screenshot pipeline's content checks
- Session handling, cookie scope, invitation token handling

## What is not in scope

- **A misconfigured deployment.** `INLET_TRUSTED_PROXIES=true` behind no proxy,
  `INLET_DISABLE_RATE_LIMITS`, a guessable session secret, or an exposed database.
  [DEPLOYMENT.md](docs/DEPLOYMENT.md#security-checklist) lists the ones that matter.
- **A secret server key doing what it is documented to do.** It carries project Admin
  authority by design. Treat it like a password.
- **What a project Admin can do to their own project.** Deletion is meant to delete.
- **Slack keeping a message after you delete the response.** Documented, unavoidable,
  and stated in the interface next to the setting.
- **Screenshot contents.** Inlet stores what respondents give it. It warns operators to
  warn respondents.
- Denial of service by volume against your own instance, missing hardening headers with
  no demonstrated impact, and findings from automated scanners with no working
  exploit.

## Supported versions

The latest release on the default branch. There are no long-term support branches yet.

## What Inlet already does

So you can tell a finding from a design choice:

- Passwords are Argon2id; session tokens are stored only as a SHA-256, in a host-only
  cookie
- Secret keys are shown once and stored only as a hash
- Screenshots are validated by decoded content rather than filename or content type,
  re-encoded through Inlet's own encoder, stripped of metadata, and refused if animated
- Slack webhook URLs are checked against an origin allowlist, and respondent text is
  escaped so it cannot become a workspace mention
- Webhook URLs, passwords and tokens are redacted from logs
- Rate limits on sign-in, intent creation, uploads, finalization, and every public
  hosted-form route
- Authorization is re-checked per request against the resource's own scope, never
  inferred from a previous call
