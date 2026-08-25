# Firefox Add-ons listing draft

This is a future listing draft, not permission to publish.

## Submission gate

Support: https://github.com/Stranmor/local-archive-firefox/issues

Security: https://github.com/Stranmor/local-archive-firefox/security/advisories/new

## Name

Local Archive — Telegram Conversation Exporter

## Summary

Export the current Telegram Web conversation to a local ZIP with readable HTML,
structured JSON, and optional attachments.

## Description

Local Archive gives you a direct Firefox-native way to save the conversation
open in Telegram Web.

Open a conversation, click the extension, and choose:

- a chosen number of recent messages;
- an inclusive date range;
- all history Telegram Web can reach through the signed-in source session;
- readable HTML, structured JSON, or both;
- optional attachments.

Telegram asks its already-authorized page manager for older history through a
static origin-limited bridge. If that manager is unavailable, a rendered
fallback loads older virtualized messages in an inactive same-session helper
tab. The visible conversation does not scroll while the export runs. Keep the
Telegram tab open until completion; if Telegram reaches its oldest reachable
edge before the requested date, the result reports that boundary instead of
claiming coverage it did not prove.

Every result includes a machine-readable coverage receipt with the requested
range, saved message count, oldest and newest collected dates when available,
attachment omissions, and the actual history traversal outcome. “All history”
means all history Telegram's page manager or rendered fallback can expose in
that session, not a complete account backup.

Telegram attachment limits are 10 MB per photo and 100 MB per other file.
Unavailable or oversized attachments are skipped without losing the text
export and are counted in the result.

The ZIP is assembled locally in the extension background. Conversation content
is not uploaded to an external processing service, stored in extension
settings, or used for telemetry.

Version `3.0.0` includes the Telegram Web page-manager connector with a
rendered fallback, a Rust/WebAssembly archive core, and eight interface
languages: English, Russian, Ukrainian, German, French, Spanish, Brazilian
Portuguese, and Polish.

Local Archive is an independent project and is not affiliated with Telegram or
Mozilla.

## Russian summary

Экспортируйте текущую переписку Telegram Web в локальный ZIP: HTML для чтения,
структурированный JSON и нужные вложения.

## Russian description

Local Archive — расширение Firefox для сохранения открытой переписки в
Telegram Web.

Выберите последние сообщения, включительный диапазон дат или всю историю,
которую Telegram Web может получить в текущей авторизованной сессии. Архив
может содержать HTML, JSON или оба формата. Фото ограничены 10 МБ, остальные
файлы — 100 МБ на элемент. Недоступные и слишком большие вложения пропускаются,
а их количество показывается в результате.

Telegram запрашивает старые сообщения у уже авторизованного менеджера через
статический bridge; при недоступности менеджера используется DOM-fallback во
вспомогательной вкладке той же сессии. Видимый чат не прокручивается. Если
источник упирается в самую старую достижимую точку раньше выбранной даты,
результат явно показывает эту границу.

ZIP собирается локально. Содержимое переписки не отправляется во внешний
сервис, не сохраняется в настройках и не используется для телеметрии.

## AMO reviewer notes

Local Archive is a user-initiated local exporter for Firefox 142 or newer and
Telegram Web.

To exercise the normal path, sign in to Telegram Web, open a conversation,
click the toolbar action, choose a range and format, and click **Export ZIP**.
The Telegram tab must remain open until the compact completion result appears.
Date and all-history runs load older virtualized messages in an inactive
same-session helper tab; the visible source tab does not scroll. The result
reports the saved count and actual coverage outcome.

Permission rationale:

- `activeTab` and `scripting` identify the explicitly selected Telegram tab and
  inject the connector after the toolbar action;
- optional `https://web.telegram.org/*` access is requested only when Firefox
  does not provide the temporary tab grant for that invocation;
- `storage` saves language and export defaults only;
- `downloads` saves the archive and handles the user-invoked **Show file**
  action.

The extension has no persistent content script, telemetry, analytics, account
service, archive server, or remote executable code. ZIP creation runs in the
extension's local background context. The manifest declares
`data_collection_permissions` as `required: ["none"]`.
