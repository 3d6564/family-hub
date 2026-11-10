# AnyList connection

Family Hub has its own small client for AnyList's unofficial list protocol. It
does not require Home Assistant or another service. Treat this connection as
experimental until it has been tested with your account. Automated tests use
synthetic data, not an AnyList account.

## Host setup

Set `FAMILY_HUB_INTEGRATION_KEY` to a random 32-byte value encoded as 64 hexadecimal
characters. For example, run `openssl rand -hex 32` locally and save the result in
the host's private environment configuration. Do not paste the key into an issue,
source file, or chat. The supplied Compose configuration passes this variable to
the application. The connection stays unavailable when the key is missing or
invalid; other Family Hub features keep working.

Use HTTPS before entering an AnyList password. The password goes through Family
Hub's server to AnyList for sign-in. Family Hub does not save the password. It
encrypts the resulting client identifier and access/refresh tokens with
AES-256-GCM, with the household ID included in the authenticated data. Credentials
are never returned through browser or paired-display APIs.

Keep the encryption key separate from the database, and retain it securely for
recovery. Database backups contain encrypted AnyList tokens and private cached
list items, but do not contain the key. Restoring a backup on another host needs
the same key, or an adult must reconnect AnyList. Changing the key does not
automatically re-encrypt existing tokens. Disconnect removes the connection and
cache from the current database, not from older backups, and does not claim to
revoke provider-side tokens.

## Connect and use

1. Sign in as an adult. Open **Settings → Integrations → AnyList**.
2. Enter the AnyList account email and password, then select **Connect / reconnect**.
3. Choose shared lists, select **Enable shared lists**, and save.
4. Open **Lists** from the main navigation.

AnyList is the source of truth. Adults and paired displays can add items and
check or uncheck them. Signed-in household members can also use these shared
actions. Only adults can manage the connection or delete completed items.
Unauthenticated visitors cannot read or change the list. Display revocation and
the usual origin and request-verification checks still apply.

Adding an item already present leaves an active item unchanged, or unchecks the
matching completed item. It does not create another entry. Item matching for this
reuse ignores letter case; changes and deletion use item IDs. Family Hub does
not expose list creation, recipes, meal planning, item renaming, or notes editing.

Displayed quantities keep their units, such as **2 kg Rice**.

Up to three selected lists appear together at wide desktop sizes. Phones,
narrower screens, and selections of more than three lists use tabs. Each list
has its own add form and unfinished draft. Paired displays show an on-screen
keyboard for text fields, excluding passwords. They return from Lists to
Calendar after 60 seconds without typing, pointer, touch, or scrolling activity.
The return waits for active saves and keeps drafts until the page is reloaded.

The Lists view checks for updates about once a minute while open. The server
shares a one-minute refresh window across readers. **Refresh** can check sooner,
but not more than once every five seconds. Writes fetch current provider data
first and are serialized within this Family Hub process. They are not queued for
offline delivery. Provider failures keep the last selected-list cache visible
with a warning, without blocking calendars, weather, routines, or chores.

**Disable** hides shared lists and stops automatic fetching, while retaining
settings and tokens. You can change selected lists while disabled without
contacting AnyList. Removed lists lose their cached items and fetch times;
retained lists keep theirs.

**Refresh available lists** is an explicit adult request
that can still contact AnyList while disabled. **Reconnect** replaces the saved
account and clears selected lists after sign-in succeeds; select and enable
lists again. **Disconnect AnyList** removes saved connection data and stops sync.

## Limits and maintenance

- This is not an official AnyList API or OAuth connection. Provider changes can
  break authentication or list updates. Account subscription and sign-in-method
  requirements have not been verified with a live account.
- The observed `/data/user-data/get` response can contain other lists, recipes,
  and meal plans. The server receives that response in memory. Its fixed local
  schema decodes only shopping-list fields. Only list IDs/names are retained for
  adult selection; only selected lists' items are cached or sent to displays.
- Requests use a fixed HTTPS origin, reject redirects, time out after 15 seconds,
  and accept at most 8 MiB per response. Larger accounts can exceed this limit.
- Protocol field numbers and operations were checked against
  [the upstream client](https://github.com/kevdliu/anylist/tree/d69278a6a7ec04750dadfdf9c6f8b1b157b3a7e8).
  Family Hub does not install the `anylist` package or copy the GPL Home Assistant
  bridge. It uses Node.js built-ins and a pinned current `protobufjs` dependency.
- A rejected access token triggers one refresh and retry. Other uncertain writes
  are not automatically retried. If a save fails, wait five seconds and refresh
  before trying again; the provider may already have applied the change.
- Adult deletion checks the latest fetched completion state. AnyList does not
  provide a verified conditional-delete operation in the reviewed client. A
  concurrent change from another device can race with deletion. Do not treat
  this as an atomic cross-device guarantee.
- Connection attempts and safe error state are held in memory and reset on
  restart. Selected lists and their last successful fetch times survive restarts.
