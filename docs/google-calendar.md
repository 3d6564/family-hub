# Google Calendar connection

Google Calendar is an optional, read-only calendar source. Google remains the
source of truth. Family Hub does not create or edit Google events. An adult can
connect one Google account and select the calendars to display.

## Set up Google OAuth

1. In Google Cloud, create or select a project and enable the Google Calendar
   API.
2. Configure the OAuth consent screen and add the Google account that will
   connect as a test user if the app is in testing mode.
3. Create an OAuth client with application type **Web application**.
4. Add this exact authorized redirect URI:

   ```text
   https://your-hub.example/api/integrations/google-calendar/callback
   ```

   Replace `https://your-hub.example` with the exact `SITE_URL`. Do not add a
   trailing slash. Google OAuth needs HTTPS; `localhost` is allowed for local
   testing. Keep the Hub private and do not expose port 3000 to the internet.

5. Set `FAMILY_HUB_INTEGRATION_KEY` in the host environment to a separate random
   32-byte value encoded as 64 hexadecimal characters. Keep this key outside the
   database and retain it securely for backup recovery. AnyList uses the same
   key.
6. In Family Hub, open **Settings → Calendars**, select **Add a calendar**,
   then choose **Google Calendar**. Enter the Google client ID and secret, and
   save them. Family Hub encrypts the client secret with
   `FAMILY_HUB_INTEGRATION_KEY`; it never shows the saved secret again.
   App-stored values take priority over optional environment fallback values.
7. Connect the Google account. In the calendar settings page, add the calendars
   you want to show. Set each calendar's enabled state and color in the saved
   calendar list. If you change or remove OAuth credentials later, disconnect
   Google Calendar first.

For host-managed setup, `GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET` can be set as an optional environment fallback.
App-stored credentials override those values. The saved client secret and OAuth
refresh token are encrypted with `FAMILY_HUB_INTEGRATION_KEY`.

The OAuth scope is `calendar.readonly`. Family Hub stores only an encrypted
refresh token. It keeps access tokens in memory, refreshes them on the server,
and sends normalized event data to signed-in household devices and paired
displays. It does not return OAuth credentials to a browser or wall display.

Disabling a calendar keeps its saved settings. Removing a Google calendar from
the saved list removes it from Family Hub only; it does not change Google. The
Google account remains connected while other saved calendars use it.
Disconnecting removes the stored connection and saved calendars, but keeps OAuth
client settings.
Backups include the encrypted client secret and refresh token, not the encryption
key. Keep the key with your other recovery material.

Google may require consent-screen verification for calendar access. While an
external app remains in testing mode, Google can expire refresh tokens. If
calendar updates stop, check **Calendars → Account connections** and reconnect
the account.

## Use a private iCal feed instead

Private HTTPS iCal URLs work without Google OAuth or its Testing-mode expiry.
In Google Calendar on a desktop browser, open **Settings**, select the calendar,
then open **Integrate calendar → Secret address in iCal format**. This option
may be unavailable for managed accounts.

In Family Hub, open **Settings → Calendars → Add a calendar → iCal feed**.
Enter a name and the secret URL, test the connection, then save. Do not make
the Google calendar public. Repeat for each calendar. Remove duplicate OAuth
calendars only after checking that the feeds work.

Treat the URL as a password: anyone with it can read the calendar. Family Hub
does not return saved URLs in calendar settings or to wall displays. Feed URLs
are stored in the database and included in backups; protect both. Reset an
exposed URL in Google Calendar, then replace it using **Edit** in Family Hub.
Editing with a blank URL keeps the saved address. Feeds are read-only and
updates may take time to appear.

Saved calendars appear in **Calendars**. Use **Account connections → Manage connection**
for Google account credentials, connection testing, and disconnecting. Calendar
colors and visibility are separate from account connections.
