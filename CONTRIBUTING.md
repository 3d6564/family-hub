# Contributing

Family Hub is a private household application. People and coding agents follow
this guide. Read `INSTRUCTIONS.md` for project safety, approval boundaries, and
the full definition of done.

## Set up the project

Use Node.js 22 or later and npm.

```bash
npm ci
cp .env.example .env
```

Follow `README.md` to create local adult accounts and start the service. Use
only local test data. Do not use a production household database, backup,
calendar feed URL, API key, password, session, or pairing code for development.

## Select work

A GitHub Issue is optional. When an issue exists, keep the change within its
stated scope and reference it in the pull request or change summary.

Keep each change focused. Preserve the existing single-service and
single-household design unless a design change is approved.

For coding agents, approval is required before creating or switching branches,
committing, pushing, opening a pull request, or changing remote issue state.
People can use their normal git workflow; this repository does not define
required branch names, labels, or a merge method.

## Issue-to-merge workflow

1. Start a focused branch from the current default branch.
2. Make only the changes required by the issue. Do not include unrelated
   worktree files.
3. Run the checks listed in [Required checks](#required-checks).
4. Commit with a short message that describes the result.
5. Open a pull request with the change summary, checks, risks, assumptions, and
   deferred work.
6. Use `Closes #123` only when the pull request meets that issue's acceptance
   criteria. Use `Refs #123` for partial or blocked work.
7. Merge only after required checks pass and review is complete.

Let the merged pull request close completed issues. Keep blocked issues open and
record the remaining dependency in the pull request or issue.

## Change rules

Ask the project owner before:

- adding, removing, or updating a dependency
- changing a public interface or major design choice
- changing the SQLite schema or adding or modifying a migration
- changing Docker, Raspberry Pi, kiosk, remote-host, or network-exposure
  behavior
- using private household data, secrets, or live provider credentials

Follow existing JavaScript, API, browser UI, error, and logging patterns. Prefer
the smallest change that fully meets the request. Update documentation when
setup, commands, public behavior, integrations, security guidance, or
deployment behavior changes.

## Security and data

- Keep every household-record query scoped to the authenticated household.
- Preserve role, session, pairing, origin, CSRF, and authorization checks.
- Never expose provider credentials, calendar feed URLs, or private settings to
  a paired wall display.
- Do not log or commit secrets, private records, databases, backups, `.env`, or
  generated local data.
- Validate user input, uploaded backups, provider responses, files, and other
  external data before use.
- Keep migrations ordered and compatible with startup migration handling.
- Keep the service private. Do not expose port 3000 directly to the internet.

## User-interface changes

Preserve usable layouts on phones, desktop browsers, and paired wall displays.
Check narrow and wide viewport behavior. Keep keyboard use, focus behavior,
labels, and visible loading and error states intact. Preserve the wall display's
lower-permission workflow.

## Required checks

Add or update focused tests for changed behavior when the test setup supports
it. Run both required checks:

```bash
npm run check
npm test
```

CI uses Node.js 22 and runs `npm ci` before the same checks. If a required check
cannot run, report the command, reason, and remaining risk. For a user-interface
change, also report the viewport classes checked and any visual check that could
not be completed.

## Review handoff

A pull request or change summary must state:

- files changed and the behavior affected
- checks run and their results
- known risks
- assumptions made
- deferred or intentionally excluded work

Do not include secrets, private household data, or sensitive debug output in the
handoff.
