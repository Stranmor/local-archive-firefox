// ==UserScript==
// @name         Telegram Web Chat Exporter
// @namespace    http://tampermonkey.net/
// @version      3.6.0
// @description  Hardened Telegram Web chat exporter for Firefox/Violentmonkey. Local ZIP export with safer media handling and offline HTML.
// @author       Sisyphus
// @match        https://web.telegram.org/k/*
// @match        https://web.telegram.org/a/*
// @icon         https://web.telegram.org/favicon.ico
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==
//
// Hardened changes (3.6.0):
// - least privilege (@grant none; no unsafeWindow/GM storage/download access)
// - offline-safe HTML links + CSP + no untrusted inline event handlers
// - real media concurrency, timeout and byte limits
// - supports blob:/data: media and avoids common avatar/emoji false positives
// - local media paths are written before HTML/JSON generation
// - safer filenames/ZIP paths and signed peer IDs
// - partial exports are actually downloaded on cancellation
// - JSZip dependency pinned to 3.10.1
//

(function() {
    'use strict';

    const CONFIG = {
        scrollWaitMs: 800,
        scrollStep: 600,
        staleThreshold: 10,
        mediaConcurrency: 4,
        mediaFetchTimeoutMs: 45000,
        maxChats: 50,
        debug: false
    };

    const EXPORT_CSS = `body { margin: 0; font: 12px/18px 'Open Sans',"Lucida Grande","Lucida Sans Unicode",Arial,Helvetica,Verdana,sans-serif; } strong { font-weight: 700; } code, kbd, pre, samp { font-family: Menlo,Monaco,Consolas,"Courier New",monospace; } code { padding: 2px 4px; font-size: 90%; color: #c7254e; background-color: #f9f2f4; border-radius: 4px; } pre { display: block; margin: 0; line-height: 1.42857143; word-break: break-all; word-wrap: break-word; color: #333; background-color: #f5f5f5; border-radius: 4px; overflow: auto; padding: 3px; border: 1px solid #eee; max-height: none; font-size: inherit; } .clearfix:after { content: " "; visibility: hidden; display: block; height: 0; clear: both; } .pull_left { float: left; } .pull_right { float: right; } .page_wrap { background-color: #ffffff; color: #000000; } .page_wrap a { color: #168acd; text-decoration: none; } .page_wrap a:hover { text-decoration: underline; } .page_header { position: fixed; z-index: 10; background-color: #ffffff; width: 100%; border-bottom: 1px solid #e3e6e8; } .page_header .content { width: 480px; margin: 0 auto; border-radius: 0 !important; } .page_header a.content { background-repeat: no-repeat; background-position: 24px 21px; background-size: 24px 24px; } .bold { color: #212121; font-weight: 700; } .details { color: #70777b; } .page_header .content .text { padding: 24px 24px 22px 24px; font-size: 22px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .page_header a.content .text { padding: 24px 24px 22px 82px; } .page_body { padding-top: 64px; width: 480px; margin: 0 auto; } .page_about { padding: 24px 24px; } .with_divider { border-top: 1px solid #e3e6e8; } .userpic_link { display: block; text-decoration: none; } .userpic_link:hover { text-decoration: none; } .userpic { display: block; border-radius: 50%; overflow: hidden; } .story { display: block; border-radius: 4px; overflow: hidden; } .userpic .initials { display: block; color: #fff; text-align: center; text-transform: uppercase; user-select: none; } .color_red, .userpic1, .media_call .fill, .media_file .fill, .media_live_location .fill { background-color: #ff5555; } .color_green, .userpic2, .media_call.success .fill, .media_photo .fill { background-color: #64bf47; } .color_yellow, .userpic3, .media_venue .fill { background-color: #ffab00; } .color_blue, .userpic4, .media_audio_file .fill, .media_voice_message .fill { background-color: #4f9cd9; } .color_purple, .userpic5, .media_game .fill { background-color: #9884e8; } .color_pink, .userpic6, .media_invoice .fill { background-color: #e671a5; } .color_sea, .userpic7, .media_location .fill, .media_video .fill { background-color: #47bcd1; } .color_orange, .userpic8, .media_contact .fill { background-color: #ff8c44; } .personal_info { padding: 24px; } .personal_info .userpic .initials { font-size: 30px; } .personal_info .rows { float: left; padding-right: 24px; } .personal_info .names { width: 164px; } .personal_info .info { width: 124px; } .personal_info .bio { width: 400px; } .personal_info .row { padding-bottom: 16px; } a.block_link { display: block; text-decoration: none !important; border-radius: 4px; } a.block_link:hover { text-decoration: none !important; background-color: #f5f7f8; } a.expanded { padding: 2px 8px; margin: -2px -8px; } .sections { padding: 11px 0; } .section { height: 48px; background-position: 24px 12px; background-repeat: no-repeat; background-size: 24px 24px; } .section .counter { float: right; padding: 14px 24px 0; font-size: 15px; } .section .label { padding: 15px 0 0 82px; font-size: 15px; } .list_page .page_about { padding: 16px 24px 0; font-size: 11px; } .list_page .entry_list { padding: 16px 0; } .list_page .entry { padding: 10px 16px; } .list_page .entry .userpic .initials { font-size: 18px; } .list_page .entry .body { margin-left: 66px; } .list_page .entry .name { padding: 4px 0 2px; font-size: 14px; } .list_page .entry .subname { padding-top: 4px; } .list_page .entry .details_entry { padding-top: 4px; } .list_page .entry .info { font-size: 11px; padding-top: 5px; } .history { padding: 16px 0; } .message { margin: 0 -10px; transition: background-color 2.0s ease; } div.selected { background-color: rgba(242,246,250,255); transition: background-color 0.5s ease; } .service { padding: 10px 24px; } .service .body { text-align: center; } .service .userpic_wrap { padding-top: 10px; } .service .userpic { margin: 0 auto; } .service .userpic .initials { font-size: 24px; } .message .userpic .initials { font-size: 16px; } .default { padding: 10px; } .default.joined { margin-top: -10px; } .default .from_name { color: #3892db; font-weight: 700; padding-bottom: 5px; } .default .from_name .details { font-weight: normal; } .default .body { margin-left: 60px; } .default .text { word-wrap: break-word; line-height: 150%; unicode-bidi: plaintext; text-align: start; } .default .reply_to, .default .media_wrap { padding-bottom: 5px; } .default .media { margin: 0 -10px; padding: 5px 10px; } .default .media .fill, .default .media .thumb { width: 48px; height: 48px; border-radius: 50%; } .default .media .fill { background-repeat: no-repeat; background-position: 12px 12px; background-size: 24px 24px; } .default .media .title, .default .media_poll .question { padding-top: 4px; font-size: 14px; } .default .media .description { color: #000000; padding-top: 4px; font-size: 13px; } .default .media .status { padding-top: 4px; font-size: 13px; } .default .video_file_wrap, .default .animated_wrap { position: relative; } .default .video_file, .default .animated, .default .photo, .default .sticker { display: block; } .video_duration { background: rgba(0, 0, 0, .4); padding: 0px 5px; position: absolute; z-index: 2; border-radius: 2px; right: 3px; bottom: 3px; color: #ffffff; font-size: 11px; } .video_play_bg { background: rgba(0, 0, 0, .4); width: 40px; height: 40px; line-height: 0; position: absolute; z-index: 2; border-radius: 50%; overflow: hidden; margin: -20px auto 0 -20px; top: 50%; left: 50%; pointer-events: none; } .video_play { position: absolute; display: inline-block; top: 50%; left: 50%; margin-left: -5px; margin-top: -9px; z-index: 1; width: 0; height: 0; border-style: solid; border-width: 9px 0 9px 14px; border-color: transparent transparent transparent #fff; } .gif_play { font-weight: 700; color: #FFF; display: block; line-height: 40px; font-size: 13px; text-align: center; } .pagination { text-align: center; padding: 20px; font-size: 16px; }  .toast_container { position: fixed; left: 50%; top: 50%; opacity: 0; transition: opacity 3.0s ease; } .toast_body { margin: 0 -50%; float: left; border-radius: 15px; padding: 10px 20px; background: rgba(0, 0, 0, 0.7); color: #ffffff; } div.toast_shown { opacity: 1; transition: opacity 0.4s ease; }  .section.calls { background-image: url(../images/section_calls.png); } .section.chats { background-image: url(../images/section_chats.png); } .section.contacts { background-image: url(../images/section_contacts.png); } .section.frequent { background-image: url(../images/section_frequent.png); } .section.photos { background-image: url(../images/section_photos.png); } .section.sessions { background-image: url(../images/section_sessions.png); } .section.stories { background-image: url(../images/section_stories.png); } .section.music { background-image: url(../images/section_music.png); } .section.web { background-image: url(../images/section_web.png); } .section.other { background-image: url(../images/section_other.png) } .page_header a.content { background-image: url(../images/back.png); } .media_call .fill { background-image: url(../images/media_call.png) } .media_contact .fill { background-image: url(../images/media_contact.png) } .media_file .fill { background-image: url(../images/media_file.png) } .media_game .fill { background-image: url(../images/media_game.png) } .media_live_location .fill, .media_location .fill, .media_venue .fill { background-image: url(../images/media_location.png) } .media_audio_file .fill { background-image: url(../images/media_music.png) } .media_invoice .fill { background-image: url(../images/media_shop.png) } .media_voice_message .fill { background-image: url(../images/media_voice.png) } .media_photo .fill { background-image: url(../images/media_photo.png) } .media_video .fill { background-image: url(../images/media_video.png) } .audio_icon { width: 48px; height: 48px; border-radius: 50%; background-color: #4f9cd9; background-image: url(../images/media_music.png); background-repeat: no-repeat; background-position: 12px 12px; background-size: 24px 24px; }  @media only screen and (min--moz-device-pixel-ratio: 2), only screen and (-o-min-device-pixel-ratio: 2/1), only screen and (-webkit-min-device-pixel-ratio: 2), only screen and (min-device-pixel-ratio: 2) { .section.calls { background-image: url(../images/section_calls@2x.png); } .section.chats { background-image: url(../images/section_chats@2x.png); } .section.contacts { background-image: url(../images/section_contacts@2x.png); } .section.frequent { background-image: url(../images/section_frequent@2x.png); } .section.photos { background-image: url(../images/section_photos@2x.png); } .section.sessions { background-image: url(../images/section_sessions@2x.png); } .section.stories { background-image: url(../images/section_stories@2x.png); } .section.music { background-image: url(../images/section_music@2x.png); } .section.web { background-image: url(../images/section_web@2x.png); } .section.other { background-image: url(../images/section_other@2x.png); } .page_header a.content { background-image: url(../images/back@2x.png); } .media_call .fill { background-image: url(../images/media_call@2x.png) } .media_contact .fill { background-image: url(../images/media_contact@2x.png) } .media_file .fill { background-image: url(../images/media_file@2x.png) } .media_game .fill { background-image: url(../images/media_game@2x.png) } .media_live_location .fill, .media_location .fill, .media_venue .fill { background-image: url(../images/media_location@2x.png) } .media_audio_file .fill { background-image: url(../images/media_music@2x.png) } .media_invoice .fill { background-image: url(../images/media_shop@2x.png) } .media_voice_message .fill { background-image: url(../images/media_voice@2x.png) } .media_photo .fill { background-image: url(../images/media_photo@2x.png) } .media_video .fill { background-image: url(../images/media_video@2x.png) } .audio_icon { background-image: url(../images/media_music@2x.png); } }  .spoiler { background: #e8e8e8; } .spoiler.hidden { background: #a9a9a9; cursor: pointer; border-radius: 3px; } .spoiler.hidden span { opacity: 0; user-select: none; }  .bot_buttons_table { border-spacing: 0px 2px; width: 100%; } .bot_button { border-radius: 8px; text-align: center; vertical-align: middle; background-color: #168acd40; } .bot_button_row { display: table; table-layout: fixed; padding: 0px; width:100%; } .bot_button_row div { display: table-cell; } .bot_button_column_separator { width: 2px }  .reactions { margin: 5px 0; }  .reactions .reaction { display: inline-flex; height: 20px; border-radius: 15px; background-color: #e8f5fc; color: #168acd; font-weight: bold; margin-bottom: 5px; }  .reactions .reaction.active { background-color: #40a6e2; color: #fff; }  .reactions .reaction.paid { background-color: #fdf6e1; color: #c58523; }  .reactions .reaction.active.paid { background-color: #ecae0a; color: #fdf6e1; }  .reactions .reaction .emoji { line-height: 20px; margin: 0 5px; font-size: 15px; }  .reactions .reaction .userpic:not(:first-child) { margin-left: -8px; }  .reactions .reaction .userpic { display: inline-block; }  .reactions .reaction .userpic .initials { font-size: 8px; }  .reactions .reaction .count { margin-right: 8px; line-height: 20px; }  @media (prefers-color-scheme: dark) { html, body { background-color: #1a2026; /* groupCallBg */ margin: 0; padding: 0; } .page_wrap { background-color: #1a2026; /* groupCallBg */ color: #ffffff; /* groupCallMembersFg */ min-height: 100vh; } .page_wrap a { color: #4db8ff; /* groupCallActiveFg */ } .page_header { background-color: #1a2026; /* groupCallBg */ border-bottom: 1px solid #2c333d; /* groupCallMembersBg */ } .bold { color: #ffffff; /* groupCallMembersFg */ } .details { color: #91979e; /* groupCallMemberNotJoinedStatus */ } .page_body { background-color: #1a2026; /* groupCallBg */ } code { color: #ff8aac; /* historyPeer6UserpicBg */ background-color: #2c333d; /* groupCallMembersBg */ } pre { color: #ffffff; /* groupCallMembersFg */ background-color: #2c333d; /* groupCallMembersBg */ border: 1px solid #323a45; /* groupCallMembersBgOver */ } .with_divider { border-top: 1px solid #2c333d; /* groupCallMembersBg */ } a.block_link:hover { background-color: #323a45; /* groupCallMembersBgOver */ } .list_page .entry { color: #ffffff; /* groupCallMembersFg */ } .message { color: #ffffff; /* groupCallMembersFg */ } div.selected { background-color: #323a45; /* groupCallMembersBgOver */ } .default .from_name { color: #4db8ff; /* groupCallActiveFg */ } .default .media .description { color: #ffffff; /* groupCallMembersFg */ } msgInBg, .historyComposeAreaBg { background-color: #2c333d; /* groupCallMembersBg */ } msgOutBg { background-color: #323a45; /* groupCallMembersBgOver */ } msgInBgSelected { background-color: #39424f; /* groupCallMembersBgRipple */ } msgOutBgSelected { background-color: #39424f; /* groupCallMembersBgRipple */ } .spoiler { background: #323a45; /* groupCallMembersBgOver */ } .spoiler.hidden { background: #61c0ff; /* groupCallMemberInactiveStatus */ } .bot_button { background-color: #4db8ff40; /* groupCallActiveFg with opacity */ } .reactions .reaction { background-color: #2c333d; /* groupCallMembersBg */ color: #4db8ff; /* groupCallActiveFg */ } .reactions .reaction.active { background-color: #4db8ff; /* groupCallActiveFg */ color: #1a2026; /* groupCallBg */ } .reactions .reaction.paid { background-color: #323a45; /* groupCallMembersBgOver */ color: #febb5b; /* historyPeer8UserpicBg */ } .reactions .reaction.active.paid { background-color: #febb5b; /* historyPeer8UserpicBg */ color: #1a2026; /* groupCallBg */ } }`;

    const EXPORT_JS = `"use strict"; window.AllowBackFromHistory = false; function CheckLocation() { var start = "#go_to_message"; var hash = location.hash; if (hash.substr(0, start.length) == start) { var messageId = parseInt(hash.substr(start.length)); if (messageId) { GoToMessage(messageId); } } else if (hash == "#allow_back") { window.AllowBackFromHistory = true; } } function ShowToast(text) { var container = document.createElement("div"); container.className = "toast_container"; var inner = container.appendChild(document.createElement("div")); inner.className = "toast_body"; inner.appendChild(document.createTextNode(text)); var appended = document.body.appendChild(container); setTimeout(function () { AddClass(appended, "toast_shown"); setTimeout(function () { RemoveClass(appended, "toast_shown"); setTimeout(function () { document.body.removeChild(appended); }, 3000); }, 3000); }, 0); } function ShowHashtag(tag) { ShowToast("This is a hashtag '#" + tag + "' link."); return false; } function ShowCashtag(tag) { ShowToast("This is a cashtag '$" + tag + "' link."); return false; } function ShowBotCommand(command) { ShowToast("This is a bot command '/" + command + "' link."); return false; } function ShowMentionName() { ShowToast("This is a link to a user mentioned by name."); return false; } function ShowNotLoadedEmoji() { ShowToast("This custom emoji is not included, change data exporting settings to download."); return false; } function ShowNotAvailableEmoji() { ShowToast("This custom emoji is not available."); return false; } function ShowTextCopied(content) { navigator.clipboard.writeText(content); ShowToast("Text copied to clipboard."); return false; } function ShowSpoiler(target) { if (target.classList.contains("hidden")) { target.classList.toggle("hidden"); } } function AddClass(element, name) { var current = element.className; var expression = new RegExp('(^|\\\\s)' + name + '(\\\\s|$)', 'g'); if (expression.test(current)) { return; } element.className = current + ' ' + name; } function RemoveClass(element, name) { var current = element.className; var expression = new RegExp('(^|\\\\s)' + name + '(\\\\s|$)', ''); var match = expression.exec(current); while ((match = expression.exec(current)) != null) { if (match[1].length > 0 && match[2].length > 0) { current = current.substr(0, match.index + match[1].length) + current.substr(match.index + match[0].length); } else { current = current.substr(0, match.index) + current.substr(match.index + match[0].length); } } element.className = current; } function EaseOutQuad(t) { return t * t; } function EaseInOutQuad(t) { return (t < 0.5) ? (2 * t * t) : ((4 - 2 * t) * t - 1); } function ScrollHeight() { if ("innerHeight" in window) { return window.innerHeight; } else if (document.documentElement) { return document.documentElement.clientHeight; } return document.body.clientHeight; } function ScrollTo(top, callback) { var html = document.documentElement; var current = html.scrollTop; var delta = top - current; var finish = function () { html.scrollTop = top; if (callback) { callback(); } }; if (!window.performance.now || delta == 0) { finish(); return; } var transition = EaseOutQuad; var max = 300; if (delta < -max) { current = top + max; delta = -max; } else if (delta > max) { current = top - max; delta = max; } else { transition = EaseInOutQuad; } var duration = 150; var interval = 7; var time = window.performance.now(); var animate = function () { var now = window.performance.now(); if (now >= time + duration) { finish(); return; } var dt = (now - time) / duration; html.scrollTop = Math.round(current + delta * transition(dt)); setTimeout(animate, interval); }; setTimeout(animate, interval); } function ScrollToElement(element, callback) { var header = document.getElementsByClassName("page_header")[0]; var headerHeight = header.offsetHeight; var html = document.documentElement; var scrollHeight = ScrollHeight(); var available = scrollHeight - headerHeight; var padding = 10; var top = element.offsetTop; var height = element.offsetHeight; var desired = top - Math.max((available - height) / 2, padding) - headerHeight; var scrollTopMax = html.offsetHeight - scrollHeight; ScrollTo(Math.min(desired, scrollTopMax), callback); } function GoToMessage(messageId) { var element = document.getElementById("message" + messageId); if (element) { var hash = "#go_to_message" + messageId; if (location.hash != hash) { location.hash = hash; } ScrollToElement(element, function () { AddClass(element, "selected"); setTimeout(function () { RemoveClass(element, "selected"); }, 1000); }); } else { ShowToast("This message was not exported. Maybe it was deleted."); } return false; } function GoBack(anchor) { if (!window.AllowBackFromHistory) { return true; } history.back(); if (!anchor || !anchor.getAttribute) { return true; } var destination = anchor.getAttribute("href"); if (!destination) { return true; } setTimeout(function () { location.href = destination; }, 100); return false; } `;

    const EXPORT_RUNTIME_JS = EXPORT_JS + `
(function(){
    function onReady() {
        CheckLocation();
        document.addEventListener('click', function(event) {
            var el = event.target.closest ? event.target.closest('[data-tgx-action]') : null;
            if (!el) return;
            var action = el.getAttribute('data-tgx-action') || '';
            var value = el.getAttribute('data-tgx-value') || '';
            event.preventDefault();
            if (action === 'spoiler') ShowSpoiler(el);
            else if (action === 'mention') ShowMentionName();
            else if (action === 'hashtag') ShowHashtag(value);
            else if (action === 'cashtag') ShowCashtag(value);
            else if (action === 'bot_command') ShowBotCommand(value);
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, {once:true});
    else onReady();
})();`;

    const IMAGES = {
        'back.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAPJJREFUSA1jYBgFQyoEiipqGkCYFEczEqsYZPC////rger/sjCzGvS0NVwhRi8TMYqQDWdkZooh1nCQ2QR9gG54f1vzCmIcBVOD1wJKDcfrA2oYjtMCahmO1QIkw2HBSBI9obMVJdiJSkUk2YCmGMU2mBySL/4yMTJE93W0roTJkUozY9Nw/MihA1a29oz/GRgcgTjQytbu5vEjh69iU0tIDKsFIE3UsgSnBdgssbR3uHHi8CGSfILXAnRLgBEWaGlnf5MUSwhagGLJ//9OYEsc7dedOHToNUiOECDKApAhsDgBWnC4v61lNSGDR+UHTwgAADa4h+Zrqrq9AAAAAElFTkSuQmCC',
        'back@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAcBJREFUaAXtl91KwzAUgHPWgbv0deratTjwDdYH8coLwYkOFUR8H9kP3dT5IPoAXrvGnEGgjDbpT9JkkEBJadOT7ztp2oQQV1wGXAZcBlwGXAY0ZeDy6nqKh6bw+7CeruAInlF6QwmJz8LI+9ykSx19aRHg8ByYSUR+MNpt39cpv6aq7qsKxOMcwu+vA/x6AG+8jcoaVAYrg+8DXDw/3H2p7IvHUiZgAh4llAiYglciYBK+tYBp+FYCNsA3FrAFvpGATfC1BWyDryVgI3xlgUJ4fLqD8vo0E/6rejIGk/AyNrwvFagSxGQbqcDL4/20B3BrElLUt/D9yj9Y+CqxZbLOlWa+/7LzyhsatqNasZ0V4A4rF+wkIyQJwmj5sUm/c9c7O60sgERlEpTSSTCKjUjUEhBIDFDCj8eL7XrV6UjUFhBJQJYlXUs0ErBJorGATGIYxnM2Z36wnc7SSgDBSib2gBCadCHRWkAkwT65k2EYLXSOhBIBmYQfn8/Z10nL66RMQCRBMsq+TnokpGshBKtTitdO9BR2f+M6caq2VToCvNPDiY2LQSY24/ePpsYFIB5HA+xAXQZcBlwGXAaOLgP/TQQam/2N7EUAAAAASUVORK5CYII=',
        'media_call.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAVtJREFUSA3tlK1OA0EUhTsE1yAraEVD8AQEuAZSAyUoBJrwCPQheAkkEoLhBRA4SJpQSZCoClKDoV2+s7mbLLM7hf2RPcnXO3N359zdnTttNJYq8gWiKHqAtKZM+kU8/HtXvMS+N19jfuTlCk39Ah+2ep14buOWxVIhVGATt7E5bpdytkV+gXfL7xEnNt5iH5o2rhYwOrUdfiKObTwirlZzttUYNeHLjBVeodIeZB4Mw3s5ozeo11zVMN2BOegMdDJPUEcC4xuQbuvwy3hg3IVPkIaZG+pIYDyAmXGW58k1B+VbmMVDkFTo15swb8ELfMMzXMMVHOQ9TDDHAhVRAekOOiBztXCepkGz0AVc9LmSPVF3qYUlHcYN2IULiBXyWZhnZRfUXWrhRDrxl9ADvVmshUZ/XcRB50SHMX3iY+PkJ+3h0pMiY8zUPYdwDPr3bRuPzrkTxkv97wv8AMG2b8VlwsFFAAAAAElFTkSuQmCC',
        'media_call@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAulJREFUaAXtmL1rFUEUxfMUFQyCATVaxgQUQSxECEGwUTC1GkHsLYKFTcB02lnbpLXUfyDWFiJqrFWMmGclFsYP/CDi+juPTZgcdue95+q8FfbCYefMnY9z73s7MztDQ401GWgy0GSglhnIsmwavAUxa+OcrmsA3cSvB9YeZACtsslR9wPf9jK/1Q+3Wq2vVpeEbonM8jnic9cer0jF+wlgjCx3DHHLJnCv8WQ0FsCqqTgY8JWgrOI+48loLIBXpmI84G+CsoonjCejsQBemIrwF3hsvlPGk9FYAM9NxWTAHwZlFSdZtbZZXRIaC+CRKZhC5HBed8x8O+FjVjd4imDttKFpd74EfoaVlFfByOAVmwJE3TGhT+Eufo2689a1HlTCLACnEn+hHmoLVCBuB/jgqnMu8TMF3epVhciFggD+D/FKJeKPFwQwV680d1FDAPctiCfw2BLcZcTEbsSetABEZxPLqDYdghctCK39o9VGTdgbsRPguwVxN6GE6lMh/oYFIHq9+siJRkCs9oUlqQ7sF+X6bmaeG8SOg49BACp+A+Fp1bvViyP2HFDmQ3sP6SsI2o+AI2Br8giZ9Bpw0y/R0/GCdjpnfckH+MRTe808OA2OggPg335jMMEt4KZfZj6WUfwzQMeRXmyZRmdi41XyMXhREBJ2D+z3wanrR7zGkfklgg9bjTOB/k7+TmhibXazoHPs4Pkn4umWZdUU9tCbOfRi++qkuWU6O80B/9vo4+gy0IHxKtAH1AOwAjZZDxKqN2FGLbG+T2wSEhCJv1g2a9CuUyxr91dPlFzb6cZuCtwEuluN2TOcWn3WLwpibUt9pZe7pT16dCBsgqa3wdkuXdbw6wZEd01KwOscL3lumO40N0jKAoHoKO7fE1T1Zyk1F86FXL2oC6DsGzsaUeGgg6hEpQ6E2oW14vi9E1WF1i7TOpj/VaAGuXpXdIY6DA4B8d1gV453PK/wCizybKzJQJOBJgM1y8BvOJC02lY/3lsAAAAASUVORK5CYII=',
        'media_contact.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAP1JREFUSA3tkz0KwjAYhq046u7Q0UVw7hXE0cnj6Dk6OPYIipt4BkfBTVzEAzjU5y2fGQqa0Cgo+MJDvuT7baKt1l8/cQNlWaZQwMmQnb5leBWCC9Sls/gmFNG00grUTMiWiuivoIiuRXLTyq5O8PkatH0Bsf6QBltrktvk+pLczh4+2zZYrOjnHlkzWRM9tt5DyHZv0mDu96Ukr0ox5QD/BMYwgj5IZ9jDBtZJkhxYw0XhDHYQKsVmQR0InMLNKl9ZlzCDIfQM2TqTTzGScqbeJgQdQZpD15egGFiAdPTF6xdTyRtYC3iW16nFua0S3CbCCPknR5T/p37DDdwB4fZJLFfE+R8AAAAASUVORK5CYII=',
        'media_contact@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAhJJREFUaAXtl7tKA0EUhl0RSxULIURLUaKFIFipWKW3TOVTpPcN0uQtUlgKgoKXShBsAoqdWimomFaJ3w+LDOMO2WHH1YU58JHZM2fObWc2u2NjUWIHYgdiB2IHYgcCdmA4HK5CB/owSNFYutWAocK6IrlJ6MInuERzspkMG72gNyUEx5BXZPt/iiAZddVXugX7FmY5WWvP29vmAV0LaikaS2eK1vz9mSAJHU5TlOis3R7pwC6iY9uVfk1SesKY0nIlgZHuhCl9l21perLRo9KUmis4RtpSpgxctnn143kN/6tdiALureJ2rGvz0p6z15q25YzZD5U/xEUeoyvltHlEFO5Cdf/IVBsFVPtVwiiimi9z5g7jblTzddosIo49OpB42DpN2TZzTG7CBizBIkg3BZJ3eII7uIVLuEiSRLq/EZJuwD7YL3OocovWykejtCoI1oRTCC3y2fy1QnBeh5PQWWf40+dmPW8huc4ADrdxeAA/PlTSQB/8XsE5XMMNPMIbSGZgHpZhDbZgHSYgS15Q7nJGzrImvXQkvwDPkCVHKPdg2sspxlqTrpWPLFHMBV+/P+xx0svwfohOnQwi8gXyaUuvcAA8vlle24WdOhwQp23FenWYfqtHngE5/LZmwL4cuca09x37xgvxReabY1B711PAGcTukNOwpInK34FYQEk7JYaJHYgdiB2IHYgdyOzAF9Srass/u5CaAAAAAElFTkSuQmCC',
        'media_file.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAKZJREFUSA3tlNsNgCAMRcE4hgM5ia7hqEadQ2w/mpCGCi0fqLEJ4dV7D22izn0uQggjjA1GLhZT8eC65pyjez0ExCca3L0uAuBSBwGBFqCDGAHlkApAEuJ5rxEAZx6D39EenWjNZ67reULJnpugRoJ2JYY1OU0AYu8tlTSpwPJQUfNXILaGLt7fotSv4oDyBunTp9KFeefnqRZNkIQQbaD5rBU9P/8CxkTjzyHIItoAAAAASUVORK5CYII=',
        'media_file@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAVJJREFUaAXtWF0KwjAM3sQT+DbxDnpEr+KD4jG8gkcQnD6IN1Dm14eMMTbSrknrIIXQuTbJ9zM3aFHYMAVMAVaBpmnWiCOiRsSOPdtQcgPQVohXLOpefjoSaHzoNZf6mYYE0N6kEA/U0SeBpp9u46mPZ7dG71qXRAICjo8eiUQE9EgkJKBDIjEBeRIZCMiSyERAjkRGAl4kSu69jipf7FnQvhKDrkNmhyZkP+3l+rXAKGFu8zIVYE5JwhHq1OwdMAJkfa7ZHMilPPX1cWDSe58aaM8+BLQxRNU3AlHyCSSbAwIiRpUwB6LkE0j2ccC+AwJCj5bwcWA0+R8WjEBuF8wBcyBSAZ9TiSd6VNQn9NSA8ibODy7P5z9w4YoorrO92a8sFN8A4BWxUgQ6VPqNm1ucJ9VDi3SPdQAF7ti8Q5wR7nHSHq7HCcGC1wZi9U2BOSjwA/sNRweOn8VhAAAAAElFTkSuQmCC',
        'media_game.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAMlJREFUSA3tU9sNgzAMJFXHQN2HRcokXaAjNt2A/ps7ipHJg0rIf40lY+fsu8BJdF2L5oCLAyIyICPSK14QGvhygQ8cIkrP3jFiCOG26Olre4lbvUtN1C7VdhTH7gM5sSq2qyWxErYjmcMqTspE2HKzL7DDdNlopu0TwAfJmocV1T6tloXZoSXK3TgZgEkJUwJm9JuxWKK41u9IhOfMIl36UY8tScn2xnR25mz1rqvAG7Xn4IxghcOfd7Pojp6XeAXFRy+xpvPvDswasyTTINoFswAAAABJRU5ErkJggg==',
        'media_game@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAbhJREFUaAXtWFFOwzAMXRHaBfiCHWLXnOAWSHANuAKH2PbFGcrzqC3PjZsUsc6THCnEeXGc55cma1mtsqQCqUAqkAqkAqlAKpAKnBTo+36D+oZ6QI1W9iBE3DZ6uzruDANf6D8wFrT9Bq9t13V74nenSL7Ajk6e6BLHZzKo6B04oP94QuP/OWIHnoimTqDXvOEgYxq/lk0HUq/N/PQjpMdvxp6dACmhy39liphr1B0q3YBUyV43x4fzWfEmnjmh4/nNxRGKCNuy4zh2gHFpqw6DZ6ufBG40ELf020MXy6l4685+hDhglLaagJc5J1AbZ7+G9rXgU8IKboA8Ihav9cvR6yjiTh5iu+4ooudg8Vp/FHgAMG+SoDePcbsu49J6Dhav9SWgMTBv8pYx7qOuXXe+wzCjGmgU+RfAvMlbxpkmsLdu9RBLhKDGkgmUbpQS9jepvC2y0Vr9CvMucojljZOI6UX5bU9j17Q9fks+QhfJ/15FPcKWDxqbsfKLYMo7kt6BjwjMGjl8sp8+A/S1f7sf9Ti09JW/RX1HpccpWiFOxE3+IxGNYPJJBVKBVCAVSAVSgVRgaQV+ANjgZTiWvls8AAAAAElFTkSuQmCC',
        'media_location.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAZpJREFUSA3dlLFKA1EQRXftQ7BQSZEubZq0Wi0RbNLoP8TKOoVVCn/Ewl+QlAYCKfMDgpUWIhKCCCKu5+7Og/Dct9msXQbuzryZO/fNzoZE0c5bmqYNMAYLsDIoVq7xrwUgkIAnEDLVklqXqBH8mPIUPwAtg2LlZOJsdwkNWoub/IZ4z59SOaCaTNzq64Ks/co0ZSaOb4KhoakLVQPuTcb+EMEzTfqIsoEJSfwxy+QPxe4SrUu2CAr6Bcj6tchadoEm921oNX0X2crX0fnPbo30Zf7DfJlzHNdTxs1rTDPPZkrTE2WIy1Z0bNx5kXLoDaZGvpCP43iJ64FLQ89yHKNzPTDXk5/KnkzUtan0LfZDXGp6s6VxuyFeYZ6mmTVeFxJIUh8ZZxbiBPM0Jtb8jj/yieQOwJtxEr9e6UzzxATu/Abyt1ab+LXKZwQ64NOEzlwj51PLqdZx+VoeAbfnF+JDoNU8A9moluh6EyL6v3mQGnZvUKxc6Ge+LrE5RqgNXoEzxe3NnVswEOyDb0N/i9bqVMSvhOodu8D8BeBPLmAG0BfFAAAAAElFTkSuQmCC',
        'media_location@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAA5lJREFUaAXtmc1LlFEUxp1CQpGEloUtDCwEW7jITYIJaZnRys1Af0MtbCMUuHLRKohACKRduJASapcbwSSjTYuyj1VkEAaRq6Kcfofmleszd3w/5r4zgXPg4T3n3HOec+713vdjbGlpSnMF9vcKFEJOv1Qq9cN3BQyCY+AoMNkAn8EyeFwoFF5x/X+ExifAOkgqFjvR8BnQRDdYTdq1J85yuxsyEQoPgU1PU2ldxjFU10lQ8Bz45enUfPOgCHpARxmmm8/GquXVZxI0YNvGt/IL+E/EraTFAItVMc78txNFdM//wXcjrnEdtxxgua6salxQm0p2t1FJ3XzUFEQ2CZX87k5U0lvlQtRM1iucup3Ws3LtmUehflkqO4zePY9/ECyCjTJMt4dbheC3M6EH2x6IYYUi08CVeV8FAqbAthtY1m2/T1XJsbuTK9O+uJp8sC+5FdCLSojPVl4PpptmYxV/CXxFNwh9SblrtiHV/d+jpMTYVomTRU+ePSdcCX8OYN9yK6B3eBqxPR8n9mK3S0iwB54rW7sC9jAO7DGmQwfFkSZXUitM5dJaFQmRQxMjv++6Kc4usc186fGpyxejXFpLOXbsNBP4sJP1T+kV28zbYNvjj1w2ZjEqp8TxXuyqZpoJvBCWC2K38KGyjO8W8E3CfDfLMZo6Ko41sWs3OWGj7ilD/wK8C4DfbqdJH2QFYj8BV3RCQSbQSoXvbhX0S7Uyw3FeOK1Ga6283nyI56TYU29gCid8j4RzLkV6ulAKDUgxe2XQA5iYlFz7tvgtnAOJCbIEUmxNCj7MwmM58DwQrvCHV5uj4JgUtb/CaY2Ls8k5CXT1x+LygoxTeAW48iwtMclPXAL0lbQcmeMpNizFzbyalJBY35fdcNL8IHE0oa/XX/EdiSMn5jDQl76luLzg4zTRB/RL6n5cIXLuAleMoy8uL5dxCs+4naDbgT5brRhjZ4B+8MxUi8/dTzNt4CNw5Q1GmxbHdwi8dgPRLbciVnNztWlgRJoy854WxXfHEzeicQ2xaWzW09zlqBnGLgLbXq7MRuMNv9JVO3jrdof+DRwHXUB/irTY9oY37jZAQ/3gJ3DFfoZ87jrQLSb87z5uM1l1GpuUZn3mZFb+3PPo1j5O9PXYnYSNBf23VvBJ0WAneOd2XdbN1xm8YB6ENNoLfpQbt4vpvh8B8igfhpOGx4E9dQ3jYVjrzELj18G1OpdtlmuuwL5agb8vZNPEQr3r0wAAAABJRU5ErkJggg==',
        'media_music.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAM1JREFUSA3tk0EKwjAQRVvxFMXiucV9BfeCSz2MurJXqG/KBEo7yZRQQagDnzQ/mf/TzKQo/uHcQOmsT5Y7YkJClITFbyxySS7HwPyD2KFyDGJaJr812Rlk7M7HqV//g3Ua/FYXJWvAo92BBjxAC850iflix93jzhET8TcwwxXwNqAqJ5e4ghqI4QX04eW766g8VWsfNjOvlJtd6GQNgrAxvgzOpFIGN804cOr+ipgflbvrmD8gGiuydFOdrzzIVJPQplKT02LiA5+Vf34AAKWne4ezSQMAAAAASUVORK5CYII=',
        'media_music@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAYpJREFUaAXtl0FKAzEUhtsiuu6ioAh6gKpncOMRCi4KbryPotJ6GUHvoK7c2EXdW5fq+AVcDK8zbzLpNBPlBX5o8l6S//+TTNJOx4o5YA6YA2060F335FmWfTOH9zxdSh1OvTrJKeaagLZXxVbAYwUyj5zgFFuBYOsa6rjR0Djew9T9zlcNbFuoyiHidog1k2wLae7EiNkKeLhsh1gzybaQ5k6M2J9fgZXfQvznHeL0OTgBe+ATvIAHMAFpFohvgmvwBcrKUiwJNbB15O/KWGvtqQi40UhqsdYFQG4I5NaY0zYGu2AHnIIZWCopCLgQrN6oDyQx2vrgVeSu9VaWHArrEHoSpM4KE2kkbyRykxCwEKT2FQEDkdu4gNgX2UeZ2ND2EAEzMdmxqOerMib75nPj/GZLrHKIL+OwVGZBwAHQPqPbxIs+o67PoTJ0vBBEQi6yaTyGFTMhoO5T4p4+WxXDxg3/ivB5zN0mRz5vFeTc08Id7EfwDtw98QyuwFE+136bA+aAOfD/HPgB+lWRM/EQ08IAAAAASUVORK5CYII=',
        'media_photo.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAuklEQVRIie2UIQ4CQQxFf8EQBCcgBE24yBougMDBoSDhElwDicAgGCyKrH6YDWk2O2R3NghgXzJimravppU6mgBkQCCdK5D5nlYSBEnjlnMGM5vEBFTFG4AkmdmrvpfYqDad4LsF/U8KlpK2javcRsq9DFi4/xzIi7xVKRe3S7UEU+AOPIrGI+Ds8nJglioYAEcXuwCHivtzAoYpgl1Fsxj7mOD3btHNTZLyJCm8E6ydJIUgadOi/h95Ajk+bU+s+jWjAAAAAElFTkSuQmCC',
        'media_photo@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAABkUlEQVRoge2ZsUrDUBSG/1scrA6C4qBZ3MQuBUXBR3B21xfwERycddVVJ4tv4KiDbi5C6SxI26mLqINDP4em0JTk2sQkt8r9oNM5uef/kkshN5LH4/FMJYCAALgGOpRPO5wdAIk5jUUgkPQsaamA+5OGnqS6MaYdV6xYLjyT+/DSIMNpUtH2BDqSVopIlIGuMWY1rmATGN94ib0FEZlvjImdb9tCfwIv4Bov4Bov4Bov4Bov4BovkIGFPBcrW2Bf0oOkauGTYl7x9MvfOvAWrnU5QX90eMECW8COpT4PNMfWO5gWgUXghcGLf5DQ04hZ7x3YcC1QAW5Hep6A6ljPUcxaQ5rAnEuBk5i+m5H6LvBlEQC4ciWwB/QTQh0Dy8DrD+GHHJYtsAb0LIH6QGvC8AAfQC2LQJZTiVlJj5I2U98VOy1J25I+hxEiw3M8lThX/uElqSbpIu1F/lzINV7ANTOWWlfRw930/8X50Ukq2J7AXQFBsnKfVPjXHzjakuqSGhpsp7LphrPrYRaPx+OZQr4B0zIxY1XMHNsAAAAASUVORK5CYII=',
        'media_shop.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAATNJREFUSA1jYBgW4D8qaKS6p1DN//8WyOehuiUgA4EGH0azjBzuIWTHMSFzgOw2ND45XGG8moBOPg91dipehUiSQPW8QPwSqi8QSQqTCVQUBlV4G0gzY6rAFAGqa4HqOYwpiyYCVMgExLegGiLQpDG4QHXSQPwNqt4cQwE2AaDiFKiGC9jkkcWA6uZD1a5EFsfLBmpgA+InUI3euBQD5fWA+C8Q/wRiJVzqsIoDNbQDMbGgH6shuASBprID8X0iTP8BVLMaiDlxmYVVHKihBGr4BSCNnlew6iFJEGjoXagFbiRpxKKYEYsYqMi4BxRXxCaHT4wRCNDlcXk/HagQZMkQBcAg8gDiR1DsicsbxKrD0A/U+ACIYeARhgKoAFABQXW44gCXmdQRB7qMtkFEHWfSyRQAM2bDqlChV0UAAAAASUVORK5CYII=',
        'media_shop@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAtBJREFUaAXtmD9oVEEQxnNR/ENUDDZqQoqUNoqFpWgjWAl2YmGhWNgJNjaKhVgIlqKViAQLwUpiJaiFnRALQUTEkBgISoIoaqHG34Y7mJvb3bf/3nmRtzDczuzM932z7729dzc01IxmB5odWN2BFfd4sSa2yK1/deXgwDdR0cDjtd6A6W/fwDchBSL4ecVV6dfye4iOSm1y3pKOnLeLpmXsH87nWq3WhI1/2BY0MQrMfT/jWu9z/LeLz9lAu+Caq7DP8ZtJfNxGw9hbTI4bSWCBRRDdl2TMP2CbAst70yg+rQC/4e/ozcyPgHsA+6P4TmYhA7YBm1egV7JAHcVw6JPvJTHnQeOA6Q0Dcl41sIS/pTczPQLeMcVh3MPpiKISoBHss0EU44JIyZqCuR57I7DN9FEWqC4G8JIiWMDfqPNSfHDOKexf+HtSsJw1AI5iXxXRWWdB4AJ4W7FFhXs7sDwuDZLriugd/ro4lO5s6q8qTHPK7ezOKuQBvAv7qQhPpMKDM459V3iXU/GC6iC7pQhfBRVaksC5o7DMczViSS0XgmASMw9ZHeNMrNLoLwlUb4NkFtseS1aR/5r1vbxEOl/cbPVVL3O2mosES4tfBPN4rHibOG+M3Z/AfhS8d76ANY2VPfNdXUB0T4mfw9/syh+oOEL3Y/pN8dRAifSJQfwDTI4ZnJRnyEdT3xpil6V65kfqYwtHDj5GEbwE7Gg4dF4mJ1KQtphb4EmepHqqg7o01FyBcT6eYZPGr3sUvwIAziP6EPYQW8aa0exA7A7wHOzGprCPbTPzsVicTj61RfE6uNZPyMyPmU+YHubHfnQT1BTFs4qWQQjvauXCn5K5IfPSeJWcEM4KwXq6UAmgEkrhxXyRKQld7kqXl+8E48U08NSjy7fmKvPV+NZceP44l7zoQ1caz6++vQrpGNY5Rs0/CLnHaFG8oCaapGYH/rMd+As3HEOlEHuU6AAAAABJRU5ErkJggg==',
        'media_video.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAsklEQVRIie2UwQ3CMAxFXyo2KkvAMqxSZoExYIuqZQo+hxZkUheCZC7QJ/niJP87dlNY+B8kbSR1Kqcbz+CFZ/CJuDWxwvWYP9x1kzFQnnt36Wx/DZwewiklgKq4h695ErdEGFjx/ewu01d3aE7kNDYfbdDk+cgWlfGtFq0CalszDHnnLUa9g8lnGv0Ozgw3AbjaBWvQm8pKAuDimFTAcVKCpK2k3hneHO14puxnt/C73AAjeMcYc+j6SgAAAABJRU5ErkJggg==',
        'media_video@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAABYklEQVRoge2YMU7DQBBFnxEtiEtE0Jsi3CpcIm1yEMIBED0U0IdbYJJ+KOJIZj2Jd2wHTaR50haxZ3f/y1q7liEIgiAIAkeICCIyEZGViFQyPlU99qSey9RSCkXgFngHbk78X30DU+DL0qko/ka+UGrmnD489RzzjLoSkLo9pTe1FaiA66HpMtkCV0ful8BH80KRLIEmkD5orZqB5I7fCg9tAe0R8oAaXsOjQHZ48CdgCg++BMzhwY/AofBL80jKyWk+LTtaSnngxF5o9WleD9uoxhJ41OrPYRtthu/E4wqk853dCpjwKLCwFHsUmGGQ8CBwr1zLlrgcN0svPtlJpAfZLKezh11oP37Wq4TnXWi/EiY8CUAPCW8CYJTwKAAGCU3gJ/ktI7cm26ESmsBrV6cReem4n0qs0gJtG70D3vifD1sPwNrSKefD1prdF7NnYNMz3DE29dhTjOGDIAiCIPDGL3zudmKPpFbhAAAAAElFTkSuQmCC',
        'media_voice.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAQJJREFUSA3tVDEOgkAQJBQ0WtLwD1teYHiJj6AywW/4Bh9gfIedCcaeyuacOXYTgQPO5IwFbjLu3uzs3t5xMYoWYcaYBKiAWsA4CXZ4NDsAfatCbsDJaVsB4zrkBmxotKFdvK2Vd/nYRYbk/hvM3uZvrggPpJGXksmId3pw9pn2uEy0jfAdN3aCq6g24o/iT/AETTnVaE2bnfrFRKVMdYGPAedfheSooZVTPTs5iNfAjVWwPTA4KTnJwVntqtNkboGiAniyGsYpueZ9E4x1cmqKuX7OPApz4AGMGXO5s9iXRIMU2AFnQI0xudS3j5dOu3uJRTT4eJ8U+2i/voHPEAvXvAA11z6qHS5ibgAAAABJRU5ErkJggg==',
        'media_voice@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAk5JREFUaAXtWEtKA0EQNVnnAhFDAoInEMwmqwjqzmXwALmBh1HBA7hwqQhGAiJEcKkXEBfuRBI3gsT3wgxTqYzJ9HQNRuyCR6q6ql5VV/fkt7ISJEwgTMB0AuPxuAR0gQEwjECdayXTYtZkaLAK9ICfhL6qdV0TPjTGyc9rPt4UY5bvJNAUr0hW6ZpMzZIEnfOeS7mAUYtwKR3QB5a1TbjQFB9YKWsxMRa5ESnD2Of7anYX2Z1spgSR9iK/jHXRyy7ByxgbNvDbpxJOIJyA5wTCFfIcoHd6OAHvEXoS/J8TwHeZEb/PCKmo4Y2kjbhabEs9WtOxFcFLdcof86S9upzAqyJYVfaTso/YOIH1Y+XTsZpL11LpiemygZckbaJtKvtU2XuwnyPsKp+O1Vy6lkpPTJcN9JO0ibav7BPYN2otzWQMY6Vorr50mui4Ck1AyieMdUkO2/lHPTkAcklpSl4THez80f4oq0A/1+RRXOa/VcihOFlj6seQrpHbBnFHFaN5mJeQuSl8nbx8C/NQrAzcqaJfsJ03wRyAuVLI7fJcLux5JgAF6sAboIVXYeqZmEnGAmMAfW3IRc56Wo75Ggq1gQ9ACx/GM+AA2AD4AUVQ5xp9+oHF0oSrbd7oPEIUbQHvrO4p5GjNq1WYD4UbQM9jA8xtFNZgFmI0wLdXXo8HIKswljneb5feBHKTaGgL9jbAK7EjfdCvgFvgGv953StfbtN0A7ILHoW09T910uejF/ue69NZxtywgYyDKiwsnEBhow3EYQJhAmECf2IC3yVOoAkgSuYtAAAAAElFTkSuQmCC',
        'section_calls.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAkpJREFUSA3tVM1rE0EUf2820a1JFYQK9miuYvVSUMGgUCzag18Xb4J3oWq1H1ZKTdvUprb+EXr0pNhQKGrAerNii1706KUqhLImtck831t3SmYbEjbnDizv6/d+v923MwOwu5pMAGvr/fdHXhLARZPj4gYhXprPZpZMLqpVtQ1MlrZigHYW6a3NRfUtAQT6IQTxtvhhVHBDfALqENvqsgQI0BfY2qymFKlVn5TgeKvk0mcJ8Pt+lyQSdYOjf/o+4rG7MzMJ8VtZloCD+MonIbimK4EP8DnpeZutkEtPrLYRDx7I469imYhO+XmEVRf39YyNDVdqcVF86wtyAwMeESz8J8BvbZg4NzU1vB6FMIy1BKSoEMfZEO+oQ2Wl94QbosY7BJ5kH31kked84NqhWnoalTCM3yEgAHRohA9Ykcd1tX/wwZ1wU5TYqQdeLhSKp9NnP3HtOj89J8+kv34ovFsLY3kzoJdMJt4vLm6Faya27iKTNFbenklyiKg5d28um5k1taGhyY6y9hZ4lF1cX+Ejv8Lfvu4g5XPZzBuDayggoGBEj1mIx4kvMObecrX6WyJviUmPGiJjmXBjbnpiv4nr/gNTFCtvrZTqk3/Cm+sKVEpfSvrPspAj4FosjkccVN0K1U3B+5tDnGA1FRDc7OT4axWDLt5dz5ggyTSpoL+oq3RZI7jk7M0HOcs0HZGF5uD24OgJTfQQEXp5bG64LvH89MQ277ZTD9goJxcg/S6e1xou8KlM8cHs5Nu4ky/Kt/wP+hr17tasCfwDFRG5hsIoVV0AAAAASUVORK5CYII=',
        'section_calls@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAABM5JREFUaAXtWV1oXEUUnjN3Q9vUagNtJfhTti1U7YNoK6Zr01Qq+AN50q6gD/qgRB8MTaJm292UpdndJoT8EB8kCiIFH2x986GIgiFN0xC0rxoxodqHEgnaH2Fbd+8dv0kzN7O3O5ubmL3rw15Yzs+cmfOd+Tln7l3Gqk91BqozUJ2BSs4AmZx3HD/xom07nzAmHjTZENEVznlLf+bkOZNNufXc5GA58LKfEOIhx3FGTGMEoTcGQMS2+QEgg0gmk7V+bMthYwxAMHHTr8Nslm3xa7vWdsYA4KgggPVUEx7qTZP8MUYzOpA82Vt1OUjeHIBg13Qgt1h+h5KxvX5T/ALl5Gu7FfRZI8EYADH6VffBie1UMrbXZcVL6tj2U7ocJG8MQBCb1oEIh9wV4ERTehsjaiqQAxSMAXBBP+s4BIkGJSOYCcVLKhhrGBkZqdF1QfHGAARZkzoInNzI+319G6UO/ON6GwpC7fTlq+ECXUACsJiftljid5nnlYVlWS85tqgTzDkNnaX0GOT6Oron3NNz7C+lC4oaV0ACwNb4XgeCqtt9F3iivOD0ViXAS2wlA8Be+VoPAKuxF/LSzAM8MfHa0KnUV7pdkHzJAHbUb0MAVFAPFDhc5PKM0+sDPemzSlcJWjKA1tbW2wD1pReYAj+Y6T7jbQtaLhmABGMRfeoFhZQa/z+Al7iWDaC/p/tH2H2jB0EOO4Ib6LJ99T7l4n2BwKlN6QCQnfZdy+bf1XWV4kvWAR0UasI5ZKEXlE7m/g1W7e5MJj6ndJWgvlbgDrDQe6DyUC88WIX7snZ2WMmVom5OXw7A5Pjon/sPHqrBtaFJs90TaWz65+L42LimC5RdwQowFq7fmsHWuaQjdIRIt8fiR3RdkPyKApB1IVRDUVyfb2ggSTA63R5PurdVra3srO9DrCNpj5142RG2rMBuf7wAzVMo1DyQThbcYvV+Xj4WO1WXo9v1Tz/x2HQ0GrW97X5kF4AfY90GWakNWWlA16FC38L14g0/Re7oscQr5IjPkQw2AsRN0AnQMazuFBM0J6z1849u3zLf0tKS0314+VUHIAdq7+zqdZjzoWdQvMyxxGBvOuPRu2Lb8a4oc8QXmICQqzQweP+e5dx6Bx/Pvi1m4jsLFet88cLYd5EDh2rxjvyM1i4n5fD+xoN7Gp87fH5idPRvrY2tBPxivzohWNPkhbEhfRzF/6cVUIMsbqd+yAXjQbiOAx7fvCH0Ma4ezirAKxfszuccV3SZAoeudhXMwsFmzmeoE/d6u8PJD4KzsyQo7dk2Nmf8TWyTn2whIgh/H2zDmPHteJ16WB+n7AFIZx8kEjvzOXEGB/JJ3bmBt/GpRr5P3HVdl/ZHO+MYZukxBbCiOrA0XHGuL5WaCT9wf4Q4PwkL99pR1JroEnHrhvpQUNTGh3LNtpDXV1ssuYux/Ef6BdBrsyjnkH5l7ZhCRZwhiyPrOLO5nPhFtzetQNkCUM47OuMHUKESkJ9XutXQigWgwHbEuvbioL4N+VUc0M1K75dWPAAFdHh4eN3s1T+a8c2mGcv/LLaY+91J2XgpttiVwZ5UQVZSNmXfQsqRicqzQsJucEg8gjOwG0VxF9KpXKFNuF9tAp2r9N9YJuxVfXUGqjNQnQHG/gX8t4MFUip7VgAAAABJRU5ErkJggg==',
        'section_chats.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAANVJREFUSA1jYBgFBEKAEVm+sLI6nuE/Q////wyCyOLEshkZGd4zMDIU9re3LoTpYYIxwDQFhoP0gx0GNAPZTBZkDszlEzpbUXyGrAYfu6C8+j/MDJg6VB/ARKlIj1pAMDBHg2gEBBFKTob5t7CiLpCB4a8HjE8sDczFDIyMjH+Q1WO14P//v6uBipiRFRLLBtqxDVktVgtAhjMxMU79/5/xErJiQmxGhn/v+ThYNiKrw2oBEyNjY197SwOyQnLZGBkNbHgHdQzHcFRRRU0DhuCoAK1DAADrXDEmZRDjfQAAAABJRU5ErkJggg==',
        'section_chats@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAYBJREFUaAXtmM1KA0EMx5O6l5489uJT9OJR8In8Qi1tYcUWv6D6Ol4E8d6D7+BZbyssuzFTFWxpxpEsOyNkYGmbmWT//1+yhy2ALSNgBIxATALou/n+YLwDRFO++gTQ9Z1teo+FFYA452t4e3H+KNUXDXyJfyCijpTcRhwRazaxK5mQxTH52OIdoIUGNwXC8hnoCznth3mEpZtm0sbqzN9dTcVxk2po4nsnQ5bwuVa1fMfdp9yBn6cS/m4GYjfHOmAdUBKwEVICVKdbB9QIlQWsA0qA6nTrgBqhsoB1QAlQnW4dUCNUFvj3HRDfideBOc7zreq96q3bazpWUR1UMtjA0WC8XRblPb9gbwZVbvQQvknlgkeoqutI4oH/16IntYE45J14eM0yPJQMBI/QUgGEZwQsl2IN/yCCgsnPYaN7fTMZvUjl/2ygg3g2u5zkUsG248HPgBOWmviFplBiKYoPNpCq+CADKYv/1UDq4r3jf3A6yr0HbNMIGAEjYASYwAf+gF/Xn8l5JAAAAABJRU5ErkJggg==',
        'section_contacts.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAbZJREFUSA3tVLFLQmEQv8tP0UGQaCiwrTFqaysiCHGMIOgfaIwEMUGojyAQqdz7A4JaXAJxE6KlrQha2mpoilDB0KfXnfrgQ9/zVSAuCh937+77/X7n3b0HMPmNuwP4mwJSWkcb31YOgdblPgGWA0GVymn97oX3FBDyZt16JKBpkwwBP/0htewlMmWCnHypvEdeDIT883L4XlFiknPCmDFPAbstTLwn1coRX0jsnEnY73sK9AP++qy8ADJQHutuo9685Hl0KhdfcN3ccAZPAdkWHnKMex5n4jebrjNkztnPbtbnlrDj9+VyZW1z46rVojlEmOFTA8TbQEhte22QzTFSO/Q9SKT1ApEV522JcdWLRDQr1SDiBxA98wxKiKqYz+pXtyodBRIZvQIt64wJV92AZpwF78CnkvlT/WDGxR8QSKSPtgDaN0zOC4BffKGASCWl8AnC4e6noVqNWhYtESEPH/g+RVjEApjayWdPCqbIwBYRtC54/xT3QUeC6lxrXTMBPf+FrZxrzu9Xvq1km+gYkLFcUO+Oszk4zJAc56x71A038A9siv+I2FjTjvxTYYpN/PF04AdflKcLC0yUTwAAAABJRU5ErkJggg==',
        'section_contacts@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAA7lJREFUaAXtV0tIVFEYPv+d6yPBBxEiZe2ikCCpaFVSYqG7WtiiwE2rKKLxNeq4OAsnNXXc9NjUQiKKWtSuF8RgrYLCIKRoVwYiIamQj+7c0/+PTp25HWfOzL2J4b0g85//+X3/PfecX8b8x++A3wG/A34HNnIHwGvyrV18jxX/eRaAHRcMdlB+YOKzEOyZGci7NXiZv/eypmcEOOf5s4tWFIGeE0IYKpAAYCOxGyUFZjP6L6l8stV5QoDAzyxYjxF4rQ4AJPKitNBs8IKEslM6IGSf5c7rgac4Ikoxco5cZdcEaM/TtkkFABMBYKdZoGgr/SVkBhOyD8VQrKzLRTZzCZJj6IPFtdQImIBN5t4hzqclv7tBzp+Keesd9r+S9PSdrMQGJb+sRalw1rGJADpt5MgAiPbhVPAJM+nIJvs6Y2WbruyaQPKoTBaMG0WxpOz8ddqcsU5/nbVrAjpF/qWPawJ0SckAA/aPI/Jalp02Z6zsqyu7JkA3rFwsLuAKfrCbZR3JpCObrHfGyjZd2fUpRONB3LYu/rl9RSWdNi0d4fbknqfOx+ctBL98AhE4upVZHtzUBbqanyc3cXNn91XbFudXK6LSGwZci/b2XFDZstG53kJUjGYbGg90C5Mvxej6p/MLpDPq2mKxWLy+rvbeki1w78MBjFO+Wdo22PnrOAc1eTEHET5lIV3gKr+1HqdVGHzdWnbAky3Uynm5WLQO2YIdxLN9FybdKUCUM8FKEmSAzYKAKcHYJ5x/PhrAXkOB+WqQ8ym3ZHMm0NLJq4SwTgkmGhF0VS5AkMw4MHgAYN4f6uXjOeXINijY0Y3/67IwzsM12cam9QcYxW5Ghvt6Um72tDFo1H4DwXDPNmbN30bwRzMldWNP3CeBwqbhSPdXnTxaBFpC4RqbwUPcLn/NOFQEi1pI7I0h4KUN9liAGR8KjMKJiori72SfnJwrW7QXKuPM3m0Io9oGcRgL78fxQznK4LaaNpg4OdQfGaX4dE9GAs3h8HZhwVsEv0WR6DkY7E6+Xfyov79jRmFfVRUK9ZUuGXMnhM3OoNMxpyOS+Aam2BeNRL44bfJa2QHZAcFHneCx409Mw+wcuMzHZN9s5BXCIxgz0tbFqy3b6sU3Up/MkaiJtXHdmNSpfjMSwAkypTsIvh0/tAFVslx1K41owAOiDUn8HrlxW9ZlyplxmMMkpXISr8Gnzy3KZLtKzkhAFbSedBpbKBXupVAYX8r6ef77N+ATWD+byUfid8DvgN8BvwMbsQO/AJ2HVlQqNEM6AAAAAElFTkSuQmCC',
        'section_frequent.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAr1JREFUSA3tVE1IVFEUPue9NzqgqBunyIKiRat2EoGatGyXqyAoiCgkK5pUZswZeTn+zGBOi7IWQW1ctWhZWwVLCCpXtQwCC6ZFjiQzzfu5fec1I6/pTT7XdeF67jvnO993zrl3JPqnVnzcPCZ7N00buwGTY18FnrHPhc0TcKg1Ypoxu2R9Yiw9ahy4Y5qFMIlaGJBg3LJ9CaZZKdXklKzLYfNCdWCaprFRsj8Sqf1CzEzr7dHIQfjtnYRCdbDxwz79i5w/gPy9UtS1WbYGdiL3igkCobK2YpliOjudjssxIieliLqZtSHGjFxSD3AVb4i0acWqENFVQbNaC7lcsljPtz2ieGI8qYiHUGknQM31QMxlsyNqdIl/o2yvk1Jt9RiIVtBdgUkt3M1NZyW+LYDC+OZYOgc7Wk2EHr8GuECKkcRL+VxmUWLxRPossduPlBgY9kDseI0LInP52UwCFk37BORDVjyZHsQQ7uOoA7TYHjUuYmQVL1j3B/4mdPMIAucRcjTia/nc1EM/bLsDv3P41sQpx3WfIrEVIsvN1DKQzY5982NA3lEsWc9Q5kl0+l1jOpOfnXrux8g58BXNz0y+iGhGHxr8jJH1V3grU59YLFu3hRyv6gsqPxFE3lBAAnMz5hrG+FLOIHon9rfFvFb9fpXPZv6MV4N//V+ES+wR+ohOK7jYo8RqwctTPGToasVy8eVhqmwBJnBEghtJpQ4hex8uaatiqUGQv8W4+mTL2bLUFZm9IrV3NJU6HMDtuRoK2I7qFQTG0wJzA8SsaXxPtpzFJ49AMI4lnQavhgLk+pKYVyN6pBsXeV22nFH9ao1SsdtQoOEdoMRe1PlVIy05Pzv5pPbDEVJ5AOiiZ3hs4oJLrvxivW5rgn4b2EEikW3HnJej1HoEL+Sxn7yWLD6JCQa+JS+nFvxvdzOBn56DF6M7eieWAAAAAElFTkSuQmCC',
        'section_frequent@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAABlpJREFUaAXtWVtsFFUYPmdmlu6WmBax2yhgAGMiIleNctEHg/CASCQhiA+GgBeISsK2FLvbLgxsuy2lZUmIF1QSr6BE4wvyoA8mKoGEAF4wEh9EkEtcLraVulvncvzOlumemZ2lO+tu4sNOMpn//89//v/7L+fSLSGVp5KBSgbKloFQi/ogf8vmAIaVchonhv4y7FO8z5TLDzdelmejqgb1lHaO4pH9yoRuVU2Ww5FUDqPcppnWn8enijE2ykhpL5TLT1kqoKqq0pvSzxDCxnPglJILNX7fRMj1UgdSlgr0DupPWuA5YMbIuP60tqzU4Lm9sgRAGFnvBMsIzZE5dYrhS95CGyPqdN3QvncDIxFp5s7tMdcxN/1CZCWvgDG0dbr7pibfVkv6lLQCzc0dY9Jk4DyavtoNJZylSMA3PqGq19zGi5GVtAKDZGCNHTzl58BZCxgjJEDS+rMWX4pvyQLAFglb7EURFCXsdUbZa6KMQWdIV5QWT5csgP5BfTG2y8kWFGQ+LQV8bwfI6L2ctuTYoSZCd8kw/x+JgtYATlPasHXrGJ+u12kGDVJGg8hkHWFmkEqgTVKH9piDCtw5jIeSd3Z1tq/m/Ibmlr0AvmZ4jNDzlLJjMJuUKElii01iQ0/KJksyqiRJFUneQsg1VMrMznGncgIINUfXoY8fwRWMgwxCoQ5naR2C8Hbxk33374qrJ7jbpog6UzO0k+4Q8koNYLiCZOEOxQOjSUro14nO2BvijJwWqiLVH2PiOAB+DFmbjra43TN4So9Y4LmzHXH1O7TRYdFxAbQM//VI4jRUdwH0x2WwOSbmBNDZGf6zxq8skij90KFbMAvPu53KWNA5MqdOPh6Z31frVxZybE6dnBYSFULhaIyZZqsou0FrMPoBkeglgr6VKEosyUlmsKQSkC93bdnyBzKOxNmfkKreKg2SIDG1oIG1w9cSAuOtiiqTVdCuss8AR2l7oiMWdbPHdW8aAFcIhVtXM5PtAenjvPXA4EF5bM3K7qamAUtWzBcLtbo3re/Hulsqzod9HejWJTra9opyJz1iAHxCQ2TzAmYYnyKlNaIBTD7B5Oolu+Itl0R5oXQk0l6fMv4+CLsP2OZQ2i9L0vKe+LYvbXIXpqAA+LxQNDqV/cMO2bZKyJGp32VJWdwdV0+52M8ragyr9xpM+5yfC6ISt0cYfTyxPfajKM9H5yzifIqJWOwnX0B5CA6OizrYoSbopn64MbJ5oSi/GY2KPmpgjgv4kz6/MqdQ8NxHwRWwAG3csWO0cbV3PxbdE5YsYwg9KxE6r6czdkyUO+mG5ugsLNqjCHyUOIbEHMLu9xTWxHVRPhJdcAUsQ3zRzp09Y5kk0VctGf/ys4Iq7Iooc6OZXJV0gkce98ydPX2pV/DcvucA+KQVK1YYTFLe43T2oRe729rOZHl3KtHeegHZPmsblej73KZNViBTVADcNjW1h0Uf6MVvRZ7TBw4ckPnrlOfqmvOdOoXyRQdgmtTmFFuhLYAN4ej8Iyd+OM5fTtsAMWK7VuDIsyXDpjsC4+2CJhqjbD52kewjKxlQ4XC8LsUGuohprsLw0CbB2De4kb4boKM3dXRELuP2iWCzk0HNyxryRg058DaHNLW23q1p7JfhaZRex11lbF/aeA4LtB3gaofHbATtRf+33DNp/Funfz2HQLIHoyz5pvR0qKdt6gUwRbWQodvbB4Cv9KW0I4yZ2JnygedoWC3XAfijqIJtxzKYUVQbFRUAsmx3htMU2ZydkzBKTqGJck7oIV12l12/uIVcXADk5osOffmXJJHGWr9vFn85zWV2wA6OOavqGM/Del4Djap6G36svZzHHhJOP8KVo7FLVS+KOptU9Q4tpffgFF4pykVaCfjqvf6K7XkXMlP5Sk1/lmTppZ3xbV+JoCz6RkBP4x70pmlk1soUa8z6GumM7c8svpCv5xbCHyC2/kcJB3CevzJl8oQZ+cCLQLgO1+VzMnPFQZIvOTYlG+O9AsL+j3b5BO0SQnbP26yOwKxdu1aDShfaah/aKoG2Wp6ZwnC2eHw8rQFctvx9ab0P2+FvOKPWJzrbvvDoz1U91Ny6CDZ344Y7idaPrUk0NKRcFV2EnlqoTyP3IeJt+GfFtFKB55i4LW4TPyRsJVf7p7rgrIgqGahkoJKB/2kG/gWG+FNaES/mzgAAAABJRU5ErkJggg==',
        'section_music.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAGKADAAQAAAABAAAAGAAAAADiNXWtAAABKElEQVRIDWNgGAUEQoCRgDyGdGF59X8MQaBAf2crVrOYsCmmphg5FmD1AS5HkWMBLrOwirNgFSVCEFeYo2uluQ9GpgVDKBXlljXIsDL87vrH+N+ekYGRE5hC9gAx1hyLnnpgfJzJFGQ4C+Pvi8DwEAIaDlMfCmMQS+NMRSCXAw0BGs6wk5GFQe7Pf1ZZhv8M24g1GKYOpwX/GRkcQIoY/zCk97W2Pp7c1fCElYE1FaaRWBqnBQQMeE5AHi6NMw4Y/zMcAPoi8j8Lw8yi6urU379Z//9m+D0TopPxINwEAgycFvxmYC1jYfjtDoxkd4Y/DI+AEQ4z6j0jy/8yGIcQzYxLwamjBz6ZWjsvY2b4J/mf8b8wMCV9AcbIVmCEB4PiBJe+UXGSQwAAJNtELUIxivQAAAAASUVORK5CYII=',
        'section_music@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAMKADAAQAAAABAAAAMAAAAADbN2wMAAACc0lEQVRoBe1YzWoUQRDunpkEvAg5CCImL+DBi7kHJeIriHjLJQbFBHE3irCXJGuIBlkJIWTveQNJFN28gXr2ZA4KHsRFXPenu6xJ3NA9cWa6e6cjCdUwTFdXVX9VX1fP9Axj1IgBYoAY+J8McN/gs6XHEjGMcVafLhjbxrEHvhPwPT8l4JvhvPlpBfIYQj0Y2Dib0Ao4U1eQY1TQPMbT2D7n8yamEspjCPW0ibNIohLKYuc4dLQCBizTJs4iiUooi53j0J34FRj4LDRbenIJmJzCD9lJZHwMrx5n8Ak/g3cDwdeE3xcxc06gUqkM//jdfcZA3sHgtZUExscxkXERwhzeNR3KhTanBPaDb3VfYSRXc6LxGnyM7QTQbHWeGwSfk1sxausEDmqeTyfgv2Dd38aCvAghXMAD6E0s/b2EjRfRuoT+blg18a+9QF6uLS19UyLcKpfL222I3mMy8cb21tRAjEBww17XDIGVE8Hvq6vV6nfO4YFm60GwTgBj0BgNBGukxdXlMlWX5mM77pKALYZq/1MViui7JPBZBZYhm1BltT8EQVKn+aq2rn3rBPBsvKOBcVa9Oz9/ThtDATfxCABf0cfhtS4PLlk/hWQI9VDwewjdT/58JIMPc6VHDyHi76LOkOgFnYm25MuMw6gSIv5mD+uKXEjX6l98HxGDfYnHhZm+bHQHtr66vJB8fxi5Zhn1WcyyOaI7e2Y4PuO8PaJIG+B8t9dq3k9TDzIeujg3Gg1xY/LaVlvIEfS/glfaSkpgsCF+NW/VarW2C1aeTxpwnt+h/h/H6XjOPTxavBGCbb5YWfx4aEwdYoAYIAZOHQN/ALFYmqOKMtC0AAAAAElFTkSuQmCC',
        'section_other.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAYklEQVRIie3NoRGAMAxG4eTvGjAQi9ABcAgEAscA7SIMBGskQWHKYXoYuHzymUfknPs+LsMwTp2IZmYyAHFd5q2mX1AORDQTWWNmraqm2v44eNttEAJ6Ij6YeQcQa7tz7k9ODCtFCLeBJagAAAAASUVORK5CYII=',
        'section_other@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAA1ElEQVRoge3UPxLBQBzF8fdIETWFGYdQq1A5gJNo0kRJQ+EUTqAnMxqtQyhTMSNF4qfQrT9LIQrv0+43m3nNAiIiIiIiIiL/ie9Eo3jSQp7NQOub0QgkCMJoMR0fftF/NGAUT1pWnPcw1J0vU1Zrbfcn3+5dFd8AK7L53eUAYKgjz2Zl9y7vAMJ6zw+tX3bv8g54xYz2694/wLh5dkQgKb13+AcEYQQifXB7iiCMSu8dVV+w266Pne5gyUvRJNEgcSK4YlAbPnohvt2LiIiIiIiIyM0Vs3ec8a4LvcsAAAAASUVORK5CYII=',
        'section_photos.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAVlJREFUSA1jYBgFBEKAEVm+uKrO8+/ff7MYGP7LIIsTy2ZkZHzMxMSU3tvWtB2mhwnGANGUGA7S////f9l///7NBLFhgAXGgNAQl0/obEXxGaoa3LyC8mqgHf9lkVWg+ABZglrsUQsIhuTgDaJVq1YxE3Q+UAFZPiioqI4+fvbSbKpYAMrdRZU1fjDDSqoadBgYGGf9Z/ifWFhZHQ8Tx0Xj9UFFRYPCv7//lvz7z7AUZHBDQwPf33+/1wKzLBfIwP//GacVVzZo4TIcJI7TAqBhHD///14LdKkQ0CSev3//bPr4/fey//8Z1OAGAi369//3aqBasIVwcSQGTgs+fv8z5T8DgxFMLdAiRSDfG8aH0UALtT78+D0Vxken0coihHR/Z0sKkAfCFAGcPqDIVCTNaD5gfAKqC0ClIpIakpigOgFZA4oPmJmZ0oBJEGgJeQBW4ZCne8TqAgB4LHTWsAMiggAAAABJRU5ErkJggg==',
        'section_photos@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAqhJREFUaAXtWc1qFEEQro4RkogIEQ+ioDcxCgEDgje96dlD8OIPePTgZENmJrO7DJKIcWHjQXPJIRf1oAT0CYzgC/gQRhQ2GAV3wvyU1QsDnTG17ExvZvfQDctWV3d1fV9V9exON4BpJgImAiYCg4yA6Obc8pbOQBQ8B4E3EOF0t7n9HxPbBG4LRscWVper37j1WQISPMbtr4BwkjMuRS+gJY6MT3MkRjgQGAeNgYOX4GQAZRUwjSUgAK8zNuWrqYQ5p6PcQLbmX6wss+XGraGjf2x7mNpnsaR6+c1mQJ00zLIhMOjsmAyYDGhGwJSQZgC1zU0GtEOouYDJgGYAtc1Lz4BtPzuhjVpZoFQCc0799p7488VqNscVDFpiaQQWqtULiPEGvaBchh87r7RQK8Z9IVBxajOW519V1t0nzjcax8IQNukP/nE5gIAP5uza3X2TCna0CVi+P5kAbkIcfugcAhwAJGrtrhPoS+oQQrJGWbmo6orIWgR83x+BIHqDiOc6b01x8DFb35ZTewSId7LgKBsyK+9pjYnsWJ6+FoHfQVQn8DdThyTP4M+djbQ/79auISbNtJ/9lln5FYRa+6Ewgcpi/VaCWM+ComjPWrZXdd2np6IE39H40f/mqAqE+5br3VNVeeRCBBzHP5/EyWtydOCLPpXHk3by9zNt17O9gEEUaxXXn+plbnZObgJUs2N7GNITBSeziyl9Ioa9b1DEiQTDQvshN4HddvSSInxFAdsXkR4CU0X2A3suxKFaXVl6SGPyMxQtdwaGArUCwhBQgjEQkd0DQsB39UxSPassH6nY5nzyJYTiE2dUtp6eyVucT54A3YzQz1SLMyxNLzFILExjCcgbEXkzIkC8leXE2B+aWvrs+O5yO3Nozs3CJgImAiYCPUfgH8mf2QU09MCIAAAAAElFTkSuQmCC',
        'section_sessions.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAEBJREFUSA1jYBgFoyEw6EOAEdmFBeXV/0H8CZ2tYHEYH1kNMWyYfpBaJmI0jGw1o3Ew8PE/GgcDHwejLhgBIQAAHqQYCtIsz4gAAAAASUVORK5CYII=',
        'section_sessions@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAJJJREFUaAXt1bEOgCAMhGH0id0cnB3cfGOdmpRLHMlZ/V0gKebgw9TWeBBAAAEEEEAAAQQQcAlMT8HLul25dh57t1bree2IueZHxhyTqiMHqHpz7BuBrwh0vT0fSvu89mGt53dHzDU/MmijIeEay9+AC45cBN4iwH/AfRPl22j5A7i/APIRQAABBBBAAAEE/ixwA8VtGBYcV3+qAAAAAElFTkSuQmCC',
        'section_stories.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAZCAYAAAArK+5dAAAACXBIWXMAAAWJAAAFiQFtaJ36AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAHySURBVHgB7VXLTcNAEJ2xYz63dAAlhA5wBZAKEipgL0AESCwSChYcWCogVBCoADoAOnAJvkWKjYfZsRMlJIsdThx4kmNnMp43u/vmBeAfFcCqBNU73wWiDj+2AIO2BCl94M8YKH82N9dPvyJQPb1dFtqdBr28DeQnTPgykxozcWgiHdcmUEenLfA8LkJNTkk46x6gMZgUkd99XhHhBX/d5isBn0LT779XEhSdZ29SHOERNgJltE6WNqJ0E9YzzbmHQoLBzveVNBbeotQunzunexP1FfwAY4RYqeMz20yn3NJwNseb6+j4fL9ccgybaxrqYhwo2Uo+LxGFiwCQ9sr7pWtbwLUSOScLUZyDoOjeRt9hZWSDoj4fvpMAPw8AcakaqmCiiOcC21yj7SaADYD8swm/hcdKsjXmQrOgdAjoDUWqK0Id6ZYMYKEkBwHCR/GQdWFV+ONWWSN2EwAO5EZ0qLSuvVWSW0w1l8ifnQQmunrlm72aMErvoC5G6cQyYnM9b36Lk2yVRA1rFV11cpbAZuCcCel8NLaNdAvPysKFcktfnDM765Z0aWdjIl8RQT7usCDU1BDzPDS3NcxuStLrsen5LzAZPsnGEHLePqThTOyVRXEgc7AE1X841p88Yo/CLVtIgtRgORN3i4/luf3jD+MLARXKtKtozPkAAAAASUVORK5CYII=',
        'section_stories@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAP1SURBVHgB7VlNTttAFH6TECp29ARNT0DYsSjCnKBwAuAEuItCFJBwJEgddZHJCZKcoOkJaqqqYtdwgpody+4QJPH0jWMoM/aM7cRJW8mfhHDGM2/e37x57xkgR44cOf4mCGQEs2qVwRvuIMU1AmzQajbawvuj2hkQUgbCLgGWHWpbLmSAmQUwq7V9YGQPHw2RMqlT+9zy5xyftPg/aekAhWlTu9GFGbAEU8KsnhrAWAcYlBVTtv48EpzD5PcVFLyDwqFlWH1aQVILYFrWKtwNz5B5Uz/T6z09Eu8zMrujmFgOBFmDlVKdWtYvSIFULuT7ORt+Aq69SGrEAY8hs8yhHxsDcW0Vz0hxBwrwFo1hKLZwgZS205yPxAIEzH8BiHIZ1kYtU2rbLiSALwwULRRkL+J1KiESCRC4zQ8IM++ixndlbSeFLwgrRillgO60ncSdCpAE3OflTQj0cJP1aZnn8C12X1pHYn3pVSXYMxaxFgjCZEda1qfN813IEObRSRe5EV2KEHSlc0e3Lt4CjMiacGFl6QCyxkPJ9GkLe7NO3DKtAL72Q64z3k4b6pKAUqSJ50kaLgc8KKG3ACOHwm8C3aSRZhpMzhNpSzzs6dYoBfDDZijej+swb5ARlUaMgJdIaCzwYIiEiTNP7T8i2MMRBnmSqIBGAGKIRPCGXRQYiHsVYE01VSeAK84c92FRYCVH+O1516qpRdWLq29fnY03Wy9RkFvMFpvU/uDAgnD13bnd2Ny8Qbddxb8ebTZsyPGPQptKBGWggS7Um7VySotJCoOpN55F2rx4p5qnFABzExPftp4GimydNqZP3NIgSN1/Pg08K09lqKNQQbrERlJYnSdCcZ+9Uk1VC+CBqG3CzbkghPbinYxoaCwQivvaKz0rBHsY4qjnqOYrBYi80tnwEOYNFipkBroURp+NYvSRRkyzVqvAnBBofx9EHtq6NfEV2fEJjwblZ0OuX0pmXBMo6m4eQl/r1sVXZITI1VcZN2pB1rgbdSBUPLHY9D1ZV+L4FHN0Jvk/68PK8sGslpho/gEVQvYl+m3Mgcy49cm6EvdLFoAUVgE7bWjyWSKT+b5WmbiNzDx302UrCY0UjS1lD4cDOwrYFkzYjApuWm7RKA27ft2dsHhK2VrUCsHh+MVIodSXhfGjF7/NJ5eUoViPHevxbprKL3V73TTRZ1+MrPCZkCmzg8cEMLq3JAPDJbpN2jOVujvttz+4HNXaIOgZlSMnMuD5THfyrO0suDzSUfvCgSkw9feBQLvdiXYLaA1WCTH2CEIusUllCG95Jxtb8LOm6Rl+YuId54KBJPHDBrmR018/PefFuQfXUWckR44cOf5P/AZ2hpvgHcKhGwAAAABJRU5ErkJggg==',
        'section_web.png': 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAMRJREFUSA1jYBgFBEKAESRfXFXn+ffvv1kMDP9lCKgnSpqRkfExExNTem9b03YmkA5qGg4y7////7L//v2bCWKzgAiYyyd0toJ9BBEjnyworwba8V8WZALYB+QbRVgnzS2ABhGqS0BeBImAggzGRlWBnYctiAfGB8guQWZjdzd+0YHxASzcR+MAFDs0jwOaWwDNaIxPQOURLHLxJzziZEElKjyImJmZ0hgYQJZQB8CKa5BpBEtPQr4ilBFpHgfUCZNhbQoApShAJwPg/7IAAAAASUVORK5CYII=',
        'section_web@2x.png': 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAXlJREFUaAXtWLFOAzEMtaEDzJ0QH9FfgD+CBYYy0qHtAF/Bb8Av8BG0EzMdWpnzqS8XRTrlqiNKgnyLT3bOeX5+yUkmsscYMAaMgZwMsL/5/fz5mva7FbHcitCVH8v/zpsG7AdNLh5eFk9fwOMKUPBy+PkkoSmCRVqmbz6/nKGIM4CUw25dPHgFqwSrSo6PK4BJbuAs3jYSB8YJXkLNvy4XTl5Yk9PePc4F+/tYXQcQrM1aAbk7Zh3I3QF3C8WA+LeArsUtFfpjeYbGkT+23iQUYyh1vPoODD4DfZrs86dmHvmr74AVgFbmsoPPQHjfQ/uh/68KQf5YPpNQjKHU8eo7MPgM9Gmyz5+aeeSvvgNWAFqZy1oHcjGPfd0txExbf96S6g+LjcdZ3uD7TkLC73CWbtsh7xFkV0Az9aVmcFo6+BajYg0L0GmvTn2Z+E3lhAWlWMXUYvMm04pt9Pxz7FkZ+yfvJFQK1SfisAJOJMyWGwPGgDHwzxj4BexZV8rZgcWtAAAAAElFTkSuQmCC',
    };



    /* ================================================================
       HELPERS
       ================================================================ */
    function log(...args) {
        if (CONFIG.debug) console.log('[TG-Exporter]', ...args);
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        const d = document.createElement('div');
        d.textContent = String(str);
        return d.innerHTML;
    }
    function escapeHtmlAttr(str) {
        if (str === null || str === undefined) return '';
        return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function formatFileSize(bytes) {
        const n = Number(bytes) || 0;
        if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
        if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
        return n + ' B';
    }
    function getInitials(name) {
        if (!name) return '?';
        const parts = String(name).trim().split(/\s+/).filter(Boolean);
        const first = parts[0] ? Array.from(parts[0])[0] : '?';
        const second = parts.length >= 2 ? Array.from(parts[1])[0] : (Array.from(parts[0] || '').slice(1, 2)[0] || '');
        return (first + second).toUpperCase();
    }
    function getUserpicIndex(name) {
        if (!name) return 1;
        let h = 0;
        for (let i = 0; i < name.length; i++) { h = ((h << 5) - h) + name.charCodeAt(i); h |= 0; }
        return (Math.abs(h) % 7) + 1;
    }
    function toValidDate(value) {
        if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
        if (value === null || value === undefined || value === '') return null;
        const d = new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }
    function formatDate(d) {
        const dt = toValidDate(d);
        if (!dt) return {dd:'00',mm:'00',yyyy:'0000',hh:'00',min:'00',ss:'00'};
        return {
            dd: String(dt.getDate()).padStart(2,'0'),
            mm: String(dt.getMonth()+1).padStart(2,'0'),
            yyyy: dt.getFullYear(),
            hh: String(dt.getHours()).padStart(2,'0'),
            min: String(dt.getMinutes()).padStart(2,'0'),
            ss: String(dt.getSeconds()).padStart(2,'0')
        };
    }
    function formatDateForFilename(d) { const f=formatDate(d); return f.dd+'-'+f.mm+'-'+f.yyyy+'_'+f.hh+'-'+f.min+'-'+f.ss; }
    function formatDateForDisplay(d) { const dt=toValidDate(d); return dt?dt.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}):'Unknown date'; }
    function formatTimeForDisplay(d) { const dt=toValidDate(d); return dt?dt.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}):''; }
    function formatDateTelegram(d) {
        const dt = toValidDate(d);
        if(!dt) return '';
        const dd = String(dt.getDate()).padStart(2,'0');
        const mm = String(dt.getMonth()+1).padStart(2,'0');
        const yyyy = dt.getFullYear();
        const hh = String(dt.getHours()).padStart(2,'0');
        const min = String(dt.getMinutes()).padStart(2,'0');
        const ss = String(dt.getSeconds()).padStart(2,'0');
        const offset = -dt.getTimezoneOffset();
        const sign = offset >= 0 ? '+' : '-';
        const offH = String(Math.floor(Math.abs(offset)/60)).padStart(2,'0');
        const offM = String(Math.abs(offset)%60).padStart(2,'0');
        return dd+'.'+mm+'.'+yyyy+' '+hh+':'+min+':'+ss+' UTC'+sign+offH+':'+offM;
    }
    function parseDate(d) { return toValidDate(d); }
    function parseTimestampValue(value) {
        if (value === null || value === undefined || value === '') return null;
        const raw = String(value).trim();
        if (/^\d{10,13}$/.test(raw)) {
            const n = Number(raw);
            const dt = new Date(raw.length <= 10 ? n * 1000 : n);
            return isNaN(dt.getTime()) ? null : dt;
        }
        return toValidDate(raw);
    }
    function parseSignedId(value) {
        if (value === null || value === undefined) return null;
        const m = String(value).match(/-?\d+/);
        if (!m) return null;
        const n = Number(m[0]);
        return Number.isSafeInteger(n) ? n : null;
    }
    function parseMessageId(value) {
        if (value === null || value === undefined) return null;
        const matches = String(value).match(/-?\d+/g);
        if (!matches || matches.length === 0) return null;
        const n = Number(matches[matches.length - 1]);
        return Number.isSafeInteger(n) ? n : null;
    }
    function sanitizeFilename(name, fallback='file') {
        let out = String(name || fallback)
            .replace(/[\\/\0-\x1f\x7f]+/g, '_')
            .replace(/[<>:"|?*]/g, '_')
            .replace(/^\.+/, '_')
            .trim();
        if (!out) out = fallback;
        return out.slice(0, 180);
    }
    function getMimeType(fn) {
        if(!fn) return 'application/octet-stream';
        const e=String(fn).split('.').pop().toLowerCase();
        const m={'jpg':'image/jpeg','jpeg':'image/jpeg','png':'image/png','gif':'image/gif','webp':'image/webp','mp4':'video/mp4','webm':'video/webm','mkv':'video/x-matroska','avi':'video/x-msvideo','mov':'video/quicktime','mp3':'audio/mpeg','ogg':'audio/ogg','wav':'audio/wav','opus':'audio/opus','pdf':'application/pdf','zip':'application/zip'};
        return m[e]||'application/octet-stream';
    }
    function getExtFromMime(mime) {
        const m={'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','video/x-matroska':'mkv','audio/ogg':'ogg','audio/mpeg':'mp3','audio/wav':'wav','audio/opus':'opus','application/pdf':'pdf','application/zip':'zip'};
        return m[mime]||'bin';
    }
    function safeHref(raw) {
        if (!raw) return '#';
        try {
            const value = String(raw).trim();
            let candidate='';
            if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) candidate=value;
            else if (/^www\./i.test(value)) candidate='https://'+value;
            else return '#';
            const u = new URL(candidate);
            if (['http:','https:','tg:','mailto:','tel:'].includes(u.protocol)) return u.href;
        } catch (_) {}
        return '#';
    }
    function normalizeMediaUrl(raw) {
        if (!raw) return '';
        try {
            const value = String(raw).trim();
            if (value.startsWith('blob:') || value.startsWith('data:')) return value;
            const u = new URL(value, location.href);
            if (u.protocol !== 'https:') return '';
            if (u.username || u.password) return '';
            return u.href;
        } catch (_) { return ''; }
    }
    function extractIdWithPrefix(el, attr, prefix) {
        const n = parseSignedId(el.getAttribute(attr));
        return n === null ? '' : prefix + String(Math.abs(n));
    }

    /* ================================================================
       STATE
       ================================================================ */
    const state = {
        messages: new Map(), isExporting: false, isDownloading: false, cancelled: false,
        scrollAttempts: 0, staleCount: 0, observer: null, scrollContainer: null,
        chatName: 'Unknown Chat', chatType: 'personal_chat', chatId: null,
        exportStartTime: null, topics: [], currentTopicName: 'General', currentTopicId: null,
        mediaQueue: [], mediaDownloaded: 0, mediaTotal: 0,
        mediaCounters: { photo:0, video_file:0, voice_message:0, sticker:0, file:0, video_message:0, animation:0 },
        downloadedMedia: new Map(), _currentTopic: null, peerId: null,
        formatHtml: true, formatJson: true,
        exportPhotos: true, exportVideos: true, exportVoice: true, exportStickers: true, exportFiles: true,
        exportMode: 'current', selectedChats: [], chatList: [],
        maxPhotoSize: 10*1024*1024, maxVideoSize: 100*1024*1024, maxFileSize: 100*1024*1024,
        dialog: null, progressEl: null, progressText: '',
        currentChatIndex: 0, mediaSkipped: 0, activeControllers: new Set()
    };
    function setCancelled(v) {
        state.cancelled = v;
        if(v){
            for(const controller of state.activeControllers){try{controller.abort();}catch(_){}}
        }
    }

    /* ================================================================
       DOM INTERFACE
       ================================================================ */
    function findScrollContainer() {
        const s = ['.bubbles-viewport','[data-scope="bubbles"]','div.scrollable','div[class*="scrollable"]','div.bubbles',
            'div[class*="bubbles"]','.chat-bubbles-list','div.messages-container','#column-center .chat',
            'div.im_history_scrollable','.im_history_scrollable','div[class*="chat"][class*="scroll"]','.history'];
        for(const sel of s) {
            for(const el of document.querySelectorAll(sel)) {
                if(el && (el.scrollHeight>el.clientHeight || el.scrollTop!==undefined)) return el;
            }
        }
        for(const div of document.querySelectorAll('div')) {
            if(div.scrollHeight>div.clientHeight*1.5 &&
                (getComputedStyle(div).overflowY==='auto'||getComputedStyle(div).overflowY==='scroll') &&
                (div.querySelector('[data-mid]')||div.querySelector('[data-message-id]'))) return div;
        }
        return null;
    }
    function getMessageElements() {
        let e = document.querySelectorAll('[data-mid]'); if(e.length) return e;
        e = document.querySelectorAll('[data-message-id]'); if(e.length) return e;
        e = document.querySelectorAll('[data-scope="bubble"]'); if(e.length) return e;
        e = document.querySelectorAll('.message-list-item,.im_message_wrap,[class*="message"]');
        return e;
    }
    function getMessageId(el) { return el.getAttribute('data-mid')||el.getAttribute('data-message-id')||el.dataset.mid||''; }
    function getPeerIdNum(el) {
        const v=el.getAttribute('data-peer-id')||el.closest('[data-peer-id]')?.getAttribute('data-peer-id')||'';
        const n=parseSignedId(v);
        return n===null?'':String(Math.abs(n));
    }
    function getChatTitle() {
        const s=['[data-scope="peer-title"]','.peer-title','[class*="peer-title"]','h1','[class*="chat-name"]',
            '.chat-name','.topbar .title','[class*="topbar"] [class*="title"]'];
        for(const sel of s) { const e=document.querySelector(sel); if(e&&e.textContent.trim()) return e.textContent.trim(); }
        return 'Unknown Chat';
    }
    function getActiveChatInfo() {
        // Method 1: Get peer ID from message input (always has the current chat's peer ID, not topic)
        const input = document.querySelector('.input-message-input[data-peer-id]');
        const currentPeerId = input?.dataset?.peerId;
        if (currentPeerId) {
            const sidebarEl = document.querySelector(`[data-peer-id="${CSS.escape(currentPeerId)}"]`);
            if (sidebarEl) {
                const info = extractChatInfo(sidebarEl);
                if (info && info.name) return info;
            }
        }
        // Method 2: Header-based fallback
        const name = getChatTitle();
        if (name && name !== 'Unknown Chat') return { name, peerId: currentPeerId || '', element: null };
        // Method 3: Sidebar active chat as last resort
        const activeChat = document.querySelector(
            'a.chatlist-chat.rp.active, a.chatlist-chat.active, .chatlist-chat.rp.active, .chatlist-chat.active'
        );
        if (activeChat) {
            const info = extractChatInfo(activeChat);
            if (info && info.name) return info;
        }
        return null;
    }
    function detectChatType() {
        // Reliable peer-ID-based detection (not CSS class names which Web K may not use)
        const input = document.querySelector('.input-message-input[data-peer-id]');
        if(input){
            const peerId = input.getAttribute('data-peer-id') || '';
            const num = Number(peerId);
            if(peerId !== '' && !isNaN(num)){
                if(num < 0){
                    return String(peerId).startsWith('-100') ? 'public_channel' : 'private_group';
                }
                return 'personal_chat';
            }
        }
        // Fallback: active chat in sidebar
        const activeChat = document.querySelector('a.chatlist-chat.rp.active, a.chatlist-chat.active, .chatlist-chat.rp.active, .chatlist-chat.active');
        if(activeChat){
            const pid = activeChat.getAttribute('data-peer-id') || '';
            const num = Number(pid);
            if(pid !== '' && !isNaN(num) && num < 0){
                return String(pid).startsWith('-100') ? 'public_channel' : 'private_group';
            }
        }
        // Last-resort fallback: old CSS-based detection
        const b=document.body;
        if(b.querySelector('[class*="saved"]')||getChatTitle()==='Saved Messages') return 'saved_messages';
        if(b.querySelector('[class*="channel"]')) return 'public_channel';
        if(b.querySelector('[class*="supergroup"]')) return 'private_supergroup';
        if(b.querySelector('[class*="group"]')) return 'private_group';
        return 'personal_chat';
    }
    function verifyCurrentChatType() {
        // After clicking a chat, detect its actual type from the loaded page
        // and compare against the expected group type.
        if(!state.chatType) return true;
        const expected=state.chatType;
        // Use peer-ID-based detection (reliable, not dependent on CSS class names)
        const input = document.querySelector('.input-message-input[data-peer-id]');
        if(input){
            const pid = String(input.getAttribute('data-peer-id') || '');
            const num = Number(pid);
            if(pid !== '' && !isNaN(num)){
                if(expected === 'Channels') return num < 0 && pid.startsWith('-100');
                if(expected === 'Groups') return num < 0 && !pid.startsWith('-100');
                if(expected === 'Personal Chats' || expected === 'Bot Chats') return num >= 0;
            }
        }
        // Fallback: use detectChatType() which now prefers peer-id over CSS
        const actual=detectChatType();
        if(expected==='Channels') return actual==='public_channel'||actual==='private_supergroup';
        if(expected==='Groups') return actual==='private_group';
        if(expected==='Personal Chats') return actual==='personal_chat'||actual==='saved_messages';
        if(expected==='Bot Chats') return actual==='personal_chat';
        return true;
    }
    function getChatList() {
        // Web K primary: chatlist-chat elements inside #column-left
        let items=document.querySelectorAll('#column-left .chatlist-chat[data-peer-id],'+
            '.chatlist-container .chatlist-chat[data-peer-id]');
        if(items.length===0){
            // Web K fallback: any a[data-peer-id] in sidebar areas
            items=document.querySelectorAll('#column-left a[data-peer-id],'+
                '.chatlist-container a[data-peer-id]');
        }
        if(items.length===0){
            // Web K bare fallback: direct chatlist-chat selectors anywhere (no sidebar needed)
            items=document.querySelectorAll('.chatlist-chat[data-peer-id]');
        }
        if(items.length===0){
            // Web K: .ListItem styled as chat rows with data-peer-id
            items=document.querySelectorAll('.ListItem[data-peer-id]');
        }
        if(items.length===0){
            // Broad fallback: any [data-peer-id] in sidebar areas
            items=document.querySelectorAll('#column-left [data-peer-id],'+
                '.sidebar-left [data-peer-id],.chat-list [data-peer-id]');
        }
        if(items.length===0){
            // Web A: im_dialog elements
            const rows=document.querySelectorAll('.im_dialog_wrap .im_dialog');
            if(rows.length>0){
                return Array.from(rows).map(el=>extractChatInfo(el)).filter(Boolean);
            }
        }
        if(items.length===0){
            // Web A fallback: bread class selectors
            const rows=document.querySelectorAll('.im_dialog, .chatlist-chat, .ListItem');
            if(rows.length>0){
                return Array.from(rows).map(el=>{
                    const link=el.matches('[data-peer-id]')?el:el.querySelector('[data-peer-id]')||el;
                    return extractChatInfo(link,el);
                }).filter(Boolean);
            }
        }
        return Array.from(items).map(el=>extractChatInfo(el)).filter(Boolean);
    }
    async function loadAllChatList() {
        const seen = new Set();
        const all = [];

        async function collectChatsFromScrollable(container) {
            const chatListEl =
                container.querySelector('ul.chatlist.virtual-chatlist') ||
                container.querySelector('ul.chatlist, .virtual-chatlist') ||
                container;

            function collect() {
                const items = chatListEl.querySelectorAll(
                    '.chatlist-chat[data-peer-id]'
                );
                for (const el of items) {
                    const id = el.getAttribute('data-peer-id') || '';
                    if (id && !seen.has(id)) {
                        seen.add(id);
                        const info = extractChatInfo(el);
                        if (info) all.push(info);
                    }
                }
                if(CONFIG.debug) {
                    console.log('[TG-Exporter] scroll collect: seen='+seen.size+', all='+all.length+', items_in_dom='+items.length);
                }
            }

            collect();

            let lastCount = seen.size;
            let staleRounds = 0;
            const maxStale = 12;

            // Use MutationObserver to detect new items appearing (faster than polling)
            let resolveNewItem = null;
            const observer = new MutationObserver(() => {
                collect();
                if (seen.size > lastCount && resolveNewItem) {
                    resolveNewItem();
                }
            });
            observer.observe(chatListEl, { childList: true, subtree: true });

            while (staleRounds < maxStale) {
                const items = chatListEl.querySelectorAll('.chatlist-chat[data-peer-id]');
                if (items.length === 0) {
                    if(CONFIG.debug) console.log('[TG-Exporter] scroll: no items found, breaking');
                    break;
                }
                if(CONFIG.debug) {
                    const lastId = items[items.length-1].getAttribute('data-peer-id');
                    console.log('[TG-Exporter] scroll round: staleRounds='+staleRounds+', seen='+seen.size+', items_in_dom='+items.length+', last_item_id='+lastId);
                }

                // Scroll the container to trigger virtual list loading
                const scrollContainer = container.matches('.scrollable') ? container : container.querySelector('.scrollable');
                if (scrollContainer) {
                    scrollContainer.scrollTop = scrollContainer.scrollHeight;
                }
                items[items.length - 1].scrollIntoView({ block: 'end' });

                // Wait for new items via observer, with timeout fallback
                await new Promise(resolve => {
                    const timeout = setTimeout(() => {
                        if(resolveNewItem === null) resolve();
                        else { resolveNewItem = null; resolve(); }
                    }, 800);
                    resolveNewItem = () => { clearTimeout(timeout); resolve(); };
                    // Also poll collect() after short delay to catch non-mutation updates
                    setTimeout(() => {
                        collect();
                        if (seen.size > lastCount) { resolveNewItem(); resolveNewItem = null; }
                    }, 400);
                });

                if (seen.size > lastCount) {
                    staleRounds = 0;
                    lastCount = seen.size;
                } else {
                    staleRounds++;
                }
            }
            observer.disconnect();

            container.scrollTop = 0;
            await sleep(200);
        }

        const foldersContainer = document.querySelector('#folders-container');
        if (foldersContainer) {
            const scrollables = foldersContainer.querySelectorAll(
                'div.scrollable.scrollable-y[data-filter-id]'
            );
            for (const scrollable of scrollables) {
                if (scrollable.offsetParent === null ||
                    scrollable.closest('[style*="display: none"],[style*="display:none"]')) {
                    continue;
                }
                if (scrollable.querySelector('.chatlist-chat[data-peer-id]')) {
                    await collectChatsFromScrollable(scrollable);
                }
            }
            if (all.length > 0) return all;

            const altScrollables = foldersContainer.querySelectorAll(
                'div.scrollable-y, div.scrollable'
            );
            for (const s of altScrollables) {
                if (s.querySelector('.chatlist, .virtual-chatlist, .chatlist-chat[data-peer-id]')) {
                    await collectChatsFromScrollable(s);
                }
            }
            if (all.length > 0) return all;
        }

        const chatlistContainer = document.querySelector('#chatlist-container');
        if (chatlistContainer) {
            const scrollables = chatlistContainer.querySelectorAll(
                'div.scrollable.scrollable-y'
            );
            for (const s of scrollables) {
                if (s.querySelector('.chatlist-chat[data-peer-id]')) {
                    await collectChatsFromScrollable(s);
                }
            }
            if (all.length > 0) return all;
        }

        const columnLeft = document.querySelector('#column-left');
        if (columnLeft) {
            const chatArea = columnLeft.querySelector(
                '#chatlist-container, #folders-container, .chatlist-container'
            ) || columnLeft;
            const scrollables = chatArea.querySelectorAll('div.scrollable.scrollable-y');
            for (const s of scrollables) {
                if (s.querySelector('.chatlist-chat[data-peer-id]')) {
                    await collectChatsFromScrollable(s);
                }
            }
            if (all.length > 0) return all;
        }

        const sidebarContainers = [
            '#column-left', '.sidebar', '.chatlist-container',
            '.sidebar-left', '.chat-list'
        ];
        let sidebar = null;
        for (const s of sidebarContainers) {
            const e = document.querySelector(s);
            if (e && e.querySelector('[data-peer-id]')) { sidebar = e; break; }
        }
        if (sidebar) {
            const cs = sidebar.querySelectorAll(
                '.scrollable, .chatlist, .chatlist-container,' +
                '[class*="scroll"], .sidebar-content'
            );
            let scrollEl = sidebar;
            for (const c of cs) {
                if (c.scrollHeight > c.clientHeight) { scrollEl = c; break; }
            }
            if (scrollEl !== sidebar) {
                await collectChatsFromScrollable(scrollEl);
            }
        }

        return all.length > 0 ? all : getChatList();
    }
    function getElementTextWithEmoji(el) {
        if (!el) return '';
        let text = '';
        for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toLowerCase();
                const cls = node.className || '';
                // SKIP: decorative icons that are not part of the chat name
                if (cls.includes('tgico') ||
                    cls.includes('premium-icon') ||
                    cls.includes('emoji-status') ||
                    cls.includes('verified-icon') ||
                    cls.includes('badge-fake') ||
                    cls.includes('peer-title-direct-badge') ||
                    tag === 'svg') {
                    continue;
                }
                // EXTRACT: emoji images and custom emoji
                if (tag === 'img') {
                    text += node.getAttribute('alt') || '';
                } else if (tag === 'custom-emoji-element' || cls.includes('custom-emoji')) {
                    const emojiText = node.getAttribute('alt') || node.dataset?.alt || node.textContent || '';
                    text += emojiText || '[icon]';
                } else if (tag === 'i' && cls.includes('emoji')) {
                    text += node.getAttribute('alt') || node.dataset?.alt || node.textContent || '';
                } else {
                    text += getElementTextWithEmoji(node);
                }
            }
        }
        return text;
    }
    function extractChatInfo(el,titleParent){
        const p=titleParent||el;
        let name='';
        // Web K primary: .user-title .peer-title (nested inside the <a> element)
        let tx=p.querySelector('.user-title .peer-title');
        // Web K alt: .peer-title directly
        if(!tx||!tx.textContent.trim()) tx=p.querySelector('.peer-title');
        // Web A: .im_dialog_peer
        if(!tx||!tx.textContent.trim()) tx=p.querySelector('.im_dialog_peer');
        // Broader fallback selectors
        if(!tx||!tx.textContent.trim()){
            tx=p.querySelector('[data-scope="peer-title"],.chatlist-chat-title,.chat-title,.conversation-title,.chat-name');
        }
        if(tx&&tx.textContent.trim()){
            name=getElementTextWithEmoji(tx).trim();
        } else {
            // Fallback: scan child elements for any non-empty text.
            // Skip subtitle/preview elements that commonly appear in chat rows.
            // IMPORTANT: no digit-starting rejection — valid chats can start with digits.
            for(let child of p.children){
                if(child.matches('.dialog-subtitle,.last-message,.im_dialog_message,.peer-title')) continue;
                const txt=getElementTextWithEmoji(child).trim();
                if(txt){
                    name=txt;
                    break;
                }
            }
            if(!name){
                // Last resort: use first line of direct text content
                const raw=getElementTextWithEmoji(p).trim().split('\n')[0].trim();
                if(raw&&raw.length<=100) name=raw;
            }
        }
        const peerId=el.getAttribute('data-peer-id')||'';
        if(CONFIG.debug){
            const info = {name, peerId, tag: el.tagName, cls: el.className?.slice(0,60) || ''};
            console.log('[TG-Exporter] extractChatInfo:', JSON.stringify(info));
        }
        if(!name||name.length>100||name==='Unknown Chat'||name==='') return null;
        const href=el.getAttribute('href')||el.closest('a[href]')?.getAttribute('href')||'';
        return {name,peerId,href,element:el};
    }
    function getChatGroups(chatList) {
        if(CONFIG.debug) {
            const items = chatList || getChatList();
            console.log('[TG-Exporter] getChatGroups input count:', items.length);
            items.forEach((c,i) => {
                const pid = c.element?.getAttribute('data-peer-id') || c.peerId || '';
                console.log('[TG-Exporter]   chat['+i+']:', JSON.stringify({name:c.name, peerId:pid, tag:c.element?.tagName}));
            });
        }
        const all=chatList||getChatList();
        if(all.length===0) return {};
        const groups={};
        for(const chat of all){
            const el=chat.element;
            let type='Personal Chats';
            if(el){
                const peerId=(el.getAttribute('data-peer-id')||'').trim();
                const href=(el.getAttribute('href')||'').trim();
                const name=chat.name.toLowerCase();
                const numPeerId=Number(peerId);
                // Web K: data-peer-id is numeric. Positive = user, negative = any chat.
                // -100 prefix = channel/supergroup, other negative = basic group.
                if(peerId!=='' && !isNaN(numPeerId)){
                    if(numPeerId<0){
                        type=peerId.startsWith('-100') ? 'Channels' : 'Groups';
                        if(type==='Groups'){
                            if(href.includes('p=c')||href.includes('p=s')||href.includes('im?p=c')||href.includes('im?p=s'))type='Channels';
                        }
                    } // positive stays 'Personal Chats'
                } else {
                    // Web A: no data-peer-id, try href patterns
                    if(href.includes('p=channel')||href.includes('im?p=c')||href.includes('im?p=s')) type='Channels';
                    else if(href.includes('p=chat')||href.includes('im?p=g')) type='Groups';
                }
                // Bot detection by name (only for personal chats)
                if(type==='Personal Chats' && name.includes('bot')) type='Bot Chats';
            }
            if(!groups[type]) groups[type]=[];
            groups[type].push(chat);
        }
        if(Object.keys(groups).length===0){groups['All Chats']=all;}
        return groups;
    }
    function getSenderName(el) {
        const s=['[data-scope="peer-title"]','.peer-title','[class*="peer-title"]','.from-name',
            '[class*="from"]','.bubble-content [class*="name"]','.im_message_from_name'];
        for(const sel of s) { const e=el.querySelector(sel); if(e&&e.textContent.trim()) return e.textContent.trim(); }
        if(el.classList.contains('is-out')||el.matches('[class*="is-out"]')||el.matches('[data-peer-out]')) return 'You';
        return '';
    }
    function getTimestamp(el) {
        const direct = [el.getAttribute('data-date'), el.getAttribute('data-timestamp')];
        for (const value of direct) {
            const dt = parseTimestampValue(value);
            if (dt) return dt.toISOString();
        }
        const selectors=['[data-scope="time"]','time[datetime]','time','.time','.time-inner','[class*="time"]'];
        for(const sel of selectors) {
            const e=el.querySelector(sel);
            if(!e) continue;
            const candidates=[e.getAttribute('datetime'),e.getAttribute('data-timestamp'),e.getAttribute('data-date'),e.getAttribute('title')];
            for(const value of candidates){
                const dt=parseTimestampValue(value);
                if(dt) return dt.toISOString();
            }
        }
        return '';
    }
    function isServiceMessage(el) {
        return el.matches('[data-scope="service"],[class*="service"],[class*="action"]') ||
            el.querySelector('[data-scope="service-message"],[class*="service"],[class*="action-message"]')!==null;
    }

    /* ================================================================
       TEXT ENTITY PARSER
       ================================================================ */
    function parseTextEntities(container) {
        if(!container||!container.childNodes) return [];
        const entities = [];
        function walk(n) {
            if(n.nodeType===Node.TEXT_NODE){const t=n.textContent;if(t)entities.push({type:'plain',text:t});return;}
            if(n.nodeType!==Node.ELEMENT_NODE) return;
            const tag=n.tagName.toLowerCase(), cls=typeof n.className==='string'?n.className:(n.getAttribute('class')||'');
            if(tag==='br'){entities.push({type:'plain',text:'\n'});return;}
            if(tag==='a') {
                const h=n.getAttribute('href')||'', t=n.textContent||'';
                if(!t) return;
                if(tag==='a'&&h.startsWith('tg://user')){entities.push({type:'mention',text:t});return;}
                if(h.startsWith('tg://')&&h!==t){entities.push({type:'text_link',text:t,href:h});return;}
                entities.push(h===t?{type:'link',text:t}:{type:'text_link',text:t,href:h});
                return;
            }
            if(tag==='b'||tag==='strong'||cls.includes('bold')){entities.push({type:'bold',text:n.textContent||''});return;}
            if(tag==='i'||tag==='em'||cls.includes('italic')){entities.push({type:'italic',text:n.textContent||''});return;}
            if(tag==='u'||tag==='ins'){entities.push({type:'underline',text:n.textContent||''});return;}
            if(tag==='s'||tag==='strike'||tag==='del'){entities.push({type:'strikethrough',text:n.textContent||''});return;}
            if(tag==='code'){entities.push({type:'code',text:n.textContent||''});return;}
            if(tag==='pre'){entities.push({type:'pre',text:n.textContent||''});return;}
            if(cls.includes('spoiler')){entities.push({type:'spoiler',text:n.textContent||''});return;}
            if(cls.includes('mention')||cls.includes('mention_name')){entities.push({type:'mention',text:n.textContent||''});return;}
            if(cls.includes('hashtag')){entities.push({type:'hashtag',text:n.textContent||''});return;}
            if(cls.includes('cashtag')){entities.push({type:'cashtag',text:n.textContent||''});return;}
            if(cls.includes('bot_command')){entities.push({type:'bot_command',text:n.textContent||''});return;}
            if(tag==='img'){const a=n.getAttribute('alt')||'';if(a)entities.push({type:'plain',text:a});return;}
            Array.from(n.childNodes).forEach(walk);
        }
        walk(container);
        // Merge adjacent plain entities
        const merged=[];
        for(const e of entities){
            if(merged.length&&merged[merged.length-1].type===e.type&&e.type==='plain')
                merged[merged.length-1].text+=e.text;
            else merged.push({...e});
        }
        return merged;
    }

    /* ================================================================
       SERVICE MESSAGE DETECTOR
       ================================================================ */
    function classifyServiceAction(el) {
        const html=el.innerHTML||'';
        if(html.includes('created the group')||html.includes('created group')) return 'create_group';
        if(html.includes('joined group')||html.includes('joined the group')) return 'join_group';
        if(html.includes('left group')||html.includes('left the group')) return 'leave_group';
        if(html.includes('removed')&&(html.includes('from group')||html.includes('from the group'))) return 'remove_user';
        if(html.includes('added')&&(html.includes('to group')||html.includes('to the group'))) return 'add_user';
        if(html.includes('pinned')||html.includes('pinned message')) return 'pin_message';
        if(html.includes('unpinned')) return 'unpin_message';
        if(html.includes('changed group photo')||html.includes('changed the group photo')) return 'group_photo_updated';
        if(html.includes('removed group photo')||html.includes('removed the group photo')) return 'group_photo_removed';
        if(html.includes('changed group name')||html.includes('changed the group name')) return 'group_name_changed';
        if(html.includes('created topic')||html.includes('topic created')||html.includes('created the topic')) return 'topic_created';
        if(html.includes('general topic')) return 'topic_created';
        if(html.includes('phone call')||html.includes('video call')||html.includes('video chat')) return 'phone_call';
        if(html.includes('channel created')||html.includes('channel photo')) return 'channel_created';
        if(html.includes('screenshot')) return 'screenshot_taken';
        if(html.includes('poll')) return 'poll_stopped';
        if(html.includes('superpowers')) return 'admin_privileges';
        if(html.includes('changed group sticker')) return 'group_sticker_set_changed';
        // Date separator detection
        const txt=el.textContent||'';
        const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
        if(months.some(m=>txt.toLowerCase().includes(m))&&txt.split(/\s+/).length<=5) return 'date_separator';
        return 'generic_service';
    }
    function getActorFromService(el) {
        const from=el.querySelector('.from_name,[class*="from_name"]');
        if(from&&from.textContent.trim()) return from.textContent.trim();
        const m=(el.innerHTML||'').match(/<a[^>]*>([^<]+)<\/a>/);
        return m?m[1]:'';
    }
    function getCallDiscardReason(el) {
        const txt=el.textContent||'';
        if(txt.includes('Declined')||txt.includes('declined')) return 'declined';
        if(txt.includes('Missed')||txt.includes('missed')) return 'missed';
        if(txt.includes('Busy')||txt.includes('busy')) return 'busy';
        if(txt.includes('canceled')||txt.includes('Cancelled')) return 'canceled';
        return 'hangup';
    }
    function getCallDuration(el) {
        const m=(el.textContent||'').match(/(\d+)\s*seconds?/);
        return m?parseInt(m[1]):0;
    }

    /* ================================================================
       MEDIA EXTRACTOR
       ================================================================ */
    function isDecorativeImage(img) {
        const cls = typeof img.className === 'string' ? img.className.toLowerCase() : (img.getAttribute('class') || '').toLowerCase();
        if (/(emoji|avatar|userpic|profile|reaction|badge|status|peer-photo)/.test(cls)) return true;
        if (img.closest('.userpic,[class*="avatar"],[class*="userpic"],[class*="reaction"],[class*="emoji"],[class*="peer-photo"]')) return true;
        return false;
    }
    function extractMediaInfo(el) {
        const items=[];
        const usedUrls=new Set();
        el.querySelectorAll('img').forEach(img=>{
            if(isDecorativeImage(img)) return;
            const src=normalizeMediaUrl(img.currentSrc||img.src||img.getAttribute('data-src')||'');
            if(src&&!usedUrls.has(src)){
                usedUrls.add(src);
                const isSticker=!!img.closest('[class*="sticker"]');
                items.push({type:isSticker?'sticker':'photo',url:src,alt:img.alt||'',width:img.naturalWidth||img.width||0,height:img.naturalHeight||img.height||0});
            }
        });
        el.querySelectorAll('video').forEach(v=>{
            const source=v.currentSrc||v.src||v.querySelector('source[src]')?.src||v.getAttribute('data-src')||'';
            const src=normalizeMediaUrl(source);
            if(src&&!usedUrls.has(src)){
                usedUrls.add(src);
                const isVM=!!v.closest('[class*="video_message"],[class*="round"],[class*="video_msg"]');
                const isVoice=!!v.closest('[class*="voice"],[class*="audio"]');
                items.push({type:isVM?'video_message':isVoice?'voice_message':'video_file',url:src,duration:Number.isFinite(v.duration)?v.duration:0,width:v.videoWidth||0,height:v.videoHeight||0});
            }
        });
        el.querySelectorAll('audio').forEach(a=>{
            const source=a.currentSrc||a.src||a.querySelector('source[src]')?.src||a.getAttribute('data-src')||'';
            const src=normalizeMediaUrl(source);
            if(src&&!usedUrls.has(src)){
                usedUrls.add(src);
                items.push({type:'voice_message',url:src,duration:Number.isFinite(a.duration)?a.duration:0});
            }
        });
        el.querySelectorAll('a[download],[data-scope="document"] a,[class*="document"] a').forEach(a=>{
            const h=normalizeMediaUrl(a.href||a.getAttribute('href')||'');
            if(h&&!usedUrls.has(h)){
                usedUrls.add(h);
                items.push({type:'file',url:h,alt:(a.getAttribute('download')||a.textContent||'').trim()});
            }
        });
        return items;
    }

    function getFileExtension(url, type) {
        if(type==='sticker') return 'webp';
        if(type==='voice_message') return 'ogg';
        if(type==='video_message') return 'mp4';
        try {
            const pathname = url.startsWith('blob:') || url.startsWith('data:') ? '' : new URL(url, location.href).pathname;
            const m=pathname.match(/\.([a-zA-Z0-9]{1,10})$/);
            if(m) return m[1].toLowerCase();
        } catch (_) {}
        if(type==='video_file'||type==='animation') return 'mp4';
        return 'bin';
    }

    /* ================================================================
       MESSAGE COLLECTOR
       ================================================================ */
    function extractMessage(el) {
        const mid=getMessageId(el);
        if(!mid) return null;
        const messageId=parseMessageId(mid);
        if(messageId===null) return null;
        if(state.messages.has(messageId)) return null;

        const isService=isServiceMessage(el);
        const timestamp=getTimestamp(el);
        const dateObj=parseDate(timestamp);
        const dateISO=dateObj?dateObj.toISOString().replace('.000Z',''):'';
        const dateUnix=dateObj?String(Math.floor(dateObj.getTime()/1000)):'';

        if(isService) {
            const action=classifyServiceAction(el);
            if(action==='date_separator') return null;
            const actor=getActorFromService(el);
            const peerNum=getPeerIdNum(el);
            const fromId=peerNum?'user'+peerNum:'';
            const msg={id:messageId,type:'service',date:dateISO,date_unixtime:dateUnix,actor:actor||'Unknown',actor_id:fromId,action:action,text:'',text_entities:[]};
            if(action==='phone_call'){
                msg.discard_reason=getCallDiscardReason(el);
                const dur=getCallDuration(el);
                if(dur) msg.duration_seconds=dur;
            }
            if(action==='topic_created'){
                const t=el.querySelector('.topic-name,[class*="topic"]');
                if(t) msg.title=t.textContent.trim();
            }
            return msg;
        }

        const sender=getSenderName(el)||'Unknown';
        const peerNum=getPeerIdNum(el);
        const fromId=peerNum?'user'+peerNum:'';

        // Check for forwarded
        let forwardedFrom='',forwardedFromId='';
        const fwdEl=el.querySelector('.forwarded,.forwarded.body,[class*="forwarded"]');
        if(fwdEl){
            const fn=fwdEl.querySelector('.from_name');
            if(fn) forwardedFrom=fn.textContent.trim();
            const fwdPeer=fwdEl.querySelector('[data-peer-id]');
            if(fwdPeer){const n=parseSignedId(fwdPeer.getAttribute('data-peer-id'));if(n!==null)forwardedFromId='user'+Math.abs(n);}
        }

        // Check for reply
        let replyToId=null;
        const replyEl=el.querySelector('[data-scope="reply"],[class*="reply"]');
        if(replyEl){
            const rid=replyEl.getAttribute('data-mid')||replyEl.getAttribute('data-message-id')||replyEl.getAttribute('data-reply-id');
            if(rid) replyToId=parseMessageId(rid);
        }

        // Check for edit - parse actual edit timestamp from DOM
        let edited=null,editedUnix=null;
        const editEl=el.querySelector('[class*="edited"]');
        if(editEl){
            const editTimeEl=editEl.querySelector('time[datetime]') || editEl.querySelector('[datetime]');
            if(editTimeEl){
                const dt=editTimeEl.getAttribute('datetime');
                if(dt){const d=new Date(dt);if(!isNaN(d.getTime())){edited=d.toISOString().replace('.000Z','');editedUnix=String(Math.floor(d.getTime()/1000));}}
            }
            // Do not fabricate an edit timestamp when Telegram Web does not expose it.
        }

        // Text extraction
        const textEl=el.querySelector('[data-scope="text"],.message-text,.bubble-content .message,[class*="text-entity"]');
        let text='', textEntities=[];
        if(textEl){
            textEntities=parseTextEntities(textEl);
            if(textEntities.length===1&&textEntities[0].type==='plain') text=textEntities[0].text;
            else if(textEntities.length>0) text=textEntities.map(e=>e.text).join('');
        }
        if(!text&&textEntities.length===0) { text=''; }

        // Build text field per tdesktop SerializeText() rule:
        // - Single plain entity -> plain string
        // - Mixed/link-only/etc -> array of entity objects
        let textField;
        if(textEntities.length===1 && textEntities[0].type==='plain') {
            textField = textEntities[0].text;
        } else if(textEntities.length > 0) {
            textField = textEntities.map(e => Object.assign({}, e));
        } else {
            textField = '';
        }

        // Media extraction
        const mediaItems=extractMediaInfo(el);
        const msg={id:messageId,type:'message',date:dateISO,date_unixtime:dateUnix,from:sender,from_id:fromId,text:textField,text_entities:textEntities};
        if(forwardedFrom) msg.forwarded_from=forwardedFrom;
        if(forwardedFromId) msg.forwarded_from_id=forwardedFromId;
        if(replyToId) msg.reply_to_message_id=replyToId;
        if(edited) { msg.edited=edited; msg.edited_unixtime=editedUnix; }
        if(state._currentTopic) msg.topic=state._currentTopic;

        // Process one primary media item. Preview images become thumbnails for files/videos.
        if(mediaItems.length>0){
            const priority=['video_message','voice_message','video_file','animation','sticker','file','photo'];
            const primary=priority.map(t=>mediaItems.find(mi=>mi.type===t)).find(Boolean)||mediaItems[0];
            const preview=primary.type!=='photo'?mediaItems.find(mi=>mi.type==='photo'&&mi.url!==primary.url):null;
            if(primary.type==='photo'){
                msg.photo=primary.url;
                msg.photo_file_size=0;
            } else {
                const ext=getFileExtension(primary.url,primary.type);
                let candidate=sanitizeFilename(primary.alt||'file');
                if(!/\.[a-zA-Z0-9]{1,10}$/.test(candidate)) candidate += '.'+ext;
                msg.file=primary.url;
                msg.file_name=candidate;
                msg.file_size=0;
                msg.media_type=primary.type;
                msg.mime_type=getMimeType(msg.file_name);
                if(preview) msg._thumbnail_source=preview.url;
            }
            if(primary.duration) msg.duration_seconds=Math.round(primary.duration);
            if(primary.width) msg.width=primary.width;
            if(primary.height) msg.height=primary.height;
        }

        // Reactions
        const reactEl=el.querySelector('.reactions,[data-scope="reactions"]');
        if(reactEl){
            const reactions=[];
            reactEl.querySelectorAll('.reaction,[data-reaction]').forEach(r=>{
                const emoji=r.getAttribute('data-reaction')||r.querySelector('.emoji')?.textContent||'';
                const cnt=r.querySelector('.count')?.textContent;
                const count=cnt?parseInt(cnt):1;
                const recent=[];
                r.querySelectorAll('.userpic').forEach(up=>{
                    const name=up.getAttribute('title')||up.querySelector('.initials')?.textContent||'';
                    if(name) recent.push({from:name,from_id:'',date:dateISO});
                });
                if(emoji) reactions.push({type:'emoji',count,emoji,recent});
            });
            if(reactions.length) msg.reactions=reactions;
        }

        return msg;
    }

    function collectVisibleMessages() {
        const els=getMessageElements();
        let n=0;
        Array.from(els).forEach(el=>{
            try {
                const m=extractMessage(el);
                if(m){state.messages.set(m.id,m);n++;}
            } catch(e) {
                log('extractMessage error for element:', el, e);
            }
        });
        if(n>0) log('Collected '+n+' new messages (total: '+state.messages.size+')');
        return n;
    }

    /* ================================================================
       SCROLL ENGINE
       ================================================================ */
    async function scrollUp() {
        const c=state.scrollContainer; if(!c) return false;
        const prev=c.scrollTop;
        c.scrollTop-=CONFIG.scrollStep;
        await sleep(50);
        return Math.abs(c.scrollTop-prev)>1;
    }

    function setupMutationObserver() {
        if(state.observer) state.observer.disconnect();
        const target=state.scrollContainer||document.querySelector('[data-scope="bubbles"]')||document.body;
        state.observer=new MutationObserver(muts=>{
            let hasNew=false;
            for(const m of muts){
                if(m.type==='childList'&&m.addedNodes.length>0){
                    for(const n of m.addedNodes){
                        if(n.nodeType===Node.ELEMENT_NODE){
                            if(n.matches&&n.matches('[data-mid]')){hasNew=true;break;}
                            if(n.querySelector&&n.querySelector('[data-mid]')){hasNew=true;break;}
                        }
                    }
                }
                if(hasNew) break;
            }
            if(hasNew&&state.isExporting) collectVisibleMessages();
        });
        state.observer.observe(target,{childList:true,subtree:true,attributes:false});
    }

    async function scrollAllMessages() {
        setupMutationObserver();
        collectVisibleMessages();
        state.staleCount=0; state.scrollAttempts=0;
        updateProgress('Scrolling... ('+state.messages.size+' messages)');
        while(!state.cancelled){
            state.scrollAttempts++;
            if(state.staleCount>=CONFIG.staleThreshold) break;
            const before=state.messages.size;
            const didScroll=await scrollUp();
            if(!didScroll) break;
            await sleep(CONFIG.scrollWaitMs);
            collectVisibleMessages();
            if(state.messages.size===before) state.staleCount++; else state.staleCount=0;
            updateProgress('Scrolling... ('+state.messages.size+' messages)');
            await sleep(50);
        }
        if(state.observer){state.observer.disconnect();state.observer=null;}
        collectVisibleMessages();
    }

    /* ================================================================
       TOPICS
       ================================================================ */
    function detectTopics() {
        const topicBars=document.querySelectorAll('[data-scope="topics-bar"],.topics-bar,[class*="topics-bar"],.TopicList');
        if(topicBars.length){
            for(const bar of topicBars){
                const items=bar.querySelectorAll('button,a,[role="button"],[data-topic-id]');
                if(items.length>1) return Array.from(items).map(el=>({id:el.getAttribute('data-topic-id')||'',name:(el.textContent||'').trim()||'Topic',element:el})).filter(t=>t.name);
            }
        }
        // Fallback: topic selectors
        for(const sel of ['[data-topic-id]','.topic-item','[class*="topic-item"]','.topic-button']){
            const els=document.querySelectorAll(sel);
            if(els.length>1){
                return Array.from(els).map(el=>({id:el.getAttribute('data-topic-id')||'',name:(el.textContent||'').trim()||'Topic',element:el})).filter(t=>t.name);
            }
        }
        return [];
    }
    async function switchToTopic(topic) {
        try{topic.element.click();await sleep(400);return true;}catch(e){return false;}
    }
    async function detectAndExportTopics() {
        state.topics=detectTopics();
        if(state.topics.length<=1){state.currentTopicName='General';await scrollAllMessages();return;}
        // Collect all topics into a single export using topic field
        const allTopicMessages=[];
        for(let i=0;i<state.topics.length;i++){
            if(state.cancelled) break;
            const t=state.topics[i];
            state.currentTopicName=t.name||'Topic '+(i+1);
            state._currentTopic=state.currentTopicName;
            const safeTopic=state.currentTopicName;
            if(i>0){
                updateProgress('Switching topic: '+safeTopic+'...');
                const ok=await switchToTopic(t);
                if(!ok){log('Failed to switch topic: '+t.name);continue;}
            } else {
                updateProgress('Topic: '+safeTopic+'...');
            }
            state.messages.clear(); state.staleCount=0;
            await scrollAllMessages();
            for(const [id,msg] of state.messages){
                allTopicMessages.push(msg);
            }
        }
        state.messages.clear();
        for(const msg of allTopicMessages){
            state.messages.set(msg.id, msg);
        }
    }

    /* ================================================================
       EXPORT DIALOG
       ================================================================ */
    async function showExportDialog() {
        if(state.dialog) return;
        let fullChatList = null;
        let chatListLoading = false;
        state.fullChatList = fullChatList; // shared for startExport access

        const D=document.createElement('div');
        D.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.75);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;backdrop-filter:blur(3px);';

        function visCbx(chk){
            return '<span class="tgx-cbx" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:2px solid '+(chk?'#2AABEE':'#555')+';border-radius:4px;background:'+(chk?'#2AABEE':'#fff')+';margin-right:10px;flex-shrink:0;font-size:14px;font-weight:bold;color:#fff;transition:all .12s;">'+(chk?'✓':'')+'</span>';
        }
        function visRd(chk){
            return '<span class="tgx-rd" style="display:inline-flex;width:20px;height:20px;border:'+(chk?'5':'2')+'px solid '+(chk?'#2AABEE':'#555')+';border-radius:50%;margin-right:10px;flex-shrink:0;transition:all .12s;box-sizing:border-box;"></span>';
        }
        function fmtSize(mb){return mb>=1024?((mb/1024).toFixed(mb%1024===0?0:1))+' GB':mb+' MB';}
        D.innerHTML=`
            <style>
            .tgx-slider{-webkit-appearance:none;appearance:none;width:90px;height:6px;background:#d0d4d9;border-radius:3px;outline:none;cursor:pointer;vertical-align:middle;}
            .tgx-slider::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:#2AABEE;cursor:pointer;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.3);}
            .tgx-slider::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:#2AABEE;cursor:pointer;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.3);}
            .tgx-sel{padding:4px 8px;border:2px solid #2AABEE;border-radius:6px;background:#fff;color:#000;font-size:14px;font-weight:500;cursor:pointer;}
            </style>
            <div style="background:#ffffff;border-radius:14px;padding:28px;width:440px;max-width:94vw;max-height:92vh;overflow-y:auto;box-shadow:0 16px 64px rgba(0,0,0,0.5);border:2px solid #2AABEE;">
                <div style="display:flex;align-items:center;margin-bottom:22px;">
                    <div style="width:36px;height:36px;background:#2AABEE;border-radius:8px;display:flex;align-items:center;justify-content:center;margin-right:12px;flex-shrink:0;"><span style="color:#fff;font-size:18px;font-weight:bold;">↯</span></div>
                    <h2 style="margin:0;font-size:22px;color:#000;font-weight:700;">Export Telegram Data</h2>
                </div>
                <div style="margin-bottom:18px;">
                    <div style="font-size:14px;font-weight:700;color:#000;margin-bottom:8px;border-left:3px solid #2AABEE;padding-left:8px;">Format</div>
                    <label style="display:flex;align-items:center;padding:8px 12px;margin-bottom:4px;cursor:pointer;font-size:15px;color:#111;background:#f0f2f5;border:1px solid #d0d4d9;border-radius:8px;user-select:none;">
                        <input type="checkbox" id="tgx-html" checked style="display:none;">`+visCbx(true)+`<span style="font-weight:600;">HTML</span>
                    </label>
                    <label style="display:flex;align-items:center;padding:8px 12px;cursor:pointer;font-size:15px;color:#111;background:#f0f2f5;border:1px solid #d0d4d9;border-radius:8px;user-select:none;">
                        <input type="checkbox" id="tgx-json" checked style="display:none;">`+visCbx(true)+`<span style="font-weight:600;">JSON</span>
                    </label>
                </div>
                <div style="margin-bottom:18px;">
                    <div style="font-size:14px;font-weight:700;color:#000;margin-bottom:8px;border-left:3px solid #2AABEE;padding-left:8px;">Media types</div>
                    <label style="display:flex;align-items:center;padding:8px 12px;margin-bottom:4px;cursor:pointer;font-size:15px;color:#111;background:#f0f2f5;border:1px solid #d0d4d9;border-radius:8px;user-select:none;">
                        <input type="checkbox" id="tgx-photos" checked style="display:none;">`+visCbx(true)+`<span style="font-weight:600;">Photos</span>
                        <span style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:13px;color:#333;">
                            <span style="font-weight:500;">up to</span>
                            <input type="range" id="tgx-photo-size" min="1" max="10000" value="10" class="tgx-slider" onclick="event.stopPropagation();">
                            <span id="tgx-photo-val" style="min-width:42px;font-weight:700;color:#2AABEE;text-align:center;">10</span>
                            <span id="tgx-photo-unit" style="font-weight:500;">MB</span>
                        </span>
                    </label>
                    <label style="display:flex;align-items:center;padding:8px 12px;margin-bottom:4px;cursor:pointer;font-size:15px;color:#111;background:#f0f2f5;border:1px solid #d0d4d9;border-radius:8px;user-select:none;">
                        <input type="checkbox" id="tgx-videos" checked style="display:none;">`+visCbx(true)+`<span style="font-weight:600;">Videos</span>
                        <span style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:13px;color:#333;">
                            <span style="font-weight:500;">up to</span>
                            <input type="range" id="tgx-video-size" min="1" max="20000" value="100" class="tgx-slider" onclick="event.stopPropagation();">
                            <span id="tgx-video-val" style="min-width:42px;font-weight:700;color:#2AABEE;text-align:center;">100</span>
                            <span id="tgx-video-unit" style="font-weight:500;">MB</span>
                        </span>
                    </label>
                    <label style="display:flex;align-items:center;padding:8px 12px;margin-bottom:4px;cursor:pointer;font-size:15px;color:#111;background:#f0f2f5;border:1px solid #d0d4d9;border-radius:8px;user-select:none;">
                        <input type="checkbox" id="tgx-voice" checked style="display:none;">`+visCbx(true)+`<span style="font-weight:600;">Voice messages</span>
                    </label>
                    <label style="display:flex;align-items:center;padding:8px 12px;margin-bottom:4px;cursor:pointer;font-size:15px;color:#111;background:#f0f2f5;border:1px solid #d0d4d9;border-radius:8px;user-select:none;">
                        <input type="checkbox" id="tgx-stickers" checked style="display:none;">`+visCbx(true)+`<span style="font-weight:600;">Stickers / GIFs</span>
                    </label>
                    <label style="display:flex;align-items:center;padding:8px 12px;cursor:pointer;font-size:15px;color:#111;background:#f0f2f5;border:1px solid #d0d4d9;border-radius:8px;user-select:none;">
                        <input type="checkbox" id="tgx-files" checked style="display:none;">`+visCbx(true)+`<span style="font-weight:600;">Files</span>
                        <span style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:13px;color:#333;">
                            <span style="font-weight:500;">up to</span>
                            <input type="range" id="tgx-file-size" min="1" max="20000" value="100" class="tgx-slider" onclick="event.stopPropagation();">
                            <span id="tgx-file-val" style="min-width:42px;font-weight:700;color:#2AABEE;text-align:center;">100</span>
                            <span id="tgx-file-unit" style="font-weight:500;">MB</span>
                        </span>
                    </label>
                </div>
                <div style="margin-bottom:22px;">
                    <div style="font-size:14px;font-weight:700;color:#000;margin-bottom:8px;border-left:3px solid #2AABEE;padding-left:8px;">Chats</div>
                    <label style="display:flex;align-items:center;padding:8px 12px;margin-bottom:4px;cursor:pointer;font-size:15px;color:#111;background:#f0f2f5;border:1px solid #d0d4d9;border-radius:8px;user-select:none;">
                        <input type="radio" name="tgx-chats" value="current" checked style="display:none;">`+visRd(true)+`<span id="tgx-current-name" style="font-weight:600;">Current chat</span>
                    </label>
                    <label style="display:flex;align-items:center;padding:8px 12px;margin-bottom:4px;cursor:pointer;font-size:15px;color:#111;background:#f0f2f5;border:1px solid #d0d4d9;border-radius:8px;user-select:none;">
                        <input type="radio" name="tgx-chats" value="all" style="display:none;">`+visRd(false)+`<span style="font-weight:600;">All chats of type</span>
                    </label>
                    <div id="tgx-chat-type-panel" style="display:none;margin-top:6px;margin-bottom:8px;border:2px solid #2AABEE;border-radius:8px;padding:10px;background:#ffffff;">
                        <select id="tgx-chat-type" class="tgx-sel" style="width:100%;box-sizing:border-box;" onclick="event.stopPropagation();"><option>Loading...</option></select>
                    </div>
                    <label style="display:flex;align-items:center;padding:8px 12px;cursor:pointer;font-size:15px;color:#111;background:#f0f2f5;border:1px solid #d0d4d9;border-radius:8px;user-select:none;">
                        <input type="radio" name="tgx-chats" value="selectable" style="display:none;">`+visRd(false)+`<span style="font-weight:600;">Selectable chats</span>
                    </label>
                    <div id="tgx-chat-list" style="display:none;margin-top:10px;border:2px solid #2AABEE;border-radius:8px;max-height:240px;overflow-y:auto;padding:8px;background:#ffffff;"></div>
                </div>
                <div style="display:flex;gap:10px;justify-content:flex-end;border-top:2px solid #d0d4d9;padding-top:18px;">
                    <button id="tgx-cancel" style="padding:10px 24px;border:2px solid #999;border-radius:8px;background:#e8eaed;color:#111;cursor:pointer;font-size:15px;font-weight:600;">Cancel</button>
                    <button id="tgx-export" style="padding:10px 24px;border:none;border-radius:8px;background:#2AABEE;color:#fff;cursor:pointer;font-size:15px;font-weight:700;">Export</button>
                </div>
                <div id="tgx-progress" style="display:none;margin-top:16px;padding:14px;background:#e8f4fd;border:1px solid #b3daf5;border-radius:8px;font-size:14px;color:#111;text-align:center;font-weight:500;"></div>
            </div>`;
        document.body.appendChild(D);
        state.dialog=D;

        // Show current chat name on the label
        const activeInfo = getActiveChatInfo();
        const currLabel = D.querySelector('#tgx-current-name');
        if (currLabel) {
            currLabel.textContent = activeInfo && activeInfo.name
                ? 'Current chat: ' + activeInfo.name
                : 'Current chat';
        }

        function upCb(cb){
            const s=cb.parentElement.querySelector('.tgx-cbx');
            if(!s) return;
            s.style.background=cb.checked?'#2AABEE':'#fff';
            s.style.borderColor=cb.checked?'#2AABEE':'#555';
            s.textContent=cb.checked?'✓':'';
            s.style.color='#fff';
        }
        function upRd(rd){
            const s=rd.parentElement.querySelector('.tgx-rd');
            if(!s) return;
            s.style.borderColor=rd.checked?'#2AABEE':'#555';
            s.style.borderWidth=rd.checked?'5px':'2px';
        }

        D.querySelectorAll('input[type="checkbox"]').forEach(cb=>{
            cb.addEventListener('change',function(){upCb(this);});
        });
        D.querySelectorAll('input[name="tgx-chats"]').forEach(rd=>{
            rd.addEventListener('change',function(){
                D.querySelectorAll('input[name="tgx-chats"]').forEach(r=>{upRd(r);});
                handleChatMode(this.value);
            });
        });

        const chatListDiv=D.querySelector('#tgx-chat-list');
        let selChats=[];

        async function handleChatMode(val){
            chatListDiv.style.display=val==='selectable'?'block':'none';
            const tp=D.querySelector('#tgx-chat-type-panel');
            if(val==='all'){
                tp.style.display='block';
                if(!fullChatList && !chatListLoading) {
                    chatListLoading = true;
                    // Show loading state in the select
                    const sel = tp.querySelector('#tgx-chat-type');
                    if(sel) sel.innerHTML = '<option>Loading chats...</option>';
                    fullChatList = await loadAllChatList();
                    state.fullChatList = fullChatList;
                    chatListLoading = false;
                    // Populate categories
                    const groups = getChatGroups(fullChatList && fullChatList.length > 0 ? fullChatList : undefined);
                    const gkeys = Object.keys(groups);
                    if(sel) {
                        if(gkeys.length === 0) {
                            sel.innerHTML = '<option>No chats found</option>';
                        } else {
                            sel.innerHTML = gkeys.map(k => '<option value="'+k.replace(/"/g,'&quot;')+'">'+k+'</option>').join('');
                        }
                    }
                }
            } else {
                if(tp) tp.style.display='none';
            }
            if(val==='selectable' && chatListDiv.children.length===0) {
                await buildChatList();
            }
        }

        async function buildChatList(){
            if(!fullChatList && !chatListLoading) {
                chatListLoading = true;
                chatListDiv.innerHTML = '<div style="padding:12px;text-align:center;color:#999;font-size:14px;">Loading chats...</div>';
                fullChatList = await loadAllChatList();
                state.fullChatList = fullChatList;
                chatListLoading = false;
            }
            const all = fullChatList && fullChatList.length > 0 ? fullChatList : getChatList();
            if(all.length===0){
                chatListDiv.innerHTML='<div style="padding:12px;text-align:center;color:#999;font-size:14px;">No chats found. Open sidebar first.</div>';
                return;
            }
            selChats=all;
            const sa=document.createElement('label');
            sa.style.cssText='display:flex;align-items:center;padding:8px 10px;font-size:14px;cursor:pointer;background:#f0f2f5;border:1px solid #d0d4d9;border-radius:8px;margin-bottom:6px;';
            const saChk=document.createElement('input');
            saChk.type='checkbox'; saChk.id='tgx-select-all'; saChk.checked=true; saChk.style.display='none';
            sa.appendChild(saChk);
            const saSpan=document.createElement('span');
            saSpan.className='tgx-cbx';
            saSpan.style.cssText='display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:2px solid #2AABEE;border-radius:4px;background:#2AABEE;margin-right:10px;flex-shrink:0;font-size:14px;font-weight:bold;color:#fff;';
            saSpan.textContent='✓';
            sa.appendChild(saSpan);
            const saB=document.createElement('b');
            saB.style.color='#000'; saB.textContent='Select All';
            sa.appendChild(saB);
            chatListDiv.appendChild(sa);
            sa.addEventListener('click',function(e){
                if(e.target.tagName==='SELECT'||e.target.type==='range') return;
                const inp=this.querySelector('input[type="checkbox"]');
                if(!inp) return;
                inp.checked=!inp.checked;
                upCb(inp);
                chatListDiv.querySelectorAll('.tgx-chat-check').forEach(c=>{
                    c.checked=inp.checked;
                    upCb(c);
                });
            });
            all.forEach((c,i)=>{
                const row=document.createElement('label');
                row.style.cssText='display:flex;align-items:center;padding:8px 10px;font-size:14px;cursor:pointer;background:#fff;border:1px solid #d0d4d9;border-radius:8px;margin-bottom:4px;';
                const inp=document.createElement('input');
                inp.type='checkbox'; inp.className='tgx-chat-check'; inp.dataset.idx=i; inp.checked=true; inp.style.display='none';
                row.appendChild(inp);
                const sp=document.createElement('span');
                sp.className='tgx-cbx';
                sp.style.cssText='display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:2px solid #2AABEE;border-radius:4px;background:#2AABEE;margin-right:10px;flex-shrink:0;font-size:14px;font-weight:bold;color:#fff;';
                sp.textContent='✓';
                row.appendChild(sp);
                const tx=document.createElement('span');
                tx.style.cssText='color:#111;font-weight:500;';
                tx.textContent=c.name;
                row.appendChild(tx);
                chatListDiv.appendChild(row);
                inp.addEventListener('change',function(){upCb(this);});
            });
        }

        ['photo','video','file'].forEach(k=>{
            const sl=D.querySelector('#tgx-'+k+'-size');
            const val=D.querySelector('#tgx-'+k+'-val');
            const unit=D.querySelector('#tgx-'+k+'-unit');
            function upd(){
                const mb=parseInt(sl.value);
                val.textContent=fmtSize(mb).replace(' GB','').replace(' MB','');
                if(unit) unit.textContent=mb>=1024?'GB':'MB';
            }
            if(sl&&val){sl.addEventListener('input',upd);upd();}
        });

        D.querySelector('#tgx-cancel').onclick=()=>{if(!state.isExporting)closeDialog();else{setCancelled(true);updateProgress('Cancelling…');}};
        D.querySelector('#tgx-export').onclick=async()=>{
            state.formatHtml=D.querySelector('#tgx-html').checked;
            state.formatJson=D.querySelector('#tgx-json').checked;
            if(!state.formatHtml&&!state.formatJson){alert('Select HTML and/or JSON.');return;}
            state.exportPhotos=D.querySelector('#tgx-photos').checked;
            state.exportVideos=D.querySelector('#tgx-videos').checked;
            state.exportVoice=D.querySelector('#tgx-voice').checked;
            state.exportStickers=D.querySelector('#tgx-stickers').checked;
            state.exportFiles=D.querySelector('#tgx-files').checked;
            state.maxPhotoSize=parseInt(D.querySelector('#tgx-photo-size').value)*1024*1024;
            state.maxVideoSize=parseInt(D.querySelector('#tgx-video-size').value)*1024*1024;
            state.maxFileSize=parseInt(D.querySelector('#tgx-file-size').value)*1024*1024;
            const mode=D.querySelector('input[name="tgx-chats"]:checked');
            state.exportMode=mode?mode.value:'current';
            state.selectedChats=[];
            state.chatType=null;
            if(state.exportMode==='selectable'){
                chatListDiv.querySelectorAll('.tgx-chat-check').forEach(cb=>{
                    if(cb.checked){
                        const idx=parseInt(cb.dataset.idx);
                        if(!isNaN(idx)&&selChats[idx]) state.selectedChats.push(selChats[idx]);
                    }
                });
                if(state.selectedChats.length===0){alert('Select at least one chat.');return;}
            } else if(state.exportMode==='all'){
                const sel=D.querySelector('#tgx-chat-type');
                if(sel) state.chatType=sel.value;
            }
            const exportAction=D.querySelector('#tgx-export');
            if(exportAction){exportAction.disabled=true;exportAction.textContent='Exporting…';exportAction.style.opacity='0.65';}
            const cancelAction=D.querySelector('#tgx-cancel');
            if(cancelAction) cancelAction.textContent='Cancel export';
            await startExport();
        };
    }
    function closeDialog() {
        if(state.dialog){state.dialog.remove();state.dialog=null;}
    }
    function updateProgress(text, pct) {
        state.progressText=String(text||'');
        if(!state.dialog) return;
        const p=state.dialog.querySelector('#tgx-progress');
        if(!p) return;
        p.style.display='block';
        p.replaceChildren();
        p.appendChild(document.createTextNode(state.progressText));
        if(pct!==undefined){
            const clamped=Math.max(0,Math.min(100,Number(pct)||0));
            const track=document.createElement('div');
            track.style.cssText='height:4px;background:#e0e0e0;border-radius:2px;margin-top:8px;';
            const bar=document.createElement('div');
            bar.style.cssText='height:4px;background:#2AABEE;border-radius:2px;width:'+clamped+'%;';
            track.appendChild(bar);
            p.appendChild(document.createElement('br'));
            p.appendChild(track);
        }
    }
    function showComplete(message) {
        if(state.dialog){
            const p=state.dialog.querySelector('#tgx-progress');
            if(p){p.style.display='block';p.textContent='✓ '+String(message||'');}
            setTimeout(()=>{if(state.dialog&&!state.isExporting)closeDialog();},5000);
        }
    }
    function showError(message) {
        if(state.dialog){
            const p=state.dialog.querySelector('#tgx-progress');
            if(p){p.style.display='block';p.textContent='✗ '+String(message||'');}
        }
    }

    /* ================================================================
       ZIP EXPORT BUILDER
       ================================================================ */
    function mediaLimitForType(mediaType) {
        if(mediaType==='photo') return state.maxPhotoSize;
        if(mediaType==='video_file'||mediaType==='video_message'||mediaType==='animation') return state.maxVideoSize;
        return state.maxFileSize;
    }
    function makeMediaFilename(prefix, counter, msg, ext) {
        const f=formatDate(msg.date);
        return sanitizeFilename(prefix+'_'+counter+'@'+f.dd+'-'+f.mm+'-'+f.yyyy+'_'+f.hh+'-'+f.min+'-'+f.ss+'.'+ext);
    }
    async function buildExportZip(messages, chatInfo, isMultiChat, chatIndex, existingZip) {
        if(typeof JSZip==='undefined') {
            await new Promise(r=>setTimeout(r,2000));
            if(typeof JSZip==='undefined') throw new Error('JSZip not loaded');
        }
        if(!state.formatHtml&&!state.formatJson) throw new Error('No output format selected');
        const zip=existingZip||new JSZip();
        const prefix=isMultiChat?'chats/chat_'+String(chatIndex).padStart(2,'0')+'/':'';

        let photoCount=0, videoCount=0, voiceCount=0, stickerCount=0, fileCount=0, videoMsgCount=0;
        const mediaTasks=[];

        function queueMedia(task){ mediaTasks.push(task); }
        function clearRemoteMedia(msg){
            if(msg.photo && /^(https?:|blob:|data:)/i.test(msg.photo)) delete msg.photo;
            if(msg.file && /^(https?:|blob:|data:)/i.test(msg.file)) delete msg.file;
            if(msg.thumbnail && /^(https?:|blob:|data:)/i.test(msg.thumbnail)) delete msg.thumbnail;
        }

        for(const msg of messages){
            let mediaType='';
            let sourceUrl='';
            let sourceName='';
            const normalizedPhoto=msg.photo?normalizeMediaUrl(msg.photo):'';
            const normalizedFile=msg.file?normalizeMediaUrl(msg.file):'';
            if(msg.photo&&normalizedPhoto){
                mediaType='photo'; sourceUrl=normalizedPhoto;
            } else if(msg.file&&normalizedFile){
                mediaType=msg.media_type||'file'; sourceUrl=normalizedFile; sourceName=msg.file_name||'file';
            }
            if(!sourceUrl){
                if(msg.photo&&!/^(photos|images)\//.test(msg.photo)) delete msg.photo;
                if(msg.file&&!/^(files|video_files|voice_messages|stickers|video_message_files|animations)\//.test(msg.file)) delete msg.file;
                delete msg.thumbnail; delete msg._thumbnail_source;
                continue;
            }

            const thumbnailSource=normalizeMediaUrl(msg._thumbnail_source||'');
            delete msg._thumbnail_source;
            clearRemoteMedia(msg);

            const enabled = mediaType==='photo' ? state.exportPhotos :
                (mediaType==='video_file'||mediaType==='animation'||mediaType==='video_message') ? state.exportVideos :
                mediaType==='voice_message' ? state.exportVoice :
                mediaType==='sticker' ? state.exportStickers : state.exportFiles;
            if(!enabled) continue;

            const maxBytes=mediaLimitForType(mediaType);
            if(mediaType==='photo'){
                photoCount++;
                const fn=makeMediaFilename('photo',photoCount,msg,'jpg');
                const rel='photos/'+fn;
                queueMedia(async()=>{
                    const result=await downloadAndAddMedia(zip,prefix+'photos/',fn,sourceUrl,{maxBytes});
                    if(result.ok){msg.photo=rel;msg.photo_file_size=result.size;}
                });
                const thumbName=fn.replace(/\.jpg$/i,'_thumb.jpg');
                queueMedia(async()=>{ await downloadAndAddMedia(zip,prefix+'photos/',thumbName,sourceUrl,{maxBytes,isThumb:true}); });
                delete msg.file; delete msg.file_name; delete msg.file_size; delete msg.media_type; delete msg.thumbnail;
            } else if(mediaType==='video_file'||mediaType==='animation'){
                videoCount++;
                const ext=getFileExtension(sourceUrl,mediaType);
                const fn=makeMediaFilename(mediaType,videoCount,msg,ext);
                const folder=mediaType==='video_file'?'video_files/':'animations/';
                queueMedia(async()=>{
                    const result=await downloadAndAddMedia(zip,prefix+folder,fn,sourceUrl,{maxBytes});
                    if(result.ok){msg.file=folder+fn;msg.file_name=fn;msg.file_size=result.size;if(result.mime)msg.mime_type=result.mime;}
                });
                if(thumbnailSource){
                    const thumbName=fn+'_thumb.jpg';
                    queueMedia(async()=>{
                        const result=await downloadAndAddMedia(zip,prefix+folder,thumbName,thumbnailSource,{maxBytes:state.maxPhotoSize,isThumb:true});
                        if(result.ok){msg.thumbnail=folder+thumbName;msg.thumbnail_file_size=result.size;}
                    });
                }
            } else if(mediaType==='voice_message'){
                voiceCount++;
                const ext=getFileExtension(sourceUrl,mediaType);
                const fn=makeMediaFilename('audio',voiceCount,msg,ext);
                queueMedia(async()=>{
                    const result=await downloadAndAddMedia(zip,prefix+'voice_messages/',fn,sourceUrl,{maxBytes});
                    if(result.ok){msg.file='voice_messages/'+fn;msg.file_name=fn;msg.file_size=result.size;if(result.mime)msg.mime_type=result.mime;}
                });
            } else if(mediaType==='sticker'){
                stickerCount++;
                const ext=getFileExtension(sourceUrl,mediaType);
                const fn=sanitizeFilename('sticker_'+stickerCount+'.'+ext);
                queueMedia(async()=>{
                    const result=await downloadAndAddMedia(zip,prefix+'stickers/',fn,sourceUrl,{maxBytes});
                    if(result.ok){msg.file='stickers/'+fn;msg.file_name=fn;msg.file_size=result.size;if(result.mime)msg.mime_type=result.mime;}
                });
            } else if(mediaType==='video_message'){
                videoMsgCount++;
                const ext=getFileExtension(sourceUrl,mediaType);
                const fn=makeMediaFilename('video',videoMsgCount,msg,ext);
                queueMedia(async()=>{
                    const result=await downloadAndAddMedia(zip,prefix+'video_message_files/',fn,sourceUrl,{maxBytes});
                    if(result.ok){msg.file='video_message_files/'+fn;msg.file_name=fn;msg.file_size=result.size;if(result.mime)msg.mime_type=result.mime;}
                });
            } else {
                fileCount++;
                const orig=sanitizeFilename(sourceName||'file');
                const f=formatDate(msg.date);
                const ext=getFileExtension(sourceUrl,'file');
                const hasExt=/\.[a-zA-Z0-9]{1,10}$/.test(orig);
                const fn=sanitizeFilename('file_'+fileCount+'@'+f.dd+'-'+f.mm+'-'+f.yyyy+'_'+f.hh+'-'+f.min+'-'+f.ss+(hasExt?'_'+orig:'.'+ext));
                queueMedia(async()=>{
                    const result=await downloadAndAddMedia(zip,prefix+'files/',fn,sourceUrl,{maxBytes});
                    if(result.ok){msg.file='files/'+fn;msg.file_name=fn;msg.file_size=result.size;if(result.mime)msg.mime_type=result.mime;}
                });
                delete msg.media_type;
            }
        }

        const total=mediaTasks.length;
        let done=0;
        if(total>0) updateProgress('Downloading media... (0/'+total+')',0);
        let next=0;
        async function worker(){
            while(!state.cancelled){
                const idx=next++;
                if(idx>=total) return;
                try{await mediaTasks[idx]();}catch(e){log('Media task failed:',e?.message||e);}
                done++;
                updateProgress('Downloading media... ('+done+'/'+total+')',Math.round(done/total*100));
            }
        }
        const workers=Array.from({length:Math.min(CONFIG.mediaConcurrency,total)},()=>worker());
        await Promise.all(workers);

        // Build outputs only after media URLs have been converted to local paths.
        if(state.formatJson){
            const resultJson=buildResultJson(messages,chatInfo,isMultiChat);
            zip.file(prefix+'result.json',JSON.stringify(resultJson,null,1));
        }
        if(state.formatHtml){
            zip.file(prefix+'css/style.css',EXPORT_CSS);
            zip.file(prefix+'js/script.js',EXPORT_RUNTIME_JS);
            for(const [name,b64] of Object.entries(IMAGES)) zip.file(prefix+'images/'+name,b64,{base64:true});
            zip.file(prefix+'messages.html',buildMessagesHtml(messages,chatInfo,isMultiChat));
        }

        state.downloadedMedia.clear();
        if(existingZip) return;
        updateProgress('Building ZIP...',90);
        return await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});
    }

    async function fetchMediaBlob(url,maxBytes) {
        const normalized=normalizeMediaUrl(url);
        if(!normalized) throw new Error('Blocked unsafe media URL');
        const cacheKey=normalized+'|'+String(maxBytes||0);
        if(state.downloadedMedia.has(cacheKey)) return await state.downloadedMedia.get(cacheKey);

        const promise=(async()=>{
            const controller=new AbortController();
            state.activeControllers.add(controller);
            const timer=setTimeout(()=>controller.abort(),CONFIG.mediaFetchTimeoutMs);
            try{
                let credentials='omit';
                if(normalized.startsWith(location.origin+'/')) credentials='same-origin';
                const resp=await fetch(normalized,{mode:'cors',credentials,signal:controller.signal,cache:'no-store',referrerPolicy:'no-referrer'});
                if(!resp.ok) throw new Error('HTTP '+resp.status);
                const declared=Number(resp.headers.get('content-length'))||0;
                if(maxBytes&&declared>maxBytes) throw new Error('Media exceeds size limit ('+formatFileSize(declared)+' > '+formatFileSize(maxBytes)+')');
                const mime=(resp.headers.get('content-type')||'').split(';')[0].trim();
                if(resp.body&&resp.body.getReader){
                    const reader=resp.body.getReader();
                    const chunks=[];
                    let total=0;
                    while(true){
                        const {done,value}=await reader.read();
                        if(done) break;
                        total+=value.byteLength;
                        if(maxBytes&&total>maxBytes){
                            try{await reader.cancel();}catch(_){}
                            throw new Error('Media exceeds size limit ('+formatFileSize(maxBytes)+')');
                        }
                        chunks.push(value);
                    }
                    return new Blob(chunks,{type:mime||'application/octet-stream'});
                }
                const blob=await resp.blob();
                if(maxBytes&&blob.size>maxBytes) throw new Error('Media exceeds size limit ('+formatFileSize(blob.size)+' > '+formatFileSize(maxBytes)+')');
                return blob;
            } finally { clearTimeout(timer); state.activeControllers.delete(controller); }
        })();
        state.downloadedMedia.set(cacheKey,promise);
        try{return await promise;}catch(e){state.downloadedMedia.delete(cacheKey);throw e;}
    }

    async function makeImageThumbnail(blob) {
        if(!blob||!(blob.type||'').startsWith('image/')) return null;
        let img=null;
        try{
            img=await createImageBitmap(blob);
            const maxDim=90;
            let w=img.width,h=img.height;
            if(!w||!h) return null;
            if(w>h&&w>maxDim){h=Math.max(1,Math.round(h*maxDim/w));w=maxDim;}
            else if(h>=w&&h>maxDim){w=Math.max(1,Math.round(w*maxDim/h));h=maxDim;}
            const canvas=document.createElement('canvas');
            canvas.width=w;canvas.height=h;
            const ctx=canvas.getContext('2d');
            if(!ctx) return null;
            ctx.drawImage(img,0,0,w,h);
            return await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.82));
        } finally { if(img&&img.close) img.close(); }
    }

    async function downloadAndAddMedia(zip,folder,filename,url,options={}) {
        if(state.cancelled) return {ok:false,cancelled:true};
        const safeName=sanitizeFilename(filename);
        try{
            const blob=await fetchMediaBlob(url,options.maxBytes||0);
            const payload=options.isThumb?(await makeImageThumbnail(blob)):blob;
            if(!payload) return {ok:false,reason:'thumbnail-unavailable'};
            zip.file(folder+safeName,payload);
            return {ok:true,size:payload.size,mime:payload.type||blob.type||''};
        } catch(e) {
            if(!options.isThumb) state.mediaSkipped++;
            log('Media skipped: '+safeName+' — '+(e?.message||e));
            return {ok:false,error:e};
        }
    }

    /* ================================================================
       JSON BUILDER
       ================================================================ */
    function buildResultJson(messages, chatInfo, isMultiChat) {
        if(isMultiChat){
            return {
                about:'Here is the data you requested...',
                personal_information:{
                    user_id:chatInfo.userId||0,
                    first_name:chatInfo.firstName||'',
                    last_name:chatInfo.lastName||'',
                    phone_number:chatInfo.phone||'',
                    username:chatInfo.username||'',
                    bio:chatInfo.bio||''
                },
                profile_pictures:[],
                contacts:{about:'',list:[]},
                chats:{
                    about:'This page lists all chats from this export.',
                    list:[{
                        name:chatInfo.name,
                        type:chatInfo.type||'personal_chat',
                        id:chatInfo.id||0,
                        messages:messages
                    }]
                }
            };
        }
        return {
            name:chatInfo.name,
            type:chatInfo.type||'personal_chat',
            id:chatInfo.id||0,
            messages:messages
        };
    }

    /* ================================================================
       HTML BUILDER
       ================================================================ */
    function buildMessagesHtml(messages, chatInfo, isMultiChat) {
        const name=escapeHtml(chatInfo.name);
        let body='<div class="history">';
        let lastDate='';
        let msgCount=0;
        let lastFrom='';
        let lastTime=0;

        for(const msg of messages){
            const dateStr=formatDateForDisplay(msg.date);
            // Date separator before every message type (including service)
            if(dateStr!==lastDate){
                lastDate=dateStr;
                msgCount++;
                lastFrom=''; lastTime=0; // Reset join tracking across date boundaries
                body+='<div class="message service" id="message-'+msgCount+'"><div class="body details">'+dateStr+'</div></div>';
            }

            // Phone calls: render as default message (not service) with media_call
            if(msg.type==='service' && msg.action==='phone_call'){
                const actor=escapeHtml(msg.actor||'Unknown');
                const time=formatTimeForDisplay(msg.date);
                const fullDate=formatDateTelegram(msg.date);
                const msgTime=new Date(msg.date).getTime();

                // Determine call partner for title bold
                let partnerName=escapeHtml(chatInfo.name||'');
                if(partnerName===actor) partnerName='You';

                // Status text and success class
                let statusText='';
                let callSuccess=false;
                if(msg.duration_seconds){
                    statusText=msg.duration_seconds+' seconds';
                    callSuccess=true;
                } else if(msg.discard_reason==='missed'){statusText='Missed';
                } else if(msg.discard_reason==='declined'||msg.discard_reason==='busy'){statusText='Declined';
                } else if(msg.discard_reason==='canceled'){statusText='Cancelled';
                } else {statusText='Declined';}

                // joined class: same actor within 900s
                const isJoined=(actor===lastFrom && lastTime>0 && (msgTime-lastTime)<=900000);
                const joinedClass=isJoined?' joined':'';
                lastFrom=actor; lastTime=msgTime;

                body+='<div class="message default clearfix'+joinedClass+'" id="message'+msg.id+'">';
                body+='<div class="body">';
                body+='<div class="pull_right date details" title="'+escapeHtmlAttr(fullDate)+'">'+escapeHtml(time)+'</div>';
                body+='<div class="from_name">'+actor+'</div>';
                body+='<div class="media_wrap clearfix">';
                body+='<div class="media clearfix pull_left media_call'+(callSuccess?' success':'')+'">';
                body+='<div class="fill pull_left"></div>';
                body+='<div class="body">';
                body+='<div class="title bold">'+partnerName+'</div>';
                body+='<div class="status details">'+escapeHtml(statusText)+'</div>';
                body+='</div></div></div></div></div>';
                continue;
            }

            if(msg.type==='service'){
                body+=buildServiceMessageHtml(msg);
                continue;
            }

            const id=msg.id;
            const rawFromName=msg.from||'Unknown';
            const fromName=escapeHtml(rawFromName);
            const initials=escapeHtml(getInitials(rawFromName));
            const userpicIdx=getUserpicIndex(rawFromName);
            const time=formatTimeForDisplay(msg.date);
            const fullDate=formatDateTelegram(msg.date);
            const msgTime=new Date(msg.date).getTime();

            // joined class: same sender within 900s (tdesktop messageNeedsWrap)
            const isJoined=(rawFromName===lastFrom && lastTime>0 && Number.isFinite(msgTime) && (msgTime-lastTime)<=900000);
            const joinedClass=isJoined?' joined':'';
            lastFrom=rawFromName; lastTime=Number.isFinite(msgTime)?msgTime:0;

            body+='<div class="message default clearfix'+joinedClass+'" id="message'+id+'">';
            if(!isJoined){
                body+='<div class="pull_left userpic_wrap"><div class="userpic userpic'+userpicIdx+'" style="width:42px;height:42px"><div class="initials" style="line-height:42px">'+initials+'</div></div></div>';
            }
            body+='<div class="body">';
            body+='<div class="pull_right date details" title="'+escapeHtmlAttr(fullDate)+'">'+escapeHtml(time)+'</div>';
            body+='<div class="from_name">'+fromName+'</div>';

            // Forwarded
            if(msg.forwarded_from){
                const rawFwdName=msg.forwarded_from;
                const fwdName=escapeHtml(rawFwdName);
                const fwdInitials=escapeHtml(getInitials(rawFwdName));
                const fwdIdx=getUserpicIndex(rawFwdName);
                body+='<div class="pull_left forwarded userpic_wrap"><div class="userpic userpic'+fwdIdx+'" style="width:42px;height:42px"><div class="initials" style="line-height:42px">'+fwdInitials+'</div></div></div>';
                body+='<div class="forwarded body"><div class="from_name">'+fwdName+'</div>';
            }

            // Media
            if(msg.photo){
                body+='<div class="media_wrap clearfix"><a class="photo_wrap" href="'+escapeHtmlAttr(msg.photo)+'"><img class="photo" src="'+escapeHtmlAttr(msg.photo)+'" style="width:200px"/></a></div>';
            } else if(msg.file){
                const iconClass=msg.media_type==='video_file'?'media_video':msg.media_type==='voice_message'?'media_voice_message':msg.media_type==='sticker'?'':msg.media_type==='video_message'?'media_video':'media_file';
                if(msg.media_type==='video_file'||msg.media_type==='video_message'){
                    body+='<div class="media_wrap clearfix"><a class="video_file_wrap clearfix" href="'+escapeHtmlAttr(msg.file)+'">';
                    if(msg.thumbnail) body+='<img src="'+escapeHtmlAttr(msg.thumbnail)+'" style="width:146px"/>';
                    if(msg.duration_seconds) body+='<div class="video_duration">'+formatDuration(msg.duration_seconds)+'</div>';
                    body+='</a></div>';
                } else if(msg.media_type==='voice_message'){
                    body+='<div class="media_wrap clearfix"><div class="media clearfix pull_left media_voice_message"><div class="fill pull_left"></div><div class="body"><div class="title bold">Voice message</div>';
                    if(msg.duration_seconds) body+='<div class="status details">'+formatDuration(msg.duration_seconds)+'</div>';
                    body+='</div></div></div>';
                } else if(msg.media_type==='sticker'){
                    body+='<div class="media_wrap clearfix"><img class="sticker" src="'+escapeHtmlAttr(msg.file)+'" style="width:128px"/></div>';
                } else {
                    body+='<div class="media_wrap clearfix"><a class="media clearfix pull_left block_link '+iconClass+'" href="'+escapeHtmlAttr(msg.file)+'"><div class="fill pull_left"></div><div class="body"><div class="title bold">'+escapeHtml(msg.file_name||'File')+'</div>';
                    if(msg.file_size) body+='<div class="status details">'+formatFileSize(msg.file_size)+'</div>';
                    body+='</div></div></a></div>';
                }
            }

            // Text
            const textHtml=buildTextHtml(msg);
            if(textHtml) body+='<div class="text">'+textHtml+'</div>';

            if(msg.forwarded_from) body+='</div>'; // close forwarded body

            body+='</div></div>';
        }

        body+='</div>';

        return '<!DOCTYPE html><html><head><meta charset="utf-8"/><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; img-src \'self\' data: blob:; media-src \'self\' data: blob:; style-src \'self\' \'unsafe-inline\'; script-src \'self\'; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'"/><title>Exported Data</title><meta content="width=device-width,initial-scale=1.0" name="viewport"/><link href="css/style.css" rel="stylesheet"/><script src="js/script.js" type="text/javascript"></script></head><body><div class="page_wrap"><div class="page_header"><div class="content"><div class="text bold">'+name+'</div></div></div><div class="page_body chat_page">'+body+'</div></div></body></html>';
    }

    function buildServiceMessageHtml(msg) {
        let text='';
        if(msg.action==='phone_call'){
            if(msg.discard_reason==='missed') text=escapeHtml(msg.actor||'')+' missed the call';
            else if(msg.discard_reason==='declined'||msg.discard_reason==='busy') text=escapeHtml(msg.actor||'')+' declined the call';
            else if(msg.duration_seconds) text='Call lasted '+msg.duration_seconds+' seconds';
            else text=escapeHtml(msg.actor||'')+' made a call';
        } else if(msg.action==='topic_created'){
            text='Topic "'+escapeHtml(msg.title||'')+'" created';
        } else if(msg.action==='create_group'){
            text='Group created';
        } else if(msg.action==='join_group'){
            text=escapeHtml(msg.actor||'')+' joined';
        } else {
            text='Service message';
        }
        return '<div class="message service" id="message'+msg.id+'"><div class="body details">'+text+'</div></div>';
    }

    function buildTextHtml(msg) {
        if(!msg.text_entities||msg.text_entities.length===0) return '';
        let html='';
        for(const e of msg.text_entities){
            const raw=String(e.text||'');
            const t=escapeHtml(raw);
            if(e.type==='bold') html+='<b>'+t+'</b>';
            else if(e.type==='italic') html+='<i>'+t+'</i>';
            else if(e.type==='underline') html+='<u>'+t+'</u>';
            else if(e.type==='strikethrough') html+='<s>'+t+'</s>';
            else if(e.type==='code') html+='<code>'+t+'</code>';
            else if(e.type==='pre') html+='<pre>'+t+'</pre>';
            else if(e.type==='spoiler') html+='<span class="spoiler hidden" data-tgx-action="spoiler"><span>'+t+'</span></span>';
            else if(e.type==='text_link') html+='<a href="'+escapeHtmlAttr(safeHref(e.href||''))+'" rel="noopener noreferrer">'+t+'</a>';
            else if(e.type==='link') html+='<a href="'+escapeHtmlAttr(safeHref(raw))+'" rel="noopener noreferrer">'+t+'</a>';
            else if(e.type==='mention') html+='<a class="mention" href="#" data-tgx-action="mention">'+t+'</a>';
            else if(e.type==='hashtag') html+='<a class="hashtag" href="#" data-tgx-action="hashtag" data-tgx-value="'+escapeHtmlAttr(raw.replace(/^#/,''))+'">'+t+'</a>';
            else if(e.type==='cashtag') html+='<a class="cashtag" href="#" data-tgx-action="cashtag" data-tgx-value="'+escapeHtmlAttr(raw.replace(/^\$/,''))+'">'+t+'</a>';
            else if(e.type==='bot_command') html+='<a class="bot_command" href="#" data-tgx-action="bot_command" data-tgx-value="'+escapeHtmlAttr(raw.replace(/^\//,''))+'">'+t+'</a>';
            else html+=t.replace(/\n/g,'<br>');
        }
        return html;
    }

    function formatDuration(secs) {
        if(!secs) return '';
        const m=Math.floor(secs/60), s=secs%60;
        return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
    }

    /* ================================================================
       MAIN EXPORT FLOW
       ================================================================ */
    async function activateChat(chat, timeoutMs=6000) {
        if(!chat) return false;
        const peerId=String(chat.peerId||'');
        const current=document.querySelector('.input-message-input[data-peer-id]')?.getAttribute('data-peer-id')||'';
        if(peerId&&current===peerId) return true;
        let el=peerId?document.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`):null;
        if(!el&&chat.element?.isConnected) el=chat.element;
        if(el){
            el.click();
        } else if(chat.href){
            try{
                const u=new URL(chat.href,location.href);
                if(u.origin!==location.origin||u.pathname!==location.pathname||u.search!==location.search||!u.hash) return false;
                location.hash=u.hash;
            }catch(_){return false;}
        } else return false;
        const deadline=Date.now()+timeoutMs;
        while(Date.now()<deadline){
            await sleep(150);
            const loadedPeer=document.querySelector('.input-message-input[data-peer-id]')?.getAttribute('data-peer-id')||'';
            if(peerId&&loadedPeer===peerId) return true;
            if(!peerId&&getChatTitle()===chat.name) return true;
        }
        return getChatTitle()===chat.name;
    }

    async function scrollChat(chatEl) {
        chatEl.click();
        await sleep(800);
        state.scrollContainer=findScrollContainer();
        if(!state.scrollContainer) return false;
        await detectAndExportTopics();
        return true;
    }

    function getCurrentChatInfo() {
        const input=document.querySelector('.input-message-input[data-peer-id]');
        const active=document.querySelector('a.chatlist-chat.active[data-peer-id],.chatlist-chat.active[data-peer-id]');
        const raw=input?.getAttribute('data-peer-id')||active?.getAttribute('data-peer-id')||'';
        const chatId=parseSignedId(raw)||0;
        return {name:state.chatName||getChatTitle(),type:detectChatType(),id:chatId};
    }

    async function exportSingleChat(zip, chatIndex) {
        state.messages.clear(); state.scrollAttempts=0; state.staleCount=0;
        state._currentTopic=null;

        state.scrollContainer=findScrollContainer();
        if(!state.scrollContainer) return false;

        state.chatName=getChatTitle();
        state.chatType=detectChatType();

        await detectAndExportTopics();
        if(state.cancelled) return false;

        const msgs=Array.from(state.messages.values()).sort((a,b)=>a.id-b.id);
        if(msgs.length===0){log('No messages in chat:',state.chatName);return false;}

        const chatInfo=getCurrentChatInfo();
        const isMulti=state.exportMode!=='current';
        await buildExportZip(msgs, chatInfo, isMulti, chatIndex, zip);
        return true;
    }

    async function runExportInternal() {
        state.cancelled=false;
        state.downloadedMedia.clear(); state.mediaSkipped=0; state.exportStartTime=Date.now();
        state.currentChatIndex=0;

        updateProgress('Starting export...',0);

        if(state.exportMode==='current'){
            // Single chat export
            state.scrollContainer=findScrollContainer();
            if(!state.scrollContainer){showError('Could not find message list. Open a chat first.');state.isExporting=false;return;}
            state.chatName=getChatTitle();
            state.chatType=detectChatType();
            const peerEl=document.querySelector('.input-message-input[data-peer-id]')||document.querySelector('a.chatlist-chat.active[data-peer-id],.chatlist-chat.active[data-peer-id]');
            if(peerEl) state.chatId=parseSignedId(peerEl.getAttribute('data-peer-id'));
            await detectAndExportTopics();
            const msgs=Array.from(state.messages.values()).sort((a,b)=>a.id-b.id);
            if(msgs.length===0){showError('No messages found.');state.isExporting=false;return;}
            updateProgress('Building export... ('+msgs.length+' messages)',30);
            const chatInfo={name:state.chatName,type:state.chatType,id:state.chatId||0};
            try {
                const blob=await buildExportZip(msgs, chatInfo, false, 1);
                updateProgress('Saving ZIP...',95);
                const isPartial=state.cancelled;
                downloadBlob(blob,sanitizeFilename(state.chatName,'Telegram_chat')+'_'+new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)+(isPartial?'_partial':'')+'.zip');
                const elapsed=Math.round((Date.now()-state.exportStartTime)/1000);
                const skipped=state.mediaSkipped?' · '+state.mediaSkipped+' media skipped':'';
                showComplete((isPartial?'Partial export saved: ':'Export complete: ')+msgs.length+' messages in '+elapsed+'s'+skipped);
            } catch(e) {
                showError('Export error: '+e.message);
                log(e);
            }
            state.isExporting=false;
            return;
        }

        // Multi-chat export
        if(typeof JSZip==='undefined') {
            await new Promise(r=>setTimeout(r,2000));
            if(typeof JSZip==='undefined'){showError('JSZip not loaded');state.isExporting=false;return;}
        }
        const zip=new JSZip();
        let chatList=[];
        if(state.exportMode==='selectable'){
            chatList=state.selectedChats;
        } else if(state.exportMode==='all'&&state.chatType){
            const groups = getChatGroups(state.fullChatList && state.fullChatList.length > 0 ? state.fullChatList : undefined);
            chatList=groups[state.chatType]||getChatList();
        } else {
            chatList=getChatList();
        }
        if(!chatList||chatList.length===0){showError('No chats found to export.');state.isExporting=false;return;}
        if(chatList.length>CONFIG.maxChats){showError('Too many chats ('+chatList.length+'). Limit: '+CONFIG.maxChats+'.');state.isExporting=false;return;}

        let successCount=0;
        for(let i=0;i<chatList.length;i++){
            if(state.cancelled) break;
            state.currentChatIndex=i;
            const chat=chatList[i];
            updateProgress('Chat '+(i+1)+'/'+chatList.length+': '+chat.name+'...', Math.round(i/chatList.length*80));
            const activated=await activateChat(chat);
            if(!activated){log('Skipping chat because it could not be activated:',chat.name);continue;}
            // Verify chat type matches expected group (mitigates -100 prefix ambiguity)
            if(state.exportMode==='all' && !verifyCurrentChatType()){
                log('Skipping "'+chat.name+'" — type mismatch (expected '+state.chatType+', got '+detectChatType()+')');
                continue;
            }
            const ok=await exportSingleChat(zip, i+1);
            if(ok) successCount++;
        }

        updateProgress(state.cancelled?'Building partial ZIP...':'Building final ZIP...',90);

        const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});
        downloadBlob(blob,'Telegram_Export_'+new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)+(state.cancelled?'_partial':'')+'.zip');
        const elapsed=Math.round((Date.now()-state.exportStartTime)/1000);
        const skipped=state.mediaSkipped?' · '+state.mediaSkipped+' media skipped':'';
        showComplete((state.cancelled?'Partial export saved: ':'Export complete: ')+successCount+' chats in '+elapsed+'s'+skipped);
        state.isExporting=false;
    }

    function downloadBlob(blob, filename) {
        const url=URL.createObjectURL(blob);
        const a=document.createElement('a');
        a.href=url;
        a.download=sanitizeFilename(filename,'Telegram_Export.zip');
        a.style.display='none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(()=>URL.revokeObjectURL(url),30000);
    }

    async function startExport() {
        if(state.isExporting) return;
        state.isExporting=true;
        updateExportButton('✕ Cancel Export',true);
        try {
            await runExportInternal();
        } catch(e) {
            log('Export failed:',e);
            showError('Export error: '+(e?.message||String(e)));
        } finally {
            if(state.observer){state.observer.disconnect();state.observer=null;}
            state.isExporting=false;
            state.isDownloading=false;
            updateExportButton('📋 Export Chats',false);
            if(state.dialog){
                const action=state.dialog.querySelector('#tgx-export');
                if(action){action.disabled=false;action.textContent='Export';action.style.opacity='1';}
                const cancel=state.dialog.querySelector('#tgx-cancel');
                if(cancel) cancel.textContent='Close';
            }
        }
    }

    /* ================================================================
       UI - EXPORT BUTTON
       ================================================================ */
    let exportBtn=null;
    function createExportButton() {
        if(exportBtn) return;
        exportBtn=document.createElement('button');
        exportBtn.id='tg-export-btn';
        exportBtn.textContent='📋 Export Chats';
        exportBtn.style.cssText='position:fixed;bottom:20px;right:20px;z-index:99999;padding:12px 22px;background:#2AABEE;color:#fff;border:2px solid #ffffff;border-radius:28px;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,0.4);transition:all .2s;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;letter-spacing:0.3px;';
        exportBtn.onmouseenter=()=>{if(!state.isExporting)exportBtn.style.transform='scale(1.05)'};
        exportBtn.onmouseleave=()=>{exportBtn.style.transform='scale(1)'};
        exportBtn.onclick=()=>{if(state.isExporting||state.isDownloading)setCancelled(true);else showExportDialog();};
        document.body.appendChild(exportBtn);
    }
    function updateExportButton(text, isActive) {
        if(exportBtn){
            exportBtn.textContent=text;
            exportBtn.style.background=isActive?'#d93636':'#2AABEE';
        }
    }

    /* ================================================================
       INIT
       ================================================================ */
    function init() {
        const interval=setInterval(()=>{
            const hasUI=document.querySelector('[data-mid],[data-scope="bubble"],[data-scope="bubbles"],.chat-input,[class*="input-message"]');
            if(hasUI||document.readyState==='complete'){
                clearInterval(interval);
                setTimeout(createExportButton,1000);
            }
        },1000);
        setTimeout(()=>clearInterval(interval),30000);
    }

    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
    else init();

})();
