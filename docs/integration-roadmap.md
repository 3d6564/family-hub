# Integration Roadmap

## Settings Structure

Keep one settings tab for each independently configured household concern:

- **Display**: header title, color palette, and scheduled dark mode.
- **Screens**: screen pairing and reconnect approval, paired display resolutions, last-seen status, and calendar previews.
- **Calendars**: week-start preference.
- **Routines**: household start times for Morning, Afternoon, and Bedtime.
- **Weather**: forecast visibility, location, units, day count, refresh interval, display choices, and one saved key per provider.
- **Household**: family members and their roles.
- **Access**: passwords, paired-display revocation, and sign-out.
- **Integrations**: public iCal feeds and Google Calendar in one Calendars card,
  plus separate cards for other outside-service connections such as AnyList.

Weather refresh defaults to 30 minutes for new and existing households. Adults
can select 15 minutes, 30 minutes, 1 hour, or 3 hours in Settings > Weather.
The server refreshes expired weather when a dashboard request arrives. Active
displays request the dashboard about every 5 minutes. Faster intervals increase
provider API use; one refresh can make several requests. Provider failures keep
the last saved forecast visible.

Calendar sources are managed together in the Integrations tab. **Add a calendar**
offers a public iCal feed or Google Calendar. Other services have separate cards.
An available integration shows its connection state, source of truth, selected
data, and enable controls. Keep planned integrations in this document, not as
cards in the working settings interface.

The current settings navigation uses a wrapping tab list. Each active section
uses the full content width. Calendar and Routines remain separate. Screen
revocation is under Screens; Access groups account controls, backups, installed
version, and restoration separately. Broader navigation and section organization
changes are deferred for a later review.

Settings forms keep drafts through unrelated refreshes and use explicit saving.
Weather and calendar connection status is adult-only. Saved weather keys are
write-only through the settings API. Connection attempts are held in memory and
reset on restart; weather's last successful fetch time comes from its cache.

Address changes use the existing kiosk installer to update the saved URL.
An adult reconnects an existing screen using the code shown at the new address.
Reconnect approval keeps the old credential valid until the new browser claims its
session, then rotates the credential on the same screen record. Names and
reported screen details remain attached to that record. Expired or revoked
pairing attempts cannot create a replacement screen silently.

## Delivery Order

1. Keep iCal feeds as the default calendar connection. Add Google Calendar OAuth as an optional read-only connection so adults can display private calendars without public iCal URLs. Google remains the source of truth; Family Hub does not write events back. Encrypt OAuth refresh tokens at rest. Add Microsoft Outlook after the shared connector model supports OAuth tokens, account reconnection, sync errors, and selected calendars.
2. Add Todoist as the first task connector. Map one shared project or selected sections to display lists. Start with read-only display and completion sync. Keep rewards, child assignments, and routine periods in Family Hub until Todoist mapping proves they fit the household workflow.
3. AnyList was approved ahead of Todoist as an independent Lists tab. It uses one selected grocery or household list, with AnyList as the source of truth. Adults manage the connection. Signed-in household members and paired displays can add and check items; only adults can delete completed items. The connection is experimental pending a live-account check. See [AnyList setup and limits](anylist.md). A shared Todoist task connector model remains deferred.
4. Add meal planning after lists. Use a meal-plan provider only if it supports a stable, documented account connection. Otherwise keep meals local.
5. Consider photos, traffic, smart-home status, and school feeds only as independent display widgets. Each must be separately enabled, so one failed provider cannot hide the calendar or tasks.

## Connector Requirements

- Store the provider, connection state, sync direction, selected resources, last successful sync, and last safe error.
- Encrypt OAuth refresh tokens at rest before adding OAuth connections. Do not put tokens or provider secrets in the wall-display API response.
- Make a source of truth explicit for every connected data type. Do not silently overwrite records from another service.
- Support disable, reconnect, and disconnect. Disabling hides the feature but retains its connection settings. Disconnecting removes credentials and stops sync.
- Poll or accept provider webhooks on the server. The wall display reads only normalized household data.

## Product Comparison Notes

Skylight groups calendar sync, tasks, lists, meal planning, and weather in one family display. It supports many calendar sources and treats chores, routines, rewards, and lists as separate features. This supports Family Hub's split settings tabs and independent feature switches.

DAKboard comparison was deferred because its public feature page was unavailable during this research. Review its current documentation before selecting any display-widget scope.

Sources consulted on 2026-10-03:

- Skylight Calendar: https://www.skylightframe.com/calendar
- Google Calendar API overview: https://developers.google.com/calendar/api/guides/overview
- Todoist developer entry point: https://developer.todoist.com/
