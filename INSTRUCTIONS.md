# INSTRUCTIONS.md

<!-- codebrief -->

## Project

Family Hub is a private household calendar and task progressive web app. It
runs as one Node.js 22 service with Express and SQLite. It serves signed-in
adult devices and paired wall displays for one household per deployment.

Preserve the single-service design and single-household boundary unless the
user approves a design change. Do not add a dependency, replace a core tool, or
change a public interface without approval.

## Scope and instruction priority

- Apply this file to the full Family Hub repository.
- Extend the rules in the parent `INSTRUCTIONS.md`; do not replace them.
- Before working, read this file and the sources relevant to the task.
- If applicable instructions disagree, report the conflict and ask rather than
  guessing.

## Project map and sources of truth

- `README.md`: setup, product behavior, deployment, and security guidance.
- `package.json`: supported Node.js version, dependencies, and npm commands.
- `src/`: server, authentication, data access, domain, backup, calendar,
  weather, token, bootstrap, and pairing behavior.
- `public/`: browser application, styles, manifest, and service worker.
- `migrations/`: ordered SQLite schema changes.
- `test/`: Node.js test suite.
- `.github/workflows/ci.yml`: CI environment and required commands.
- `docs/integration-roadmap.md`: approved integration direction and connector
  constraints.
- `Dockerfile`, `compose.yaml`, and `scripts/`: container, Raspberry Pi,
  deployment, and kiosk behavior.

Do not invent a tool, workflow, provider, or architecture decision that these
sources do not support.

## Working method

- Inspect the relevant code and tests before editing.
- Prefer the smallest change that fully meets the request.
- Follow the existing JavaScript, API, browser UI, error, and logging patterns.
- Keep work within the requested scope. Nearby changes are allowed when they
  directly support the task.
- Ask before changing the database schema or adding or modifying a migration.
- Ask before dependency changes, public-interface changes, major design
  changes, or deployment changes.
- Do not require a GitHub Issue before implementation work.
- Work in the current worktree. Ask before creating or switching branches,
  committing, pushing, opening a pull request, or changing remote issue state.
- Do not revert or overwrite unrelated worktree changes.
- For a bug fix, reproduce the failure, identify the cause, and add a focused
  test that prevents it from returning.

## Code and documentation

- Use ECMAScript modules and the Node.js version declared in `package.json`.
- Keep code consistent with the surrounding file. Do not introduce a new
  abstraction for one local use unless it makes the behavior easier to verify.
- Add concise docstrings to public functions and non-obvious behavior.
- Use comments to explain reasons and tradeoffs, not to restate code.
- Give TODO comments an issue or task reference.
- Update `README.md` or the relevant document when setup, commands, public
  behavior, deployment, security guidance, or integration direction changes.
- Do not edit generated output or household data as source code.

## Errors and logging

- Follow the existing error pattern. Handle an error when recovery or useful
  context is possible; otherwise let it surface.
- Give users a clear failure description and the next useful step without
  exposing internal or sensitive details.
- Use the existing logger and output paths. Ask before adding a logging system.
- Do not log passwords, session or pairing tokens, calendar feed URLs, API keys,
  backup contents, or private household records.
- Keep detailed local debug output out of version control.

## User interface

- Preserve usable layouts on phones, desktop browsers, and paired wall
  displays.
- Keep keyboard use, focus behavior, labels, and visible loading and error
  states intact when changing interactive UI.
- Check both narrow and wide viewport behavior for user-interface changes.
- Preserve the wall display's lower-permission workflow and avoid controls it
  cannot use.
- Follow the existing visual language unless the user requests a redesign.

## Data, authentication, and integrations

- Treat `.env`, SQLite databases, backups, calendar feed URLs, weather API keys,
  passwords, sessions, and pairing codes as sensitive.
- Never place real household data or secrets in source, tests, logs,
  documentation, screenshots, or prompts.
- Keep every household-record query scoped to the authenticated household.
- Preserve role, session, pairing, origin, CSRF, and authorization checks when
  changing related code.
- Never return provider secrets, feed URLs, or private credentials to a paired
  wall display.
- Validate user input, uploaded backups, provider responses, files, and other
  external data before use.
- Keep migrations numbered and compatible with startup migration handling.
- For integrations, follow `docs/integration-roadmap.md`. Make the source of
  truth and sync direction explicit, isolate provider failures, and require
  secure credential storage before adding OAuth tokens.

## Testing and verification

Run both required checks for code changes:

```bash
npm run check
npm test
```

CI uses Node.js 22 and runs `npm ci` before the same checks.

- Add or update focused tests for changed behavior when the test setup supports
  it.
- Keep tests deterministic and independent of production household data,
  secrets, and live providers.
- Do not invent replacement commands. If a required check cannot run, report
  the exact command, reason, and remaining risk.
- For UI changes, report the viewport classes checked and any visual check that
  could not be completed.

## Deployment and operations

- Keep Family Hub private. Do not expose port 3000 directly to the internet.
- Preserve HTTPS, origin, backup, and private-network guidance in `README.md`.
- Ask before running or changing deployment, provisioning, kiosk, cloud, or
  remote-host operations.
- Do not access or alter a live household database or backup without explicit
  approval.
- Preserve the Docker data volume and remote `.env` during deployment work.

## Agent permissions

Without asking, the agent may read safe project files, edit requested source and
documentation, and run offline checks. The agent may run an already approved
local container when the task requires it.

Ask before accessing sensitive data, using the network, changing dependencies,
changing migrations or schema, changing deployment behavior, running remote
commands, performing git write actions, deleting files, or taking other
hard-to-reverse actions.

## Definition of done

- Requested behavior and stated acceptance conditions are met.
- Existing architecture, supported environments, and public behavior remain
  intact unless an approved change requires otherwise.
- Authentication, household isolation, sensitive-data handling, and wall-display
  permissions remain intact for affected paths.
- `npm run check` and `npm test` pass, or each blocked check is reported with its
  reason and risk.
- Focused tests cover changed behavior where the test setup supports them.
- Setup, command, behavior, security, integration, and deployment documentation
  matches the change.
- No unapproved dependency, schema, migration, deployment, network, git, remote,
  sensitive-data, or destructive action occurred.
- The final response lists changed files, checks, risks, assumptions, and
  deferred work.
