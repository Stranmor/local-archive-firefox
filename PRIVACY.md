# Local Archive privacy policy

Effective date: August 23, 2026

Local Archive creates Telegram conversation archives inside Firefox. Version 3.0 supports Telegram Web through its already-authorized page manager with a rendered fallback. It does not collect, sell, share, upload, or remotely process conversation data.

## Data used during an export

After the user clicks **Export**, Local Archive asks Telegram Web's own signed-in page manager for history, or uses the rendered fallback if that manager is unavailable. Telegram performs the history scan in an inactive same-session helper tab, so the visible source tab does not need to scroll. Depending on the selection, this can include text, names, dates, links, reactions, and attachments.

The Telegram bridge does not extract or store a Telegram token, cookie, password, or session identifier. It only forwards the current chat, bounded history requests, and bounded attachment-chunk requests to the page's existing managers; opaque media references are released after each item, and the archive records whether the native manager or rendered fallback supplied the data.

The connector passes normalized archive entries through Firefox extension messaging to the local background service. That service builds and validates the ZIP and starts a normal Firefox download. Conversation content and generated archives are not sent to the developer or an external service.

## Data stored by the extension

Local Archive stores only local UI choices: language, default format, attachment inclusion, recent-message count, and legacy attachment-size defaults. It does not store conversation content, generated ZIP files, Telegram credentials, session cookies, or passwords in extension storage.

## Network activity

Local Archive has no telemetry, analytics, ads, account service, archive server, or remote executable code. When attachments are enabled, Telegram Web may fetch them through the user’s existing signed-in session. Those requests are not routed through Local Archive infrastructure; Local Archive does not implement a separate Telegram HTTP/MTProto client.

Content remains in the browser until Firefox saves the archive to the local download location configured by the user.

## Permissions

- optional `https://web.telegram.org/*` access: lets the explicitly invoked Telegram connector read Telegram Web; Firefox requests it from the Export click and can revoke it later;
- `activeTab` and `scripting`: identify the active source and inject the connector;
- `storage`: save local defaults and language;
- `downloads`: reveal the file created by the user’s export action.

There is no registered always-running content script. The connector is injected only by the extension workflow.

## Deletion and changes

Stored defaults can be reset from the extension settings or removed by uninstalling the extension. Generated ZIP files are ordinary local downloads controlled by the user.

Any future connector or external processing feature must be disclosed here and in the Firefox manifest before release. A new connector must also document its source boundary, network behavior, and coverage limitations before it is listed as supported.
