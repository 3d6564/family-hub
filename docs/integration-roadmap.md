# Integration Roadmap

## Settings Structure

Keep one settings tab for each independently configured household concern:

- **Display**: header title, color palette, and scheduled dark mode.
- **Screens**: paired display resolutions, last-seen status, and calendar previews.
- **Calendars**: week start and read-only iCal feeds.
- **Routines**: household start times for Morning, Afternoon, and Bedtime.
- **Weather**: forecast visibility, location, units, day count, display choices, and one saved key per provider.
- **Household**: family members and their roles.
- **Access**: passwords, paired displays, pairing codes, and sign-out.
- **Integrations**: available and planned outside-service connections.

An integration has a dedicated card in the Integrations tab. The card shows its connection state, the source of truth, the selected data, and an enable switch. Do not show an enable switch for a planned integration. Enable it only after configuration is valid.

The current settings navigation uses an inline tab list. Keep it while each section is a peer and the labels fit on one row. Move to a Material-style navigation rail on wider displays and a drawer on narrow displays when settings gain nested pages, many connection instances, or more than about eight top-level sections.

## Delivery Order

1. Keep iCal feeds as the default calendar connection. Add Google Calendar OAuth only when two-way event editing is required. Add Microsoft Outlook after the shared connector model supports OAuth tokens, account reconnection, sync errors, and selected calendars.
2. Add Todoist as the first task connector. Map one shared project or selected sections to display lists. Start with read-only display and completion sync. Keep rewards, child assignments, and routine periods in Family Hub until Todoist mapping proves they fit the household workflow.
3. Add AnyList only after the task connector model is stable. Its first scope is a selected grocery or household list, with one declared source of truth.
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
