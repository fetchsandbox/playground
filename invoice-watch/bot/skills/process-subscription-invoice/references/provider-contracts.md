# Provider contracts (source of truth)

## Gmail MCP `search_threads`

Docs: https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/search_threads

```json
{
  "query": "(subject:(invoice OR receipt OR renewal OR subscription) OR \"your invoice\" OR \"billing period\") newer_than:7d -category:promotions -category:social",
  "pageSize": 20,
  "includeTrash": false,
  "view": "THREAD_VIEW_MINIMAL"
}
```

`query` uses Gmail search-box operators (same family as REST
`users.messages.list` `q`:
https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list).

## Gmail MCP `get_message`

Docs: https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/get_message

```json
{
  "messageId": "18f…",
  "messageFormat": "FULL_CONTENT"
}
```

## Google Calendar MCP `create_event`

Docs: https://developers.google.com/workspace/calendar/api/v3/reference/mcp/tools_list/create_event

Required: `summary`, `startTime`, `endTime` (ISO 8601).

```json
{
  "summary": "Cancel Notion subscription",
  "startTime": "2026-11-12T09:00:00",
  "endTime": "2026-11-12T10:00:00",
  "calendarId": "primary",
  "description": "Cancel the Notion subscription before renewal.\nAmount: $29.00 USD\nRenewal: 2026-11-15\nInvoice: INV-1001",
  "allDay": false,
  "visibility": "private"
}
```

REST twin: `POST https://www.googleapis.com/calendar/v3/calendars/primary/events`
with `start`/`end` `dateTime` (or `date` when all-day) —
https://developers.google.com/calendar/api/v3/reference/events/insert

## Slack Web API `chat.postMessage`

Docs: https://docs.slack.dev/reference/methods/chat.postMessage

```json
{
  "channel": "C0123456789",
  "text": "Subscription invoice: Notion — $29.00 USD\nRenews: 2026-11-15 · Cancel by: 2026-11-12\nCalendar reminder created.\nInvoice key: notion|inv-1001|29.00 usd",
  "unfurl_links": false,
  "unfurl_media": false
}
```

REST: `POST https://slack.com/api/chat.postMessage` with JSON body.
SDK: `@slack/web-api` `WebClient.chat.postMessage(args)`.
