// ==UserScript==
// @name         Telegram Web Chat Exporter
// @namespace    http://tampermonkey.net/
// @version      4.0.0
// @description  Privacy-first Telegram Web chat exporter. Local ZIP export with readable HTML, JSON, optional media, and a modern accessible interface.
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

    const CONFIG_OVERRIDES = globalThis.__TELEARCHIVE_CONFIG__ && typeof globalThis.__TELEARCHIVE_CONFIG__ === 'object'
        ? globalThis.__TELEARCHIVE_CONFIG__
        : {};
    const CONFIG = {
        scrollWaitMs: 500,
        scrollStep: 600,
        staleThreshold: 10,
        historyEdgeWaitMs: 1200,
        historyEdgeStaleThreshold: 2,
        historyMaxScrollAttempts: 10000,
        mediaConcurrency: 4,
        mediaFetchTimeoutMs: 45000,
        maxChats: 50,
        debug: false,
        ...CONFIG_OVERRIDES
    };
    const EXTENSION_BUILD = typeof __TELEARCHIVE_EXTENSION_BUILD__ !== 'undefined' && __TELEARCHIVE_EXTENSION_BUILD__ === true;
    const EXTENSION_MODE = typeof browser !== 'undefined' && Boolean(browser?.runtime?.id);
    const OPEN_EVENT = 'telearchive:open';
    const DOWNLOAD_EVENT = 'telearchive:download';
    const PREFERENCES_KEY = 'telearchive.preferences.v1';
    const BATCH_RESUME_STORAGE_KEY = 'telearchive.batch-resume.v1';
    const MAX_SKIPPED_ITEM_DETAILS = 250;
    const ACTIVE_CONNECTOR = (()=>{
        const value=globalThis.__LOCAL_ARCHIVE_CONNECTOR__;
        const input=value&&typeof value==='object'?value:{};
        const text=(key,fallback,max=80)=>typeof input[key]==='string'&&input[key].trim()
            ?input[key].trim().slice(0,max)
            :fallback;
        return Object.freeze({
            id:text('id','telegram-web',64),
            displayName:text('displayName','Telegram',64),
            conversationLabel:text('conversationLabel','chat',32),
            conversationsLabel:text('conversationsLabel','chats',32),
            surfaceLabel:text('surfaceLabel','this Telegram tab',120),
        });
    })();
    const RUST_CORE = (()=>{
        const value=globalThis.__LOCAL_ARCHIVE_RUST_CORE__;
        if(!value||typeof value!=='object')return null;
        if(typeof value.normalizeExportRange!=='function'
            ||typeof value.normalizePreferences!=='function'
            ||typeof value.normalizeQuickExportRequest!=='function'
            ||typeof value.filterMessagesForRange!=='function'
            ||typeof value.createExportSession!=='function'
            ||typeof value.validateArchivePassword!=='function')return null;
        return value;
    })();
    const NATIVE_HISTORY = (()=>{
        const value=globalThis.__LOCAL_ARCHIVE_TELEGRAM_NATIVE__;
        if(!value||typeof value!=='object'
            ||typeof value.inspect!=='function'
            ||typeof value.collect!=='function')return null;
        return value;
    })();

    function archivePasswordIsValid(value) {
        if(RUST_CORE){
            try{RUST_CORE.validateArchivePassword(String(value||''));return true;}
            catch(_){return false;}
        }
        const count=Array.from(String(value||'')).length;
        return count>=8&&count<=256;
    }

    function readBatchResumeSession() {
        try {
            if (typeof sessionStorage === 'undefined') return null;
            const raw = sessionStorage.getItem(BATCH_RESUME_STORAGE_KEY);
            if (!raw) return null;
            const value = JSON.parse(raw);
            if (!value || typeof value !== 'object' || typeof value.key !== 'string' || value.key.length > 20000) return null;
            if (!['all', 'selectable'].includes(value.mode)) return null;
            if (!Number.isInteger(value.totalChats) || value.totalChats <= 0 || value.totalChats > 100000) return null;
            if (!Number.isInteger(value.activeIndex) || value.activeIndex < 0) return null;
            if (!Array.isArray(value.completedIndexes)) return null;
            const completedIndexes = value.completedIndexes
                .filter((index) => Number.isInteger(index) && index >= 0)
                .slice(0, 1000);
            const completedBatchStats = {};
            if (value.completedBatchStats && typeof value.completedBatchStats === 'object') {
                for (const [index, stat] of Object.entries(value.completedBatchStats).slice(0, 1000)) {
                    if (!/^\d+$/u.test(index)) continue;
                    completedBatchStats[index] = { archiveFilename: typeof stat?.archiveFilename === 'string' ? stat.archiveFilename.slice(0, 255) : '' };
                }
            }
            return {
                key: value.key,
                mode: value.mode,
                totalChats: value.totalChats,
                activeIndex: value.activeIndex,
                completedIndexes: [...new Set(completedIndexes)].sort((a, b) => a - b),
                batchRunAll: value.batchRunAll === true,
                completedBatchStats,
            };
        } catch (_) {
            return null;
        }
    }

    function clearBatchResumeSession() {
        try {
            if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(BATCH_RESUME_STORAGE_KEY);
        } catch (_) {}
    }

    function persistBatchResumeSession(value) {
        try {
            if (typeof sessionStorage === 'undefined') return;
            if (!value) {
                clearBatchResumeSession();
                return;
            }
            const completedBatchStats = {};
            for (const [index, stat] of Object.entries(value.completedBatchStats || {}).slice(0, 1000)) {
                completedBatchStats[index] = { archiveFilename: String(stat?.archiveFilename || '').slice(0, 255) };
            }
            sessionStorage.setItem(BATCH_RESUME_STORAGE_KEY, JSON.stringify({
                key: String(value.key || '').slice(0, 20000),
                mode: value.mode,
                totalChats: Number(value.totalChats) || 0,
                activeIndex: Number(value.activeIndex) || 0,
                completedIndexes: [...new Set((value.completedIndexes || []).map(Number).filter((index) => Number.isInteger(index) && index >= 0))].slice(0, 1000),
                batchRunAll: Boolean(value.batchRunAll),
                completedBatchStats,
            }));
        } catch (_) {}
    }

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
    function createRuntimeRequestId() {
        return typeof globalThis.crypto?.randomUUID === 'function'
            ? globalThis.crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
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
        const raw = String(value).trim();
        if (/^-?\d+$/.test(raw)) {
            const direct = Number(raw);
            return Number.isSafeInteger(direct) ? direct : null;
        }
        // In compound DOM identifiers such as "message-42", a hyphen is a
        // separator rather than the numeric sign of the message ID.
        const matches = raw.match(/\d+/g);
        if (!matches || matches.length === 0) return null;
        const n = Number(matches[matches.length - 1]);
        return Number.isSafeInteger(n) ? n : null;
    }
    function sanitizeFilename(name, fallback='file') {
        let out = String(name || fallback)
            .replace(/[\\/\0-\x1f\x7f]+/g, '_')
            .replace(/[<>:"|?*]/g, '_')
            .replace(/^\.+/, '_')
            .replace(/^_+/, '_')
            .replace(/[. ]+$/g, '')
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
    function tr(key, fallback, substitutions) {
        // The popup can choose a locale independently of Firefox's UI locale.
        // Quick-export progress must follow that choice, especially when the
        // Telegram worker tab runs in a background document. These semantic
        // states have compact product labels with no positional placeholders.
        let quickLabels=null;
        try{quickLabels=state.quickMode&&state.quickLabels?state.quickLabels:null;}catch(_){ }
        if(quickLabels){
            const quickKey={
                statusStarting:'preparing',
                statusScanningNewer:'reading',
                statusScanningOlder:'reading',
                statusSwitchingTopic:'reading',
                statusTopic:'reading',
                statusDownloadingMedia:'saving',
                statusBuildingPartial:'saving',
                statusBuilding:'saving',
                statusSaving:'saving',
                statusChatProgress:'reading'
            }[key];
            if(quickKey&&quickLabels[quickKey])return String(quickLabels[quickKey]);
        }
        if (EXTENSION_MODE) {
            try {
                const translated = browser.i18n.getMessage(key, substitutions);
                if (translated) return translated;
            } catch (_) {}
        }
        return fallback;
    }
    function clampMegabytes(value, fallback, max) {
        const parsed=Number(value);
        if(!Number.isFinite(parsed)) return fallback;
        return Math.min(max,Math.max(1,Math.round(parsed)));
    }
    function normalizePreferences(value) {
        if(RUST_CORE)return RUST_CORE.normalizePreferences(value);
        const input=value&&typeof value==='object'?value:{};
        const bool=(key,fallback)=>typeof input[key]==='boolean'?input[key]:fallback;
        return {
            onboardingCompleted:bool('onboardingCompleted',false),
            formatHtml:bool('formatHtml',true),
            formatJson:bool('formatJson',true),
            exportPhotos:bool('exportPhotos',true),
            exportVideos:bool('exportVideos',false),
            exportVoice:bool('exportVoice',true),
            exportStickers:bool('exportStickers',true),
            exportFiles:bool('exportFiles',false),
            maxPhotoSizeMb:clampMegabytes(input.maxPhotoSizeMb,10,10000),
            maxVideoSizeMb:clampMegabytes(input.maxVideoSizeMb,100,20000),
            maxFileSizeMb:clampMegabytes(input.maxFileSizeMb,100,20000)
        };
    }
    async function loadStoredPreferences() {
        if(!EXTENSION_MODE) return normalizePreferences(null);
        try {
            const stored=await browser.storage.local.get(PREFERENCES_KEY);
            return normalizePreferences(stored[PREFERENCES_KEY]);
        } catch (_) {
            return normalizePreferences(null);
        }
    }
    async function saveStoredPreferences(preferences) {
        if(!EXTENSION_MODE) return;
        try {
            await browser.storage.local.set({[PREFERENCES_KEY]:normalizePreferences(preferences)});
        } catch (_) {}
    }
    function applyPreferencesToState(preferences) {
        const p=normalizePreferences(preferences);
        state.formatHtml=p.formatHtml;
        state.onboardingCompleted=p.onboardingCompleted;
        state.formatJson=p.formatJson;
        state.exportPhotos=p.exportPhotos;
        state.exportVideos=p.exportVideos;
        state.exportVoice=p.exportVoice;
        state.exportStickers=p.exportStickers;
        state.exportFiles=p.exportFiles;
        state.maxPhotoSize=p.maxPhotoSizeMb*1024*1024;
        state.maxVideoSize=p.maxVideoSizeMb*1024*1024;
        state.maxFileSize=p.maxFileSizeMb*1024*1024;
        return p;
    }
    function preferencesFromState() {
        return normalizePreferences({
            onboardingCompleted:state.onboardingCompleted,
            formatHtml:state.formatHtml,
            formatJson:state.formatJson,
            exportPhotos:state.exportPhotos,
            exportVideos:state.exportVideos,
            exportVoice:state.exportVoice,
            exportStickers:state.exportStickers,
            exportFiles:state.exportFiles,
            maxPhotoSizeMb:Math.round(state.maxPhotoSize/1024/1024),
            maxVideoSizeMb:Math.round(state.maxVideoSize/1024/1024),
            maxFileSizeMb:Math.round(state.maxFileSize/1024/1024)
        });
    }

    /* ================================================================
       STATE
       ================================================================ */
    function createExportStats() {
        return {
            formatVersion: '1.1',
            scopeMode: 'current',
            scopeLabel: '',
            historySource: 'rendered-telegram-web',
            completeHistoryNotGuaranteed: true,
            historyComplete: false,
            contentUploaded: false,
            archiveEncrypted: false,
            requestedRange: {mode:'all'},
            rangeMessagesIncluded: 0,
            coverageTargetDate: null,
            coverageTargetReached: null,
            historyLoad: {
                attempted: false,
                completed: false,
                edgeReached: false,
                initialMessages: 0,
                messagesCollected: 0,
                scrollAttempts: 0,
                noProgressPasses: 0,
                stoppedReason: null
            },
            oldestMessageDate: null,
            newestMessageDate: null,
            partial: false,
            chatsRequested: 0,
            chatsIncluded: 0,
            chatsSkipped: 0,
            chatsSkippedByReason: {},
            messagesIncluded: 0,
            chatCoverage: [],
            batch: null,
            media: {
                discovered: 0,
                included: 0,
                skipped: 0,
                notSelected: 0,
                pending: 0,
                thumbnailsSkipped: 0,
                byType: { photo: 0, video_file: 0, video_message: 0, animation: 0, voice_message: 0, sticker: 0, file: 0 },
                skippedByReason: {},
                skippedItems: [],
                skippedItemsTruncated: 0
            }
        };
    }

    function resetExportStats() {
        state.exportStats = createExportStats();
        state.exportStats.scopeMode = state.exportMode;
        state.exportStats.scopeLabel = state.chatName || '';
        state.exportStats.requestedRange = normalizeExportRange(state.exportRange);
        state.exportStats.coverageTargetDate = normalizeCoverageTargetDate(state.coverageTargetDate) || null;
        state.exportStats.batch = state.batchContext ? JSON.parse(JSON.stringify(state.batchContext)) : null;
    }

    function resetHistoryLoadStats() {
        if (!state.exportStats) return;
        state.exportStats.historyLoad = {
            attempted: false,
            completed: false,
            edgeReached: false,
            initialMessages: 0,
            messagesCollected: 0,
            scrollAttempts: 0,
            noProgressPasses: 0,
            stoppedReason: null
        };
    }

    function updateHistoryLoadStats(patch = {}) {
        if (!state.exportStats) return;
        state.exportStats.historyLoad = {
            ...(state.exportStats.historyLoad || {}),
            ...patch
        };
    }

    function incrementCounter(target, key, amount = 1) {
        if (!target || !key) return;
        target[key] = (Number(target[key]) || 0) + amount;
    }

    function recordChatSkip(reason) {
        state.exportStats.chatsSkipped++;
        incrementCounter(state.exportStats.chatsSkippedByReason, reason || 'unknown');
    }

    function recordMediaDiscovery(mediaType, enabled) {
        if (!mediaType) return;
        state.exportStats.media.discovered++;
        if (!enabled) {
            state.exportStats.media.notSelected++;
        }
    }

    function mediaSkipReason(error, fallback = 'unknown') {
        if (fallback === 'cancelled') return 'cancelled';
        const message = String(error?.message || error || '').toLowerCase();
        if (message.includes('size limit') || message.includes('exceeds size')) return 'size_limit';
        if (message.includes('blocked unsafe') || message.includes('invalid')) return 'invalid';
        if (message.includes('http ') || message.includes('network') || message.includes('fetch')) return 'network';
        return fallback;
    }

    function createMediaSizeError(actualBytes, limitBytes, actualBytesExact = true) {
        const actual=Number(actualBytes)||0;
        const limit=Number(limitBytes)||0;
        const error=new Error('Media exceeds size limit ('+formatFileSize(actual)+' > '+formatFileSize(limit)+')');
        error.actualBytes=actual;
        error.limitBytes=limit;
        error.actualBytesExact=Boolean(actualBytesExact);
        return error;
    }

    function recordMediaIncluded(mediaType) {
        state.exportStats.media.included++;
        incrementCounter(state.exportStats.media.byType, mediaType || 'file');
    }

    function recordMediaSkipped(mediaType, reason, {
        thumbnail = false,
        name = '',
        actualBytes = null,
        actualBytesExact = true,
        limitBytes = null,
        messageId = null,
        chat = ''
    } = {}) {
        if (thumbnail) {
            state.exportStats.media.thumbnailsSkipped++;
            return;
        }
        state.mediaSkipped++;
        state.exportStats.media.skipped++;
        incrementCounter(state.exportStats.media.skippedByReason, reason || 'unknown');
        if (mediaType && !Object.prototype.hasOwnProperty.call(state.exportStats.media.byType, mediaType)) {
            state.exportStats.media.byType[mediaType] = 0;
        }
        const detail={
            type:mediaType||'file',
            name:sanitizeFilename(name||'unnamed-media'),
            reason:reason||'unknown',
            actualBytes:Number.isFinite(Number(actualBytes))&&Number(actualBytes)>=0?Number(actualBytes):null,
            actualBytesExact:Boolean(actualBytesExact),
            limitBytes:Number.isFinite(Number(limitBytes))&&Number(limitBytes)>0?Number(limitBytes):null,
            messageId:Number.isFinite(Number(messageId))?Number(messageId):null,
            chat:String(chat||state.chatName||'').slice(0,256)
        };
        if(state.exportStats.media.skippedItems.length<MAX_SKIPPED_ITEM_DETAILS){
            state.exportStats.media.skippedItems.push(detail);
        } else {
            state.exportStats.media.skippedItemsTruncated++;
        }
    }

    function getMessageRange(messages) {
        let oldest=null;
        let newest=null;
        for(const message of messages||[]){
            const unixSeconds=Number(message?.date_unixtime);
            const date=Number.isFinite(unixSeconds)&&unixSeconds>0
                ?new Date(unixSeconds*1000)
                :toValidDate(message?.date);
            if(!date)continue;
            const iso=date.toISOString();
            if(!oldest||iso<oldest)oldest=iso;
            if(!newest||iso>newest)newest=iso;
        }
        return {oldestMessageDate:oldest,newestMessageDate:newest};
    }

    function normalizeCoverageTargetDate(value) {
        const match=String(value||'').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if(!match)return '';
        const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
        const date=new Date(Date.UTC(year,month-1,day));
        if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return '';
        return match[0];
    }

    function getMessageCalendarDate(message) {
        const direct=normalizeCoverageTargetDate(String(message?.date||'').slice(0,10));
        if(direct)return direct;
        const unixSeconds=Number(message?.date_unixtime);
        const date=Number.isFinite(unixSeconds)&&unixSeconds>0
            ?new Date(unixSeconds*1000)
            :toValidDate(message?.date);
        if(!date)return '';
        const year=date.getFullYear();
        const month=String(date.getMonth()+1).padStart(2,'0');
        const day=String(date.getDate()).padStart(2,'0');
        return `${year}-${month}-${day}`;
    }

    function normalizeExportRange(value) {
        if(RUST_CORE)return RUST_CORE.normalizeExportRange(value);
        const input=value&&typeof value==='object'?value:{};
        if(input.mode==='all')return {mode:'all'};
        if(input.mode==='dates'){
            const from=normalizeCoverageTargetDate(input.from);
            const to=normalizeCoverageTargetDate(input.to);
            if(!from||!to||from>to)throw new Error('invalid date range');
            return {mode:'dates',from,to};
        }
        const parsed=Number(input.count);
        return {mode:'recent',count:Number.isFinite(parsed)?Math.min(100000,Math.max(1,Math.round(parsed))):500};
    }

    function compareMessagesChronologically(left,right) {
        const leftTime=Number(left?.date_unixtime)||Number(toValidDate(left?.date)?.getTime()||0)/1000;
        const rightTime=Number(right?.date_unixtime)||Number(toValidDate(right?.date)?.getTime()||0)/1000;
        return leftTime-rightTime||(Number(left?.id)||0)-(Number(right?.id)||0);
    }

    function filterMessagesForRange(messages,range=state.exportRange) {
        if(RUST_CORE){
            const result=RUST_CORE.filterMessagesForRange(Array.from(messages||[]),range);
            if(state.exportStats)state.exportStats.rangeMessagesIncluded=result.length;
            return result;
        }
        const normalized=normalizeExportRange(range);
        const ordered=[...(messages||[])].sort(compareMessagesChronologically);
        let result=ordered;
        if(normalized.mode==='recent')result=ordered.slice(-normalized.count);
        else if(normalized.mode==='dates')result=ordered.filter(message=>{
            const date=getMessageCalendarDate(message);
            return Boolean(date&&date>=normalized.from&&date<=normalized.to);
        });
        if(state.exportStats)state.exportStats.rangeMessagesIncluded=result.length;
        return result;
    }

    function selectedRangeLoaded() {
        const range=normalizeExportRange(state.exportRange);
        if(range.mode==='all')return false;
        if(range.mode==='recent')return state.messages.size>=range.count;
        const oldest=getOldestMessageCalendarDate(state.messages.values());
        return Boolean(oldest&&oldest<=range.from);
    }

    function getOldestMessageCalendarDate(messages) {
        let oldest='';
        for(const message of messages||[]){
            const date=getMessageCalendarDate(message);
            if(date&&(!oldest||date<oldest))oldest=date;
        }
        return oldest;
    }

    function getNewestMessageCalendarDate(messages) {
        let newest='';
        for(const message of messages||[]){
            const date=getMessageCalendarDate(message);
            if(date&&(!newest||date>newest))newest=date;
        }
        return newest;
    }

    function historyDirectionSatisfied(direction, range=state.exportRange) {
        const normalized=normalizeExportRange(range);
        if(normalized.mode==='all')return false;
        if(direction==='older'){
            if(normalized.mode==='recent')return state.messages.size>=normalized.count;
            const oldest=getOldestMessageCalendarDate(state.messages.values());
            return Boolean(oldest&&oldest<=normalized.from);
        }
        if(normalized.mode==='recent')return false;
        const newest=getNewestMessageCalendarDate(state.messages.values());
        return Boolean(newest&&newest>=normalized.to);
    }

    function historyScanPlan(range=state.exportRange) {
        const normalized=normalizeExportRange(range);
        if(normalized.mode==='all')return {newer:true,older:true};
        if(normalized.mode==='recent')return {newer:true,older:true};
        const oldest=getOldestMessageCalendarDate(state.messages.values());
        const newest=getNewestMessageCalendarDate(state.messages.values());
        return {
            newer:!newest||newest<normalized.to,
            older:!oldest||oldest>normalized.from
        };
    }

    function coverageTargetReachedForMessages(messages,targetDate=state.exportStats?.coverageTargetDate) {
        const target=normalizeCoverageTargetDate(targetDate);
        if(!target)return null;
        const oldest=getOldestMessageCalendarDate(messages);
        return oldest?oldest<=target:false;
    }

    function recordMessageRange(messages) {
        const range=getMessageRange(messages);
        if(range.oldestMessageDate&&(!state.exportStats.oldestMessageDate||range.oldestMessageDate<state.exportStats.oldestMessageDate))state.exportStats.oldestMessageDate=range.oldestMessageDate;
        if(range.newestMessageDate&&(!state.exportStats.newestMessageDate||range.newestMessageDate>state.exportStats.newestMessageDate))state.exportStats.newestMessageDate=range.newestMessageDate;
        return range;
    }

    function recordChatCoverage(chatInfo,messages) {
        const range=getMessageRange(messages);
        const oldestCalendarDate=getOldestMessageCalendarDate(messages);
        state.exportStats.chatCoverage.push({
            name:String(chatInfo?.name||state.chatName||'Unknown Chat').slice(0,256),
            messagesIncluded:Array.isArray(messages)?messages.length:0,
            oldestMessageDate:range.oldestMessageDate,
            newestMessageDate:range.newestMessageDate,
            oldestCalendarDate:oldestCalendarDate||null,
            coverageTargetReached:coverageTargetReachedForMessages(messages)
        });
        return range;
    }

    function snapshotExportStats() {
        const stats = JSON.parse(JSON.stringify(state.exportStats || createExportStats()));
        stats.partial = Boolean(state.cancelled || stats.partial);
        stats.media.pending = Math.max(0, stats.media.discovered - stats.media.included - stats.media.skipped - stats.media.notSelected);
        if(stats.coverageTargetDate){
            const chats=Array.isArray(stats.chatCoverage)?stats.chatCoverage:[];
            const allRequestedVerified=Number(stats.chatsRequested)>0&&Number(stats.chatsIncluded)===Number(stats.chatsRequested)&&Number(stats.chatsSkipped)===0&&!stats.partial;
            stats.coverageTargetReached=Boolean(allRequestedVerified&&chats.length===Number(stats.chatsRequested)&&chats.every(chat=>chat?.coverageTargetReached===true));
        }else{
            stats.coverageTargetReached=null;
        }
        return stats;
    }

    const state = {
        messages: new Map(), isExporting: false, isDownloading: false, cancelled: false,
        scrollAttempts: 0, staleCount: 0,
        observer: null, scrollContainer: null,
        chatName: 'Unknown Chat', chatType: 'personal_chat', chatId: null,
        exportStartTime: null, topics: [], currentTopicName: 'General', currentTopicId: null,
        mediaQueue: [], mediaDownloaded: 0, mediaTotal: 0,
        mediaCounters: { photo:0, video_file:0, voice_message:0, sticker:0, file:0, video_message:0, animation:0 },
        downloadedMedia: new Map(), _currentTopic: null, peerId: null,
        formatHtml: true, formatJson: true,
        exportPhotos: true, exportVideos: true, exportVoice: true, exportStickers: true, exportFiles: true,
        exportMode: 'current', selectedChats: [], chatList: [],
        maxPhotoSize: 10*1024*1024, maxVideoSize: 100*1024*1024, maxFileSize: 100*1024*1024,
        dialog: null, dialogRoot: null, dialogOpening: false, previousFocus: null, progressEl: null, progressText: '', lastProgressPct: 0, lastOutcome: null, lastErrorCode: null, lastDownload: null,
        currentChatIndex: 0, mediaSkipped: 0, activeControllers: new Set(), nativeController: null, nativeReady: false, fullChatList: null,
        archivePassword: '', coverageTargetDate: '', exportRange: {mode:'all'}, dialogCleanup: null,
        quickMode: false, quickHost: null, quickRoot: null, quickLabels: null, quickLocale: 'en', quickStartedAt: 0, quickElapsedTimer: null,
        backgroundJobId: '', backgroundRemote: false, backgroundLastSentAt: 0, backgroundPending: null, backgroundTimer: null,
        batchContext: null, batchCompletedCount: 0, batchRunAll: false, completedBatchStats: {}, batchResume: readBatchResumeSession(), onboardingCompleted: false, exportStats: createExportStats(), lastExportStats: null,
        exportSession: null, rustCoreVersion: String(RUST_CORE?.version||'')
    };

    function typedExportLabels() {
        return {
            title:tr('extensionName','Local Archive'),
            preparing:tr('quickPreparing','Preparing export…'),
            reading:tr('quickReading','Reading messages…'),
            saving:tr('quickSaving','Saving archive…'),
            saved:tr('quickSaved','Archive saved'),
            failed:tr('quickFailed','Export failed'),
            emptyRange:tr('errorNoMessages','No messages were found in the selected range.'),
            messages:tr('quickMessages','{count} messages'),
            mediaSkipped:tr('quickMediaSkipped','{count} attachments skipped'),
            cancel:tr('cancel','Cancel'),
            close:tr('close','Close'),
            showFile:tr('showFile','Show file'),
            keepOpen:tr('quickKeepOpen','Keep this Telegram tab open until the ZIP is saved.'),
            elapsed:tr('quickElapsed','Elapsed: {time}'),
            file:tr('quickFile','ZIP: {filename} · {size}'),
            ...(state.quickLabels||{})
        };
    }

    function typedExportRequest() {
        return {
            format:state.formatHtml?(state.formatJson?'both':'html'):'json',
            includeMedia:Boolean(state.exportPhotos||state.exportVideos||state.exportVoice||state.exportStickers||state.exportFiles),
            locale:String(state.quickLocale||document.documentElement.lang||'en').slice(0,16),
            range:normalizeExportRange(state.exportRange),
            labels:typedExportLabels()
        };
    }

    function beginTypedExportSession() {
        if(state.exportMode!=='current')return null;
        if(!RUST_CORE){
            if(EXTENSION_MODE||EXTENSION_BUILD){
                const error=new Error('The typed Rust export core did not load.');
                error.code='archive-engine-failed';
                throw error;
            }
            return null;
        }
        state.exportSession=RUST_CORE.createExportSession(typedExportRequest());
        return state.exportSession;
    }

    function typedSessionIsTerminal(session=state.exportSession) {
        if(!session)return true;
        try{return ['complete','cancelled','failed'].includes(String(session.snapshot()?.phase||''));}
        catch(_){return false;}
    }

    function failTypedExportSession(error) {
        const session=state.exportSession;
        if(!session||typedSessionIsTerminal(session))return;
        try{session.fail(String(error?.code||'unexpected'),String(error?.message||error||'Export failed'));}catch(_){}
    }

    function failAndShowExport(message,code='unexpected') {
        const error=new Error(String(message||'Export failed'));
        error.code=String(code||'unexpected');
        failTypedExportSession(error);
        showError(error.message,error.code);
    }

    function releaseTypedExportSession() {
        const session=state.exportSession;
        state.exportSession=null;
        if(session&&typeof session.free==='function'){
            try{session.free();}catch(_){}
        }
    }

    function setCancelled(v) {
        if(!v){state.cancelled=false;return true;}
        if(v){
            const session=state.exportSession;
            if(session&&!typedSessionIsTerminal(session)){
                try{session.requestPartial();}catch(_){return false;}
            }
            state.cancelled=true;
            for(const controller of state.activeControllers){try{controller.abort();}catch(_){}}
        }
        return true;
    }

    function backgroundJobId() {
        return String(state.backgroundJobId||'');
    }

    function clearBackgroundJobState() {
        if(state.backgroundTimer){clearTimeout(state.backgroundTimer);state.backgroundTimer=null;}
        state.backgroundPending=null;
        state.backgroundLastSentAt=0;
        state.backgroundJobId='';
        state.backgroundRemote=false;
    }

    function isQuickExportBusy() {
        return Boolean(state.isExporting||(state.backgroundRemote&&state.backgroundJobId));
    }

    function sendBackgroundProgress(phase, text, pct, extra = {}) {
        if(!state.backgroundJobId||state.backgroundRemote||!EXTENSION_MODE||typeof browser==='undefined'||typeof browser.runtime?.sendMessage!=='function') return;
        const payload={
            type:'telearchive.background-export.progress.v1',
            jobId:String(state.backgroundJobId),
            phase:String(phase||'reading'),
            text:String(text||''),
            pct:Math.max(0,Math.min(100,Number(pct)||0)),
            messages:Number(state.messages?.size)||0,
            ...extra
        };
        const now=Date.now();
        const terminal=phase==='complete'||phase==='error';
        if(terminal){
            if(state.backgroundTimer){clearTimeout(state.backgroundTimer);state.backgroundTimer=null;}
            state.backgroundPending=null;
        }
        if(!terminal&&now-Number(state.backgroundLastSentAt||0)<180){
            state.backgroundPending=payload;
            if(!state.backgroundTimer){
                state.backgroundTimer=setTimeout(()=>{
                    state.backgroundTimer=null;
                    const pending=state.backgroundPending;
                    state.backgroundPending=null;
                    if(pending)sendBackgroundProgress(pending.phase,pending.text,pending.pct,pending);
                },200);
            }
            return;
        }
        state.backgroundLastSentAt=now;
        try{void browser.runtime.sendMessage(payload).catch(()=>{});}catch(_){ }
    }

    /* ================================================================
       DOM INTERFACE
       ================================================================ */
    function findScrollContainer() {
        // Telegram Web K keeps the actual scroll owner on `.bubbles-scrollable`.
        // The inner `.bubbles`/`.bubbles-inner` nodes are virtualized render
        // surfaces; writing scrollTop to them can stop at the currently
        // rendered window and never ask Telegram for older history.
        const s = ['.bubbles-scrollable','.bubbles-viewport','[data-scope="bubbles"]','div.scrollable','div[class*="scrollable"]','div.bubbles',
            'div[class*="bubbles"]','.chat-bubbles-list','div.messages-container','#column-center .chat',
            'div.im_history_scrollable','.im_history_scrollable','div[class*="chat"][class*="scroll"]','.history'];
        for(const sel of s) {
            for(const el of document.querySelectorAll(sel)) {
                if(el && (el.scrollHeight>el.clientHeight || el.scrollTop!==undefined)) {
                    const hasMessageSurface=Boolean(el.querySelector?.('[data-mid],[data-message-id],[data-scope="bubble"],.message-list-item,.im_message_wrap,.bubble'));
                    if(sel==='div[class*="bubbles"]'&&!hasMessageSurface) continue;
                    return el;
                }
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
        e = document.querySelectorAll('.message-list-item,.im_message_wrap,[class*="message" i],[class*="bubble" i]');
        return Array.from(e).filter(element=>{
            if(!(element instanceof Element))return false;
            if(element.matches('input,textarea,button,[contenteditable="true"],[role="textbox"],.input-message-input,[class*="composer" i],[class*="input-message" i]'))return false;
            if(element.closest('.input-message-input,[class*="composer" i],[class*="input-message" i]'))return false;
            if(element.matches('.message-list-item,.im_message_wrap'))return true;
            const tokens=Array.from(element.classList,token=>token.toLocaleLowerCase());
            if(tokens.some(token=>/message-(?:text|input|field|button|menu|status|count|icon)|bubble-(?:text|button|menu|status|icon)/u.test(token)))return false;
            const messageContainer=tokens.some(token=>/^(?:message|bubble)(?:$|-(?:row|item|wrap|container|bubble|list-item))/u.test(token));
            if(!messageContainer)return false;
            return Boolean(element.querySelector('time,[datetime],[data-scope="text"],.text-content,.message-text,[class*="message-text" i]'));
        });
    }
    function getMessageId(el) {
        return el.getAttribute('data-mid')
            ||el.getAttribute('data-message-id')
            ||el.getAttribute('data-id')
            ||el.dataset.mid
            ||el.id
            ||el.querySelector?.('[data-mid],[data-message-id]')?.getAttribute('data-mid')
            ||el.querySelector?.('[data-mid],[data-message-id]')?.getAttribute('data-message-id')
            ||'';
    }
    function getMessageContainerFamily(el) {
        if(!(el instanceof Element))return 'unknown';
        if(el.matches('[data-mid]'))return '[data-mid]';
        if(el.matches('[data-message-id]'))return '[data-message-id]';
        if(el.matches('[data-scope="bubble"]'))return '[data-scope="bubble"]';
        if(el.matches('.message-list-item'))return '.message-list-item';
        if(el.matches('.im_message_wrap'))return '.im_message_wrap';
        if(el.id&&parseMessageId(el.id)!==null)return 'id-backed message';
        return 'message container';
    }
    function inspectRenderedMessageCompatibility() {
        const chat=getActiveChatInfo();
        const elements=Array.from(getMessageElements());
        if(!chat)return {ok:false,reason:'no_chat',renderedCount:elements.length,recognizedCount:0,readableCount:0,families:[]};
        if(elements.length===0)return {ok:false,reason:'no_messages',renderedCount:0,recognizedCount:0,readableCount:0,families:[]};
        const families=new Set();
        let recognizedCount=0;
        let readableCount=0;
        for(const element of elements.slice(0,50)){
            if(!(element instanceof Element))continue;
            const messageId=parseMessageId(getMessageId(element));
            if(messageId===null)continue;
            recognizedCount++;
            families.add(getMessageContainerFamily(element));
            const textElement=element.querySelector('[data-scope="text"],.message-text,.bubble-content .message,[class*="text-entity"]');
            let hasMedia=false;
            try{hasMedia=extractMediaInfo(element).length>0;}catch(_){hasMedia=false;}
            if(Boolean(textElement)||hasMedia||isServiceMessage(element)||Boolean(getTimestamp(element)))readableCount++;
        }
        if(recognizedCount===0)return {ok:false,reason:'message_ids_unreadable',renderedCount:elements.length,recognizedCount,readableCount,families:[...families]};
        if(readableCount===0)return {ok:false,reason:'message_content_unreadable',renderedCount:elements.length,recognizedCount,readableCount,families:[...families]};
        return {ok:true,reason:'passed',renderedCount:elements.length,recognizedCount,readableCount,families:[...families]};
    }
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
    function getOldestLoadedTimestamp() {
        let oldest='';
        for(const element of Array.from(getMessageElements())){
            const timestamp=getTimestamp(element);
            if(timestamp&&(!oldest||timestamp<oldest))oldest=timestamp;
        }
        return oldest;
    }
    function formatUiDateTime(value) {
        const date=toValidDate(value);
        if(!date)return '';
        try{
            const locale=typeof browser!=='undefined'&&browser?.i18n?.getUILanguage?browser.i18n.getUILanguage():undefined;
            return new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(date);
        }catch(_){
            return date.toLocaleString();
        }
    }
    function formatUiCalendarDate(value) {
        const normalized=normalizeCoverageTargetDate(value);
        if(!normalized)return '';
        const [year,month,day]=normalized.split('-').map(Number);
        const date=new Date(year,month-1,day,12,0,0,0);
        try{
            const locale=typeof browser!=='undefined'&&browser?.i18n?.getUILanguage?browser.i18n.getUILanguage():undefined;
            return new Intl.DateTimeFormat(locale,{dateStyle:'medium'}).format(date);
        }catch(_){
            return normalized;
        }
    }
    function calendarDateFromTimestamp(value) {
        const date=toValidDate(value);
        if(!date)return '';
        const year=date.getFullYear();
        const month=String(date.getMonth()+1).padStart(2,'0');
        const day=String(date.getDate()).padStart(2,'0');
        return `${year}-${month}-${day}`;
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
                const explicitType=v.getAttribute('data-media-type')||v.closest('[data-media-type]')?.getAttribute('data-media-type')||'';
                const isVM=explicitType==='video_message'||!!v.closest('[class*="video_message"],[class*="round"],[class*="video_msg"]');
                const isVoice=explicitType==='voice_message'||!!v.closest('[class*="voice"],[class*="audio"]');
                const type=explicitType==='video_file'||explicitType==='video_message'||explicitType==='voice_message'||explicitType==='animation'
                    ?explicitType:(isVM?'video_message':isVoice?'voice_message':'video_file');
                items.push({type,url:src,duration:Number.isFinite(v.duration)?v.duration:0,width:v.videoWidth||0,height:v.videoHeight||0});
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
        if(String(url||'').startsWith('data:')){
            const mime=String(url).slice(5).split(/[;,]/,1)[0].trim().toLowerCase();
            const dataExt=getExtFromMime(mime);
            if(dataExt&&dataExt!=='bin') return dataExt;
        }
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
    function extractMessage(el, allowSeen=false) {
        const mid=getMessageId(el);
        if(!mid) return null;
        const messageId=parseMessageId(mid);
        if(messageId===null) return null;
        if(!allowSeen&&state.messages.has(messageId)) return null;

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

    async function collectNativeTelegramHistory() {
        if(!NATIVE_HISTORY||!EXTENSION_MODE)return null;
        const requested=normalizeExportRange(state.exportRange);
        const inspection=await NATIVE_HISTORY.inspect();
        state.nativeReady=Boolean(inspection?.ready);
        if(!inspection?.ready)return null;
        state.chatName=String(inspection.chatName||getChatTitle()||'Unknown Chat');
        state.chatId=Number(inspection.peerId)||state.chatId||0;
        state.peerId=Number(inspection.peerId)||0;
        state.chatType=String(inspection.chatType||detectChatType()||'personal_chat');
        resetHistoryLoadStats();
        updateHistoryLoadStats({
            attempted:true,
            initialMessages:state.messages.size,
            source:'telegram-web-api',
            transport:'page-manager',
        });
        const controller=new AbortController();
        state.nativeController=controller;
        state.activeControllers.add(controller);
        let result;
        try {
            result=await NATIVE_HISTORY.collect({
                range:requested,
                threadId:Number(inspection.threadId)||0,
                signal:controller.signal,
                onProgress:progress=>{
                    updateHistoryLoadStats({
                        messagesCollected:Number(progress.messages)||0,
                        batches:Number(progress.batch)||0,
                        oldestDate:String(progress.oldestDate||''),
                        newestDate:String(progress.newestDate||''),
                    });
                    updateProgress(tr('statusScanningOlder','Loading Telegram history automatically… '+(Number(progress.messages)||0)+' found',[String(progress.messages||0)]));
                }
            });
        } finally {
            state.activeControllers.delete(controller);
            if(state.nativeController===controller)state.nativeController=null;
        }
        if(!result?.available){
            // A manager failure before the first page is safe to hand back to
            // the rendered connector; do not strand the export on a transient
            // Telegram Web bootstrap race.
            state.nativeReady=false;
            return null;
        }
        state.messages.clear();
        for(const message of result.messages||[]){
            if(message&&Number.isSafeInteger(Number(message.id)))state.messages.set(Number(message.id),message);
        }
        state.exportStats.historySource='telegram-web-api';
        // Keep the conservative public marker required by the archive
        // verifier; expose the exact transport result separately.
        state.exportStats.completeHistoryNotGuaranteed=true;
        state.exportStats.historyComplete=Boolean(result.complete);
        if(result.error)state.exportStats.partial=true;
        updateHistoryLoadStats({
            attempted:true,
            completed:Boolean(result.complete),
            edgeReached:result.stoppedReason==='oldest-edge',
            messagesCollected:state.messages.size,
            stoppedReason:String(result.stoppedReason||'unknown'),
            nativeBatches:Number(result.batches)||0,
            nativeCount:result.count===null?null:Number(result.count)||0,
            ...(result.error?{error:String(result.error).slice(0,240)}:{}),
        });
        return result;
    }

    /* ================================================================
       SCROLL ENGINE
       ================================================================ */
    function getHistorySnapshot() {
        const c=state.scrollContainer;
        const timestamps=Array.from(getMessageElements()).map(getTimestamp).filter(Boolean).sort();
        return {
            messageCount:state.messages.size,
            renderedCount:getMessageElements().length,
            oldestTimestamp:timestamps[0]||'',
            newestTimestamp:timestamps[timestamps.length-1]||'',
            scrollTop:Number(c?.scrollTop)||0,
            scrollHeight:Number(c?.scrollHeight)||0,
            clientHeight:Number(c?.clientHeight)||0
        };
    }

    function historySnapshotProgressed(before, direction) {
        const after=getHistorySnapshot();
        if(after.messageCount>before.messageCount)return true;
        if(direction==='older'&&before.oldestTimestamp&&after.oldestTimestamp&&after.oldestTimestamp<before.oldestTimestamp)return true;
        if(direction==='newer'&&before.newestTimestamp&&after.newestTimestamp&&after.newestTimestamp>before.newestTimestamp)return true;
        return false;
    }

    function historyIsNearEdge(direction, threshold=24) {
        const c=state.scrollContainer;
        if(!c)return false;
        const top=Number(c.scrollTop)||0;
        const maxTop=Math.max(0,(Number(c.scrollHeight)||0)-(Number(c.clientHeight)||0));
        return direction==='older' ? top<=threshold : (maxTop-top)<=threshold;
    }

    function historyLooksBusy() {
        const c=state.scrollContainer||document;
        return Boolean(c.querySelector?.('[aria-busy="true"],[data-loading="true"],.loading,.progress-ring,.spinner,[class*="loading" i],[class*="spinner" i]'));
    }

    async function scrollMessages(direction) {
        const c=state.scrollContainer; if(!c) return false;
        const prev=Number(c.scrollTop)||0;
        const maxTop=Math.max(0,(Number(c.scrollHeight)||0)-(Number(c.clientHeight)||0));
        const target=direction==='newer'
            ?Math.min(maxTop,prev+CONFIG.scrollStep)
            :Math.max(0,prev-CONFIG.scrollStep);
        // Assign first: Firefox and Telegram's own Scrollable react to the
        // property write. A few test/embedded DOMs expose scrollTo without
        // actually updating scrollTop, so scrollTo is only a fallback.
        c.scrollTop=target;
        if(Math.abs((Number(c.scrollTop)||0)-target)>1&&typeof c.scrollTo==='function'){
            try{c.scrollTo({top:target,left:0,behavior:'auto'});}catch(_){ }
        }
        // Telegram Web's Scrollable checks its top/bottom trigger from the
        // scroll event. Dispatching it explicitly also handles the edge case
        // where the virtualized list is already clamped at scrollTop=0.
        try{c.dispatchEvent(new Event('scroll',{bubbles:true,cancelable:false}));}catch(_){ }
        await sleep(50);
        return Math.abs((Number(c.scrollTop)||0)-prev)>1;
    }

    async function waitForHistoryProgress(before, direction) {
        const edge=historyIsNearEdge(direction);
        const timeout=edge?Number(CONFIG.historyEdgeWaitMs)||2200:Number(CONFIG.scrollWaitMs)||800;
        // Prefer the DOM's own mutation signal over a fixed sleep. This keeps
        // background tabs responsive while still retaining a hard upper bound
        // for a page that never arrives.
        const target=state.scrollContainer||document;
        return await new Promise(resolve=>{
            let settled=false;
            let observer=null;
            let timer=null;
            const finish=value=>{
                if(settled)return;
                settled=true;
                if(timer)clearTimeout(timer);
                try{observer?.disconnect();}catch(_){ }
                resolve(Boolean(value));
            };
            const probe=()=>{
                if(state.cancelled){finish(false);return;}
                collectVisibleMessages();
                finish(historySnapshotProgressed(before,direction));
            };
            try{
                observer=new MutationObserver(()=>{
                    if(state.cancelled){finish(false);return;}
                    collectVisibleMessages();
                    if(historySnapshotProgressed(before,direction))finish(true);
                });
                observer.observe(target,{childList:true,subtree:true,attributes:false});
            }catch(_){
                observer=null;
            }
            timer=setTimeout(probe,Math.max(100,timeout));
        });
    }

    function updateHistoryProgress(direction) {
        const statusKey=direction==='newer'?'statusScanningNewer':'statusScanningOlder';
        const fallback=direction==='newer'
            ?'Checking newer messages… '+state.messages.size+' found'
            :'Loading older messages automatically… '+state.messages.size+' found';
        updateProgress(tr(statusKey,fallback,[String(state.messages.size)]));
    }

    /*
     * Do not stop merely because scrollTop reached the edge. Telegram loads
     * older pages asynchronously after the edge trigger and may keep the same
     * scrollTop while it inserts a new virtualized page. The old implementation
     * broke at that first clamped write, which is why an export could contain
     * only the initially rendered window.
     */
    async function collectScrollDirection(direction, startingScrollTop=0) {
        state.staleCount=0;
        let edgeNoProgress=0;
        while(!state.cancelled){
            if(historyDirectionSatisfied(direction,state.exportRange)){
                updateHistoryLoadStats({stoppedReason:'range-covered'});
                break;
            }
            state.scrollAttempts++;
            updateHistoryLoadStats({scrollAttempts:state.scrollAttempts});
            if(state.scrollAttempts>Number(CONFIG.historyMaxScrollAttempts||10000)){
                updateHistoryLoadStats({stoppedReason:'attempt-limit'});
                break;
            }
            const before=getHistorySnapshot();
            const didScroll=await scrollMessages(direction);
            const progressed=await waitForHistoryProgress(before,direction);
            collectVisibleMessages();
            const atEdge=historyIsNearEdge(direction);
            // A clamped edge may report a tiny scrollTop change even though
            // Telegram did not append a page. Do not let that synthetic
            // movement reset the edge watchdog; only a real history change
            // or movement away from the edge counts as progress.
            if(progressed||(didScroll&&!atEdge)){
                state.staleCount=0;
                if(progressed||!atEdge) edgeNoProgress=0;
            }else if(atEdge||!didScroll){
                edgeNoProgress++;
                state.staleCount=0;
            }else{
                state.staleCount++;
            }
            updateHistoryLoadStats({
                messagesCollected:Math.max(Number(state.exportStats?.historyLoad?.messagesCollected)||0,state.messages.size),
                noProgressPasses:Math.max(Number(state.exportStats?.historyLoad?.noProgressPasses)||0,edgeNoProgress)
            });
            updateHistoryProgress(direction);
            if(historyDirectionSatisfied(direction,state.exportRange)){
                updateHistoryLoadStats({stoppedReason:'range-covered'});
                break;
            }
            if(atEdge&&edgeNoProgress>=Number(CONFIG.historyEdgeStaleThreshold||3)){
                // A stable edge with no loading indicator is Telegram's
                // observable end-of-history boundary. Keep the integrity flag
                // conservative, but record that the loader reached this edge.
                if(direction==='older'){
                    updateHistoryLoadStats({completed:!historyLooksBusy(),edgeReached:true,stoppedReason:historyLooksBusy()?'edge-timeout':'oldest-edge'});
                }else{
                    updateHistoryLoadStats({stoppedReason:'newest-edge'});
                }
                break;
            }
            if(state.staleCount>=Number(CONFIG.staleThreshold||10)){
                updateHistoryLoadStats({stoppedReason:'no-progress'});
                break;
            }
            await sleep(50);
        }
        // Keep this function's historical return contract for callers that
        // only need to know whether cancellation occurred.
        return !state.cancelled;
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
        const nativeResult=await collectNativeTelegramHistory();
        if(nativeResult){
            if(state.observer){state.observer.disconnect();state.observer=null;}
            return;
        }
        resetHistoryLoadStats();
        updateHistoryLoadStats({attempted:true,initialMessages:state.messages.size});
        setupMutationObserver();
        collectVisibleMessages();
        state.staleCount=0; state.scrollAttempts=0;
        const startingScrollTop=Number(state.scrollContainer?.scrollTop||0);
        const plan=historyScanPlan(state.exportRange);
        // A user may open the exporter while previewing an older part of a
        // virtualized chat. Traverse to the newest edge first, then walk back
        // through older history so neither side of that starting viewport is
        // silently omitted.
        if(plan.newer){
            updateProgress(tr('statusScanningNewer','Checking newer messages… '+state.messages.size+' found',[String(state.messages.size)]));
            await collectScrollDirection('newer',startingScrollTop);
        }
        if(!state.cancelled&&plan.older){
            updateProgress(tr('statusScanningOlder','Loading older messages automatically… '+state.messages.size+' found',[String(state.messages.size)]));
            await collectScrollDirection('older',startingScrollTop);
        }
        if(state.observer){state.observer.disconnect();state.observer=null;}
        collectVisibleMessages();
        updateHistoryLoadStats({messagesCollected:Math.max(Number(state.exportStats?.historyLoad?.messagesCollected)||0,state.messages.size)});
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
                updateProgress(tr('statusSwitchingTopic','Opening topic: '+safeTopic,[safeTopic]));
                const ok=await switchToTopic(t);
                if(!ok){log('Failed to switch topic: '+t.name);continue;}
            } else {
                updateProgress(tr('statusTopic','Reading topic: '+safeTopic,[safeTopic]));
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
    async function showModernExportDialog() {
        if(state.dialog){
            const focusTarget=(state.dialogRoot||state.dialog).querySelector('#tgx-export,#tgx-cancel,button');
            if(focusTarget) focusTarget.focus();
            return;
        }
        if(state.dialogOpening) return;
        state.dialogOpening=true;
        try {
            const preferences=applyPreferencesToState(await loadStoredPreferences());
            let activeInfo=getActiveChatInfo();
            let currentName=activeInfo&&activeInfo.name?activeInfo.name:tr('unknownChat','No chat detected');
            let oldestLoadedTimestamp=getOldestLoadedTimestamp();
            let loadedMessageCount=getMessageElements().length;
            const iconUrl=EXTENSION_MODE?browser.runtime.getURL('icon-48.png'):'';

            const host=document.createElement('div');
            host.id='telearchive-extension-root';
            host.dataset.firstRun='false';
            host.dataset.interfaceVersion='universal-v2';
            const root=host.attachShadow({mode:'open'});
            const legacyCss=[
                ':host{all:initial;position:fixed;inset:0;z-index:2147483647;display:block;color-scheme:light;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.45;color:#14213a}',
                '*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}',
                '.tgx-backdrop{position:absolute;inset:0;display:grid;place-items:center;padding:24px;background:rgba(4,12,29,.72);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}',
                '.tgx-modal{display:grid;grid-template-rows:auto minmax(0,1fr) auto auto;width:min(920px,96vw);max-height:min(900px,94vh);overflow:hidden;border:1px solid rgba(145,170,207,.28);border-radius:26px;background:#f5f8fc;box-shadow:0 32px 100px rgba(0,0,0,.38)}',
                '.tgx-header{display:flex;align-items:center;gap:15px;padding:22px 25px;border-bottom:1px solid #dce5ef;background:linear-gradient(115deg,#0a244f,#0d3868);color:#fff}',
                '.tgx-brand{width:48px;height:48px;object-fit:contain;filter:drop-shadow(0 8px 16px rgba(0,0,0,.22))}.tgx-heading{min-width:0;flex:1}.tgx-eyebrow{display:block;margin-bottom:3px;color:#83e9f5;font-size:10px;font-weight:850;letter-spacing:.14em}.tgx-header h1{margin:0;font-size:24px;line-height:1.1;letter-spacing:-.03em}.tgx-header p{margin:6px 0 0;color:#cbdaf0;font-size:12.5px}',
                '.tgx-icon-button{display:grid;width:38px;height:38px;place-items:center;border:1px solid rgba(255,255,255,.22);border-radius:12px;background:rgba(255,255,255,.08);color:#fff;font-size:22px;line-height:1}.tgx-icon-button:hover{background:rgba(255,255,255,.15)}',
                '.tgx-body{display:grid;grid-template-columns:minmax(0,1fr) 270px;min-height:0}.tgx-form{min-width:0;overflow:auto;padding:23px 24px 28px}.tgx-aside{padding:24px;border-left:1px solid #dce5ef;background:#eef4f9}',
                '.tgx-section+.tgx-section{margin-top:23px}.tgx-section-title{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:11px}.tgx-section-title h2{margin:0;color:#142541;font-size:15px;letter-spacing:-.01em}.tgx-section-title p{max-width:410px;margin:3px 0 0;color:#708097;font-size:11.5px}',
                '.tgx-choice-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.tgx-choice-grid--three{grid-template-columns:repeat(3,minmax(0,1fr))}.tgx-choice{position:relative;display:flex;min-height:58px;align-items:flex-start;gap:10px;padding:13px;border:1px solid #d7e0ea;border-radius:14px;background:#fff;cursor:pointer;transition:border-color .15s ease,box-shadow .15s ease,transform .15s ease}.tgx-choice:hover{border-color:#a9c4d5;transform:translateY(-1px)}.tgx-choice:has(input:checked){border-color:#13a9c2;box-shadow:0 0 0 3px rgba(19,169,194,.1)}.tgx-choice input{width:17px;height:17px;margin:1px 0 0;accent-color:#079ab5}.tgx-choice strong{display:block;color:#172944;font-size:13px}.tgx-choice small{display:block;margin-top:3px;color:#758399;font-size:10.5px;line-height:1.35}',
                '.tgx-panel{margin-top:10px;padding:12px;border:1px solid #d7e0ea;border-radius:14px;background:#fff}.tgx-panel[hidden]{display:none}.tgx-select,.tgx-search{width:100%;padding:10px 12px;border:1px solid #ccd8e4;border-radius:10px;background:#f9fbfd;color:#152641;outline:none}.tgx-select:focus,.tgx-search:focus{border-color:#0c9db8;box-shadow:0 0 0 3px rgba(12,157,184,.12)}',
                '.tgx-chat-toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;align-items:center;margin-bottom:9px}.tgx-select-all{display:flex;align-items:center;gap:7px;padding:0 4px;color:#52647c;font-size:11px;white-space:nowrap}.tgx-select-all input{accent-color:#079ab5}.tgx-chat-list{max-height:220px;overflow:auto;border-top:1px solid #e4eaf1;padding-top:7px}.tgx-chat-row{display:flex;align-items:center;gap:9px;padding:8px 7px;border-radius:9px;cursor:pointer}.tgx-chat-row:hover{background:#f1f6fa}.tgx-chat-row[hidden]{display:none}.tgx-chat-row input{width:16px;height:16px;accent-color:#079ab5}.tgx-chat-name{min-width:0;overflow:hidden;color:#243551;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.tgx-chat-empty{padding:18px 8px;color:#718098;font-size:12px;text-align:center}.tgx-selected-count{margin:7px 3px 0;color:#6d7d93;font-size:10.5px}.tgx-batch-planner{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;margin-top:10px;padding:12px 13px;border:1px solid #91d5e1;border-radius:12px;background:#eefbfe;color:#173a50}.tgx-batch-planner[hidden]{display:none}.tgx-batch-mark{display:grid;width:26px;height:26px;place-items:center;border-radius:8px;background:#d6f3f8;color:#087f96;font-size:16px;font-weight:800}.tgx-batch-copy{min-width:0}.tgx-batch-copy strong{display:block;color:#17344d;font-size:11.5px}.tgx-batch-copy p{margin:3px 0 0;color:#557087;font-size:10.5px;line-height:1.5}.tgx-batch-copy small{display:block;margin-top:4px;color:#397285;font-size:9.5px;font-weight:760;line-height:1.45}.tgx-batch-controls{display:flex;align-items:center;gap:6px}.tgx-batch-controls .tgx-button{min-height:32px;padding:7px 10px;white-space:nowrap}.tgx-coverage-goal{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:5px 12px;margin-top:11px;padding:11px 12px;border:1px solid #d8e2ec;border-radius:12px;background:#fff}.tgx-coverage-goal label{color:#243551;font-size:11.5px;font-weight:780}.tgx-coverage-goal input{min-width:145px;padding:7px 9px;border:1px solid #ccd8e4;border-radius:9px;background:#f9fbfd;color:#152641;font-size:11px}.tgx-coverage-goal small{grid-column:1/-1;color:#728298;font-size:9.5px;line-height:1.45}',
                '.tgx-media-list{display:grid;gap:8px}.tgx-media-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;min-height:52px;padding:10px 11px 10px 13px;border:1px solid #d9e2eb;border-radius:13px;background:#fff}.tgx-media-check{display:flex;align-items:center;gap:9px;cursor:pointer}.tgx-media-check input{width:17px;height:17px;accent-color:#079ab5}.tgx-media-check strong{color:#1c2e4a;font-size:12.5px}.tgx-media-inherited-limit{max-width:190px;color:#738298;font-size:9px;line-height:1.35;text-align:right}.tgx-limit{display:flex;align-items:center;gap:7px;color:#738298;font-size:10px}.tgx-number{display:flex;align-items:center;overflow:hidden;border:1px solid #cad6e1;border-radius:9px;background:#f8fafc}.tgx-number input{width:67px;padding:7px 5px 7px 9px;border:0;background:transparent;color:#142641;font-size:11.5px;font-weight:700;outline:0}.tgx-number b{padding:7px;border-left:1px solid #d9e1ea;color:#738298;font-size:9px}',
                '.tgx-protection-choices{display:grid;grid-template-columns:1fr 1fr;gap:10px}.tgx-protection-option{position:relative;min-height:78px;padding:13px 38px 13px 14px;border:1px solid #d7e0ea;border-radius:14px;background:#fff;color:#172944;text-align:left;box-shadow:none}.tgx-protection-option::after{content:"";position:absolute;top:14px;right:14px;width:17px;height:17px;border:2px solid #b8c6d5;border-radius:50%;background:#fff}.tgx-protection-option[aria-pressed="true"]::after{content:"✓";display:grid;place-items:center;border-color:#079ab5;background:#079ab5;color:#fff;font-size:10px;font-weight:900}.tgx-protection-option strong,.tgx-protection-option small{display:block}.tgx-protection-option strong{font-size:12px;line-height:1.35}.tgx-protection-option small{margin-top:6px;color:#66788e;font-size:10px;line-height:1.45}.tgx-protection-option[aria-pressed="true"]{border-color:#13a9c2;background:#f2fbfc;box-shadow:0 0 0 3px rgba(19,169,194,.1)}.tgx-protection-option[data-mode="none"][aria-pressed="true"]{border-color:#d6a148;background:#fff8e9;box-shadow:0 0 0 3px rgba(214,161,72,.11)}.tgx-protection-option[data-mode="none"][aria-pressed="true"]::after{border-color:#b77719;background:#b77719}.tgx-password-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.tgx-password-field{display:grid;gap:5px;color:#52647c;font-size:10px;font-weight:700}.tgx-password-field input{width:100%;padding:10px 11px;border:1px solid #ccd8e4;border-radius:10px;background:#f9fbfd;color:#152641;outline:none}.tgx-password-field input:focus{border-color:#0c9db8;box-shadow:0 0 0 3px rgba(12,157,184,.12)}.tgx-password-note{margin:8px 1px 0;color:#728298;font-size:10px;line-height:1.45}',
                '.tgx-protection-warning{margin:0 0 9px;padding:8px 10px;border-left:3px solid #d19432;border-radius:0 9px 9px 0;background:#fff8e9;color:#6f4b18;font-size:10px;font-weight:720;line-height:1.45}',
                '.tgx-aside-card{padding:16px;border:1px solid #d7e2ec;border-radius:17px;background:#fff}.tgx-aside-card+.tgx-aside-card{margin-top:12px}.tgx-current-label{color:#7b899c;font-size:9px;font-weight:800;letter-spacing:.11em;text-transform:uppercase}.tgx-current-name{margin-top:7px;color:#122441;font-size:15px;font-weight:800;line-height:1.3;overflow-wrap:anywhere}.tgx-summary-label{display:block;margin-top:14px;color:#7c899b;font-size:9.5px;font-weight:750}.tgx-summary-value{display:block;margin-top:4px;color:#41536d;font-size:11.5px;line-height:1.45}.tgx-scope-note{margin-top:9px;padding-top:9px;border-top:1px solid #e2e9f0;color:#697b91;font-size:10.5px;line-height:1.45}.tgx-privacy{background:linear-gradient(150deg,#0a2a58,#0c466f);color:#fff}.tgx-privacy-mark{display:grid;width:35px;height:35px;place-items:center;margin-bottom:13px;border:1px solid rgba(135,235,247,.25);border-radius:11px;background:rgba(135,235,247,.11);color:#8be9f5;font-size:17px}.tgx-privacy strong{display:block;font-size:13px}.tgx-privacy p{margin:7px 0 0;color:#cbdcf0;font-size:10.5px;line-height:1.55}',
                '.tgx-progress{margin-top:12px;padding:13px;border:1px solid #c8e4e9;border-radius:13px;background:#edf9fa}.tgx-progress[hidden]{display:none}.tgx-progress-head{display:flex;align-items:flex-start;gap:10px}.tgx-progress-icon{display:grid;width:28px;height:28px;flex:0 0 auto;place-items:center;border-radius:9px;background:#0b9fba;color:#fff;font-weight:800}.tgx-progress strong{display:block;color:#16314b;font-size:11.5px}.tgx-progress p{margin:2px 0 0;color:#61768a;font-size:10.5px}.tgx-track{height:5px;margin-top:10px;overflow:hidden;border-radius:99px;background:#d5e5ea}.tgx-bar{display:block;width:0;height:100%;border-radius:inherit;background:linear-gradient(90deg,#0d9db8,#1ed0d7);transition:width .2s ease}.tgx-progress[data-state=complete]{border-color:#bfe3d7;background:#eefaf6}.tgx-progress[data-state=complete] .tgx-progress-icon{background:#0b9a75}.tgx-progress[data-state=error]{border-color:#efd1d5;background:#fff3f4}.tgx-progress[data-state=error] .tgx-progress-icon{background:#bc3d4c}.tgx-receipt{margin-top:12px;padding-top:10px;border-top:1px solid rgba(19,94,117,.16)}.tgx-receipt>div{display:flex;justify-content:space-between;gap:12px;margin-top:5px;color:#5f7488;font-size:10px}.tgx-receipt>div:first-child{margin-top:0}.tgx-receipt strong{color:#16314b;text-align:right;overflow-wrap:anywhere}.tgx-result-summary{margin-top:10px;padding:9px 10px;border-radius:10px;background:rgba(13,157,184,.08);color:#3f6076;font-size:10.5px;line-height:1.5}.tgx-result-target,.tgx-result-coverage{margin-top:7px;padding:8px 9px;border:1px solid #c9dfe7;border-radius:9px;background:#f2fafc;color:#416579;font-size:10px;line-height:1.5;white-space:pre-line}.tgx-result-target{border-color:#b9ddcf;background:#eef9f5;color:#24634f;font-weight:720}.tgx-result-target[data-state=missed]{border-color:#e8c990;background:#fff7e6;color:#76511e}.tgx-result-target[hidden],.tgx-result-coverage[hidden]{display:none}.tgx-result-omissions{margin-top:7px;padding:8px 9px;border:1px solid #ead7b6;border-radius:9px;background:#fffaf0;color:#76552a;font-size:10px;line-height:1.5;white-space:pre-line}.tgx-result-omissions[hidden]{display:none}.tgx-result-note{margin-top:8px;padding:8px 9px;border-radius:9px;background:#fff2d7;color:#72511d;font-size:10px;font-weight:700;line-height:1.45}.tgx-result-note[data-partial=true]{background:#ffebdf;color:#8c4322}.tgx-result-help{margin-top:7px;color:#687b91;font-size:10px;line-height:1.45}',
                '.tgx-live-check{margin-top:6px;padding:6px 7px;border:1px solid #b9ddcf;border-radius:8px;background:#eef9f5;color:#24634f;font-size:9px;line-height:1.4}.tgx-live-check strong{font-weight:850}.tgx-live-check[data-state="error"]{border-color:#e4b3ba;background:#fff0f1;color:#8b2f3d}.tgx-run-boundary{margin-bottom:8px;padding:8px 10px;border:1px solid #e1b763;border-radius:9px;background:#fff3d5;color:#684718;font-size:9.5px;font-weight:720;line-height:1.45}.tgx-run-boundary[hidden]{display:none}#tgx-result-target-status[data-state="reached"]{color:#08745a}#tgx-result-target-status[data-state="missed"]{color:#9a5d12}#tgx-result-target-status[data-state="unknown"]{color:#6f6075}.tgx-form-error{margin:12px 2px 0;color:#a42c3a;font-size:11.5px}.tgx-form-error:empty{display:none}',
                '.tgx-private-preflight{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:8px;align-items:center;margin-bottom:8px;padding:8px 9px;border:1px solid #c9dfe7;border-radius:10px;background:#f3fafc;color:#416579}.tgx-private-preflight-mark{display:grid;width:24px;height:24px;place-items:center;border-radius:8px;background:#dceff4;color:#17677b;font-size:12px;font-weight:900}.tgx-private-preflight strong{display:block;color:#24465c;font-size:10px}.tgx-private-preflight p{margin:2px 0 0;font-size:9px;line-height:1.4}.tgx-private-preflight .tgx-button{padding:7px 9px;white-space:nowrap}.tgx-private-preflight[data-state="passed"]{border-color:#9fd6c5;background:#eef9f5;color:#24634f}.tgx-private-preflight[data-state="passed"] .tgx-private-preflight-mark{background:#0b9572;color:#fff}.tgx-private-preflight[data-state="error"]{border-color:#e4b3ba;background:#fff0f1;color:#8b2f3d}.tgx-private-preflight[data-state="error"] .tgx-private-preflight-mark{background:#bc3d4c;color:#fff}@media(max-width:560px){.tgx-private-preflight{grid-template-columns:24px minmax(0,1fr)}.tgx-private-preflight .tgx-button{grid-column:1/-1;width:100%}}@media(prefers-color-scheme:dark){.tgx-protection-warning{border-color:#9b742f;background:#342b1b;color:#f2d49a}.tgx-private-preflight{border-color:#285363;background:#112e3a;color:#c2e7ef}.tgx-private-preflight strong{color:#eaf6fb}.tgx-private-preflight-mark{background:#143c48;color:#9beaf5}.tgx-private-preflight[data-state="passed"]{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-private-preflight[data-state="error"]{border-color:#713743;background:#351f28;color:#ffc3ce}}',
                '.tgx-preparation-disclosure{display:flex;width:100%;align-items:center;justify-content:space-between;gap:12px;margin:0;padding:7px 9px;border:1px solid rgba(170,126,45,.28);border-radius:9px;background:rgba(255,255,255,.5);color:#513b18;text-align:left;box-shadow:none}.tgx-preparation-disclosure span{min-width:0}.tgx-preparation-disclosure strong,.tgx-preparation-disclosure small{display:block}.tgx-preparation-disclosure strong{font-size:10px;line-height:1.3}.tgx-preparation-disclosure small{margin-top:2px;color:#85652e;font-size:8.8px;line-height:1.35}.tgx-preparation-disclosure b{color:#9b722e;font-size:14px;transition:transform .15s ease}.tgx-preparation-disclosure[aria-expanded="true"] b{transform:rotate(180deg)}.tgx-preparation-list{margin-top:8px}.tgx-preparation-list[hidden]{display:none}@media(prefers-color-scheme:dark){.tgx-preparation-disclosure{border-color:#594726;background:#2e2719;color:#f2d49a}.tgx-preparation-disclosure small,.tgx-preparation-disclosure b{color:#d8bb7c}}',
                '.tgx-export-boundary{display:block;padding:0;border-top:1px solid #e6d29e;border-bottom:1px solid #e6d29e;background:#fff7df;color:#684d1d;font-size:10.5px;line-height:1.4}.tgx-export-boundary summary{display:flex;align-items:flex-start;gap:9px;padding:9px 18px 4px;list-style:none;cursor:pointer}.tgx-export-boundary summary::-webkit-details-marker{display:none}.tgx-export-boundary summary::before{content:"!";display:grid;width:18px;height:18px;flex:0 0 auto;place-items:center;border-radius:6px;background:#d68b20;color:#fff;font-size:11px;font-weight:900}.tgx-export-boundary summary::after{content:"⌄";margin-left:auto;color:#9b722e;font-size:14px;font-weight:900;line-height:18px}.tgx-export-boundary summary strong{min-width:0;flex:1;display:block;font-weight:780}.tgx-boundary-compact{display:none}.tgx-boundary-details{padding:0 18px 9px 45px}.tgx-oldest-loaded,.tgx-loaded-count{display:block;margin-top:2px;color:#85652e;font-size:10px}',
                '.tgx-footer{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:16px 22px;border-top:1px solid #dce5ef;background:#fff}.tgx-footer-note{color:#7c8a9d;font-size:10.5px}.tgx-actions{display:flex;gap:9px}.tgx-button{padding:10px 15px;border:0;border-radius:11px;font-size:12px;font-weight:780}.tgx-button--quiet{background:#edf1f5;color:#52627a}.tgx-button--primary{display:flex;align-items:center;gap:11px;background:#0b2858;color:#fff;box-shadow:0 7px 17px rgba(11,40,88,.2)}.tgx-button--primary:hover{background:#0d346d}.tgx-button:disabled{cursor:wait;opacity:.6}.tgx-button[hidden]{display:none}',
                'button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid rgba(19,181,209,.3);outline-offset:3px}',
                '@media(max-width:760px){.tgx-backdrop{padding:0}.tgx-modal{width:100vw;max-height:100dvh;height:100dvh;border:0;border-radius:0}.tgx-body{display:block;overflow:auto}.tgx-form{overflow:visible}.tgx-aside{display:grid;grid-template-columns:1fr 1fr;gap:10px;border-top:1px solid #dce5ef;border-left:0}.tgx-aside-card+.tgx-aside-card{margin-top:0}.tgx-choice-grid--three{grid-template-columns:1fr}.tgx-footer-note{display:none}}',
                '@media(max-width:560px){.tgx-header{padding:17px}.tgx-brand{width:40px;height:40px}.tgx-header h1{font-size:20px}.tgx-header p{display:none}.tgx-form{padding:18px 15px 24px}.tgx-choice-grid,.tgx-protection-choices,.tgx-password-grid,.tgx-coverage-goal{grid-template-columns:1fr}.tgx-coverage-goal input{width:100%}.tgx-media-row{grid-template-columns:1fr}.tgx-limit{justify-content:space-between}.tgx-aside{grid-template-columns:1fr;padding:15px}.tgx-export-boundary summary{align-items:center;padding:8px 14px}.tgx-export-boundary summary strong{display:none}.tgx-boundary-compact{min-width:0;flex:1;display:block;font-size:9.5px;font-weight:750;overflow-wrap:anywhere}.tgx-boundary-details{padding:0 14px 9px 39px}.tgx-footer{align-items:stretch;flex-direction:column;padding:12px 15px}.tgx-actions{display:grid;grid-template-columns:1fr 1fr}.tgx-button{width:100%}}',
                '@media(prefers-color-scheme:dark){:host{color-scheme:dark;color:#eaf1fb}.tgx-modal{border-color:#263750;background:#0e1c31}.tgx-form{background:#0e1c31}.tgx-aside{border-color:#273850;background:#111f35}.tgx-header,.tgx-footer{border-color:#283951}.tgx-footer{background:#101e33}.tgx-section-title h2,.tgx-choice strong,.tgx-media-check strong,.tgx-current-name{color:#edf5ff}.tgx-section-title p,.tgx-choice small,.tgx-limit,.tgx-selected-count,.tgx-scope-note,.tgx-result-help,.tgx-password-note,.tgx-password-field{color:#97a9c0}.tgx-choice,.tgx-panel,.tgx-media-row,.tgx-aside-card,.tgx-protection-option{border-color:#2b3d55;background:#14243b}.tgx-choice:has(input:checked),.tgx-protection-option[aria-pressed="true"]{border-color:#20b5ce;background:#143c48}.tgx-protection-option[data-mode="none"][aria-pressed="true"]{border-color:#6a5229;background:#342b1b}.tgx-protection-option{color:#edf5ff}.tgx-protection-option small{color:#97a9c0}.tgx-protection-option::after{border-color:#50637a;background:#14243b}.tgx-live-check{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-live-check[data-state="error"]{border-color:#713743;background:#351f28;color:#ffc3ce}.tgx-run-boundary{border-color:#6a5229;background:#342b1b;color:#f2d49a}.tgx-select,.tgx-search,.tgx-number,.tgx-password-field input{border-color:#34475f;background:#0d1b2f;color:#eff6ff}.tgx-chat-list{border-color:#293a51}.tgx-chat-row:hover{background:#1b2d46}.tgx-chat-name,.tgx-summary-value{color:#c7d5e8}.tgx-batch-planner{border-color:#285d6b;background:#12313b;color:#d2f3f8}.tgx-batch-mark{background:#174553;color:#75dced}.tgx-batch-copy strong{color:#e8f9fc}.tgx-batch-copy p{color:#9bc3cd}.tgx-button--quiet{background:#203149;color:#c6d3e5}.tgx-progress{border-color:#285363;background:#112e3a}.tgx-progress strong{color:#eaf6fb}.tgx-progress p{color:#aac0ce}.tgx-track{background:#294552}.tgx-result-summary{background:rgba(32,181,206,.12);color:#c2e7ef}.tgx-result-omissions{border-color:#594726;background:#2e2719;color:#f2d49a}.tgx-result-note{background:#3b2d16;color:#ffd893}.tgx-result-note[data-partial=true]{background:#45251e;color:#ffc3a6}.tgx-export-boundary{border-color:#594726;background:#2e2719;color:#f2d49a}.tgx-oldest-loaded,.tgx-loaded-count{color:#d8bb7c}.tgx-result-summary strong,.tgx-receipt strong{color:#eaf6fb}}',
                '@media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important;scroll-behavior:auto!important}}',
                '.tgx-technical-details{margin-top:5px;color:inherit;font-size:8.5px;opacity:.84}.tgx-technical-details>summary{display:inline-block;cursor:pointer;font-weight:760}.tgx-technical-details>small{display:block;margin-top:3px;overflow-wrap:anywhere;font-size:8.5px;line-height:1.35}.tgx-batch-copy small{display:block;margin-top:4px;color:#397285;font-size:9px;font-weight:760;line-height:1.35}.tgx-result-batch{margin-top:7px;padding:7px 8px;border:1px solid #91d5e1;border-radius:8px;background:#eefbfe;color:#1f6173;font-size:9.5px;font-weight:760;line-height:1.4}.tgx-result-batch[hidden]{display:none}.tgx-compatibility-diagnostic{display:grid;gap:6px}.tgx-compatibility-refresh{justify-self:start;padding:6px 9px;border:1px solid #e4b3ba;background:#fff;color:#8b2f3d}.tgx-compatibility-refresh[hidden]{display:none}.tgx-batch-controls{justify-content:flex-end;flex-wrap:wrap}.tgx-batch-run-all{border:1px solid #78c5d4;background:#fff;color:#17677b}.tgx-batch-run-all[hidden]{display:none}.tgx-preparation-plain{margin-bottom:8px;padding:8px 10px;border:1px solid #c9dfe7;border-radius:9px;background:#f2fafc;color:#416579;font-size:9.8px;line-height:1.45}.tgx-preparation-plain strong{display:block;color:#17677b;font-size:10px}.tgx-preparation-plain ul{margin:4px 0 0;padding-left:16px}.tgx-preparation-plain li+li{margin-top:2px}@media(prefers-color-scheme:dark){.tgx-batch-copy small{color:#8dc9d7}.tgx-result-batch{border-color:#285d6b;background:#12313b;color:#bfeaf2}.tgx-compatibility-refresh{border-color:#713743;background:#2b1b24;color:#ffc3ce}.tgx-batch-run-all{border-color:#285d6b;background:#14243b;color:#bfeaf2}.tgx-preparation-plain{border-color:#285363;background:#112e3a;color:#c2e7ef}.tgx-preparation-plain strong{color:#9beaf5}}',
                '.tgx-preparation-plain{padding:10px 12px 10px 13px;border-left:4px solid #18a8c1;font-size:10px}.tgx-preparation-plain strong{font-size:11px}.tgx-preparation-plain li+li{margin-top:4px}@media(prefers-color-scheme:dark){.tgx-preparation-plain{border-left-color:#46bfd2}}',
                '.tgx-batch-planner,.tgx-batch-copy,.tgx-batch-controls{min-width:0;max-width:100%}.tgx-batch-copy p,.tgx-batch-copy small{overflow-wrap:anywhere}.tgx-batch-controls .tgx-button{min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere;text-align:center}.tgx-export-boundary summary{min-width:0}.tgx-boundary-compact{min-width:0;overflow:visible;overflow-wrap:anywhere;text-overflow:clip;white-space:normal}',
            ].join('')+[
                '.tgx-modal{width:min(1040px,100%)}.tgx-aside[data-terminal="true"]{overflow:hidden}.tgx-aside[data-terminal="true"]>.tgx-aside-card{display:none}.tgx-aside[data-terminal="true"]>.tgx-progress{display:flex;max-height:100%;flex-direction:column;overflow:hidden}.tgx-aside[data-terminal="true"] .tgx-receipt{flex:1 1 auto;min-height:0;overflow:auto;padding-right:4px;scrollbar-gutter:stable}@media(min-width:761px){.tgx-body:has(.tgx-aside[data-terminal="true"]){grid-template-columns:minmax(0,1fr) minmax(340px,40%)}}',
                '.tgx-preset-bar{display:grid;grid-template-columns:minmax(0,1fr) repeat(3,auto);align-items:center;gap:7px;margin-bottom:8px;padding:8px 9px 8px 12px;border:1px solid #d8e2ec;border-radius:13px;background:#fff}.tgx-preset-label{color:#53657d;font-size:11px;font-weight:750}.tgx-preset{padding:7px 10px;border:1px solid transparent;border-radius:9px;background:#edf2f7;color:#42546d;font-size:10.5px;font-weight:750}.tgx-preset:hover{background:#e2eaf2}.tgx-preset[aria-pressed="true"]{border-color:#18a8c1;background:#e7f8fa;color:#086f84;box-shadow:0 0 0 2px rgba(24,168,193,.1)}.tgx-workload-estimate{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 8px;margin-bottom:19px;padding:8px 10px;border:1px solid #c9dfe7;border-radius:11px;background:#f2fafc;color:#416579;font-size:9.5px;line-height:1.45}.tgx-workload-estimate strong{color:#17677b;font-size:9px;font-weight:850;letter-spacing:.07em;text-transform:uppercase}.tgx-workload-estimate[data-level="moderate"]{border-color:#e5ca91;background:#fff8e9;color:#76552a}.tgx-workload-estimate[data-level="moderate"] strong{color:#8a5a16}.tgx-workload-estimate[data-level="heavy"]{border-color:#e4b3ba;background:#fff1f3;color:#843542}.tgx-workload-estimate[data-level="heavy"] strong{color:#a42c3a}',
                '.tgx-disclosure{margin-top:10px;overflow:hidden;border:1px solid #d8e2ec;border-radius:12px;background:#fff}.tgx-disclosure>summary{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:2px 10px;padding:10px 12px;list-style:none;cursor:pointer}.tgx-disclosure>summary::-webkit-details-marker{display:none}.tgx-disclosure>summary::after{content:"+";grid-column:2;grid-row:1/span 2;color:#6d8398;font-size:16px;font-weight:800}.tgx-disclosure[open]>summary::after{content:"−"}.tgx-disclosure>summary span{color:#243551;font-size:11.5px;font-weight:780}.tgx-disclosure>summary small{color:#728298;font-size:9.5px;line-height:1.35}.tgx-disclosure-body{padding:0 11px 11px}.tgx-scale-guidance{margin-top:8px;padding:8px 10px;border-left:3px solid #7d9db7;border-radius:0 9px 9px 0;background:#eef3f7;color:#53677d;font-size:9.8px;line-height:1.5}',
                '.tgx-aes-help ol{margin:2px 0 0;padding-left:20px;color:#52677e;font-size:10px;line-height:1.5}.tgx-aes-help li+li{margin-top:3px}.tgx-aes-help p{margin:8px 0 0;padding:7px 8px;border-radius:8px;background:#fff6df;color:#75511e;font-size:9.5px;font-weight:700;line-height:1.4}.tgx-aes-help .tgx-app-recommendation{border:1px solid #b9ddcf;background:#eef9f5;color:#24634f}.tgx-aes-help .tgx-compatibility-note{border:1px solid #c9dfe7;background:#f2fafc;color:#416579;font-weight:650}',
                '.tgx-result-help,.tgx-result-check,.tgx-result-summary,.tgx-result-target,.tgx-result-coverage,.tgx-result-omissions,.tgx-result-note{overflow-wrap:anywhere}.tgx-result-check{padding:8px 9px;border:1px solid #bddfd3;border-radius:9px;background:#eef9f5;color:#2b6755;font-size:10px;font-weight:700;line-height:1.45}.tgx-download-status{margin-top:8px;padding:7px 8px;border:1px solid #bddfd3;border-radius:8px;background:#eef9f5;color:#2b6755;font-size:9.5px;font-weight:700;line-height:1.4;overflow-wrap:anywhere}.tgx-download-status[data-state="folder"]{border-color:#e5ca91;background:#fff8e9;color:#76552a}.tgx-download-status[data-state="error"]{border-color:#e4b3ba;background:#fff1f3;color:#843542}.tgx-download-status[hidden]{display:none}.tgx-button--receipt{position:static;width:100%;flex:0 0 auto;margin-top:8px;justify-self:stretch;border:1px solid #9bcdd7;background:#eaf8fb;color:#145a70;box-shadow:none}.tgx-button--receipt:hover{border-color:#65b6c6;background:#dff4f8}.tgx-button--receipt[hidden]{display:none}',
                '.tgx-export-boundary[data-ready="false"]{border-top-width:2px;border-bottom-width:2px;box-shadow:inset 4px 0 0 #d68b20}.tgx-export-boundary[data-invalid="true"]{border-color:#d45a68;background:#fff0f1;color:#7f2935;box-shadow:inset 4px 0 0 #c33d4d}.tgx-boundary-required{flex:0 0 auto;align-self:center;padding:2px 7px;border-radius:99px;background:#d68b20;color:#fff;font-size:8.5px;font-weight:850;letter-spacing:.06em;text-transform:uppercase}.tgx-export-boundary[data-ready="true"] .tgx-boundary-required{background:#0b9572}.tgx-history-check{display:flex;align-items:flex-start;gap:8px;margin-top:8px;padding:8px 9px;border:1px solid #dfbd75;border-radius:9px;background:rgba(255,255,255,.58);color:#654717;cursor:pointer;font-size:10px;font-weight:740;line-height:1.4}.tgx-history-check input{width:16px;height:16px;flex:0 0 auto;margin:0;accent-color:#0a9bb7}.tgx-history-error{display:block;margin-top:6px;color:#a42c3a;font-size:10px;font-weight:780;line-height:1.4}.tgx-history-error[hidden]{display:none}',
                '.tgx-footer-meta{display:flex;min-width:0;flex:1 1 auto;align-items:center;gap:12px}.tgx-footer-scope{display:none}.tgx-footer-protection{flex:0 0 auto;color:#7a5a25;font-size:10px;font-weight:720;line-height:1.35;white-space:nowrap}.tgx-footer-protection[data-protected="true"]{color:#16765f}.tgx-button--link{flex:0 0 auto;padding-inline:4px;background:transparent;color:#3f6681;white-space:nowrap}.tgx-unencrypted-confirm{min-width:0;flex:1;padding:8px 10px;border:1px solid #e4bf7d;border-radius:10px;background:#fff7e6;color:#6e4b18;font-size:9.8px;line-height:1.4}.tgx-unencrypted-confirm[hidden]{display:none}.tgx-unencrypted-confirm strong,.tgx-unencrypted-confirm span{display:block}.tgx-unencrypted-confirm strong{margin-bottom:1px;font-size:10.5px}.tgx-footer[data-confirming-unencrypted="true"] .tgx-footer-meta{display:none}',
                '@media(max-width:560px){.tgx-preset-bar{grid-template-columns:repeat(3,1fr)}.tgx-preset-label{grid-column:1/-1}.tgx-workload-estimate{grid-template-columns:1fr}.tgx-disclosure>summary{padding:9px 10px}.tgx-boundary-required{padding-inline:6px;font-size:8px}.tgx-history-check{margin-top:7px;padding:7px 8px;font-size:9.5px}.tgx-footer{align-items:stretch;flex-direction:column-reverse;padding:10px 14px}.tgx-footer-meta{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:3px 10px}.tgx-footer-scope{display:block;grid-column:1/-1;overflow:hidden;color:#53677d;font-size:9.5px;font-weight:740;text-overflow:ellipsis;white-space:nowrap}.tgx-footer-protection{text-align:right}.tgx-unencrypted-confirm{width:100%}}',
                '@media(prefers-color-scheme:dark){.tgx-preset-bar,.tgx-workload-estimate,.tgx-disclosure{border-color:#2b3d55;background:#14243b}.tgx-preset{background:#203149;color:#c6d3e5}.tgx-preset[aria-pressed="true"]{border-color:#20b5ce;background:#143c48;color:#9beaf5}.tgx-workload-estimate{color:#b8d8e3}.tgx-workload-estimate strong{color:#9beaf5}.tgx-workload-estimate[data-level="moderate"]{border-color:#594726;background:#2e2719;color:#f2d49a}.tgx-workload-estimate[data-level="moderate"] strong{color:#ffd893}.tgx-workload-estimate[data-level="heavy"]{border-color:#713743;background:#351f28;color:#ffc3ce}.tgx-workload-estimate[data-level="heavy"] strong{color:#ffadba}.tgx-disclosure>summary span{color:#edf5ff}.tgx-disclosure>summary small,.tgx-aes-help ol{color:#a7b8cb}.tgx-scale-guidance{border-color:#52718e;background:#13243a;color:#a8bacd}.tgx-aes-help p{background:#342b1b;color:#f2d49a}.tgx-aes-help .tgx-app-recommendation{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-aes-help .tgx-compatibility-note{border-color:#285363;background:#112e3a;color:#c2e7ef}.tgx-button--link{color:#91bdd6}.tgx-button--receipt{border-color:#285363;background:#143c48;color:#9beaf5}.tgx-button--receipt:hover{border-color:#39798c;background:#194957}.tgx-download-status{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-download-status[data-state="folder"]{border-color:#594726;background:#2e2719;color:#f2d49a}.tgx-download-status[data-state="error"]{border-color:#713743;background:#351f28;color:#ffc3ce}.tgx-footer-protection{color:#dfc389}.tgx-footer-protection[data-protected="true"]{color:#8de0c6}.tgx-unencrypted-confirm{border-color:#6a5229;background:#342b1b;color:#f2d49a}.tgx-result-check{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-history-check{border-color:#6a5229;background:rgba(15,27,47,.58);color:#f2d49a}.tgx-export-boundary[data-invalid="true"]{border-color:#713743;background:#351f28;color:#ffc3ce;box-shadow:inset 4px 0 0 #c65868}.tgx-history-error{color:#ffadba}}',
                '.tgx-workload-estimate{display:block;margin-top:5px;margin-bottom:0;padding:0 0 0 8px;border:0;border-left:3px solid #5ca2b3;border-radius:0;background:transparent;color:#416579;font-size:9.5px;line-height:1.45}.tgx-workload-estimate[data-level="moderate"]{border-left-color:#d19a3c;background:transparent;color:#76552a}.tgx-workload-estimate[data-level="heavy"]{border-left-color:#cc5363;background:transparent;color:#843542}.tgx-export-boundary[data-compatibility="error"]{border-color:#d45a68;box-shadow:inset 4px 0 0 #c33d4d}.tgx-boundary-details{padding:2px 18px 10px 45px}.tgx-preparation-list{display:grid;grid-template-columns:1.18fr 1fr 1fr;gap:8px}.tgx-preparation-step{display:grid;min-width:0;grid-template-columns:19px minmax(0,1fr);gap:7px;align-content:start;padding:8px 9px;border:1px solid rgba(170,126,45,.26);border-radius:10px;background:rgba(255,255,255,.54)}.tgx-preparation-number{display:grid;width:19px;height:19px;place-items:center;border-radius:6px;background:#d68b20;color:#fff;font-size:9px;font-weight:900}.tgx-preparation-step>div{min-width:0}.tgx-preparation-step>div>strong{display:block;color:#513b18;font-size:10px;font-weight:820;line-height:1.3}.tgx-preparation-step p{margin:4px 0 0;font-size:9.5px;line-height:1.42}.tgx-compatibility-diagnostic{margin-top:6px;padding:6px 7px;border:1px solid #e4b3ba;border-radius:8px;background:#fff0f1;color:#8b2f3d;font-size:9px;font-weight:720;line-height:1.4}.tgx-compatibility-diagnostic[hidden]{display:none}.tgx-preparation-protection[data-protected="true"]{color:#21654f}.tgx-button--step{margin-top:6px;padding:6px 8px;border:1px solid #d4aa5c;border-radius:8px;background:#fffdf7;color:#714d14;font-size:9px;box-shadow:none}.tgx-oldest-loaded,.tgx-loaded-count{margin-top:3px;font-size:9px;line-height:1.38}.tgx-modal[hidden],.tgx-history-coach[hidden]{display:none}.tgx-backdrop[data-history-mode="true"]{display:block;padding:0;background:transparent;backdrop-filter:none;pointer-events:none;-webkit-backdrop-filter:none}.tgx-history-coach{position:absolute;right:22px;bottom:22px;display:grid;width:min(540px,calc(100vw - 44px));grid-template-columns:38px minmax(0,1fr) auto;gap:12px;align-items:center;padding:14px;border:1px solid rgba(129,221,233,.35);border-radius:17px;background:#0b2f5c;color:#fff;box-shadow:0 18px 58px rgba(0,0,0,.35);pointer-events:auto}.tgx-history-coach-mark{display:grid;width:38px;height:38px;place-items:center;border-radius:12px;background:rgba(103,226,239,.14);color:#8debf5;font-size:21px;font-weight:900}.tgx-history-coach strong{display:block;font-size:12px}.tgx-history-coach p{margin:3px 0 0;color:#c8d9ed;font-size:10px;line-height:1.45}.tgx-history-coach .tgx-button{white-space:nowrap}',
                '@media(max-width:560px){.tgx-preparation-list{grid-template-columns:1fr}.tgx-boundary-details{padding:0 14px 9px 39px}.tgx-history-coach{right:12px;bottom:12px;left:12px;width:auto;grid-template-columns:34px minmax(0,1fr);padding:12px}.tgx-history-coach-mark{width:34px;height:34px}.tgx-history-coach .tgx-button{grid-column:1/-1;width:100%}}',
                '@media(prefers-color-scheme:dark){.tgx-workload-estimate{border-left-color:#5ca2b3;background:transparent;color:#b8d8e3}.tgx-workload-estimate[data-level="moderate"]{border-left-color:#d19a3c;background:transparent;color:#f2d49a}.tgx-workload-estimate[data-level="heavy"]{border-left-color:#cc5363;background:transparent;color:#ffc3ce}.tgx-export-boundary[data-compatibility="error"]{border-color:#713743;box-shadow:inset 4px 0 0 #c65868}.tgx-preparation-step{border-color:rgba(216,187,124,.22);background:rgba(15,27,47,.42)}.tgx-preparation-step>div>strong{color:#fff1cf}.tgx-compatibility-diagnostic{border-color:#713743;background:#351f28;color:#ffc3ce}.tgx-preparation-protection[data-protected="true"]{color:#a9ead5}.tgx-button--step{border-color:#6a5229;background:#342b1b;color:#f2d49a}}',
                '.tgx-export-boundary summary{align-items:center;padding:9px 18px}.tgx-export-boundary summary strong{flex:0 0 auto}.tgx-boundary-compact{min-width:0;flex:1 1 auto;display:block;overflow:hidden;color:#85652e;font-size:9.5px;font-weight:680;text-overflow:ellipsis;white-space:nowrap}.tgx-preparation-app-links,.tgx-aes-source-links{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:6px;margin-top:7px}.tgx-official-source{display:grid;gap:1px;min-width:0;padding:7px 8px;border:1px solid #86c8b5;border-radius:8px;background:#effaf6;color:#145f4b;text-decoration:none}.tgx-official-source span{font-size:9.5px;font-weight:820;line-height:1.25}.tgx-official-source small{color:#4e7b6e;font-size:8px;font-weight:700;line-height:1.25}.tgx-official-source[hidden]{display:none}@media(max-width:560px){.tgx-boundary-compact{white-space:normal}.tgx-compact-chip{display:inline-block;margin:2px 3px 2px 0;padding:2px 5px;border:1px solid #e1c481;border-radius:999px;background:#fff8e9;color:#684718}.tgx-compact-chip:last-child{margin-right:0}}@media(prefers-color-scheme:dark){.tgx-boundary-compact{color:#d8bb7c}.tgx-compact-chip{border-color:#6a5229;background:#342b1b;color:#f2d49a}.tgx-official-source{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-official-source small{color:#86b9aa}}',
                '.tgx-receipt-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}.tgx-receipt-actions .tgx-button--receipt{min-width:0;margin-top:0;padding-inline:8px}.tgx-button--verify{border-color:#77baa9;background:#e9f8f3;color:#17644f}.tgx-button--verify:hover{border-color:#4b9e88;background:#ddf4ed}.tgx-verify-panel{display:grid;gap:7px;margin-top:8px;padding:9px;border:1px solid #c9dfe7;border-radius:10px;background:#f7fbfd}.tgx-verify-panel[hidden],#tgx-verify-file[hidden]{display:none}.tgx-verify-file span,.tgx-verify-password span{display:block;color:#708298;font-size:8.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}.tgx-verify-file strong{display:block;margin-top:2px;color:#24463d;font-size:10px;overflow-wrap:anywhere}.tgx-verify-password{display:grid;gap:4px}.tgx-verify-password input{width:100%;padding:8px 9px;border:1px solid #b9ccd9;border-radius:8px;background:#fff;color:#152641;font-size:11px;outline:none}.tgx-verify-panel p{margin:0;color:#76511e;font-size:9px;font-weight:700;line-height:1.4}.tgx-button--verify-now{width:100%;padding:8px 10px;border:0;border-radius:8px;background:#176c58;color:#fff;box-shadow:none;font-size:10px}.tgx-button--verify-now:hover{background:#115846}.tgx-verify-status[data-state="working"]{border-color:#c9dfe7;background:#f2fafc;color:#416579}.tgx-verify-status[data-state="limit"]{border-color:#d7a243;background:#fff5dc;color:#704b13;font-weight:800}',
                '@media(max-width:560px){.tgx-receipt-actions{grid-template-columns:1fr}}',
                '@media(prefers-color-scheme:dark){.tgx-button--verify{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-button--verify:hover{border-color:#3f806e;background:#19443a}.tgx-verify-panel{border-color:#34475f;background:#0d1b2f}.tgx-verify-file span,.tgx-verify-password span{color:#97a9c0}.tgx-verify-file strong{color:#eaf6fb}.tgx-verify-password input{border-color:#34475f;background:#13243a;color:#eff6ff}.tgx-verify-panel p{color:#f2d49a}.tgx-verify-status[data-state="working"]{border-color:#285363;background:#112e3a;color:#c2e7ef}.tgx-verify-status[data-state="limit"]{border-color:#6a5229;background:#342b1b;color:#f2d49a}}',
                '.tgx-batch-planner,.tgx-batch-copy,.tgx-batch-controls{min-width:0;max-width:100%}.tgx-batch-copy p,.tgx-batch-copy small{overflow-wrap:anywhere}.tgx-batch-controls .tgx-button{min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere;text-align:center}.tgx-export-boundary summary{min-width:0}.tgx-boundary-compact{min-width:0;overflow:visible;overflow-wrap:anywhere;text-overflow:clip;white-space:normal}.tgx-compact-chip{display:inline}.tgx-footer-protection{min-width:0;max-width:38ch;flex:0 1 auto;overflow-wrap:anywhere;white-space:normal}'
            ].join('');
            const css=typeof globalThis.__TELEARCHIVE_UI_CSS__==='string'&&globalThis.__TELEARCHIVE_UI_CSS__
                ?globalThis.__TELEARCHIVE_UI_CSS__
                :legacyCss;
            root.innerHTML=`
                <div class="tgx-backdrop" data-tgx-dismiss>
                  <section class="tgx-modal" role="dialog" aria-modal="true" aria-labelledby="tgx-title" aria-describedby="tgx-description">
                    <header class="tgx-header">
                      <img class="tgx-brand" alt="">
                      <div class="tgx-heading"><span class="tgx-eyebrow" data-i18n="exporterEyebrow"></span><h1 id="tgx-title" data-i18n="exporterTitle"></h1><p id="tgx-description" data-i18n="exporterSubtitle"></p><small class="tgx-scope-boundary" id="tgx-scope-boundary" data-i18n="scopeBoundary"></small></div>
                      <button type="button" class="tgx-icon-button" id="tgx-close-icon">×</button>
                    </header>
                    <div class="tgx-body">
                      <div class="tgx-form">
                        <section class="tgx-quick-start" id="tgx-quick-start" aria-labelledby="tgx-quick-title">
                          <div class="tgx-quick-chat">
                            <span class="tgx-quick-avatar" aria-hidden="true">↧</span>
                            <div><span class="tgx-quick-kicker"><span data-i18n="quickSourceLabel"></span> <strong id="tgx-quick-source-name"></strong></span><h2 id="tgx-quick-title"><strong id="tgx-quick-chat-name"></strong></h2><p id="tgx-quick-history"></p></div>
                          </div>
                          <div class="tgx-quick-summary" aria-label="Archive summary">
                            <div><span class="tgx-quick-summary-icon" aria-hidden="true">▤</span><div><small data-i18n="quickContentLabel"></small><strong id="tgx-quick-content"></strong></div></div>
                            <div><span class="tgx-quick-summary-icon" aria-hidden="true">◉</span><div><small data-i18n="quickMediaLabel"></small><strong id="tgx-quick-media"></strong></div></div>
                            <div><span class="tgx-quick-summary-icon" aria-hidden="true">⌁</span><div><small data-i18n="quickPrivacyLabel"></small><strong id="tgx-quick-protection"></strong></div></div>
                          </div>
                          <div class="tgx-quick-status" id="tgx-quick-status" data-state="ready" role="status" aria-live="polite"><span class="tgx-quick-status-mark" aria-hidden="true">✓</span><div><strong data-i18n="quickReadyTitle"></strong><p id="tgx-quick-status-text" data-i18n="quickReadyBody"></p></div><button type="button" class="tgx-button tgx-button--step" id="tgx-quick-recheck" data-i18n="compatibilityRefresh" hidden></button></div>
                          <button type="button" class="tgx-customize-toggle" id="tgx-customize-toggle" aria-expanded="false" aria-controls="tgx-customize"><span><strong data-i18n="quickCustomize"></strong><small id="tgx-customize-hint" data-i18n="quickCustomizeHint"></small></span><b aria-hidden="true">⌄</b></button>
                        </section>
                        <details class="tgx-customize" id="tgx-customize">
                          <summary><span><strong data-i18n="quickSettingsTitle"></strong><small data-i18n="quickSettingsHint"></small></span><b aria-hidden="true">⌄</b></summary>
                          <div class="tgx-customize-body">
                        <div class="tgx-preset-bar" role="group" aria-label="Quick setup">
                          <span class="tgx-preset-label" data-i18n="presetTitle"></span>
                          <button type="button" class="tgx-preset" data-tgx-preset="readable" aria-pressed="false" data-i18n="presetReadable"></button>
                          <button type="button" class="tgx-preset" data-tgx-preset="text" aria-pressed="false" data-i18n="presetText"></button>
                          <button type="button" class="tgx-preset" data-tgx-preset="balanced" aria-pressed="false" data-i18n="presetBalanced"></button>
                          <button type="button" class="tgx-preset" data-tgx-preset="complete" aria-pressed="false" data-i18n="presetComplete"></button>
                        </div>
                        <div class="tgx-protection-primer" id="tgx-protection-primer" role="status" aria-live="polite"><div><strong data-i18n="protectionPrimerTitle"></strong><span id="tgx-protection-primer-text"></span></div><button type="button" class="tgx-button tgx-button--step" id="tgx-protection-primer-action" data-i18n="protectionPrimerAction"></button></div>
                        <div class="tgx-beginner-guide" id="tgx-beginner-guide" data-state="idle" role="note"><div class="tgx-beginner-guide-main"><div class="tgx-beginner-guide-copy"><strong data-i18n="beginnerGuideTitle"></strong><span id="tgx-beginner-guide-body" data-i18n="beginnerGuideBody"></span></div><div class="tgx-beginner-guide-choices" role="group" aria-label="Archive opening choice"><div class="tgx-beginner-choice"><strong class="tgx-beginner-choice-tag" data-i18n="beginnerGuideActionTag"></strong><button type="button" class="tgx-button tgx-button--step" id="tgx-beginner-guide-action" data-mode="simple" aria-pressed="false" data-i18n="beginnerGuideAction"></button><small data-i18n="beginnerGuideActionHint"></small></div><div class="tgx-beginner-choice"><strong class="tgx-beginner-choice-tag" data-i18n="beginnerGuideActionProtectedTag"></strong><button type="button" class="tgx-button tgx-button--quiet" id="tgx-beginner-guide-protected" data-mode="protected" aria-pressed="false" data-i18n="beginnerGuideActionProtected"></button><small data-i18n="beginnerGuideActionProtectedHint"></small></div></div><div class="tgx-beginner-setup" id="tgx-beginner-setup" hidden><div class="tgx-beginner-setup-head"><strong data-i18n="beginnerSetupSummaryTitle"></strong><button type="button" class="tgx-button tgx-button--link" id="tgx-beginner-setup-change" data-i18n="beginnerSetupChange"></button></div><div class="tgx-beginner-setup-grid"><div><small data-i18n="beginnerSetupScopeLabel"></small><strong id="tgx-beginner-setup-scope"></strong></div><div><small data-i18n="beginnerSetupFormatLabel"></small><strong id="tgx-beginner-setup-format"></strong></div><div><small data-i18n="beginnerSetupMediaLabel"></small><strong id="tgx-beginner-setup-media"></strong></div><div><small data-i18n="beginnerSetupProtectionLabel"></small><strong id="tgx-beginner-setup-protection"></strong></div></div><small class="tgx-beginner-setup-hint" data-i18n="beginnerSetupHint"></small></div><small class="tgx-beginner-guide-boundary" data-i18n="beginnerGuideBoundary"></small></div></div>
                        <div class="tgx-preflight-strip" id="tgx-preflight-strip" role="note"><strong data-i18n="preflightStripTitle"></strong><span id="tgx-preflight-strip-tab"></span><span data-i18n="preflightStripScope"></span><span id="tgx-preflight-strip-protection"></span></div>
                        <section class="tgx-section" id="tgx-output-section">
                          <div class="tgx-section-title"><div><h2 data-i18n="outputTitle"></h2><p data-i18n="outputDescription"></p></div></div>
                          <div class="tgx-choice-grid">
                            <label class="tgx-choice"><input type="checkbox" id="tgx-html"><span><strong data-i18n="formatHtml"></strong><small data-i18n="formatHtmlHint"></small></span></label>
                            <label class="tgx-choice"><input type="checkbox" id="tgx-json"><span><strong data-i18n="formatJson"></strong><small data-i18n="formatJsonHint"></small></span></label>
                          </div>
                          <div class="tgx-capability-limits" id="tgx-capability-limits" role="note" hidden></div>
                        </section>
                        <section class="tgx-section" id="tgx-scope-section">
                          <div class="tgx-section-title"><div><h2 data-i18n="scopeTitle"></h2></div></div>
                          <div class="tgx-choice-grid tgx-choice-grid--three">
                            <label class="tgx-choice"><input type="radio" name="tgx-chats" value="current" checked><span><strong data-i18n="scopeCurrent"></strong></span></label>
                            <label class="tgx-choice"><input type="radio" name="tgx-chats" value="all"><span><strong data-i18n="scopeAllType"></strong></span></label>
                            <label class="tgx-choice"><input type="radio" name="tgx-chats" value="selectable"><span><strong data-i18n="scopeSelected"></strong></span></label>
                          </div>
                          <div class="tgx-scope-handoff-note" id="tgx-scope-handoff-note" role="note" data-i18n="scopeManualPrimer" hidden></div>
                          <div class="tgx-scope-effort" id="tgx-scope-effort" hidden role="note"></div>
                          <div class="tgx-commit-summary" id="tgx-commit-summary" hidden role="note"></div>
                          <div class="tgx-panel" id="tgx-chat-type-panel" hidden><select id="tgx-chat-type" class="tgx-select"><option data-i18n="loadingChats"></option></select></div>
                          <div class="tgx-panel" id="tgx-chat-list-panel" hidden>
                            <div class="tgx-chat-toolbar"><input class="tgx-search" id="tgx-chat-search" type="search"><label class="tgx-select-all"><input id="tgx-select-all" type="checkbox" checked><span data-i18n="selectAll"></span></label></div>
                            <div class="tgx-chat-list" id="tgx-chat-list"><div class="tgx-chat-empty" data-i18n="loadingChats"></div></div>
                            <div class="tgx-selected-count" id="tgx-selected-count"></div>
                          </div>
                          <div class="tgx-batch-planner" id="tgx-batch-planner" hidden role="status" aria-live="polite" tabindex="-1">
                            <span class="tgx-batch-mark" aria-hidden="true">≡</span>
                            <div class="tgx-batch-copy"><strong id="tgx-batch-title"></strong><p id="tgx-batch-detail"></p><small class="tgx-batch-tab-guidance" id="tgx-batch-tab-guidance" data-i18n="batchTabGuidance"></small><small class="tgx-batch-handoff" id="tgx-batch-handoff"></small><small id="tgx-batch-progress"></small></div>
                            <div class="tgx-batch-controls"><button type="button" class="tgx-button tgx-button--quiet" id="tgx-batch-previous"></button><button type="button" class="tgx-button tgx-button--step" id="tgx-batch-next"></button><button type="button" class="tgx-button tgx-button--step tgx-batch-next-chat" id="tgx-batch-next-chat" hidden></button><button type="button" class="tgx-button tgx-button--step tgx-batch-run-all" id="tgx-batch-run-all" data-i18n="batchRunAll" hidden></button></div><div class="tgx-batch-chat-progress" id="tgx-batch-chat-progress" role="list"><strong data-i18n="batchChatProgressTitle"></strong><div id="tgx-batch-chat-progress-rows"></div></div><div class="tgx-batch-manifest"><strong data-i18n="batchManifestTitle"></strong><div id="tgx-batch-manifest-rows"></div></div>
                          </div>
                        <details class="tgx-disclosure" id="tgx-coverage-settings"><summary><span data-i18n="coverageSettingsTitle"></span><small data-i18n="coverageSettingsHint"></small></summary><div class="tgx-disclosure-body"><div class="tgx-coverage-goal"><label for="tgx-coverage-target" data-i18n="coverageTargetLabel"></label><input type="date" id="tgx-coverage-target" aria-describedby="tgx-coverage-target-hint"><strong class="tgx-coverage-target-readable" id="tgx-coverage-target-readable" aria-live="polite"></strong><small id="tgx-coverage-target-hint" data-i18n="coverageTargetHint"></small></div><div class="tgx-scale-guidance" id="tgx-scale-guidance" role="note"></div></div></details>
                        </section>
                        <section class="tgx-section" id="tgx-media-section">
                          <div class="tgx-section-title"><div><h2 data-i18n="mediaTitle"></h2><p data-i18n="mediaDescription"></p></div></div>
                          <div class="tgx-media-list">
                            <div class="tgx-media-row"><label class="tgx-media-check"><input type="checkbox" id="tgx-photos"><strong data-i18n="mediaPhotos"></strong></label><label class="tgx-limit"><span data-i18n="maxEach"></span><span class="tgx-number"><input type="number" id="tgx-photo-size" min="1" max="10000"><b data-i18n="megabytesShort"></b></span></label></div>
                            <div class="tgx-media-row"><label class="tgx-media-check"><input type="checkbox" id="tgx-voice"><strong data-i18n="mediaVoice"></strong></label><small class="tgx-media-inherited-limit" data-i18n="mediaSharedFileLimit"></small></div>
                            <details class="tgx-disclosure tgx-media-more" id="tgx-more-media"><summary><span data-i18n="moreMediaTitle"></span><small id="tgx-more-media-status"></small></summary><div class="tgx-disclosure-body tgx-media-list tgx-media-list--nested"><div class="tgx-media-row"><label class="tgx-media-check"><input type="checkbox" id="tgx-videos"><strong data-i18n="mediaVideos"></strong></label><label class="tgx-limit"><span data-i18n="maxEach"></span><span class="tgx-number"><input type="number" id="tgx-video-size" min="1" max="20000"><b data-i18n="megabytesShort"></b></span></label></div><div class="tgx-media-row"><label class="tgx-media-check"><input type="checkbox" id="tgx-stickers"><strong data-i18n="mediaStickers"></strong></label><small class="tgx-media-inherited-limit" data-i18n="mediaSharedFileLimit"></small></div><div class="tgx-media-row"><label class="tgx-media-check"><input type="checkbox" id="tgx-files"><strong data-i18n="mediaFiles"></strong></label><label class="tgx-limit"><span data-i18n="maxEach"></span><span class="tgx-number"><input type="number" id="tgx-file-size" min="1" max="20000"><b data-i18n="megabytesShort"></b></span></label></div></div></details>
                          </div>
                        </section>
                        <section class="tgx-section" id="tgx-protection-section">
                          <div class="tgx-section-title"><div><h2 data-i18n="protectionTitle"></h2><p data-i18n="protectionDescription"></p></div></div>
                          <p class="tgx-protection-warning" data-i18n="protectionOpeningWarning"></p>
                          <div class="tgx-protection-workbench" data-protected="true">
                            <div class="tgx-protection-choices">
                              <button type="button" class="tgx-protection-option" id="tgx-protection-aes" data-mode="aes" aria-pressed="true"><strong data-i18n="protectionChoiceAesTitle"></strong><small data-i18n="protectionChoiceAesHint"></small></button>
                              <button type="button" class="tgx-protection-option" id="tgx-protection-none" data-mode="none" aria-pressed="false"><strong data-i18n="protectionChoiceNoneTitle"></strong><small data-i18n="protectionChoiceNoneHint"></small></button>
                              <input type="checkbox" id="tgx-encrypt" hidden aria-hidden="true">
                            </div>
                            <div class="tgx-panel" id="tgx-password-panel" hidden>
                              <strong class="tgx-password-panel-title" data-i18n="passwordPanelTitle"></strong>
                              <div class="tgx-password-grid">
                                <label class="tgx-password-field"><span data-i18n="passwordLabel"></span><input type="password" id="tgx-password" minlength="8" maxlength="256" autocomplete="new-password" spellcheck="false"></label>
                                <label class="tgx-password-field"><span data-i18n="passwordConfirmLabel"></span><input type="password" id="tgx-password-confirm" minlength="8" maxlength="256" autocomplete="new-password" spellcheck="false"></label>
                              </div>
                              <p class="tgx-password-note" data-i18n="passwordHint"></p>
                            </div>
                          </div>
                          <details class="tgx-disclosure tgx-aes-help" id="tgx-aes-help"><summary><span data-i18n="aesHelpTitle"></span><small data-i18n="aesHelpHint"></small></summary><div class="tgx-disclosure-body"><ol><li data-i18n="aesHelpStepDownload"></li><li data-i18n="aesHelpStepOpen"></li><li data-i18n="aesHelpStepPassword"></li><li data-i18n="aesHelpStepExtract"></li></ol><p class="tgx-app-recommendation" id="tgx-aes-app-recommendation"></p><nav class="tgx-aes-source-links" aria-label="Official AES ZIP applications"><a class="tgx-official-source" id="tgx-aes-peazip" href="https://peazip.github.io/" target="_blank" rel="noopener noreferrer"><span data-i18n="aesGetPeaZip"></span><small data-i18n="aesOfficialSource"></small></a><a class="tgx-official-source" id="tgx-aes-7zip" href="https://www.7-zip.org/" target="_blank" rel="noopener noreferrer"><span data-i18n="aesGet7Zip"></span><small data-i18n="aesOfficialSource"></small></a></nav><p class="tgx-compatibility-note" data-i18n="aesCompatibilityNote"></p><p data-i18n="aesHelpSafety"></p></div></details>
                        </section>
                          </div>
                        </details>
                        <div class="tgx-form-error" id="tgx-form-error" role="alert"></div>
                      </div>
                      <aside class="tgx-aside">
                        <div class="tgx-progress" id="tgx-progress" hidden data-state="working" role="status" aria-live="polite"><div class="tgx-progress-head"><div class="tgx-progress-icon" id="tgx-progress-icon">↯</div><div><strong id="tgx-progress-title" data-i18n="exporting"></strong><p id="tgx-progress-text"></p></div></div><div class="tgx-track"><span class="tgx-bar" id="tgx-progress-bar"></span></div><div class="tgx-receipt" id="tgx-receipt" hidden><div class="tgx-result-primary" id="tgx-result-primary" role="status"><strong data-i18n="resultPrimaryTitle"></strong><span id="tgx-result-primary-file"></span><span id="tgx-result-primary-summary"></span><span id="tgx-result-primary-omissions"></span><span id="tgx-result-primary-next"></span></div><details class="tgx-result-details" id="tgx-result-details"><summary data-i18n="resultDetailsTitle"></summary><div class="tgx-result-details-body"><div><span data-i18n="resultFileLabel"></span><strong id="tgx-result-file"></strong></div><div><span data-i18n="resultSizeLabel"></span><strong id="tgx-result-size"></strong></div><div><span data-i18n="resultProtectionLabel"></span><strong id="tgx-result-protection"></strong></div><div id="tgx-result-validation-row" hidden><span data-i18n="resultValidationLabel"></span><strong id="tgx-result-validation"></strong></div><div class="tgx-result-target-row" id="tgx-result-target-row" hidden><span data-i18n="resultTargetStatusLabel"></span><strong id="tgx-result-target-status"></strong></div><div class="tgx-result-summary" id="tgx-result-summary" aria-label="Export report"></div><div class="tgx-result-batch" id="tgx-result-batch" hidden role="status" aria-live="polite"></div><div class="tgx-result-target" id="tgx-result-target" hidden></div><div class="tgx-result-coverage" id="tgx-result-coverage" hidden></div><div class="tgx-result-omissions" id="tgx-result-omissions" hidden></div><div class="tgx-result-note" id="tgx-result-note"></div><div class="tgx-result-help" id="tgx-result-help" data-i18n="resultOpenHelp"></div></div></details><div class="tgx-result-aes-guide" id="tgx-result-aes-guide" hidden><strong id="tgx-result-guide-title" data-i18n="resultAesGuideTitle"></strong><p id="tgx-result-guide-body" data-i18n="resultAesGuideBody"></p><ol><li id="tgx-result-guide-step-start" data-i18n="resultAesGuideStepStart"></li><li id="tgx-result-guide-step-password" data-i18n="aesHelpStepPassword"></li><li id="tgx-result-guide-step-extract" data-i18n="aesHelpStepExtract"></li></ol><nav class="tgx-aes-source-links" id="tgx-result-guide-sources" aria-label="Official AES ZIP applications"><a class="tgx-official-source" href="https://peazip.github.io/" target="_blank" rel="noopener noreferrer"><span data-i18n="aesGetPeaZip"></span><small data-i18n="aesOfficialSource"></small></a><a class="tgx-official-source" href="https://www.7-zip.org/" target="_blank" rel="noopener noreferrer"><span data-i18n="aesGet7Zip"></span><small data-i18n="aesOfficialSource"></small></a></nav></div><div class="tgx-result-check" id="tgx-result-check" data-i18n="resultExtractionCheck"></div></div><div class="tgx-download-status" id="tgx-show-download-status" role="status" aria-live="polite" hidden></div><div class="tgx-receipt-actions"><button type="button" class="tgx-button tgx-button--receipt" id="tgx-show-download" data-i18n="resultShowDownload" hidden></button><button type="button" class="tgx-button tgx-button--receipt tgx-button--verify" id="tgx-verify-download" data-i18n="resultVerifyDownload" hidden></button></div><input type="file" id="tgx-verify-file" accept=".zip,application/zip" hidden><div class="tgx-verify-panel" id="tgx-verify-panel" hidden><div class="tgx-verify-file"><span data-i18n="verificationSelectedFile"></span><strong id="tgx-verify-filename"></strong></div><label class="tgx-verify-password"><span data-i18n="verificationPasswordLabel"></span><input type="password" id="tgx-verify-password" minlength="8" maxlength="256" autocomplete="off" spellcheck="false"></label><p data-i18n="verificationPasswordWarning"></p><button type="button" class="tgx-button tgx-button--verify-now" id="tgx-verify-now" data-i18n="verificationRun"></button></div><div class="tgx-download-status tgx-verify-status" id="tgx-verify-status" role="status" aria-live="polite" hidden></div></div>
                        <div class="tgx-aside-card"><span class="tgx-current-label" data-i18n="currentChat"></span><div class="tgx-current-name"></div><div class="tgx-scope-note" data-i18n="renderedScopeNote"></div><span class="tgx-summary-label" data-i18n="scopeTitle"></span><span class="tgx-summary-value" id="tgx-summary-scope"></span><span class="tgx-summary-label" data-i18n="outputTitle"></span><span class="tgx-summary-value" id="tgx-summary-formats"></span><span class="tgx-summary-label" data-i18n="mediaTitle"></span><span class="tgx-summary-value" id="tgx-summary-media"></span><div class="tgx-coverage-preflight" id="tgx-coverage-preflight" hidden><span class="tgx-summary-label" data-i18n="coveragePreflightTitle"></span><div id="tgx-coverage-preflight-rows"></div><p id="tgx-coverage-preflight-note" data-i18n="coveragePreflightNote"></p></div></div>
                        <div class="tgx-aside-card tgx-privacy"><div class="tgx-privacy-mark">✓</div><strong data-i18n="localOnlyTitle"></strong><p data-i18n="localOnlyBody"></p></div>
                      </aside>
                    </div>
                    <details class="tgx-export-boundary" id="tgx-export-boundary" role="note" data-ready="false">
                    <summary><strong data-i18n="preparationTitle"></strong><span class="tgx-boundary-compact" id="tgx-boundary-compact"></span><button type="button" class="tgx-button tgx-button--step tgx-collapsed-sample" id="tgx-collapsed-sample" hidden></button><span class="tgx-boundary-required" id="tgx-history-badge" data-i18n="historyReadyBadgeRequired"></span></summary>
                      <div class="tgx-boundary-details">
                        <div class="tgx-preparation-plain" role="note" tabindex="-1"><strong data-i18n="preparationPlainTitle"></strong><ul><li data-i18n="preparationPlainSave"></li><li data-i18n="preparationPlainMissing"></li><li id="tgx-preparation-plain-open" data-i18n="preparationPlainOpenAes"></li></ul></div><div class="tgx-preparation-next" id="tgx-preparation-next" role="status" aria-live="polite"><strong data-i18n="preparationNextTitle"></strong><span id="tgx-preparation-next-text" data-i18n="preparationNextCurrent"></span></div><div class="tgx-workload-advice" id="tgx-workload-advice" role="note" hidden></div><div class="tgx-manual-wizard" id="tgx-manual-wizard" hidden role="status" aria-live="polite"><div class="tgx-manual-wizard-head"><strong id="tgx-manual-wizard-title" data-i18n="manualWizardTitle"></strong><span id="tgx-manual-wizard-meta"></span></div><ol class="tgx-manual-wizard-steps"><li data-wizard-step="1"><b>1</b><span id="tgx-manual-wizard-open"></span></li><li data-wizard-step="2"><b>2</b><span data-i18n="manualWizardCheck"></span></li><li data-wizard-step="3"><b>3</b><span data-i18n="manualWizardSave"></span></li><li data-wizard-step="4"><b>4</b><span data-i18n="manualWizardVerify"></span></li></ol><div class="tgx-manual-wizard-next"><span id="tgx-manual-wizard-next"></span><button type="button" class="tgx-button tgx-button--step" id="tgx-manual-wizard-action"></button></div></div>
                        <button type="button" class="tgx-preparation-disclosure" id="tgx-preparation-toggle" aria-expanded="false" aria-controls="tgx-preparation-list"><span><strong data-i18n="preparationDetailsTitle"></strong><small data-i18n="preparationDetailsHint"></small></span><b aria-hidden="true">⌄</b></button>
                        <div class="tgx-preparation-list" id="tgx-preparation-list" hidden>
                          <div class="tgx-run-boundary" id="tgx-run-boundary" hidden></div>
                          <div class="tgx-private-preflight" id="tgx-private-preflight" data-state="idle" role="status" aria-live="polite"><span class="tgx-private-preflight-mark" id="tgx-private-preflight-mark" aria-hidden="true">•</span><div><strong data-i18n="privatePreflightTitle"></strong><p id="tgx-private-preflight-text" data-i18n="privatePreflightIdle"></p></div><button type="button" class="tgx-button tgx-button--step" id="tgx-run-private-preflight" data-i18n="privatePreflightAction"></button></div>
                          <section class="tgx-preparation-step" data-step="1"><span class="tgx-preparation-number">1</span><div><strong data-i18n="preparationHistoryTitle"></strong><p id="tgx-preexport-title" data-i18n="preExportScopeWarning"></p><div class="tgx-live-check" id="tgx-live-check" role="status" aria-live="polite"><strong data-i18n="liveCheckTitle"></strong> <span id="tgx-live-check-text"></span><details class="tgx-technical-details" id="tgx-live-check-details"><summary data-i18n="technicalDetailsTitle"></summary><small id="tgx-live-check-technical"></small></details></div><div class="tgx-live-smoke" id="tgx-live-smoke" data-state="idle" role="status" aria-live="polite"><span class="tgx-live-smoke-mark" id="tgx-live-smoke-mark" aria-hidden="true">•</span><div><strong data-i18n="liveSmokeTitle"></strong><p id="tgx-live-smoke-text" data-i18n="liveSmokeIdle"></p></div><button type="button" class="tgx-button tgx-button--step" id="tgx-run-live-smoke" data-i18n="liveSmokeAction"></button></div><div class="tgx-compatibility-diagnostic" id="tgx-compatibility-diagnostic" role="alert" hidden><span id="tgx-compatibility-diagnostic-text"></span><button type="button" class="tgx-button tgx-button--step tgx-compatibility-refresh" id="tgx-compatibility-refresh" data-i18n="compatibilityRefresh" hidden></button></div><span class="tgx-oldest-loaded" id="tgx-oldest-loaded"></span><span class="tgx-loaded-count" id="tgx-loaded-count"></span><button type="button" class="tgx-button tgx-button--step" id="tgx-load-history" data-i18n="historyCoachStart"></button></div></section>
                          <section class="tgx-preparation-step" data-step="2"><span class="tgx-preparation-number">2</span><div><strong data-i18n="preparationWorkloadTitle"></strong><div class="tgx-workload-compact" id="tgx-workload-compact"></div><details class="tgx-technical-details tgx-workload-details"><summary data-i18n="workloadDetailsTitle"></summary><div class="tgx-workload-estimate" id="tgx-workload-estimate" data-level="light"><span id="tgx-workload-estimate-text"></span></div></details></div></section>
                          <section class="tgx-preparation-step" data-step="3"><span class="tgx-preparation-number">3</span><div><strong data-i18n="preparationProtectionTitle"></strong><p class="tgx-preparation-protection" id="tgx-preparation-protection"></p><div class="tgx-preparation-app-links" id="tgx-preparation-app-links"><a class="tgx-official-source" id="tgx-preparation-peazip" href="https://peazip.github.io/" target="_blank" rel="noopener noreferrer"><span data-i18n="aesGetPeaZip"></span><small data-i18n="aesOfficialSource"></small></a><a class="tgx-official-source" id="tgx-preparation-7zip" href="https://www.7-zip.org/" target="_blank" rel="noopener noreferrer"><span data-i18n="aesGet7Zip"></span><small data-i18n="aesOfficialSource"></small></a></div><button type="button" class="tgx-button tgx-button--step" id="tgx-open-aes-guide" data-i18n="aesHelpOpen"></button></div></section>
                        </div>
                        <label class="tgx-history-check"><input type="checkbox" id="tgx-history-ready" aria-required="true" aria-describedby="tgx-history-error"><span id="tgx-history-ready-text" data-i18n="historyReadyCurrent"></span></label><span class="tgx-history-error" id="tgx-history-error" role="alert" data-i18n="validationHistoryReady" hidden></span>
                      </div>
                    </details>
                    <footer class="tgx-footer" id="tgx-footer"><div class="tgx-footer-meta"><button type="button" class="tgx-button tgx-button--link" id="tgx-settings" data-i18n="popupSettings"></button><span class="tgx-footer-scope" id="tgx-footer-scope"></span><span class="tgx-footer-protection" id="tgx-footer-protection" aria-live="polite"></span><span class="tgx-footer-preflight" id="tgx-footer-preflight" role="status" aria-live="polite" hidden></span></div><div class="tgx-unencrypted-confirm" id="tgx-unencrypted-confirm" hidden role="note"><strong data-i18n="unencryptedConfirmTitle"></strong><span data-i18n="unencryptedConfirmBody"></span></div><div class="tgx-actions"><button type="button" class="tgx-button tgx-button--link tgx-missing-summary" id="tgx-missing-summary" data-i18n="missingSummaryAction"></button><button type="button" class="tgx-button tgx-button--quiet" id="tgx-cancel" data-i18n="close"></button><button type="button" class="tgx-button tgx-button--primary" id="tgx-export"><span data-i18n="exportNow"></span><span aria-hidden="true">→</span></button></div></footer>
                  </section>
                  <aside class="tgx-history-coach" id="tgx-history-coach" role="status" aria-live="polite" hidden><span class="tgx-history-coach-mark">↑</span><div><strong data-i18n="historyCoachTitle"></strong><p data-i18n="historyCoachBody"></p></div><button type="button" class="tgx-button tgx-button--primary" id="tgx-history-return" data-i18n="historyCoachReturn"></button></aside>
                </div>`;
            const style=document.createElement('style');
            style.textContent=css+'.tgx-result-aes-guide{display:grid;gap:6px;padding:9px 10px;border:1px solid #c9dfe7;border-radius:9px;background:#f2fafc;color:#416579;font-size:9.5px;line-height:1.45}.tgx-result-aes-guide[hidden]{display:none}.tgx-result-aes-guide strong{color:#17677b;font-size:10.5px}.tgx-result-aes-guide p,.tgx-result-aes-guide ol{margin:0}.tgx-result-aes-guide ol{padding-left:18px}.tgx-preparation-next{display:grid;gap:2px;margin-bottom:8px;padding:8px 10px;border:1px solid #b9ddcf;border-radius:9px;background:#eef9f5;color:#2b6755;font-size:10px;line-height:1.4}.tgx-preparation-next strong{color:#17644f;font-size:10px}@media (prefers-color-scheme:dark){.tgx-result-aes-guide{border-color:#285363;background:#112e3a;color:#c2e7ef}.tgx-result-aes-guide strong{color:#9beaf5}.tgx-preparation-next{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-preparation-next strong{color:#9be8cd}}';
            style.textContent+='.tgx-protection-primer{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;margin-bottom:12px;padding:8px 10px;border:1px solid #b9ddcf;border-radius:11px;background:#eef9f5;color:#2b6755;font-size:9.5px;line-height:1.35}.tgx-protection-primer strong,.tgx-protection-primer span{display:block}.tgx-protection-primer strong{color:#17644f;font-size:10px}.tgx-protection-primer span{margin-top:2px}.tgx-protection-primer .tgx-button{margin-top:0;white-space:nowrap}.tgx-protection-primer[data-protected="false"]{border-color:#e0bd79;background:#fff8e9;color:#76552a}.tgx-protection-primer[data-protected="false"] strong{color:#714d14}.tgx-result-aes-guide-action{width:100%;margin-top:1px;border-color:#2c9078;background:#176c58;color:#fff;font-weight:800}.tgx-result-aes-guide-action:hover{border-color:#176c58;background:#115846}.tgx-compatibility-refresh{order:-1;justify-self:stretch;padding:7px 10px;border:1px solid #b93c4c;background:#c33d4d;color:#fff;font-weight:850}.tgx-compatibility-refresh:hover{border-color:#8f2736;background:#a92f3f}.tgx-progress-boundary{display:block;margin-top:3px;color:#7a8a9d;font-size:8.5px;line-height:1.35}.tgx-missing-summary{margin-right:auto;text-align:left}@media(max-width:560px){.tgx-protection-primer{grid-template-columns:1fr}.tgx-protection-primer .tgx-button{width:100%}.tgx-missing-summary{grid-column:1/-1;margin-right:0;text-align:center}}@media(prefers-color-scheme:dark){.tgx-protection-primer{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-protection-primer strong{color:#9be8cd}.tgx-protection-primer[data-protected="false"]{border-color:#6a5229;background:#342b1b;color:#f2d49a}.tgx-protection-primer[data-protected="false"] strong{color:#ffd893}.tgx-compatibility-refresh{border-color:#713743;background:#2b1b24;color:#ffc3ce}.tgx-progress-boundary{color:#97a9c0}}';
            style.textContent+='.tgx-beginner-guide{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;margin-bottom:10px;padding:8px 10px;border:1px solid #b9ddcf;border-radius:11px;background:#eef9f5;color:#2b6755;font-size:9.5px;line-height:1.4}.tgx-beginner-guide strong,.tgx-beginner-guide span{display:block}.tgx-beginner-guide strong{color:#17644f;font-size:10.5px}.tgx-beginner-guide span{margin-top:2px}.tgx-beginner-guide .tgx-button{white-space:nowrap}.tgx-capability-limits{margin-top:8px;padding:7px 9px;border-left:3px solid #7d9db7;border-radius:0 8px 8px 0;background:#eef3f7;color:#53677d;font-size:9.2px;line-height:1.45}.tgx-capability-limits[hidden]{display:none}.tgx-preflight-strip{display:flex;flex-wrap:wrap;gap:4px 9px;align-items:baseline;margin:-2px 0 10px;padding:6px 9px;border:1px solid #d8e2ec;border-radius:9px;background:#f7fafc;color:#64778c;font-size:8.8px;line-height:1.4}.tgx-preflight-strip strong{color:#314e6d;font-size:9px}.tgx-preflight-strip span:not(:last-child)::after{content:" ·";color:#9aabbc}.tgx-batch-tab-guidance{padding-left:6px;border-left:3px solid #d19432;color:#76511e;font-weight:780}.tgx-result-aes-guide nav[hidden]{display:none}:host([data-simple-mode="true"]) #tgx-output-section,:host([data-simple-mode="true"]) #tgx-scope-section,:host([data-simple-mode="true"]) #tgx-media-section,:host([data-simple-mode="true"]) #tgx-coverage-settings{display:none}@media(max-width:560px){.tgx-beginner-guide{grid-template-columns:1fr}.tgx-beginner-guide .tgx-button{width:100%}}@media(prefers-color-scheme:dark){.tgx-beginner-guide{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-beginner-guide strong{color:#9be8cd}.tgx-capability-limits{border-left-color:#7092a9;background:#172a3d;color:#b6cada}.tgx-preflight-strip{border-color:#2b3d55;background:#14243b;color:#9fb2c7}.tgx-preflight-strip strong{color:#d5e7f6}.tgx-batch-tab-guidance{border-left-color:#d8bb7c;color:#f2d49a}}';
            style.textContent+='.tgx-beginner-guide-main{min-width:0}.tgx-beginner-guide-copy span{margin-top:3px}.tgx-beginner-guide-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:8px 0 0;padding:0;list-style:none}.tgx-beginner-guide-steps li{display:grid;grid-template-columns:19px minmax(0,1fr);gap:6px;align-items:start;min-width:0;padding:6px 7px;border:1px solid rgba(23,100,79,.18);border-radius:8px;background:rgba(255,255,255,.54);color:#356b5a;font-size:8.8px;line-height:1.35}.tgx-beginner-guide-steps li>span:first-child{display:grid;width:19px;height:19px;place-items:center;margin:0;border-radius:6px;background:#176c58;color:#fff;font-size:9px;font-weight:900}.tgx-beginner-guide[data-state="active"]{border-color:#72c4ad;box-shadow:0 0 0 3px rgba(23,108,88,.08)}.tgx-beginner-guide[data-state="active"] .tgx-beginner-guide-steps li{border-color:rgba(23,108,88,.28);background:rgba(255,255,255,.76)}.tgx-result-primary{display:grid;gap:4px;padding:9px 10px;border:1px solid #9fd6c5;border-radius:10px;background:#eef9f5;color:#2b6755;font-size:10px;line-height:1.42}.tgx-result-primary strong{color:#17644f;font-size:10.5px}.tgx-result-primary span{display:block;overflow-wrap:anywhere}.tgx-result-primary span:first-of-type{color:#24463d;font-weight:760}.tgx-result-primary span:nth-of-type(2){color:#416579}.tgx-result-primary span:nth-of-type(3){color:#76552a;font-weight:700}.tgx-result-primary span:nth-of-type(4){color:#176c58;font-weight:780}.tgx-result-details{border:1px solid #d6e2e8;border-radius:9px;background:rgba(255,255,255,.58)}.tgx-result-details>summary{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 9px;color:#4f6578;cursor:pointer;font-size:9px;font-weight:780;list-style:none}.tgx-result-details>summary::-webkit-details-marker{display:none}.tgx-result-details>summary::after{content:"⌄";color:#7190a0;font-size:13px;line-height:1}.tgx-result-details[open]>summary::after{transform:rotate(180deg)}.tgx-result-details-body{display:grid;gap:8px;padding:0 8px 8px}.tgx-result-details-body>div:not([class]){display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px;align-items:baseline;margin:0;padding:5px 6px;border-radius:7px;background:rgba(13,157,184,.045)}.tgx-result-details-body>div:not([class])>strong{margin-top:0;text-align:right}.tgx-result-aes-guide ol{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;padding-left:0;list-style-position:inside}.tgx-result-aes-guide li{padding:5px 6px;border:1px solid rgba(65,101,121,.16);border-radius:7px;background:rgba(255,255,255,.5);overflow-wrap:anywhere}@media(max-width:560px){.tgx-beginner-guide-steps{grid-template-columns:1fr}.tgx-result-aes-guide ol{grid-template-columns:1fr}.tgx-preparation-plain{font-size:10.5px;line-height:1.5}.tgx-preparation-plain li+li{margin-top:5px}.tgx-preparation-list{grid-template-columns:1fr;gap:8px}.tgx-preparation-step{padding:10px}.tgx-preparation-step p,.tgx-live-check,.tgx-workload-estimate,.tgx-preparation-protection{font-size:10.5px;line-height:1.5}.tgx-preparation-disclosure small{font-size:9.5px}}@media(prefers-color-scheme:dark){.tgx-beginner-guide-steps li{border-color:rgba(155,234,213,.22);background:rgba(17,46,58,.72);color:#b8e1d4}.tgx-beginner-guide-steps li>span:first-child{background:#2a8c73}.tgx-result-primary{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-result-primary strong,.tgx-result-primary span:nth-of-type(4){color:#9be8cd}.tgx-result-primary span:first-of-type{color:#d0eee3}.tgx-result-primary span:nth-of-type(2){color:#b8d9e3}.tgx-result-primary span:nth-of-type(3){color:#f2d49a}.tgx-result-details{border-color:#2b3d55;background:rgba(20,36,59,.78)}.tgx-result-details>summary{color:#b6c9dc}.tgx-result-details-body>div:not([class]){background:rgba(32,181,206,.08)}.tgx-result-aes-guide li{border-color:rgba(194,231,239,.16);background:rgba(17,46,58,.72)}}';
            style.textContent+='.tgx-beginner-guide-choices{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}.tgx-beginner-choice{display:grid;min-width:192px;gap:4px;padding:5px;border:1px solid rgba(23,100,79,.18);border-radius:10px;background:rgba(255,255,255,.58)}.tgx-beginner-choice .tgx-button{width:100%;min-width:0;margin:0;text-align:center}.tgx-beginner-choice-tag{display:block;padding:0 4px;color:#17644f;font-size:8px;font-weight:850;letter-spacing:.06em;line-height:1.2;text-align:center;text-transform:uppercase}.tgx-beginner-choice:nth-child(2) .tgx-beginner-choice-tag{color:#315f8a}.tgx-beginner-choice small{display:block;padding:0 4px 2px;color:#4d7467;font-size:8.8px;line-height:1.3;text-align:center}.tgx-beginner-choice:has(.tgx-button[aria-pressed="true"]){border-color:#72c4ad;background:rgba(255,255,255,.82);box-shadow:0 0 0 2px rgba(23,108,88,.08)}.tgx-beginner-guide-choices .tgx-button[aria-pressed="true"]{border-color:#0b9572;background:#176c58;color:#fff;box-shadow:0 0 0 3px rgba(23,108,88,.13)}.tgx-beginner-guide-boundary{display:block;margin-top:7px;color:#4d7467;font-size:8.8px;line-height:1.35}.tgx-scope-boundary{display:block;margin-top:7px;color:#a9c3dc;font-size:9px;font-weight:720;line-height:1.35}.tgx-progress-simple{display:block;margin-top:3px;color:#356b5a;font-size:9px;font-weight:760;line-height:1.35}.tgx-workload-compact{margin-top:5px;padding:6px 7px;border:1px solid rgba(170,126,45,.24);border-radius:8px;background:rgba(255,255,255,.56);color:#684d1d;font-size:9.5px;font-weight:760;line-height:1.35}.tgx-workload-advice{margin-top:6px;padding:6px 7px;border-left:3px solid #d19432;border-radius:0 8px 8px 0;background:#fff8e9;color:#76511e;font-size:9.5px;font-weight:720;line-height:1.4}.tgx-workload-advice[data-level="heavy"]{border-left-color:#c33d4d;background:#fff1f3;color:#843542}.tgx-workload-advice[hidden]{display:none}.tgx-workload-details{margin-top:6px}.tgx-workload-details>summary{color:#85652e}:host([data-first-run="true"]) .tgx-preset-bar,:host([data-first-run="true"]) .tgx-protection-primer,:host([data-first-run="true"]) .tgx-preflight-strip,:host([data-first-run="true"]) #tgx-output-section,:host([data-first-run="true"]) #tgx-scope-section,:host([data-first-run="true"]) #tgx-media-section,:host([data-first-run="true"]) #tgx-protection-section{display:none}:host([data-guided-mode="protected"]) #tgx-scope-section,:host([data-guided-mode="protected"]) #tgx-media-section,:host([data-guided-mode="protected"]) #tgx-coverage-settings{display:none}@media(max-width:560px){.tgx-beginner-guide-choices{display:grid;grid-template-columns:1fr}.tgx-beginner-choice{min-width:0}.tgx-beginner-choice .tgx-button{width:100%}.tgx-scope-boundary{margin-top:5px;font-size:8.5px}}@media(prefers-color-scheme:dark){.tgx-beginner-guide-boundary{color:#a9d6ca}.tgx-beginner-choice{border-color:rgba(155,234,213,.22);background:rgba(17,46,58,.72)}.tgx-beginner-choice-tag,.tgx-beginner-choice:nth-child(2) .tgx-beginner-choice-tag{color:#9be8cd}.tgx-beginner-choice small{color:#a9d6ca}.tgx-beginner-choice:has(.tgx-button[aria-pressed="true"]){border-color:#2a8c73;background:rgba(17,46,58,.92)}.tgx-scope-boundary{color:#b8cee5}.tgx-progress-simple{color:#a9d6ca}.tgx-workload-compact{border-color:#594726;background:rgba(20,36,59,.72);color:#f2d49a}.tgx-workload-advice{border-left-color:#d8bb7c;background:#342b1b;color:#f2d49a}.tgx-workload-advice[data-level="heavy"]{border-left-color:#c65868;background:#351f28;color:#ffc3ce}.tgx-workload-details>summary{color:#d8bb7c}}';
            style.textContent+='.tgx-beginner-setup[hidden]{display:none}.tgx-beginner-setup{display:grid;gap:6px;margin-top:8px;padding:8px 9px;border:1px solid rgba(23,100,79,.24);border-radius:10px;background:rgba(255,255,255,.64)}.tgx-beginner-setup-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.tgx-beginner-setup-head strong{color:#17644f;font-size:10px}.tgx-beginner-setup-head .tgx-button{padding:3px 4px;color:#17677b;font-size:8.8px}.tgx-beginner-setup-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}.tgx-beginner-setup-grid>div{min-width:0;padding:5px 6px;border:1px solid rgba(23,100,79,.14);border-radius:7px;background:rgba(255,255,255,.56)}.tgx-beginner-setup-grid small,.tgx-beginner-setup-grid strong,.tgx-beginner-setup-hint{display:block;overflow-wrap:anywhere}.tgx-beginner-setup-grid small{color:#4d7467;font-size:7.7px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}.tgx-beginner-setup-grid strong{margin-top:2px;color:#24465c;font-size:8.8px;line-height:1.3}.tgx-beginner-setup-hint{color:#4d7467;font-size:8.5px;line-height:1.3}:host([data-simple-mode="true"]) .tgx-beginner-setup,:host([data-guided-mode="protected"]) .tgx-beginner-setup{display:grid}@media(max-width:560px){.tgx-beginner-setup-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(prefers-color-scheme:dark){.tgx-beginner-setup{border-color:rgba(155,234,213,.22);background:rgba(17,46,58,.82)}.tgx-beginner-setup-head strong,.tgx-beginner-setup-head .tgx-button{color:#9be8cd}.tgx-beginner-setup-grid>div{border-color:rgba(155,234,213,.18);background:rgba(20,36,59,.72)}.tgx-beginner-setup-grid small,.tgx-beginner-setup-hint{color:#a9d6ca}.tgx-beginner-setup-grid strong{color:#d0eee3}}';
            style.textContent+='.tgx-collapsed-sample{flex:0 0 auto;min-height:26px;margin:0;padding:4px 8px;border:1px solid #78c5d4;border-radius:7px;background:#eefbfe;color:#17677b;font-size:8.5px;font-weight:820;line-height:1.15;white-space:nowrap}.tgx-collapsed-sample:hover{border-color:#2da2b8;background:#e1f7fb}.tgx-collapsed-sample[hidden]{display:none}@media(max-width:560px){.tgx-collapsed-sample{min-height:24px;padding-inline:6px;font-size:8px}}@media(prefers-color-scheme:dark){.tgx-collapsed-sample{border-color:#285d6b;background:#143c48;color:#9beaf5}.tgx-collapsed-sample:hover{border-color:#39798c;background:#194957}}';
            style.textContent+='.tgx-simple-mode .tgx-preparation-step[data-step="2"],.tgx-simple-mode .tgx-preparation-step[data-step="3"]{display:none}:host([data-simple-mode="true"]) .tgx-preparation-step[data-step="2"],:host([data-simple-mode="true"]) .tgx-preparation-step[data-step="3"]{display:none}:host([data-simple-mode="true"]) .tgx-preparation-list{grid-template-columns:1fr}';
            style.textContent+=':host([data-simple-mode="true"]) .tgx-preparation-disclosure,:host([data-simple-mode="true"]) #tgx-preparation-list{display:none}';
            style.textContent+=':host([data-first-run="true"]) #tgx-export-boundary,:host([data-first-run="true"]) .tgx-footer{display:none}:host([data-simple-mode="true"]) .tgx-beginner-guide-choices,:host([data-guided-mode="protected"]) .tgx-beginner-guide-choices{display:none}';
            style.textContent+='.tgx-protection-workbench{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;align-items:stretch}.tgx-protection-workbench[data-protected="false"]{display:block}.tgx-protection-workbench[data-protected="false"] .tgx-protection-choices{grid-template-columns:1fr 1fr}.tgx-protection-workbench .tgx-protection-choices{min-width:0}.tgx-protection-workbench #tgx-password-panel{display:grid;align-content:start;min-width:0;margin-top:0}.tgx-password-panel-title{display:block;margin-bottom:9px;color:#17677b;font-size:11px;line-height:1.35}@media(max-width:560px){.tgx-protection-workbench{grid-template-columns:1fr}.tgx-protection-workbench .tgx-protection-choices,.tgx-protection-workbench[data-protected="false"] .tgx-protection-choices{grid-template-columns:1fr}.tgx-protection-workbench #tgx-password-panel{margin-top:0}}@media(prefers-color-scheme:dark){.tgx-password-panel-title{color:#9beaf5}}';
            style.textContent+='.tgx-footer-preflight{min-width:0;max-width:34ch;color:#17677b;font-size:9px;font-weight:760;line-height:1.3;overflow-wrap:anywhere}.tgx-footer-preflight[hidden]{display:none}@media(max-width:560px){.tgx-footer-preflight{grid-column:1/-1;max-width:none}}@media(prefers-color-scheme:dark){.tgx-footer-preflight{color:#9beaf5}}';
            style.textContent+='.tgx-scope-handoff-note{display:none;margin-top:8px;padding:8px 10px;border:1px solid #b9ddcf;border-radius:9px;background:#eef9f5;color:#2b6755;font-size:9.5px;font-weight:780;line-height:1.4}.tgx-scope-handoff-note:not([hidden]){display:block}.tgx-scope-effort{display:grid;gap:2px;margin-top:8px;padding:7px 9px;border-left:3px solid #d19432;border-radius:0 8px 8px 0;background:#fff8e9;color:#76511e;font-size:9.2px;line-height:1.4}.tgx-scope-effort[hidden]{display:none}.tgx-scope-effort strong{color:#714d14;font-size:9.5px}.tgx-scope-effort span{overflow-wrap:anywhere}@media(prefers-color-scheme:dark){.tgx-scope-handoff-note{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-scope-effort{border-left-color:#d8bb7c;background:#342b1b;color:#f2d49a}.tgx-scope-effort strong{color:#ffd893}}';
            style.textContent+='.tgx-coverage-target-readable{grid-column:1/-1;color:#17677b;font-size:10px;line-height:1.35}.tgx-coverage-target-readable:empty{display:none}@media(prefers-color-scheme:dark){.tgx-coverage-target-readable{color:#9beaf5}}';
            style.textContent+='.tgx-commit-summary{display:grid;gap:2px;margin-top:8px;padding:7px 9px;border:1px solid #c9dfe7;border-radius:8px;background:#f2fafc;color:#416579;font-size:9.2px;line-height:1.4}.tgx-commit-summary[hidden]{display:none}.tgx-commit-summary strong{color:#17677b;font-size:9.5px}.tgx-commit-summary span{overflow-wrap:anywhere}@media(prefers-color-scheme:dark){.tgx-commit-summary{border-color:#285363;background:#112e3a;color:#c2e7ef}.tgx-commit-summary strong{color:#9beaf5}}';
            style.textContent+='.tgx-batch-manifest{grid-column:2/-1;min-width:0;display:grid;gap:4px;margin-top:2px;padding-top:7px;border-top:1px solid rgba(57,114,133,.2)}.tgx-batch-manifest>strong{color:#17677b;font-size:9px;letter-spacing:.04em;text-transform:uppercase}.tgx-batch-manifest-row{min-width:0;padding:4px 6px;border-radius:6px;background:rgba(255,255,255,.55);color:#397285;font-size:8.8px;font-weight:720;line-height:1.35;overflow-wrap:anywhere}.tgx-batch-manifest-row[data-batch]::before{content:"•";margin-right:4px;color:#d19432}@media(max-width:760px){.tgx-batch-manifest{grid-column:1/-1}}@media(prefers-color-scheme:dark){.tgx-batch-manifest{border-top-color:rgba(141,201,215,.22)}.tgx-batch-manifest>strong{color:#9beaf5}.tgx-batch-manifest-row{background:rgba(20,36,59,.72);color:#8dc9d7}}';
            style.textContent+='.tgx-result-next-batch{width:100%;margin-top:6px;border-color:#176c58;background:#176c58;color:#fff;font-weight:820}.tgx-result-next-batch:hover{border-color:#115846;background:#115846}.tgx-result-next-batch[hidden]{display:none}@media(prefers-color-scheme:dark){.tgx-result-next-batch{border-color:#2a8c73;background:#176c58;color:#fff}.tgx-result-next-batch:hover{border-color:#2a8c73;background:#115846}}';
            style.textContent+='.tgx-result-readable-limit{display:block;color:#76511e;font-size:9px;font-weight:760;line-height:1.35;overflow-wrap:anywhere}@media(prefers-color-scheme:dark){.tgx-result-readable-limit{color:#f2d49a}}';
            style.textContent+='.tgx-result-primary-missing{color:#5d7184;font-weight:650}@media(prefers-color-scheme:dark){.tgx-result-primary-missing{color:#b8d9e3}}';
            style.textContent+='.tgx-result-omission-action{grid-column:1/-1;order:-1;width:100%;margin:0;border-color:#d19432;background:#fff7df;color:#684d1d;font-size:9.5px;font-weight:850}@media(prefers-color-scheme:dark){.tgx-result-omission-action{border-color:#8b692d;background:#342b1b;color:#f2d49a}}';
            style.textContent+='.tgx-result-primary span{font-size:10.5px;letter-spacing:normal;line-height:1.38;text-transform:none}.tgx-preparation-plain{font-size:10.5px;line-height:1.4}.tgx-preparation-plain li{line-height:1.35}';
            style.textContent+='.tgx-live-smoke{display:none!important}#tgx-export-boundary[data-compatibility="error"] .tgx-private-preflight{display:none}:host([data-first-run="true"]) .tgx-aside .tgx-privacy{display:none}.tgx-beginner-choice small{font-size:9.3px;line-height:1.38}.tgx-beginner-choice-tag{font-size:8.6px}#tgx-result-primary-file{display:none}.tgx-result-primary-missing{font-size:9.5px;line-height:1.35}.tgx-number input[data-omission-target="true"]{outline:3px solid rgba(13,157,184,.28);outline-offset:2px;background:#fff7df}.tgx-result-omission-action[data-exact="true"]{font-size:10px;line-height:1.35}@media(prefers-color-scheme:dark){.tgx-number input[data-omission-target="true"]{background:#342b1b}}';
            style.textContent+='.tgx-workload-advice .tgx-button{border-color:#176c58;background:#176c58;color:#fff;font-weight:850}.tgx-workload-advice .tgx-button:hover{border-color:#115846;background:#115846}';
            style.textContent+='.tgx-batch-handoff{display:block;color:#17677b;font-weight:820}.tgx-batch-chat-progress{display:grid;grid-column:1/-1;gap:4px;margin-top:7px;padding:7px 8px;border:1px solid #b9ddcf;border-radius:9px;background:#eef9f5;color:#2b6755;font-size:9px;line-height:1.35}.tgx-batch-chat-progress>strong{color:#17644f;font-size:9.5px}.tgx-batch-chat-progress>div{display:grid;gap:3px}.tgx-batch-chat-row{padding:4px 6px;border-radius:6px;background:rgba(255,255,255,.58);overflow-wrap:anywhere}.tgx-batch-chat-row[data-state="next"]{border-left:3px solid #176c58;font-weight:820}.tgx-batch-chat-row[data-state="verified"]{color:#28684f}.tgx-batch-chat-row[data-state="queued"]{color:#568173}.tgx-batch-chat-progress[hidden]{display:none}.tgx-batch-next-chat{border-color:#176c58!important;background:#176c58!important;color:#fff!important;font-weight:850}.tgx-batch-next-chat[hidden]{display:none}@media(prefers-color-scheme:dark){.tgx-batch-handoff{color:#9beaf5}.tgx-batch-chat-progress{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-batch-chat-progress>strong{color:#9be8cd}.tgx-batch-chat-row{background:rgba(17,46,58,.72)}.tgx-batch-chat-row[data-state="next"]{border-left-color:#2a8c73}.tgx-batch-chat-row[data-state="verified"]{color:#9be8cd}.tgx-batch-chat-row[data-state="queued"]{color:#86b9aa}}';
            style.textContent+='.tgx-live-smoke{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:8px;align-items:center;margin-top:6px;padding:7px 8px;border:1px solid #c9dfe7;border-radius:9px;background:#f3fafc;color:#416579}.tgx-live-smoke-mark{display:grid;width:24px;height:24px;place-items:center;border-radius:8px;background:#dceff4;color:#17677b;font-size:12px;font-weight:900}.tgx-live-smoke strong{display:block;color:#24465c;font-size:9.5px}.tgx-live-smoke p{margin:2px 0 0;font-size:8.8px;line-height:1.38}.tgx-live-smoke .tgx-button{margin:0;white-space:nowrap}.tgx-preparation-step .tgx-live-smoke{grid-template-columns:24px minmax(0,1fr)}.tgx-preparation-step .tgx-live-smoke .tgx-button{grid-column:1/-1;width:100%}.tgx-preparation-list>.tgx-private-preflight{grid-column:1/-1}.tgx-live-smoke[data-state="passed"]{border-color:#9fd6c5;background:#eef9f5;color:#24634f}.tgx-live-smoke[data-state="passed"] .tgx-live-smoke-mark{background:#0b9572;color:#fff}.tgx-live-smoke[data-state="error"]{border-color:#e4b3ba;background:#fff0f1;color:#8b2f3d}.tgx-live-smoke[data-state="error"] .tgx-live-smoke-mark{background:#bc3d4c;color:#fff}.tgx-manual-wizard{display:grid;grid-column:1/-1;gap:8px;margin-top:10px;padding:11px 12px;border:1px solid #b9ddcf;border-radius:12px;background:#eef9f5;color:#2b6755}.tgx-manual-wizard[hidden]{display:none}.tgx-manual-wizard-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.tgx-manual-wizard-head strong{color:#17644f;font-size:11px}.tgx-manual-wizard-head span{color:#568173;font-size:9px;font-weight:760}.tgx-manual-wizard-steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:0;padding:0;list-style:none}.tgx-manual-wizard-steps li{display:grid;grid-template-columns:18px minmax(0,1fr);gap:6px;min-width:0;align-items:start;padding:6px 7px;border:1px solid rgba(23,100,79,.16);border-radius:8px;background:rgba(255,255,255,.56);color:#416f60;font-size:8.8px;line-height:1.35}.tgx-manual-wizard-steps li b{display:grid;width:18px;height:18px;place-items:center;border-radius:6px;background:#c5e6da;color:#17644f;font-size:9px}.tgx-manual-wizard-steps li[data-state="current"]{border-color:#58b496;background:#fff;box-shadow:0 0 0 2px rgba(23,108,88,.08);color:#245c4b;font-weight:780}.tgx-manual-wizard-steps li[data-state="current"] b,.tgx-manual-wizard-steps li[data-state="complete"] b{background:#176c58;color:#fff}.tgx-manual-wizard-next{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;color:#356b5a;font-size:9.5px;font-weight:760;line-height:1.4}.tgx-manual-wizard-next .tgx-button{margin:0;border-color:#176c58;background:#176c58;color:#fff;font-weight:850}.tgx-manual-wizard-next .tgx-button:hover{border-color:#115846;background:#115846}@media(max-width:760px){.tgx-manual-wizard-steps{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.tgx-live-smoke{grid-template-columns:24px minmax(0,1fr)}.tgx-live-smoke .tgx-button{grid-column:1/-1;width:100%}.tgx-manual-wizard-head{display:grid;gap:2px}.tgx-manual-wizard-next{grid-template-columns:1fr}.tgx-manual-wizard-next .tgx-button{width:100%}}@media(prefers-color-scheme:dark){.tgx-live-smoke{border-color:#285363;background:#112e3a;color:#c2e7ef}.tgx-live-smoke strong{color:#eaf6fb}.tgx-live-smoke-mark{background:#143c48;color:#9beaf5}.tgx-live-smoke[data-state="passed"]{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-live-smoke[data-state="passed"] .tgx-live-smoke-mark{background:#2a8c73;color:#fff}.tgx-live-smoke[data-state="error"]{border-color:#713743;background:#351f28;color:#ffc3ce}.tgx-live-smoke[data-state="error"] .tgx-live-smoke-mark{background:#bc3d4c;color:#fff}.tgx-manual-wizard{border-color:#2b6656;background:#15362f;color:#a9ead5}.tgx-manual-wizard-head strong{color:#9be8cd}.tgx-manual-wizard-head span,.tgx-manual-wizard-next{color:#a9d6ca}.tgx-manual-wizard-steps li{border-color:rgba(155,234,213,.2);background:rgba(20,36,59,.72);color:#b8e1d4}.tgx-manual-wizard-steps li b{background:#194957;color:#9beaf5}.tgx-manual-wizard-steps li[data-state="current"]{border-color:#2a8c73;background:#112e3a;color:#d0eee3}}';
            if(typeof globalThis.__LOCAL_ARCHIVE_UI_CSS__==='string')style.textContent+='\n'+globalThis.__LOCAL_ARCHIVE_UI_CSS__;
            root.prepend(style);
            const dialogMessages={
                exporterEyebrow:'CONVERSATION EXPORTER',exporterTitle:'Local Archive',exporterSubtitle:'A readable copy, reusable data, and selected media — saved on this device.',
                quickSourceLabel:'Source:',quickSaveTitle:'Save',quickContentLabel:'Archive',quickMediaLabel:'Attachments',quickPrivacyLabel:'Access',quickReadyTitle:'Ready to save',quickReadyBody:'The archive is built locally. Nothing is uploaded.',quickCustomize:'Change what is saved',quickCustomizeHint:'Chats, formats, attachments, date range, or password',quickSettingsTitle:'Archive settings',quickSettingsHint:'Change only what you need',quickContentBoth:'Readable page + reusable data',quickContentHtml:'Readable page',quickContentJson:'Reusable data',quickMediaNone:'No attachments',quickProtectionNone:'ZIP without password',quickProtectionAes:'Password-protected ZIP',quickHistoryOne:'$1 message is loaded now. Local Archive loads older history automatically before saving.',quickHistoryMany:'$1 messages are loaded now. Local Archive loads older history automatically before saving.',quickHistoryUnknown:'Open a conversation before saving.',quickReadySpecific:'$1 can be read from this $2 source. Keep the source tab open until the ZIP is ready.',quickBlockedTitle:'Cannot read this conversation yet',quickBlockedNoChat:'Open a conversation in $1, then check again.',quickBlockedNoMessages:'Wait for messages to load in $1, then check again.',quickBlockedLayout:'This $1 layout is not supported by the current connector yet.',quickSaveAction:'Save conversation',quickSaveProtectedAction:'Save with password',quickUnavailableAction:'Open a readable conversation first',
                presetTitle:'Quick setup',presetReadable:'Readable',presetText:'Text only',presetBalanced:'Balanced',presetComplete:'All media',
                outputTitle:'Formats',outputDescription:'Keep both when you want a readable copy and reusable data.',formatHtml:'Readable HTML',formatHtmlHint:'Browse messages offline in a familiar layout.',
                formatJson:'Structured JSON',formatJsonHint:'Keep machine-readable message data.',scopeTitle:'Chats',scopeCurrent:'Current chat',scopeAllType:'All chats in one category · one chat at a time · verify each ZIP',scopeSelected:'Choose chats · one chat at a time · verify each ZIP',coverageSettingsTitle:'History goal & scale',coverageSettingsHint:'Optional date target, workload, and batching guidance',coverageTargetLabel:'Oldest date I need',coverageTargetHint:'Optional. Local Archive checks whether each saved chat range reaches this date; this does not claim that Telegram history is complete.',coveragePreflightTitle:'Coverage before export',coveragePreflightNote:'Telegram exposes message history only for the open chat. Other chosen chats are checked during collection, and exact saved ranges appear in the receipt.',coveragePreflightTarget:'Goal: reach $1 in every chosen chat. The open chat is previewed now; every other range is checked during export.',coveragePreflightOpen:'$1 — $2 messages visible · oldest $3',coveragePreflightOpenOne:'$1 — $2 message visible · oldest $3',coveragePreflightOpenUnknown:'$1 — $2 visible; oldest date unavailable',coveragePreflightPending:'$1 — exact range reported after export',coveragePreflightMore:'+$1 more chats',coverageCompactCurrent:'Open chat: $1 visible · oldest $2',coverageCompactCurrentUnknown:'Open chat: $1 visible · oldest date unavailable',coverageCompactMulti:'$1 chosen · open chat: $2 visible · exact ranges after export',coverageCompactTarget:'Need history back to $1 · $2',
                loadingChats:'Reading the chat list…',selectAll:'Select all',batchTitle:'$1 chats · $2 ZIPs planned',batchDetail:'Batch $1 of $2 · chats $3–$4 · $5 in this ZIP. Your full selection stays intact.',batchPrevious:'Previous batch',batchNext:'Next batch',batchNextRange:'Next: batch $1 ($2–$3)',batchScopeSummary:'Batch $1 of $2: $3 of $4 chats',batchScaleGuidance:'Scale: $1 chats are split into $2 ZIPs. Current batch $3 of $2 contains $4 chats; use the guided next-batch action after a verified export.',batchResultSummary:'Batch $1 of $2',batchNextAction:'Continue to batch $1 of $2',scaleGuidanceCurrent:'Scale: visible messages now — $1. Large histories or many large files can take minutes and use substantial browser memory; export one chat at a time when possible.',scaleGuidanceMulti:'Scale: chats to process — $1 (up to $2 per archive). Chats are processed one at a time; for a larger selection, export batches of $2 and then select the next batch.',preparationTitle:'Review before export',preparationDetailsTitle:'History, workload & ZIP-opening details',preparationDetailsHint:'Optional details; readiness and the main action stay visible',preparationHistoryTitle:'Automatic history scan',preparationWorkloadTitle:'Check the workload',preparationProtectionTitle:'Prepare to open the ZIP',preparationProtectionAes:'Save the password now — Local Archive cannot recover it. $1 After download, use Verify downloaded ZIP below.',preparationProtectionNone:'No password: anyone with the ZIP can read it. After download, use Verify downloaded ZIP below.',preparationCompact:'$1 · $2 · $3 · $4',preparationCompactRendered:'Messages available in this tab',preparationCompactNoMessages:'No messages detected · review compatibility',preparationCompactAes:'AES-256 · save password now (cannot recover) · use AES ZIP app',preparationCompactNone:'no password',historyCoachStart:'Preview older history',historyCoachTitle:'Optional history preview',historyCoachBody:'Local Archive scans newer and older messages automatically during export. If you want to inspect the date first, scroll upward until the oldest message you need appears, then update this review.',historyCoachReturn:'Update review',preparationAppWindows:"On Windows, use 7-Zip or PeaZip from the publisher's official site.",preparationAppMac:"On macOS, use PeaZip from the publisher's official site.",preparationAppLinux:'On Linux, use PeaZip or 7-Zip from the official site or package manager.',preparationAppOther:'Use PeaZip from its official site; Windows and Linux can also use 7-Zip.',aesHelpOpen:'First-use walkthrough',aesGetPeaZip:'Get PeaZip',aesGet7Zip:'Get 7-Zip',aesOfficialSource:'Official source',liveCheckTitle:'Live Telegram check:',liveCheckPassed:'Passed in this tab · $1/$2 rendered messages recognized · $3',liveCheckNoChat:'Not ready · open a chat in this tab.',liveCheckNoMessages:'Not ready · wait for messages to appear.',liveCheckUnsupported:'Blocked · this Telegram message layout could not be read safely.',liveCheckLayoutUnknown:'layout not recognized',compatibilityRefresh:'Check again',compatibilityNoChat:'No open chat was detected. Choose Preview older history, open a Telegram chat, then Update review. If a chat is already open, this Telegram layout is not supported yet.',compatibilityNoMessages:'No rendered messages were detected. The chat may still be loading, be empty, or use an unsupported Telegram layout. Wait or use Preview older history, then refresh; export stays blocked until a message is detected.',compatibilityUnsupported:'Messages are visible, but their IDs or content cannot be read safely in this Telegram layout. Export is blocked; update Local Archive before relying on it.',validationNoMessages:'No readable messages were detected. Open or load a chat, then update the pre-export review.',runBoundaryMulti:'Before this multi-chat export: only messages available in this authorized Telegram tab can be saved; this is not a complete account backup. The live layout check is repeated for every chat, and the receipt reports each exact range.',runBoundaryLong:'Before this larger export: only messages available in this authorized Telegram tab can be saved; this is not a complete account backup. Verify the exact saved range before relying on the ZIP.',privatePreflightTitle:'Private nearby-history ZIP test',privatePreflightIdle:'Optional: briefly check the current and nearby history, package up to 10 real messages, reopen the ZIP locally, and return to your position. No file is saved and nothing is uploaded.',privatePreflightWorking:'Checking nearby history, packaging the sample, and reopening it locally…',privatePreflightPassed:'Passed · $1 real messages · checked $2 · packaged and reopened locally · $3 · position restored · no file saved',privatePreflightFailed:'Not passed · the local ZIP pipeline is not ready. Reload Telegram Web or change archive protection and try again.',privatePreflightAction:'Test nearby history',privatePreflightAgain:'Run again',privatePreflightPassword:'Enter and confirm the archive password first so the selected AES route can be tested.',privatePreflightFormat:'Select HTML, JSON, or both before running this test.',privatePreflightDirectionsBoth:'newer + older nearby history',privatePreflightDirectionsNewer:'newer nearby history',privatePreflightDirectionsOlder:'older nearby history',privatePreflightDirectionsVisible:'the current visible page',workloadTitle:'Preflight —',workloadLevelLight:'Light',workloadLevelModerate:'Moderate',workloadLevelHeavy:'Heavy',workloadCurrent:'$1 · 1 chat · $2 visible · $3 · caps: $4. Final size is measured after fetch; peak memory can exceed the ZIP.',workloadMulti:'$1 · $2 chats · $3 visible in the open chat · $4 · caps: $5. Other counts are measured during export; peak memory can exceed the ZIP.',workloadMediaNone:'text only',workloadMediaCount:'$1 media types',workloadMediaOne:'1 media type',workloadCapsNone:'none in this selection',footerScopeCurrent:'Current: $1',footerScopeSelected:'$1 chats selected',footerScopeCategory:'Category: $1',footerScopeSummary:'$1 · $2',mediaTitle:'Media',mediaDescription:'Each file is checked against its size limit before it enters the archive.',moreMediaTitle:'More media options',moreMediaStatus:'$1 selected · Videos, stickers, and files',moreMediaStatusNone:'Videos, stickers, and files',mediaPhotos:'Photos',mediaVideos:'Videos and GIFs',
                mediaVoice:'Voice messages',mediaStickers:'Stickers',mediaFiles:'Files',maxEach:'Max per item',megabytesShort:'MB',currentChat:'Open chat',localOnlyTitle:'Nothing leaves this browser',
                localOnlyBody:'Archive processing stays local and no conversation content is uploaded. The default ZIP has no password; optional AES-256 protection is available in advanced settings.',exporting:'Creating archive…',close:'Close',exportNow:'Save protected ZIP · open with PeaZip or 7-Zip',exportNowUnencrypted:'Save unencrypted ZIP · open with Firefox after unzipping',footerProtectionNone:'Unencrypted ZIP · unzip, then open in Firefox · anyone with the file can read it',footerProtectionAes:'AES-256 · keep password elsewhere · open with PeaZip or 7-Zip',
                protectionTitle:'Archive protection',protectionDescription:'Choose privacy or easiest opening. You can change this before export.',protectionPrimerTitle:'Opening choice',protectionPrimerAes:'Password protection uses AES-256. Firefox cannot extract it; use PeaZip or 7-Zip and keep the password elsewhere.',protectionPrimerNone:'Default: a no-password ZIP is easiest to open, but anyone with the file can read it.',protectionPrimerAction:'Change ZIP protection',protectionOpeningWarning:'Firefox does not extract this AES ZIP itself. Use PeaZip (or 7-Zip on Windows/Linux), or choose the unencrypted option.',protectionEnable:'Require a password to open this ZIP',protectionEnableHint:'Uses AES-256. The password stays only in memory for this export.',protectionChoiceAesTitle:'Password-protected ZIP · requires PeaZip/7-Zip',protectionChoiceAesHint:'AES-256 · Firefox cannot open it by itself · keep the password elsewhere',protectionChoiceNoneTitle:'No-password ZIP · easiest to open',protectionChoiceNoneHint:'Unzip, then open messages.html in Firefox · anyone with the file can read it',passwordLabel:'Password',passwordConfirmLabel:'Confirm password',passwordHint:'Before creating the archive, write down or store this password elsewhere. Local Archive clears it after export and cannot recover it. Use at least 8 characters. Some built-in extractors cannot open AES-encrypted ZIPs; use an archive app that explicitly supports AES ZIP encryption.',aesHelpTitle:'How to open an AES ZIP',aesHelpHint:'Official app links and four first-use steps',aesHelpStepDownload:'Let Firefox finish downloading the ZIP.',aesHelpStepOpen:'Open the ZIP in PeaZip or 7-Zip.',aesHelpStepPassword:'Enter the password you saved before export.',aesHelpStepExtract:'Extract the folder, then open messages.html in Firefox; keep result.json for reusable data.',aesAppWindows:'Recommended on Windows: 7-Zip or PeaZip. Use one of the official links below.',aesAppMac:'Recommended on macOS: PeaZip. Use the official link below.',aesAppLinux:'Recommended on Linux: PeaZip or 7-Zip. Use an official link below or your package manager.',aesAppOther:'Recommended: PeaZip. On Windows and Linux, 7-Zip is another option. Use an official source.',aesCompatibilityNote:'Compatibility: Local Archive creates AES-256 / WinZip AES ZIPs, not legacy ZipCrypto. Use an app whose documentation explicitly lists AES-256 ZIP or WinZip AES support.',aesHelpSafety:'Test the extracted archive before deleting or replacing any original data.',unencryptedConfirmTitle:'This ZIP will not be encrypted.',unencryptedConfirmBody:'Anyone who gets the file can read it. Enable AES-256 above if you need password protection.',createUnencrypted:'Create unencrypted ZIP · open in Firefox after unzipping',
                popupSettings:'Defaults & privacy',resultFileLabel:'File',resultSizeLabel:'Archive size',resultProtectionLabel:'Protection',resultProtectionAes:'AES-256 password',resultProtectionNone:'No password',resultValidationLabel:'Local check',resultValidationPassed:'Passed · $1 files · report readable',resultValidationStructure:'Passed · $1 files',
                renderedScopeNote:"Local Archive scans toward newer and older messages automatically during export. The receipt records the exact range Telegram Web exposed; a complete account history is not guaranteed. A passed check describes this tab's current rendered layout only; Telegram may change another layout later.",
                preExportScopeWarning:'Local Archive scans older and newer messages automatically. Preview only to check the date now; the receipt records the exact saved range.',preExportMultiScopeWarning:'Local Archive scans every chosen chat automatically and reports its exact saved range. Preview the open chat only to inspect the date before export.',preExportTargetCurrent:'Required goal: save the open chat back to $1. Its oldest currently visible date is $2; Local Archive will scan older messages automatically and report whether the saved range reached the goal.',preExportTargetCurrentUnknown:'Required goal: save the open chat back to $1. Local Archive will scan automatically and report whether the exact saved range reached the goal.',preExportTargetMulti:'Required goal: save every chosen chat back to $1. Local Archive scans each chat automatically and reports whether every exact saved range reached the goal.',historyReadyCurrent:'Live check passed. I understand this ZIP includes only messages exposed in this tab; I reviewed workload and protection.',historyReadyMulti:'Live check passed for the open chat; every chosen chat is checked before collection. I reviewed ranges, workload, and protection.',historyReadyBadgeRequired:'Required',historyReadyBadgeDone:'Checked',
                oldestLoadedValue:'Oldest currently loaded in the open chat: $1',oldestLoadedUnknown:'Oldest loaded message could not be dated — check the chat manually before export.',loadedCountValue:'Visible now: $1 messages. Collection may load more; large histories are safer one chat at a time and can be stopped with a partial save.',loadedCountValueOne:'Visible now: $1 message. Collection may load more; large histories are safer one chat at a time and can be stopped with a partial save.',
                resultOpenHelp:'Verify the downloaded ZIP below, then extract it and open messages.html. Keep result.json for reusable data.',resultOpenHelpEncrypted:'Verify this AES ZIP below by re-entering the password, then open it with PeaZip or 7-Zip and open messages.html.',resultExtractionCheck:'Use Verify downloaded ZIP below. After extracting, open messages.html before deleting or replacing originals.',resultShowDownload:'Show downloaded ZIP',resultShowDownloadFile:'Shown in its folder: $1',resultShowDownloadFolder:'Exact match not found. Opened the Downloads folder — find: $1',resultShowDownloadError:'Could not open a folder. In Firefox Downloads, find: $1',
                resultVerifyDownload:'Verify downloaded ZIP',verificationSelectedFile:'Selected file',verificationPasswordLabel:'Archive password',verificationPasswordWarning:'Local Archive cannot recover a forgotten password. Re-enter it only to verify this local file; the field is cleared immediately after the check.',verificationRun:'Verify locally',verificationReading:'Opening and checking this ZIP locally…',verificationNeedPassword:'This AES ZIP needs its password. Re-enter it below; Local Archive clears the field immediately after the check.',verificationPasswordTooShort:'Enter the archive password (at least 8 characters).',verificationWrongPassword:'That password did not open this ZIP. Nothing was changed; try again.',verificationMismatch:'Selected $1, but this receipt belongs to $2. Choose the matching downloaded ZIP.',verificationNotArchive:'This file is not a readable Local Archive ZIP, or its report and saved outputs do not agree.',verificationLimit:'Archive created and downloaded successfully. Built-in verification stopped at the 512 MB readable HTML/JSON limit; extract the ZIP with PeaZip or 7-Zip and inspect the files directly. This does not mean the archive is corrupt.',verificationError:'Firefox could not verify this ZIP. The file was not changed; choose it again or extract it with PeaZip or 7-Zip.',verificationOutputsBoth:'messages.html + result.json',verificationOutputsHtml:'messages.html',verificationOutputsJson:'result.json',verificationSuccess:'Verified locally: $1 · export-summary.json + $2 · $3 · $4 · $5. The selected file never left this device.',
                validationPasswordLength:'Use a password with at least 8 characters.',validationPasswordMismatch:'The two passwords do not match.',validationHistoryReady:'Confirm the pre-export review below before creating the archive.',validationLiveCheck:'This Telegram message layout did not pass the live safety check. Export is blocked until Local Archive supports it.',errorLiveLayoutCheck:'The open chat no longer passes Local Archive’s live layout check. Refresh Telegram Web or update Local Archive before retrying.',
                resultSummaryChats:'$1 chats',resultSummaryChat:'$1 chat',resultSummaryMessages:'$1 messages',resultSummaryMessage:'$1 message',resultSummaryMedia:'$1 media items included',resultSummaryMediaOne:'$1 media item included',resultSummarySkipped:'$1 skipped',resultSummaryNotSelected:'$1 not selected',resultSummaryPending:'$1 pending',resultSummaryReasons:'Reasons: $1',
                resultSummaryRange:'Saved range: $1 – $2',resultTargetStatusLabel:'Oldest-date goal',resultTargetStatusReached:'Reached: yes · $1 · $2/$3 chats',resultTargetStatusMissed:'Reached: no · $1 · $2/$3 chats',resultTargetStatusUnknown:'Reached: unknown · $1',resultTargetReached:'Saved range reaches $1 in $2/$3 requested chats. This verifies the saved dates, not complete Telegram history.',resultTargetMissed:'Saved range does not reach $1 in: $2. Load older messages and export again.',resultTargetUnverified:'Saved range back to $1 could not be verified for $2 requested chats because they were skipped.',resultTargetStopped:'The export was stopped, so the saved range back to $1 is not confirmed for every requested chat.',resultCoverageTitle:'Saved by chat:',resultCoverageRow:'$1 — $2 messages · $3 – $4',resultCoverageRowOne:'$1 — $2 message · $3 – $4',resultCoverageRowNoDate:'$1 — $2 messages',resultCoverageRowNoDateOne:'$1 — $2 message',resultCoverageMore:'…and $1 more chats; see export-summary.json.',resultOmissionsTitle:'Skipped items:',resultOmissionSize:'$1 — $2 ($3 > $4)',resultOmissionAtLeast:'$1 — $2 (at least $3; limit $4)',resultOmissionBasic:'$1 — $2',resultOmissionsMore:'…and $1 more items; see export-summary.json.',resultOmissionsMoreOne:'…and $1 more item; see export-summary.json.',
                resultSummaryPartial:'Partial archive: only content collected before stopping was saved.',resultSummaryRendered:'This is not a complete Telegram backup. Local Archive saved the messages it could load in this tab; older messages remain outside this ZIP if Telegram did not reach them.',resultSummaryHistoryReached:'History scan reached Telegram’s oldest available point in this tab. This is not a complete account backup.',resultReadableLimit:'Built-in verifier limit: 512 MB of readable HTML/JSON. Larger ZIPs remain valid; open them with PeaZip or 7-Zip.',
                mediaReasonSize:'size limit',mediaReasonNetwork:'network or access',mediaReasonCancelled:'stopped by you',mediaReasonInvalid:'invalid item',mediaReasonThumbnail:'thumbnail unavailable',mediaReasonUnknown:'unknown reason'
            };
            dialogMessages.scopeAllType='All chats in one category · automatic chat check · you start each batch and keep this tab open';
            dialogMessages.exporterEyebrow='CONVERSATION EXPORTER';
            dialogMessages.exporterTitle='Local Archive';
            dialogMessages.exporterSubtitle='A readable copy, reusable data, and selected media — saved on this device.';
            dialogMessages.exportNow='Save conversation';
            dialogMessages.exportNowUnencrypted='Save conversation';
            dialogMessages.createUnencrypted='Save conversation';
            dialogMessages.scopeSelected='Choose chats · automatic chat check · you start each batch and keep this tab open';
            dialogMessages.formatJson='Reusable data (JSON)';
            dialogMessages.formatJsonHint='Use result.json for search, analysis, or migration.';
            dialogMessages.protectionDescription='Need to open it in Firefox now? Choose no password. Have or will install PeaZip/7-Zip? Keep AES-256.';
            dialogMessages.preparationPlainTitle='Three decisions before export';
            dialogMessages.preparationPlainSave='Local Archive loads older history automatically; the receipt shows the exact loaded range.';
            dialogMessages.resultTargetStatusLabel='History-date coverage';
            dialogMessages.resultTargetStatusReached='History goal reached · $1 · $2/$3 chats';
            dialogMessages.resultTargetStatusMissed='History goal not reached · $1 · $2/$3 chats · load older messages and export again';
            dialogMessages.resultTargetStatusUnknown='History goal unknown · $1 · export stopped before every requested chat could be confirmed';
            dialogMessages.preparationDetailsTitle='More details (optional)';
            dialogMessages.preparationDetailsHint='Open only for date, workload, or ZIP-opening help';
            dialogMessages.beginnerSetupSummaryTitle='Current archive settings';
            dialogMessages.beginnerSetupScopeLabel='Scope';
            dialogMessages.beginnerSetupFormatLabel='Format';
            dialogMessages.beginnerSetupMediaLabel='Media';
            dialogMessages.beginnerSetupProtectionLabel='Protection';
            dialogMessages.beginnerSetupCurrent='Current chat';
            dialogMessages.beginnerSetupReadable='Readable HTML';
            dialogMessages.beginnerSetupBalancedFormat='Readable HTML + reusable JSON data';
            dialogMessages.beginnerSetupNoMedia='No media';
            dialogMessages.beginnerSetupBalancedMedia='Balanced media · photos, voice, stickers';
            dialogMessages.beginnerSetupUnencrypted='Unencrypted ZIP · open in Firefox';
            dialogMessages.beginnerSetupProtected='AES-256 · PeaZip or 7-Zip';
            dialogMessages.beginnerSetupChange='Change setup';
            dialogMessages.beginnerSetupHint='Technical history, workload, and compatibility details stay behind the review below.';
            dialogMessages.preflightFooterRecommended='Nearby-history sample recommended before this run';
            dialogMessages.preflightFooterWorking='Checking nearby history…';
            dialogMessages.preflightFooterPassed='Nearby-history sample passed · $1 messages · no file saved';
            dialogMessages.preflightFooterFailed='Nearby-history sample needs attention';
            dialogMessages.batchProgress='$1 of $2 batches complete · your full selection remains queued.';
            dialogMessages.batchProgressComplete='All $1 batches complete · $2 chats archived.';
            dialogMessages.batchResultProgress='Batch $1 complete · $2 of $3 batches · $4 of $5 chats archived. Continue with the next verified batch below.';
            dialogMessages.batchRunAll='Queue all batches · start each · verify each ZIP';
            dialogMessages.batchRunRemaining='Run remaining batches';
            dialogMessages.batchManifestTitle='Batch handoff';
            dialogMessages.batchManifestCurrent='Batch $1 · chats $2–$3 · current batch';
            dialogMessages.batchManifestPending='Batch $1 · chats $2–$3 · not started';
            dialogMessages.batchManifestQueued='Batch $1 · chats $2–$3 · queued for a separate start and verification';
            dialogMessages.batchManifestVerified='Batch $1 · chats $2–$3 · verified ZIP: $4';
            dialogMessages.batchManifestDownloads='saved in Downloads';
            dialogMessages.batchHandoff='Next: Local Archive opens “$1” in this tab, checks the layout, and adds it to the current ZIP. Verify the ZIP after export.';
            dialogMessages.batchResumeHandoff='Resuming: $1 of $2 ZIPs verified. Start batch $3; Local Archive opens and checks its chats, then verify the ZIP.';
            dialogMessages.batchNextActionHandoff='Continue to batch $1 of $2: start with “$3”; Local Archive opens and checks the batch, then verify its ZIP';
            dialogMessages.batchChatProgressTitle='Chat-by-chat progress';
            dialogMessages.batchChatNext='Next chat: $1';
            dialogMessages.batchChatVerified='$1 · verified';
            dialogMessages.batchChatCurrent='$1 · checked next';
            dialogMessages.batchChatQueued='$1 · queued';
            dialogMessages.batchChatMore='+$1 more chats in this batch';
            dialogMessages.batchChatAction='Continue automatic chat check';
            dialogMessages.manualWizardTitle='Automatic chat check';
            dialogMessages.manualWizardMeta='Chat $1 of $2 · $3 included · one ZIP per batch';
            dialogMessages.manualWizardOpen='Next: open “$1” in this Telegram tab';
            dialogMessages.manualWizardCheck='Local Archive checks whether Telegram displays this chat in a readable format';
            dialogMessages.manualWizardSave='Add this chat to the current ZIP';
            dialogMessages.manualWizardVerify='Verify the ZIP after export';
            dialogMessages.manualWizardNext='Next: Local Archive opens “$1” and checks it';
            dialogMessages.manualWizardNextSave='Next: Local Archive adds the checked chat to this ZIP';
            dialogMessages.manualWizardNextVerify='Next: verify the ZIP after export';
            dialogMessages.manualWizardActionCheck='Continue automatic chat check';
            dialogMessages.manualWizardActionReview='Review and save ZIP';
            dialogMessages.manualWizardActionVerify='Verify downloaded ZIP';
            dialogMessages.batchProgressQueued='$1 of $2 batches complete · all remaining batches are queued. Start each batch separately; Local Archive checks its chats and AES passwords are re-entered per batch.';
            dialogMessages.batchResultQueued='Batch $1 complete · $2 of $3 batches · $4 of $5 chats archived. Continue to the next verified batch; each ZIP is started and verified separately.';
            dialogMessages.batchDetail='Batch $1 of $2 · chats $3–$4 · $5 in this ZIP · one ZIP for this batch.';
            dialogMessages.preparationPlainTitle='Three decisions before export';
            dialogMessages.preparationPlainSave='Local Archive loads older history automatically; the receipt shows the exact loaded range.';
            dialogMessages.preparationPlainMissing='The scan waits for Telegram pages to arrive. Large runs take more time and memory; a stopped run is marked partial.';
            dialogMessages.preparationPlainOpenAes='Open: Firefox for an unencrypted ZIP; PeaZip or 7-Zip for AES-256.';
            dialogMessages.preparationPlainOpenNone='Protection: no password; anyone with the file can read it; confirm once more.';
            dialogMessages.preparationNextTitle='Next step';
            dialogMessages.preparationNextCurrent='Next: confirm these three checks, then use the main action.';
            dialogMessages.preparationNextReady='Next: use the main action; Firefox validates the ZIP before download.';
            dialogMessages.preparationNextBatch='Next: queue the batches. For each one, start the automatic chat check; Local Archive opens and checks every chat, then verify the ZIP before moving on.';
            dialogMessages.preparationNextMulti='Next: start the automatic chat check; Local Archive opens and checks each selected chat, builds this ZIP, then you verify it.';
            dialogMessages.preparationNextCompatibility='Next: open a Telegram chat and use Check again before continuing.';
            dialogMessages.preparationNextSimple='Next: confirm this short review, then use the main action. It opens in Firefox without an extra app.';
            dialogMessages.scopeBoundary='Local Archive loads the open chat through Telegram Web before saving — this is not a complete account backup.';
            dialogMessages.coverageTargetSelected='Selected date: $1';
            dialogMessages.coverageTargetEmpty='No date target selected';
            dialogMessages.formatHtmlHint='Open messages.html in Firefox after unzipping; browse the chat like a webpage.';
            dialogMessages.formatJsonHint='Use result.json for search, analysis, or migration.';
            dialogMessages.workloadDetailsTitle='Workload details (optional)';
            dialogMessages.workloadCompactCurrent='$1 · $2 loaded now · $3';
            dialogMessages.workloadCompactMulti='$1 · $2 chats · $3';
            dialogMessages.privatePreflightTitle='Optional ZIP sample';
            dialogMessages.privatePreflightIdle='Optional: test up to 10 current or nearby messages, reopen the ZIP locally, and return here. This does not change your export, save a file, or upload content.';
            dialogMessages.privatePreflightWorking='Checking a small sample and reopening it locally…';
            dialogMessages.privatePreflightPassed='Passed · $1 real messages · checked $2 · reopened locally · $3 · position restored · no file saved';
            dialogMessages.privatePreflightFailed='Sample check did not pass. Reload Telegram Web or change ZIP protection and try again.';
            dialogMessages.privatePreflightAction='Run optional ZIP sample';
            dialogMessages.privatePreflightAgain='Run sample again';
            dialogMessages.liveSmokeTitle='One-message live check';
            dialogMessages.liveSmokeIdle='User-driven: read one real message in this Telegram tab, build and reopen a local ZIP, and save nothing.';
            dialogMessages.liveSmokeWorking='Checking one real message and reopening the ZIP locally…';
            dialogMessages.liveSmokePassed='Passed · 1 real message · ZIP reopened locally · no file saved';
            dialogMessages.liveSmokeFailed='One-message check did not pass. Reload Telegram Web or use Check again, then retry.';
            dialogMessages.liveSmokeAction='Test one message';
            dialogMessages.liveSmokeAgain='Run one-message check';
            dialogMessages.protectionPrimerTitle='Choose archive protection';
            dialogMessages.protectionPrimerAes='Password protection uses AES-256 and needs PeaZip or 7-Zip. Save the password elsewhere before export.';
            dialogMessages.preparationProtectionAes='Write down or store the password elsewhere — Local Archive cannot recover it. $1 After download, use Verify downloaded ZIP below.';
            dialogMessages.preparationCompactAes='AES-256 · write down password (cannot recover) · use AES ZIP app';
            dialogMessages.protectionPrimerNone='Default: no password. Anyone with the ZIP can read it. For a simple first export, keep Current chat and choose Readable first above.';
            dialogMessages.protectionPrimerAction='Change ZIP protection';
            dialogMessages.missingSummaryAction='What may be missing?';
            dialogMessages.beginnerGuideTitle='Choose a starting preset';
            dialogMessages.scopeManualPrimer='Multi-chat mode. To return to one chat, choose Current chat above. Local Archive checks each selected chat before adding it and creates one ZIP per batch.';
            dialogMessages.beginnerGuideBody='Both presets stay in this Telegram tab and upload nothing. Quick preset: unencrypted ZIP with readable HTML and no media. Privacy preset: AES-256 password-protected ZIP with HTML, reusable JSON, photos, voice messages, and stickers. You can customize either setup later.';
            dialogMessages.beginnerGuideBodySimple='Quick-open mode is active: current chat, readable HTML, unencrypted ZIP, no media. Unzip it, then open messages.html in Firefox. Advanced formats, media, dates, and chat selection are hidden until you switch back.';
            dialogMessages.beginnerGuideBodyProtected='Privacy mode is active: readable HTML + reusable JSON data are protected with AES-256. Firefox cannot open this ZIP itself; use PeaZip or 7-Zip and write down or store the password elsewhere. Advanced controls remain below.';
            dialogMessages.beginnerGuideAction='Use quick path';
            dialogMessages.beginnerGuideActionAdvanced='Show advanced setup';
            dialogMessages.beginnerGuideActionProtected='Use privacy path';
            dialogMessages.beginnerGuideActionSimpleSwitch='Use quick path';
            dialogMessages.beginnerGuideActionProtectedSwitch='Show advanced setup';
            dialogMessages.beginnerSetupSummaryTitle='Current archive settings';
            dialogMessages.beginnerSetupScopeLabel='Scope';
            dialogMessages.beginnerSetupFormatLabel='Format';
            dialogMessages.beginnerSetupMediaLabel='Media';
            dialogMessages.beginnerSetupProtectionLabel='Protection';
            dialogMessages.beginnerSetupCurrent='Current chat';
            dialogMessages.beginnerSetupReadable='Readable HTML';
            dialogMessages.beginnerSetupBalancedFormat='Readable HTML + reusable JSON data';
            dialogMessages.beginnerSetupNoMedia='No media';
            dialogMessages.beginnerSetupBalancedMedia='Balanced media · photos, voice, stickers';
            dialogMessages.beginnerSetupUnencrypted='Unencrypted ZIP · open in Firefox';
            dialogMessages.beginnerSetupProtected='AES-256 · PeaZip or 7-Zip';
            dialogMessages.beginnerSetupChange='Change setup';
            dialogMessages.beginnerSetupHint='Technical history, workload, and compatibility details stay behind the review below.';
            dialogMessages.beginnerGuideBoundary='Keep this Telegram tab open · only messages it exposes can be saved.';
            dialogMessages.beginnerGuideBoundaryCurrent='Current settings: 1 chat — $1 · $2 · $3 · media: $4';
            dialogMessages.beginnerGuideBoundaryMulti='Current settings: multi-chat · $1 · $2 · $3 · media: $4';
            dialogMessages.beginnerBoundaryProtected='AES-256 password-protected ZIP';
            dialogMessages.beginnerBoundaryUnencrypted='Unencrypted ZIP';
            dialogMessages.beginnerBoundaryNoMedia='no media';
            dialogMessages.beginnerGuideStepOne='Simple: current chat + readable HTML.';
            dialogMessages.beginnerGuideStepTwo='Protection: write down or store the AES password elsewhere, or choose no password.';
            dialogMessages.beginnerGuideStepThree='Keep this tab open, review, then create the ZIP.';
            dialogMessages.capabilityLimitChats='Up to $1 chats per ZIP. Larger selections are split into verified batches; keep this Telegram tab open while each chat is checked.';
            dialogMessages.capabilityLimitReadable='Built-in verification reads up to 512 MB of HTML/JSON. Larger ZIPs are still valid; open them with PeaZip or 7-Zip.';
            dialogMessages.batchTabGuidance='Keep Telegram open · Local Archive checks chats one by one · one ZIP per batch.';
            dialogMessages.preflightStripTitle='Before you start';
            dialogMessages.preflightStripTabCurrent='Keep this Telegram tab open until the ZIP is ready.';
            dialogMessages.preflightStripTabMulti='Keep this Telegram tab open. Local Archive opens each selected chat, checks its layout, and adds it to the current ZIP. Stop anytime; verify the ZIP after export.';
            dialogMessages.preflightStripScope='Local Archive loads the selected chat history in this tab before saving.';
            dialogMessages.preflightStripPassword='Write down or store the password elsewhere before exporting; Local Archive cannot recover it.';
            dialogMessages.preflightStripNone='No password: anyone with the ZIP can read it.';
            dialogMessages.resultOpenGuideTitle='Next: open this ZIP in Firefox';
            dialogMessages.resultOpenGuideBody='No password is required. Verify it below, then open the downloaded ZIP in Firefox or any archive app and open messages.html. Keep result.json for reusable data.';
            dialogMessages.resultOpenGuideStepOpen='Open the downloaded ZIP in Firefox or any archive app — no password is required.';
            dialogMessages.resultOpenGuideStepHtml='Open messages.html in Firefox.';
            dialogMessages.resultOpenGuideStepJson='Keep result.json for reusable data.';
            dialogMessages.presetReadable='Readable first';
            dialogMessages.coverageCompactCurrent='Open chat: $1 loaded now · oldest $2 · older history loads during export';
            dialogMessages.coverageCompactCurrentUnknown='Open chat: $1 loaded now · older history loads during export · oldest date unavailable';
            dialogMessages.compatibilityRefresh='Check again now';
            dialogMessages.resultAesGuideTitle='Next: open this protected ZIP';
            dialogMessages.resultAesGuideBody='The archive is ready. Open it with PeaZip or 7-Zip; Firefox can open messages.html after extraction.';
            dialogMessages.resultAesGuideStepStart='Open the downloaded ZIP in PeaZip or 7-Zip.';
            dialogMessages.resultAesGuideOpenButton='How to open this ZIP';
            dialogMessages.resultDetailsTitle='Full receipt details';
            dialogMessages.resultPrimaryTitle='ZIP checked locally · Firefox is saving it';
            dialogMessages.downloadSavingTitle='ZIP created · Firefox is saving it';
            dialogMessages.downloadCompleteTitle='Download complete';
            dialogMessages.downloadInterruptedTitle='ZIP created · Firefox download interrupted';
            dialogMessages.downloadUnknownTitle='ZIP created · check Firefox Downloads';
            dialogMessages.resultPrimarySavingTitle='ZIP checked locally · Firefox is saving it';
            dialogMessages.resultPrimaryDownloadedTitle='Saved ZIP checked locally · download complete';
            dialogMessages.resultPrimaryInterruptedTitle='ZIP checked locally · Firefox download interrupted';
            dialogMessages.resultPrimaryDownloadUnknownTitle='ZIP checked locally · confirm the saved file in Firefox Downloads';
            dialogMessages.resultPrimaryFile='File: $1';
            dialogMessages.resultPrimaryOmissions='Some items were omitted; see full receipt details below.';
            dialogMessages.resultOmissionAction='Review skipped media → change limit → re-export';
            dialogMessages.resultOmissionActionOne='Review 1 skipped media item → change limit → re-export';
            dialogMessages.resultOmissionActionMany='Review $1 skipped media items → change limit → re-export';
            dialogMessages.resultPrimaryOmissionSpecific='Skipped: $1';
            dialogMessages.resultPrimaryOmissionExact='Skipped: $1 · $2 · $3 exceeds the $4 limit · message $5 in $6';
            dialogMessages.resultOmissionActionExact='Fix $1: set $2 limit to at least $4';
            dialogMessages.resultPrimaryNextOmissionExact='Recovery: increase the highlighted $1 limit from $2 to at least $3 → Create another archive → Verify the new ZIP. This ZIP already contains all text and other included media.';
            dialogMessages.resultPrimaryNextSelectedOmissionExact='Recovery: increase the highlighted $1 limit from $2 to at least $3 → Create another archive → Verify the new ZIP. All selected chats and other included items are already in this ZIP.';
            dialogMessages.resultPrimaryNextBatchOmissionExact='Recovery for this batch: increase the highlighted $1 limit from $2 to at least $3 → Create another archive → Verify the new ZIP. Or keep this omission and continue with the next batch, “$4”.';
            dialogMessages.beginnerGuideBodyAdvanced='Advanced setup is active: choose AES-256 for a password-protected ZIP, or no password for easiest opening. The protection cards and footer always show the current choice.';
            dialogMessages.resultPrimaryNoOmissions='No item omissions were recorded.';
            dialogMessages.resultPrimaryMissing='Scope: this Telegram tab only · exact saved range in Full receipt · not a complete Telegram backup';
            dialogMessages.resultPrimaryNextAes='Recommended: verify the downloaded ZIP with your password, then extract it in PeaZip or 7-Zip and open messages.html.';
            dialogMessages.resultPrimaryNextNone='Recommended: verify the downloaded ZIP, then unzip it and open messages.html in Firefox.';
            dialogMessages.resultPrimaryNextSelected='Next: verify this ZIP; all selected chats are already in this archive.';
            dialogMessages.resultPrimaryNextBatch='Next: verify this ZIP, then switch Telegram to “$1” and continue with the next batch.';
            dialogMessages.resultPrimaryNextBatchOmissions='Next: verify this ZIP, then switch Telegram to “$1” and continue with the next batch. Omitted media can be retried later by raising the limit or enabling its type.';
            dialogMessages.resultPrimaryNextBatchesComplete='Next: verify this ZIP; all planned batches are complete.';
            dialogMessages.resultPrimaryNextBatchesCompleteOmissions='Next: verify this ZIP; all planned batches are complete. Omitted media can be retried by raising the limit or enabling its type.';
            dialogMessages.resultPrimaryNextSelectedOmissions='Next: verify this ZIP; all selected chats are already in it. To include omitted media, raise the limit or enable its type, then export again.';
            dialogMessages.resultPrimaryNextPartialMulti='Next: verify this partial ZIP, then reopen the incomplete chat and export it again; remaining chats stay pending.';
            dialogMessages.resultPrimaryNextPartial='Next: return to this chat, load more history, and export again; this ZIP keeps only messages collected before Stop.';
            dialogMessages.resultPrimaryNextOmissions='Next: raise the per-file limit or enable the media type, then export again; text and included media are already saved.';
            dialogMessages.resultPrimaryStatusPartial='Partial archive';
            dialogMessages.resultPrimaryStatusReachedYes='History goal: reached';
            dialogMessages.resultPrimaryStatusReachedNo='History goal: not reached';
            dialogMessages.resultPrimaryStatusReachedUnknown='History goal: unknown';
            dialogMessages.resultPrimaryStatusBatchRemaining='1 batch remaining';
            dialogMessages.resultPrimaryStatusBatchesRemaining='$1 batches remaining';
            dialogMessages.resultPrimaryStatusBatchesComplete='All planned batches complete';
            dialogMessages.progressChatsRemaining='$1 of $2 chats checked · $3 remaining$4';
            dialogMessages.progressBatchHint=' · one ZIP per batch · $1 planned';
            dialogMessages.progressCurrentHint='$1 messages collected so far · keep this Telegram tab open';
            dialogMessages.progressScopeNote='Local archive in this browser · older history loads automatically · the receipt records the exact range reached in this Telegram tab.';
            dialogMessages.technicalDetailsTitle='Technical details (optional)';
            dialogMessages.technicalDetailsValue='Recognized Telegram layout: $1 · supported contract: rendered messages with stable IDs and readable content';
            dialogMessages.technicalDetailsFailure='Recognition detail: $1';
            dialogMessages.liveCheckPassed='Telegram layout readable in this open chat · $1/$2 visible messages recognized. History dates, unloaded messages, and media are checked separately.';
            dialogMessages.liveCheckTitle='Telegram layout check:';
            dialogMessages.compatibilityNoMessages='No readable messages were detected. Telegram may still be loading, the chat may be empty, or its layout may have changed. Wait, then use Check again; export stays blocked until a readable message appears.';
            dialogMessages.compatibilityUnsupported='Messages are visible, but their IDs or content cannot be read safely in this Telegram layout. Export is blocked; update Local Archive before relying on it.';
            dialogMessages.beginnerGuideActionHint='After download: 1 Unzip · 2 Open messages.html in Firefox · anyone with the ZIP can read it';
            dialogMessages.beginnerGuideActionProtectedHint='Before download: save the password. After download: 1 Open in PeaZip/7-Zip · 2 Enter saved password · 3 Extract · 4 Open messages.html';
            dialogMessages.beginnerGuideActionTag='Quick preset · unencrypted · no media';
            dialogMessages.beginnerGuideActionProtectedTag='Privacy preset · AES-256 · selected media';
            dialogMessages.beginnerGuideActionProtectedTagAdvanced='AES-256 ZIP · PeaZip/7-Zip';
            dialogMessages.preparationCompact='$1 · $3 · $4';
            dialogMessages.preparationCompactVerifier='verify up to 512 MB HTML/JSON · split large runs or inspect larger ZIP directly';
            dialogMessages.preExportScopeWarning='Local Archive scans older and newer messages automatically. Preview only to check the date now; the receipt records the exact saved range.';
            dialogMessages.preExportMultiScopeWarning='Local Archive scans every chosen chat automatically and reports its exact saved range. Preview the open chat only to inspect the date before export.';
            dialogMessages.historyReadyCurrent='Telegram layout check passed for this open chat. I reviewed the separate history range, workload, and ZIP protection.';
            dialogMessages.historyReadyMulti='Telegram layout check passed for the open chat; every selected chat is checked before it is added. I reviewed the separate history ranges, workload, and ZIP protection.';
            dialogMessages.historyReadyBadgeRequired='Review required';
            dialogMessages.historyReadyBadgeDone='Ready';
            dialogMessages.exportReviewFirst='Complete required review first';
            dialogMessages.scopeManualTitle='Multi-chat mode';
            dialogMessages.protectionPrimerTitle='Choose archive protection';
            dialogMessages.protectionPrimerAes='Password protection uses AES-256 and needs PeaZip or 7-Zip. Save the password elsewhere before export.';
            dialogMessages.protectionPrimerNone='Default: a no-password ZIP opens in Firefox, but anyone with the file can read it.';
            dialogMessages.protectionOpeningWarning='Choose between privacy and easy opening: AES-256 is private but needs PeaZip/7-Zip; unencrypted opens in Firefox but anyone with the file can read it.';
            dialogMessages.preparationCompactAes='Archive: AES-256 password-protected ZIP';
            dialogMessages.preparationCompactLive='Telegram layout: readable';
            dialogMessages.batchDetail='Batch $1 of $2 · chats $3–$4 · $5 in this ZIP · one ZIP for this batch.';
            dialogMessages.batchTabGuidance='Keep Telegram open · Local Archive checks chats one by one · one ZIP per batch.';
            dialogMessages.batchReadyStatus='Batch $1 is ready; start and verify it before Batch $2. $3 of $4 batches complete.';
            dialogMessages.batchReadyStatusLast='Batch $1 is ready; start and verify it. $2 of $3 batches complete.';
            dialogMessages.workloadVerifierLimit='Local verifier reads up to 512 MB of HTML/JSON; open larger archives with PeaZip or 7-Zip.';
            dialogMessages.workloadAdviceModerate='Recommended before a long or multi-chat export: test nearby history first. Then export one chat at a time; if media dominates, deselect Videos/GIFs or Files, or lower their per-item limits.';
            dialogMessages.workloadAdviceTarget='Recommended before a date-targeted export: test nearby history first, then confirm the saved range reaches the date you need.';
            dialogMessages.workloadAdviceHeavy='Recommended: test nearby history first, then split a large selection into smaller batches or export text + photos. Per-item limits are enforced; built-in verification reads up to 512 MB of HTML/JSON, so inspect larger ZIPs directly with PeaZip or 7-Zip.';
            dialogMessages.workloadAdviceSample='Run optional ZIP sample';
            dialogMessages.preparationCompactSampleRecommended='Optional ZIP sample not run';
            dialogMessages.preparationCompactSamplePassed='Optional ZIP sample passed: $1 messages';
            dialogMessages.collapsedSampleAction='Run optional ZIP sample';
            dialogMessages.passwordPanelTitle='Write down or store this password elsewhere before exporting';
            dialogMessages.preparationCompactCurrent='1 chat · $1 messages currently visible';
            dialogMessages.preparationCompactCurrentUnknown='1 chat · $1 messages currently visible';
            dialogMessages.preparationCompactMulti='Multi-chat mode · $1 chats · $2';
            dialogMessages.preparationCompactGoal='History goal: reach $1';
            dialogMessages.preparationCompactNoMessages='Not ready · open a chat and check again';
            dialogMessages.preparationCompactNone='Archive: unencrypted ZIP';
            dialogMessages.preparationCompactLarge='Large export';
            dialogMessages.manualWizardTitle='Multi-chat mode · automatic per-chat check';
            dialogMessages.batchTitle='Multi-chat mode · $1 chats · $2 ZIP batches';
            dialogMessages.completeTitle='ZIP created · Firefox is saving it';
            dialogMessages.resultVerifyDownload='Verify ZIP (recommended)';
            dialogMessages.footerProtectionNone='Unencrypted ZIP · unzip, then open in Firefox · anyone with the file can read it';
            dialogMessages.footerProtectionAes='AES-256 · keep password elsewhere · open with PeaZip or 7-Zip';
            dialogMessages.batchAggregateCoverage='Date goal: $1/$2 chats reached $3.';
            dialogMessages.workloadCurrent='$1 · 1 chat · $2 loaded now · $3 · caps: $4. Local Archive may load more during export; final size is measured after fetch and peak memory can exceed the ZIP. $5';
            dialogMessages.workloadMulti='$1 · $2 chats · $3 loaded in the open chat now · $4 · caps: $5. Other counts are measured during export; peak memory can exceed the ZIP. $6';
            dialogMessages.coveragePreflightOpen='$1 — $2 messages loaded now · oldest $3';
            dialogMessages.coveragePreflightOpenOne='$1 — $2 message loaded now · oldest $3';
            dialogMessages.coveragePreflightOpenUnknown='$1 — $2 loaded now; oldest date unavailable';
            dialogMessages.coverageCompactCurrent='Open chat: $1 loaded now · oldest $2 · older history loads during export';
            dialogMessages.coverageCompactCurrentUnknown='Open chat: $1 loaded now · older history loads during export · oldest date unavailable';
            dialogMessages.coverageCompactMulti='$1 chosen · open chat: $2 loaded now · other chats checked during export';
            dialogMessages.scaleGuidanceCurrent='Loaded in Telegram now: $1 messages. Local Archive may load more during export; large histories or many large files can take minutes and use substantial browser memory.';
            dialogMessages.manualEffortCompact='$1 chats · $2 · Local Archive checks each and builds one ZIP';
            dialogMessages.manualBatchOne='1 ZIP';
            dialogMessages.manualBatchMany='$1 ZIPs';
            dialogMessages.manualEffortProgress='$1 of $2 chats included · next: $3';
            dialogMessages.manualEffortGuidance='Automatic chat check: Local Archive opens $1 chats one by one, checks each readable format, and builds $2.';
            dialogMessages.loadedCountValue='Loaded in Telegram now: $1 messages. Local Archive will load older history before saving; large histories are safer one chat at a time and can be stopped with a partial save.';
            dialogMessages.loadedCountValueOne='Loaded in Telegram now: $1 message. Local Archive will load older history before saving; large histories are safer one chat at a time and can be stopped with a partial save.';
            dialogMessages.workloadCurrent='$1 · 1 chat · $2 loaded now · $3 · caps: $4. Local Archive may load more during export; final size is measured after fetch and peak memory can exceed the ZIP. $5';
            dialogMessages.workloadMulti='$1 · $2 chats · $3 loaded in the open chat now · $4 · caps: $5. Other counts are measured during export; peak memory can exceed the ZIP. $6';
            dialogMessages.protectionChoiceNoneTitle='Easiest to open: unencrypted ZIP · unzip, then open messages.html in Firefox';
            dialogMessages.protectionChoiceNoneHint='Unzip, then open messages.html in Firefox · anyone with the file can read it';
            dialogMessages.createUnencrypted='Create unencrypted ZIP · open in Firefox after unzipping';
            dialogMessages.exportNowUnencrypted='Save unencrypted ZIP · open in Firefox after unzipping';
            root.querySelectorAll('[data-i18n]').forEach(element=>{
                const key=element.dataset.i18n;
                element.textContent=tr(key,dialogMessages[key]||key);
            });
            const brand=root.querySelector('.tgx-brand');
            if(brand&&iconUrl)brand.src=iconUrl;
            const closeButton=root.querySelector('#tgx-close-icon');
            if(closeButton){closeButton.setAttribute('aria-label',tr('close','Close'));closeButton.title=tr('close','Close');}
            const presetGroup=root.querySelector('.tgx-preset-bar');
            if(presetGroup)presetGroup.setAttribute('aria-label',tr('presetTitle','Quick setup'));
            const currentNameElement=root.querySelector('.tgx-current-name');
            if(currentNameElement)currentNameElement.textContent=currentName;
            const oldestLoadedElement=root.querySelector('#tgx-oldest-loaded');
            const loadedCountElement=root.querySelector('#tgx-loaded-count');
            const compatibilityDiagnostic=root.querySelector('#tgx-compatibility-diagnostic');
            const compatibilityDiagnosticText=root.querySelector('#tgx-compatibility-diagnostic-text');
            const compatibilityRefreshButton=root.querySelector('#tgx-compatibility-refresh');
            const liveCheckTechnical=root.querySelector('#tgx-live-check-technical');
            let invalidatePrivatePreflight=()=>{};
            let openPreparationDetails=()=>{};
            function renderCompatibilityDiagnostic(){
                const boundary=root.querySelector('#tgx-export-boundary');
                const liveCheck=root.querySelector('#tgx-live-check');
                const liveCheckText=root.querySelector('#tgx-live-check-text');
                const quickStatus=root.querySelector('#tgx-quick-status');
                const quickStatusTitle=quickStatus?.querySelector('strong');
                const quickStatusText=root.querySelector('#tgx-quick-status-text');
                const quickStatusMark=quickStatus?.querySelector('.tgx-quick-status-mark');
                const quickRecheck=root.querySelector('#tgx-quick-recheck');
                const inspection=inspectRenderedMessageCompatibility();
                if(quickStatus){
                    quickStatus.dataset.state=inspection.ok?'ready':'error';
                    if(quickStatusMark)quickStatusMark.textContent=inspection.ok?'✓':'!';
                    if(quickStatusTitle)quickStatusTitle.textContent=inspection.ok
                        ?tr('quickReadyTitle','Ready to save')
                        :tr('quickBlockedTitle','Cannot read this conversation yet');
                    if(quickStatusText)quickStatusText.textContent=inspection.ok
                        ?tr('quickReadySpecific',`${currentName} can be read from this ${ACTIVE_CONNECTOR.displayName} source. Keep the source tab open until the ZIP is ready.`,[currentName,ACTIVE_CONNECTOR.displayName])
                        :inspection.reason==='no_chat'
                            ?tr('quickBlockedNoChat',`Open a conversation in ${ACTIVE_CONNECTOR.displayName}, then check again.`,[ACTIVE_CONNECTOR.displayName])
                            :inspection.reason==='no_messages'
                                ?tr('quickBlockedNoMessages',`Wait for messages to load in ${ACTIVE_CONNECTOR.displayName}, then check again.`,[ACTIVE_CONNECTOR.displayName])
                                :tr('quickBlockedLayout',`This ${ACTIVE_CONNECTOR.displayName} layout is not supported by the current connector yet.`,[ACTIVE_CONNECTOR.displayName]);
                    if(quickRecheck)quickRecheck.hidden=inspection.ok;
                }
                if(liveCheck){
                    liveCheck.dataset.state=inspection.ok?'passed':'error';
                    const family=inspection.families.join(', ')||tr('liveCheckLayoutUnknown','layout not recognized');
                    if(liveCheckTechnical){
                        liveCheckTechnical.textContent=inspection.ok
                            ?tr('technicalDetailsValue',`Recognized Telegram layout: ${family}.`,[family])
                            :tr('technicalDetailsFailure',`Recognition detail: ${family}.`,[family]);
                    }
                    if(liveCheckText){
                        if(inspection.ok){
                            liveCheckText.textContent=tr(
                                'liveCheckPassed',
                                `Current-tab check only · ${inspection.recognizedCount}/${inspection.renderedCount} readable messages · current layout supported; this does not confirm older history, target dates, or media.`,
                                [String(inspection.recognizedCount),String(inspection.renderedCount)]
                            );
                        }else if(inspection.reason==='no_chat'){
                            liveCheckText.textContent=tr('liveCheckNoChat','Not ready · open a chat in this tab.');
                        }else if(inspection.reason==='no_messages'){
                            liveCheckText.textContent=tr('liveCheckNoMessages','Not ready · wait for messages to appear.');
                        }else{
                            liveCheckText.textContent=tr('liveCheckUnsupported','Blocked · this Telegram message layout could not be read safely.');
                        }
                    }
                }
                if(!compatibilityDiagnostic)return inspection;
                if(inspection.ok){
                    compatibilityDiagnostic.hidden=true;
                    if(compatibilityDiagnosticText)compatibilityDiagnosticText.textContent='';
                    if(compatibilityRefreshButton)compatibilityRefreshButton.hidden=true;
                    boundary?.removeAttribute('data-compatibility');
                    return inspection;
                }
                invalidatePrivatePreflight();
                openPreparationDetails();
                compatibilityDiagnostic.hidden=false;
                const diagnosticText=inspection.reason==='no_chat'
                    ?tr('compatibilityNoChat','No open chat was detected. Choose Preview older history, open a Telegram chat, then Update review. If a chat is already open, this Telegram layout is not supported yet.')
                    :inspection.reason==='no_messages'
                        ?tr('compatibilityNoMessages','No readable messages were detected. Telegram may still be loading, the chat may be empty, or its layout may have changed. Wait, then use Check again; export stays blocked until a readable message appears.')
                        :tr('compatibilityUnsupported','Messages are visible, but their IDs or content cannot be read safely in this Telegram layout. Export is blocked; update Local Archive before relying on it.');
                if(compatibilityDiagnosticText)compatibilityDiagnosticText.textContent=diagnosticText;
                else compatibilityDiagnostic.textContent=diagnosticText;
                if(compatibilityRefreshButton){
                    compatibilityRefreshButton.hidden=false;
                    compatibilityRefreshButton.disabled=false;
                }
                if(boundary){boundary.dataset.compatibility='error';boundary.open=true;}
                return inspection;
            }
            function renderLoadedHistoryFacts(){
                const quickChatName=root.querySelector('#tgx-quick-chat-name');
                const quickSourceName=root.querySelector('#tgx-quick-source-name');
                const quickHistory=root.querySelector('#tgx-quick-history');
                if(quickChatName)quickChatName.textContent=currentName;
                if(quickSourceName)quickSourceName.textContent=ACTIVE_CONNECTOR.displayName;
                if(quickHistory)quickHistory.textContent=loadedMessageCount===1
                    ?tr('quickHistoryOne',`${loadedMessageCount} message is loaded now. Local Archive will load older history before saving.`,[String(loadedMessageCount)])
                    :loadedMessageCount>1
                        ?tr('quickHistoryMany',`${loadedMessageCount} messages are loaded now. Local Archive will load older history before saving.`,[String(loadedMessageCount)])
                        :tr('quickHistoryUnknown','Open a conversation before saving.');
                if(oldestLoadedElement){
                    const formattedOldest=formatUiDateTime(oldestLoadedTimestamp);
                    oldestLoadedElement.textContent=formattedOldest
                        ?tr('oldestLoadedValue','Oldest currently loaded in the open chat: '+formattedOldest,[formattedOldest])
                        :tr('oldestLoadedUnknown','Oldest loaded message could not be dated — check the chat manually before export.');
                    if(oldestLoadedTimestamp)oldestLoadedElement.dataset.timestamp=oldestLoadedTimestamp;
                    else oldestLoadedElement.removeAttribute('data-timestamp');
                }
                if(loadedCountElement)loadedCountElement.textContent=tr(
                    loadedMessageCount===1?'loadedCountValueOne':'loadedCountValue',
                    `Loaded in Telegram now: ${loadedMessageCount} ${loadedMessageCount===1?'message':'messages'}. Local Archive may load more during export; large histories are safer one chat at a time and can be stopped with a partial save.`,
                    [String(loadedMessageCount)]
                );
                renderCompatibilityDiagnostic();
            }
            function refreshLoadedHistoryFacts(){
                invalidatePrivatePreflight();
                activeInfo=getActiveChatInfo();
                currentName=activeInfo&&activeInfo.name?activeInfo.name:tr('unknownChat','No chat detected');
                if(currentNameElement)currentNameElement.textContent=currentName;
                oldestLoadedTimestamp=getOldestLoadedTimestamp();
                loadedMessageCount=getMessageElements().length;
                renderLoadedHistoryFacts();
            }
            renderLoadedHistoryFacts();
            const search=root.querySelector('#tgx-chat-search');
            if(search){search.placeholder=tr('searchChats','Search chats');search.setAttribute('aria-label',tr('searchChats','Search chats'));}
            const inputDefaults={
                '#tgx-html':preferences.formatHtml,'#tgx-json':preferences.formatJson,'#tgx-photos':preferences.exportPhotos,'#tgx-videos':preferences.exportVideos,
                '#tgx-voice':preferences.exportVoice,'#tgx-stickers':preferences.exportStickers,'#tgx-files':preferences.exportFiles
            };
            for(const [selector,value] of Object.entries(inputDefaults)){
                const input=root.querySelector(selector);
                if(input)input.checked=Boolean(value);
            }
            const sizeDefaults={'#tgx-photo-size':preferences.maxPhotoSizeMb,'#tgx-video-size':preferences.maxVideoSizeMb,'#tgx-file-size':preferences.maxFileSizeMb};
            for(const [selector,value] of Object.entries(sizeDefaults)){
                const input=root.querySelector(selector);
                if(input)input.value=String(value);
            }
            document.body.appendChild(host);
            state.dialog=host;
            state.dialogRoot=root;
            state.previousFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;
            state.lastOutcome=null;

            const q=selector=>root.querySelector(selector);
            const customize=q('#tgx-customize');
            const customizeToggle=q('#tgx-customize-toggle');
            const customizeHint=q('#tgx-customize-hint');
            const quickContent=q('#tgx-quick-content');
            const quickMedia=q('#tgx-quick-media');
            const quickProtection=q('#tgx-quick-protection');
            const quickRecheck=q('#tgx-quick-recheck');
            const formatManualBatchLabel=count=>{
                const numeric=Math.max(0,Number(count)||0);
                return numeric===1
                    ?tr('manualBatchOne','1 ZIP')
                    :tr('manualBatchMany',`${numeric} ZIPs`,[String(numeric)]);
            };
            const progressCopy=q('#tgx-progress-text');
            if(progressCopy&&!q('#tgx-progress-simple')){
                const simpleStatus=document.createElement('small');
                simpleStatus.className='tgx-progress-simple';
                simpleStatus.id='tgx-progress-simple';
                progressCopy.after(simpleStatus);
            }
            const resultAesGuide=q('#tgx-result-aes-guide');
            if(resultAesGuide&&!q('#tgx-result-aes-guide-action')){
                const action=document.createElement('button');
                action.type='button';
                action.className='tgx-button tgx-button--step tgx-result-aes-guide-action';
                action.id='tgx-result-aes-guide-action';
                action.textContent=tr('resultAesGuideOpenButton','How to open this ZIP');
                const steps=resultAesGuide.querySelector('ol');
                if(steps)resultAesGuide.insertBefore(action,steps);
            }
            const formError=q('#tgx-form-error');
            const setFormError=message=>{if(formError)formError.textContent=message||'';};
            const chatTypePanel=q('#tgx-chat-type-panel');
            const chatListPanel=q('#tgx-chat-list-panel');
            const chatListDiv=q('#tgx-chat-list');
            const categorySelect=q('#tgx-chat-type');
            const searchInput=q('#tgx-chat-search');
            const selectAll=q('#tgx-select-all');
            const selectedCount=q('#tgx-selected-count');
            const batchPlanner=q('#tgx-batch-planner');
            const batchTitle=q('#tgx-batch-title');
            const batchDetail=q('#tgx-batch-detail');
            const batchProgress=q('#tgx-batch-progress');
            const batchHandoff=q('#tgx-batch-handoff');
            const batchPrevious=q('#tgx-batch-previous');
            const batchNext=q('#tgx-batch-next');
            const batchNextChat=q('#tgx-batch-next-chat');
            const batchChatProgress=q('#tgx-batch-chat-progress');
            const batchChatProgressRows=q('#tgx-batch-chat-progress-rows');
            const batchRunAll=q('#tgx-batch-run-all');
            const batchManifest=q('#tgx-batch-manifest-rows');
            const manualWizard=q('#tgx-manual-wizard');
            const manualWizardMeta=q('#tgx-manual-wizard-meta');
            const manualWizardOpen=q('#tgx-manual-wizard-open');
            const manualWizardNext=q('#tgx-manual-wizard-next');
            const manualWizardAction=q('#tgx-manual-wizard-action');
            const encryptToggle=q('#tgx-encrypt');
            const protectionAesButton=q('#tgx-protection-aes');
            const protectionNoneButton=q('#tgx-protection-none');
            const protectionPrimerAction=q('#tgx-protection-primer-action');
            const missingSummaryAction=q('#tgx-missing-summary');
            const beginnerGuide=q('#tgx-beginner-guide');
            const beginnerGuideAction=q('#tgx-beginner-guide-action');
            const beginnerGuideProtected=q('#tgx-beginner-guide-protected');
            const beginnerGuideProtectedTag=q('[data-i18n="beginnerGuideActionProtectedTag"]');
            const beginnerGuideBody=q('#tgx-beginner-guide-body');
            const beginnerGuideBoundary=q('.tgx-beginner-guide-boundary');
            const beginnerSetup=q('#tgx-beginner-setup');
            const beginnerSetupChange=q('#tgx-beginner-setup-change');
            const beginnerSetupScope=q('#tgx-beginner-setup-scope');
            const beginnerSetupFormat=q('#tgx-beginner-setup-format');
            const beginnerSetupMedia=q('#tgx-beginner-setup-media');
            const beginnerSetupProtection=q('#tgx-beginner-setup-protection');
            const capabilityLimits=q('#tgx-capability-limits');
            const scopeHandoffNote=q('#tgx-scope-handoff-note');
            const scopeEffort=q('#tgx-scope-effort');
            const commitSummary=q('#tgx-commit-summary');
            const preflightStripTab=q('#tgx-preflight-strip-tab');
            const preflightStripProtection=q('#tgx-preflight-strip-protection');
            const resultAesGuideAction=q('#tgx-result-aes-guide-action');
            const passwordPanel=q('#tgx-password-panel');
            const passwordInput=q('#tgx-password');
            const passwordConfirm=q('#tgx-password-confirm');
            const coveragePanel=q('#tgx-coverage-preflight');
            const coverageRows=q('#tgx-coverage-preflight-rows');
            const coverageNote=q('#tgx-coverage-preflight-note');
            const coverageTargetInput=q('#tgx-coverage-target');
            const coverageTargetReadable=q('#tgx-coverage-target-readable');
            const coverageSettings=q('#tgx-coverage-settings');
            const exportBoundary=q('#tgx-export-boundary');
            const boundaryCompact=q('#tgx-boundary-compact');
            const collapsedSample=q('#tgx-collapsed-sample');
            const historyReady=q('#tgx-history-ready');
            const historyReadyText=q('#tgx-history-ready-text');
            const historyBadge=q('#tgx-history-badge');
            const historyError=q('#tgx-history-error');
            const scaleGuidance=q('#tgx-scale-guidance');
            const moreMedia=q('#tgx-more-media');
            const moreMediaStatus=q('#tgx-more-media-status');
            const footer=q('#tgx-footer');
            const footerScope=q('#tgx-footer-scope');
            const footerPreflight=q('#tgx-footer-preflight');
            const unencryptedConfirm=q('#tgx-unencrypted-confirm');
            const preExportTitle=q('#tgx-preexport-title');
            const showDownload=q('#tgx-show-download');
            const showDownloadStatus=q('#tgx-show-download-status');
            const verifyDownload=q('#tgx-verify-download');
            const verifyFile=q('#tgx-verify-file');
            const verifyPanel=q('#tgx-verify-panel');
            const verifyFilename=q('#tgx-verify-filename');
            const verifyPassword=q('#tgx-verify-password');
            const verifyNow=q('#tgx-verify-now');
            const verifyStatus=q('#tgx-verify-status');
            const aesAppRecommendation=q('#tgx-aes-app-recommendation');
            const aes7ZipLinks=Array.from(root.querySelectorAll('#tgx-aes-7zip,#tgx-preparation-7zip'));
            const workloadCompact=q('#tgx-workload-compact');
            const workloadAdvice=q('#tgx-workload-advice');
            const workloadEstimate=q('#tgx-workload-estimate');
            const workloadEstimateText=q('#tgx-workload-estimate-text');
            const runBoundary=q('#tgx-run-boundary');
            const privatePreflight=q('#tgx-private-preflight');
            const privatePreflightMark=q('#tgx-private-preflight-mark');
            const privatePreflightText=q('#tgx-private-preflight-text');
            const privatePreflightButton=q('#tgx-run-private-preflight');
            const liveSmoke=q('#tgx-live-smoke');
            const liveSmokeMark=q('#tgx-live-smoke-mark');
            const liveSmokeText=q('#tgx-live-smoke-text');
            const liveSmokeButton=q('#tgx-run-live-smoke');
            const preparationToggle=q('#tgx-preparation-toggle');
            const preparationList=q('#tgx-preparation-list');
            const preparationNextText=q('#tgx-preparation-next-text');
            const preparationProtection=q('#tgx-preparation-protection');
            const preparationPlainOpen=q('#tgx-preparation-plain-open');
            const preparationBoundaryDetails=q('.tgx-boundary-details');
            const preparationPlain=q('.tgx-preparation-plain');
            const backdrop=q('[data-tgx-dismiss]');
            const modal=q('.tgx-modal');
            const historyCoach=q('#tgx-history-coach');
            const loadHistoryButton=q('#tgx-load-history');
            const historyReturnButton=q('#tgx-history-return');
            const openAesGuideButton=q('#tgx-open-aes-guide');
            const presetButtons=Array.from(root.querySelectorAll('[data-tgx-preset]'));
            const historyCheckLabel=historyReady?.closest('.tgx-history-check');
            if(preparationBoundaryDetails&&preparationPlain&&historyCheckLabel){
                preparationBoundaryDetails.insertBefore(historyCheckLabel,preparationPlain);
                if(historyError)preparationBoundaryDetails.insertBefore(historyError,preparationPlain);
            }
            let fullChatList=state.fullChatList;
            let chatsPromise=null;
            let selectableChats=[];
            let batchPlanKey='';
            let activeBatchIndex=0;
            const completedBatchIndexes=new Set();
            let resumedBatchPlan=false;
            let unencryptedConfirmed=true;
            let historyMode=false;
            let selectedVerificationFile=null;
            let privatePreflightRevision=0;
            let privatePreflightRunning=false;
            let liveSmokeRevision=0;
            let liveSmokeRunning=false;
            let manualWizardChecked=false;

            const setExportActionLabel=(kind='protected')=>{
                const action=q('#tgx-export');
                if(!action)return;
                const label=action.querySelector('span:first-child');
                const gated=!historyReady?.checked&&!state.isExporting&&state.lastOutcome!=='complete';
                const key=gated?'quickUnavailableAction':kind==='unencrypted'?'quickSaveAction':'quickSaveProtectedAction';
                const fallback=gated
                    ?'Open a readable conversation first'
                    :kind==='unencrypted'
                        ?'Save conversation'
                        :'Save with password';
                const text=tr(key,fallback);
                if(label)label.textContent=text;
                else action.textContent=text;
                action.disabled=state.isExporting||gated;
                action.dataset.reviewGated=String(gated);
                action.setAttribute('aria-label',text);
                action.title=text;
            };
            const refreshExportActionLabel=()=>setExportActionLabel(encryptToggle?.checked===false?'unencrypted':'protected');

            function syncFooterPreflight(){
                if(!footerPreflight)return;
                const mode=q('input[name="tgx-chats"]:checked')?.value||'current';
                const level=workloadEstimate?.dataset.level||'light';
                const stateName=privatePreflight?.dataset.state||'idle';
                const relevant=mode!=='current'||level!=='light'||stateName==='passed'||stateName==='working'||stateName==='error';
                footerPreflight.hidden=!relevant;
                if(!relevant){footerPreflight.textContent='';return;}
                footerPreflight.textContent=stateName==='passed'
                    ?tr('preflightFooterPassed',`Nearby-history sample passed · ${privatePreflight?.dataset.messageCount||0} messages · no file saved`,[privatePreflight?.dataset.messageCount||'0'])
                    :stateName==='working'
                        ?tr('preflightFooterWorking','Checking nearby history…')
                        :stateName==='error'
                            ?tr('preflightFooterFailed','Nearby-history sample needs attention')
                            :tr('preflightFooterRecommended','Nearby-history sample recommended before this run');
            }

            function syncCollapsedSample(mode=getCheckedMode()){
                if(!collapsedSample)return;
                const level=workloadEstimate?.dataset.level||'light';
                const shouldShow=mode!=='current'||level!=='light';
                collapsedSample.hidden=!shouldShow;
                collapsedSample.disabled=state.isExporting||privatePreflightRunning||liveSmokeRunning;
                collapsedSample.textContent=privatePreflight?.dataset.state==='passed'
                    ?tr('preparationCompactSamplePassed',`Sample passed: ${privatePreflight.dataset.messageCount||0} messages`,[privatePreflight.dataset.messageCount||'0'])
                    :tr('collapsedSampleAction','Run optional ZIP sample');
                collapsedSample.setAttribute('aria-label',collapsedSample.textContent);
            }

            function getCheckedMode(){return q('input[name="tgx-chats"]:checked')?.value||'current';}

            function updateCoverageTargetReadable(){
                if(!coverageTargetReadable)return;
                const target=normalizeCoverageTargetDate(coverageTargetInput?.value);
                const formatted=target?formatUiCalendarDate(target):'';
                coverageTargetReadable.hidden=!formatted;
                coverageTargetReadable.textContent=formatted
                    ?tr('coverageTargetSelected',`Selected date: ${formatted}`,[formatted])
                    :tr('coverageTargetEmpty','No date target selected');
            }

            function setLiveSmoke(stateName,text){
                if(liveSmoke)liveSmoke.dataset.state=stateName;
                if(liveSmokeMark)liveSmokeMark.textContent=stateName==='passed'?'✓':stateName==='error'?'!':stateName==='working'?'…':'•';
                if(liveSmokeText)liveSmokeText.textContent=text;
                if(liveSmokeButton){
                    liveSmokeButton.disabled=stateName==='working'||state.isExporting;
                    liveSmokeButton.textContent=stateName==='idle'||stateName==='working'
                        ?tr('liveSmokeAction','Test one message')
                        :tr('liveSmokeAgain','Run one-message check');
                }
            }

            function resetLiveSmoke(){
                liveSmokeRevision++;
                if(liveSmokeRunning)return;
                if(liveSmoke){
                    liveSmoke.removeAttribute('data-message-id');
                    liveSmoke.removeAttribute('data-message-count');
                    liveSmoke.removeAttribute('data-entry-count');
                    liveSmoke.removeAttribute('data-size');
                    liveSmoke.removeAttribute('data-encrypted');
                }
                setLiveSmoke('idle',tr('liveSmokeIdle','User-driven: read one real message in this Telegram tab, build and reopen a local ZIP, and save nothing.'));
            }

            function renderManualWizard(mode,plan=getBatchPlan(mode)){
                const visible=mode!=='current'&&plan.chats.length>0;
                if(!manualWizard)return plan;
                manualWizard.hidden=!visible;
                if(!visible)return plan;
                const firstName=String(plan.chats[0]?.name||tr('manualWizardOpenFallback','the first selected chat'));
                const verifiedChats=Object.values(state.completedBatchStats||{}).reduce((sum,stat)=>sum+Math.max(0,Number(stat?.chatsIncluded)||0),0);
                if(manualWizardMeta)manualWizardMeta.textContent=tr('manualWizardMeta',`Chat ${plan.start+1} of ${plan.totalChats} · ${verifiedChats} included · one ZIP per batch`,[String(plan.start+1),String(plan.totalChats),String(verifiedChats)]);
                if(manualWizardOpen)manualWizardOpen.textContent=tr('manualWizardOpen',`Local Archive opens “${firstName}” in Telegram`,[firstName]);
                const inspection=inspectRenderedMessageCompatibility();
                const exported=Boolean(state.lastExportStats);
                const acknowledged=Boolean(historyReady?.checked);
                const currentStep=exported?4:acknowledged?3:manualWizardChecked?2:1;
                manualWizard.dataset.currentStep=String(currentStep);
                manualWizard.querySelectorAll('[data-wizard-step]').forEach(step=>{
                    const index=Number(step.dataset.wizardStep||0);
                    step.dataset.state=index<currentStep?'complete':index===currentStep?'current':'pending';
                });
                if(manualWizardNext)manualWizardNext.textContent=currentStep===1
                    ?tr('manualWizardNext',`Next: Local Archive opens “${firstName}” and checks it`,[firstName])
                    :currentStep===2
                        ?tr('manualWizardNextSave','Next: confirm the checklist, then save this ZIP')
                        :currentStep===3
                            ?tr('manualWizardNextVerify','Next: verify this ZIP before switching to another chat')
                            :tr('manualWizardNextVerify','Next: verify this ZIP before switching to another chat');
                if(manualWizardAction){
                    manualWizardAction.disabled=state.isExporting;
                    manualWizardAction.textContent=currentStep===1
                        ?tr('manualWizardActionCheck','Continue automatic chat check')
                        :currentStep===2||currentStep===3
                            ?tr('manualWizardActionReview','Review and save ZIP')
                            :tr('manualWizardActionVerify','Verify downloaded ZIP');
                }
                return plan;
            }

            function setPrivatePreflight(stateName,text){
                if(privatePreflight)privatePreflight.dataset.state=stateName;
                if(privatePreflightMark)privatePreflightMark.textContent=stateName==='passed'?'✓':stateName==='error'?'!':stateName==='working'?'…':'•';
                if(privatePreflightText)privatePreflightText.textContent=text;
                if(privatePreflightButton){
                    privatePreflightButton.disabled=stateName==='working'||state.isExporting;
                    privatePreflightButton.textContent=stateName==='idle'||stateName==='working'
                        ?tr('privatePreflightAction','Run optional ZIP sample')
                        :tr('privatePreflightAgain','Run again');
                }
                syncCollapsedSample();
                syncFooterPreflight();
            }

            function resetPrivatePreflight(){
                privatePreflightRevision++;
                resetLiveSmoke();
                manualWizardChecked=false;
                if(privatePreflightRunning)return;
                if(privatePreflight){
                    privatePreflight.removeAttribute('data-message-ids');
                    privatePreflight.removeAttribute('data-message-count');
                    privatePreflight.removeAttribute('data-directions');
                    privatePreflight.removeAttribute('data-position-restored');
                    privatePreflight.removeAttribute('data-scroll-start');
                    privatePreflight.removeAttribute('data-scroll-final');
                    privatePreflight.removeAttribute('data-entry-count');
                    privatePreflight.removeAttribute('data-size');
                    privatePreflight.removeAttribute('data-encrypted');
                }
                setPrivatePreflight('idle',tr('privatePreflightIdle','Optional: briefly check the current and nearby history, package up to 10 real messages, reopen the ZIP locally, and return to your position. No file is saved and nothing is uploaded.'));
            }

            invalidatePrivatePreflight=resetPrivatePreflight;
            resetPrivatePreflight();

            function setPreparationDetails(open){
                const expanded=Boolean(open);
                if(preparationToggle)preparationToggle.setAttribute('aria-expanded',String(expanded));
                if(preparationList)preparationList.hidden=!expanded;
            }

            function focusAesGuide(guide){
                const summary=guide?.querySelector('summary');
                if(!summary)return;
                summary.setAttribute('tabindex','0');
                guide.setAttribute('tabindex','-1');
                const focusTarget=()=>{
                    if(!guide.isConnected||!summary.isConnected)return;
                    try{summary.focus({preventScroll:true});}catch{summary.focus();}
                    if(root.activeElement!==summary){
                        try{guide.focus({preventScroll:true});}catch{guide.focus();}
                    }
                };
                guide.open=true;
                focusTarget();
                if(typeof requestAnimationFrame==='function')requestAnimationFrame(focusTarget);
                setTimeout(focusTarget,50);
                setTimeout(focusTarget,150);
            }

            openPreparationDetails=()=>setPreparationDetails(true);
            workloadAdvice?.addEventListener('click',event=>{
                const target=event.target instanceof Element?event.target.closest('[data-tgx-run-sample]'):null;
                if(!target||state.isExporting)return;
                openPreparationDetails();
                privatePreflightButton?.click();
            });
            collapsedSample?.addEventListener('click',event=>{
                event.preventDefault();
                event.stopPropagation();
                if(state.isExporting||privatePreflightRunning||liveSmokeRunning)return;
                openPreparationDetails();
                privatePreflightButton?.click();
            });
            setPreparationDetails(!inspectRenderedMessageCompatibility().ok);

            function resetUnencryptedConfirmation(){
                unencryptedConfirmed=Boolean(encryptToggle?.checked===false);
                if(unencryptedConfirm)unencryptedConfirm.hidden=true;
                if(footer)footer.removeAttribute('data-confirming-unencrypted');
            }

            if(coverageTargetInput)coverageTargetInput.max=calendarDateFromTimestamp(new Date());
            updateCoverageTargetReadable();
            const mobileBoundaryQuery=typeof window.matchMedia==='function'?window.matchMedia('(max-width: 560px)'):null;
            const syncBoundaryDisclosure=()=>{
                const mode=q('input[name="tgx-chats"]:checked')?.value||'current';
                const level=workloadEstimate?.dataset.level||'light';
                const keepRecommendationVisible=mode!=='current'||level!=='light';
                if(exportBoundary&&(historyReady?.checked||mobileBoundaryQuery?.matches)&&!keepRecommendationVisible)exportBoundary.open=false;
            };
            syncBoundaryDisclosure();
            if(mobileBoundaryQuery?.addEventListener)mobileBoundaryQuery.addEventListener('change',syncBoundaryDisclosure);
            else if(mobileBoundaryQuery?.addListener)mobileBoundaryQuery.addListener(syncBoundaryDisclosure);
            state.dialogCleanup=()=>{
                if(mobileBoundaryQuery?.removeEventListener)mobileBoundaryQuery.removeEventListener('change',syncBoundaryDisclosure);
                else if(mobileBoundaryQuery?.removeListener)mobileBoundaryQuery.removeListener(syncBoundaryDisclosure);
            };

            const platformText=`${navigator.userAgentData?.platform||navigator.platform||''} ${navigator.userAgent||''}`.toLocaleLowerCase();
            let preparationAppRecommendation='';
            if(aesAppRecommendation){
                if(platformText.includes('win')){
                    aesAppRecommendation.textContent=tr('aesAppWindows','Recommended on Windows: 7-Zip or PeaZip. Use one of the official links below.');
                    preparationAppRecommendation=tr('preparationAppWindows',"On Windows, use 7-Zip or PeaZip from the publisher's official site.");
                }else if(platformText.includes('mac')){
                    aesAppRecommendation.textContent=tr('aesAppMac','Recommended on macOS: PeaZip. Use the official link below.');
                    preparationAppRecommendation=tr('preparationAppMac',"On macOS, use PeaZip from the publisher's official site.");
                    aes7ZipLinks.forEach(link=>{link.hidden=true;});
                }else if(platformText.includes('linux')){
                    aesAppRecommendation.textContent=tr('aesAppLinux','Recommended on Linux: PeaZip or 7-Zip. Use an official link below or your package manager.');
                    preparationAppRecommendation=tr('preparationAppLinux','On Linux, use PeaZip or 7-Zip from the official site or package manager.');
                }else{
                    aesAppRecommendation.textContent=tr('aesAppOther','Recommended: PeaZip. Use the official link below.');
                    preparationAppRecommendation=tr('preparationAppOther','Use PeaZip from its official site.');
                    aes7ZipLinks.forEach(link=>{link.hidden=true;});
                }
            }

            function syncHistoryGate(invalid=false){
                const ready=Boolean(historyReady?.checked);
                if(exportBoundary){
                    exportBoundary.dataset.ready=String(ready);
                    if(!ready&&state.lastOutcome!=='complete')exportBoundary.open=true;
                    if(invalid&&!ready)exportBoundary.dataset.invalid='true';
                    else exportBoundary.removeAttribute('data-invalid');
                }
                if(historyBadge)historyBadge.textContent=ready
                    ?tr('historyReadyBadgeDone','Ready')
                    :tr('historyReadyBadgeRequired','Review required');
                if(historyError)historyError.hidden=ready||!invalid;
                if(state.lastOutcome!=='complete')refreshExportActionLabel();
            }

            function resetHistoryGate(){
                if(historyReady)historyReady.checked=inspectRenderedMessageCompatibility().ok;
                syncHistoryGate(false);
                syncBoundaryDisclosure();
            }

            function enterHistoryMode(){
                if(state.isExporting||!backdrop||!modal||!historyCoach)return;
                historyMode=true;
                backdrop.dataset.historyMode='true';
                modal.hidden=true;
                historyCoach.hidden=false;
                setFormError('');
            }

            function returnFromHistoryMode(){
                if(!historyMode)return;
                historyMode=false;
                if(historyCoach)historyCoach.hidden=true;
                if(modal)modal.hidden=false;
                if(backdrop)backdrop.removeAttribute('data-history-mode');
                refreshLoadedHistoryFacts();
                resetHistoryGate();
                updateSummary();
                if(exportBoundary)exportBoundary.open=true;
                loadHistoryButton?.focus();
            }

            compatibilityRefreshButton?.addEventListener('click',()=>{
                if(state.isExporting)return;
                setFormError('');
                refreshLoadedHistoryFacts();
                resetHistoryGate();
                updateSummary();
                if(inspectRenderedMessageCompatibility().ok)setPreparationDetails(false);
                if(exportBoundary)exportBoundary.open=true;
                if(!inspectRenderedMessageCompatibility().ok)compatibilityRefreshButton.focus();
            });
            manualWizardAction?.addEventListener('click',()=>{
                if(state.isExporting)return;
                const mode=q('input[name="tgx-chats"]:checked')?.value||'current';
                if(mode==='current')return;
                const plan=getBatchPlan(mode);
                const inspection=inspectRenderedMessageCompatibility();
                if(!inspection.ok){
                    exportBoundary?.setAttribute('data-compatibility','error');
                    exportBoundary?.setAttribute('open','');
                    compatibilityRefreshButton?.click();
                    return;
                }
                if(!manualWizardChecked){
                    manualWizardChecked=true;
                    updateSummary();
                    return;
                }
                if(!historyReady?.checked){
                    if(exportBoundary)exportBoundary.open=true;
                    historyReady?.focus();
                    return;
                }
                if(!state.lastExportStats){
                    exportBoundary?.setAttribute('open','');
                    historyReady?.focus();
                    return;
                }
                verifyDownload?.focus();
                renderManualWizard(mode,plan);
            });
            batchNextChat?.addEventListener('click',()=>manualWizardAction?.click());

            function showChatListMessage(message){
                if(!chatListDiv)return;
                const empty=document.createElement('div');
                empty.className='tgx-chat-empty';
                empty.textContent=message;
                chatListDiv.replaceChildren(empty);
            }

            const categoryLabels={
                'Personal Chats':tr('categoryPersonal','Personal chats'),
                'Bot Chats':tr('categoryBots','Bots'),
                'Groups':tr('categoryGroups','Groups'),
                'Channels':tr('categoryChannels','Channels')
            };
            function allPlannedChats(mode){
                if(mode==='selectable'){
                    return Array.from(root.querySelectorAll('.tgx-chat-check'))
                        .filter(input=>input.checked)
                        .map(input=>selectableChats[Number(input.dataset.idx)])
                        .filter(Boolean);
                }
                if(mode==='all'){
                    const groups=getChatGroups(fullChatList&&fullChatList.length>0?fullChatList:undefined);
                    return groups[categorySelect?.value]||[];
                }
                return [];
            }
            function batchIdentity(chat,index){
                return String(chat?.peerId||chat?.element?.getAttribute?.('data-peer-id')||chat?.href||chat?.name||index);
            }
            function persistBatchResume(mode,plan){
                if(mode==='current'||!plan||plan.totalChats<=0)return;
                const completedIndexes=[...completedBatchIndexes].filter(index=>index>=0&&index<plan.totalBatches).sort((a,b)=>a-b);
                if(completedIndexes.length>=plan.totalBatches){
                    state.batchResume=null;
                    clearBatchResumeSession();
                    return;
                }
                state.batchResume={
                    key:plan.key,
                    mode,
                    totalChats:plan.totalChats,
                    activeIndex:plan.activeIndex,
                    completedIndexes,
                    batchRunAll:Boolean(state.batchRunAll),
                    completedBatchStats:JSON.parse(JSON.stringify(state.completedBatchStats||{}))
                };
                persistBatchResumeSession(state.batchResume);
            }
            function getBatchPlan(mode){
                const all=allPlannedChats(mode);
                const key=mode+':'+all.map(batchIdentity).join('|');
                if(key!==batchPlanKey){
                    const resume=state.batchResume?.key===key?state.batchResume:null;
                    batchPlanKey=key;
                    resumedBatchPlan=Boolean(resume);
                    activeBatchIndex=resume?Number(resume.activeIndex)||0:0;
                    completedBatchIndexes.clear();
                    for(const index of resume?.completedIndexes||[])completedBatchIndexes.add(Number(index));
                    state.batchCompletedCount=completedBatchIndexes.size;
                    state.batchRunAll=Boolean(resume?.batchRunAll);
                    state.batchContext=null;
                    state.completedBatchStats=resume?.completedBatchStats&&typeof resume.completedBatchStats==='object'
                        ?JSON.parse(JSON.stringify(resume.completedBatchStats))
                        :{};
                    if(!resume&&mode!=='current'){
                        state.batchResume=null;
                        clearBatchResumeSession();
                    }
                }
                const totalBatches=Math.max(1,Math.ceil(all.length/CONFIG.maxChats));
                activeBatchIndex=Math.max(0,Math.min(activeBatchIndex,totalBatches-1));
                const start=activeBatchIndex*CONFIG.maxChats;
                const chats=all.slice(start,start+CONFIG.maxChats);
                return {
                    key,mode,all,chats,
                    totalChats:all.length,
                    totalBatches,
                    activeIndex:activeBatchIndex,
                    start,
                    end:start+chats.length
                };
            }
            function plannedChatsForCoverage(mode){
                return getBatchPlan(mode).chats;
            }
            function renderBatchChatProgress(mode,plan=getBatchPlan(mode)){
                const visible=mode!=='current'&&plan.totalBatches>1;
                if(batchChatProgress)batchChatProgress.hidden=!visible;
                if(batchNextChat){
                    batchNextChat.hidden=!visible;
                    batchNextChat.disabled=state.isExporting||!visible;
                }
                if(!visible||!batchChatProgressRows)return plan;
                const stat=state.completedBatchStats[String(plan.activeIndex)];
                const coverage=Array.isArray(stat?.chatCoverage)?stat.chatCoverage:[];
                const isVerified=(chat)=>Boolean(stat)||coverage.some(item=>{
                    const chatName=String(chat?.name||'');
                    const chatPeer=String(chat?.peerId||'');
                    return (chatName&&String(item?.name||'')===chatName)||(chatPeer&&String(item?.peerId||'')===chatPeer);
                });
                const pending=plan.chats.filter(chat=>!isVerified(chat));
                const nextChat=pending[0]||plan.chats[0];
                const nextName=String(nextChat?.name||tr('manualNextChatFallback','the next chat'));
                if(batchNextChat){
                    batchNextChat.textContent=tr('batchChatAction','Continue automatic chat check');
                    batchNextChat.setAttribute('aria-label',tr('batchChatNext',`Next chat: ${nextName}`,[nextName]));
                    batchNextChat.title=tr('batchChatNext',`Next chat: ${nextName}`,[nextName]);
                }
                batchChatProgressRows.replaceChildren();
                const visibleChats=plan.chats.slice(0,8);
                for(const chat of visibleChats){
                    const name=String(chat?.name||tr('unknownChat','Unknown chat'));
                    const verified=isVerified(chat);
                    const row=document.createElement('div');
                    row.className='tgx-batch-chat-row';
                    row.setAttribute('role','listitem');
                    row.dataset.state=verified?'verified':chat===nextChat?'next':'queued';
                    row.textContent=verified
                        ?tr('batchChatVerified',`${name} · verified`,[name])
                        :chat===nextChat
                            ?tr('batchChatCurrent',`${name} · checked next`,[name])
                            :tr('batchChatQueued',`${name} · queued`,[name]);
                    batchChatProgressRows.appendChild(row);
                }
                if(plan.chats.length>visibleChats.length){
                    const more=document.createElement('small');
                    more.className='tgx-batch-chat-more';
                    more.textContent=tr('batchChatMore',`+${plan.chats.length-visibleChats.length} more chats in this batch`,[String(plan.chats.length-visibleChats.length)]);
                    batchChatProgressRows.appendChild(more);
                }
                return plan;
            }
            function renderBatchPlanner(mode,plan=getBatchPlan(mode)){
                if(!batchPlanner)return plan;
                const visible=mode!=='current'&&plan.totalBatches>1;
                batchPlanner.hidden=!visible;
                if(!visible){
                    state.batchCompletedCount=completedBatchIndexes.size;
                    if(batchProgress)batchProgress.textContent='';
                    batchPlanner.removeAttribute('data-active-batch');
                    batchPlanner.removeAttribute('data-total-batches');
                    batchPlanner.removeAttribute('data-total-chats');
                    batchPlanner.removeAttribute('data-batch-size');
                    batchPlanner.removeAttribute('data-batch-start');
                    batchPlanner.removeAttribute('data-batch-end');
                    batchPlanner.removeAttribute('data-completed-batches');
                    batchPlanner.removeAttribute('data-resumed');
                    batchManifest?.replaceChildren();
                    if(batchRunAll){batchRunAll.hidden=true;batchRunAll.disabled=true;}
                    renderBatchChatProgress(mode,plan);
                    persistBatchResume(mode,plan);
                    return plan;
                }
                const active=plan.activeIndex+1;
                batchPlanner.dataset.activeBatch=String(active);
                batchPlanner.dataset.totalBatches=String(plan.totalBatches);
                batchPlanner.dataset.totalChats=String(plan.totalChats);
                batchPlanner.dataset.batchSize=String(plan.chats.length);
                batchPlanner.dataset.batchStart=String(plan.start+1);
                batchPlanner.dataset.batchEnd=String(plan.end);
                batchPlanner.dataset.completedBatches=[...completedBatchIndexes].sort((a,b)=>a-b).map(index=>index+1).join(',');
                batchPlanner.dataset.batchRunAll=String(state.batchRunAll);
                const completed=Math.min(plan.totalBatches,completedBatchIndexes.size);
                batchPlanner.dataset.resumed=String(resumedBatchPlan&&completed>0);
                if(batchTitle)batchTitle.textContent=tr('batchTitle',`Multi-chat mode · ${plan.totalChats} chats · ${plan.totalBatches} ZIP batches`,[String(plan.totalChats),String(plan.totalBatches)]);
                if(batchDetail)batchDetail.textContent=tr(
                    'batchDetail',
                    `Batch ${active} of ${plan.totalBatches} · chats ${plan.start+1}–${plan.end} · ${plan.chats.length} in this ZIP.`,
                    [String(active),String(plan.totalBatches),String(plan.start+1),String(plan.end),String(plan.chats.length)]
                );
                if(batchHandoff){
                    const firstChat=String(plan.chats[0]?.name||'the first chat in this batch');
                    batchHandoff.textContent=resumedBatchPlan&&completed>0
                        ?tr('batchResumeHandoff',`Resuming: ${completed} of ${plan.totalBatches} ZIPs verified. Continue with batch ${active}; open its chat, check, save, then verify.`,[String(completed),String(plan.totalBatches),String(active)])
                        :tr('batchHandoff',`Next: Local Archive opens “${firstChat}” in this tab, checks whether Telegram displays it in a readable format, and adds it to the current ZIP. Verify the ZIP after export.`,[firstChat]);
                }
                if(batchProgress){
                state.batchCompletedCount=completed;
                    const progressKey=completed===plan.totalBatches
                        ?'batchProgressComplete'
                        :state.batchRunAll?'batchProgressQueued':'batchProgress';
                    if(completed===plan.totalBatches){
                        batchProgress.textContent=tr(
                            progressKey,
                            `All ${plan.totalBatches} batches complete · ${plan.totalChats} chats archived.`,
                            [String(completed),String(plan.totalBatches),String(plan.totalChats)]
                        );
                    }else{
                        const nextBatch=active<plan.totalBatches?active+1:0;
                        batchProgress.textContent=nextBatch
                            ?tr('batchReadyStatus',`Batch ${active} is ready; start and verify it before Batch ${nextBatch}. ${completed} of ${plan.totalBatches} batches complete.`,[String(active),String(nextBatch),String(completed),String(plan.totalBatches)])
                            :tr('batchReadyStatusLast',`Batch ${active} is ready; start and verify it. ${completed} of ${plan.totalBatches} batches complete.`,[String(active),String(completed),String(plan.totalBatches)]);
                    }
                }
                renderBatchChatProgress(mode,plan);
                if(batchManifest){
                    batchManifest.replaceChildren();
                    for(let index=0;index<plan.totalBatches;index++){
                        const start=index*CONFIG.maxChats+1;
                        const end=Math.min(plan.totalChats,(index+1)*CONFIG.maxChats);
                        const stat=state.completedBatchStats[String(index)];
                        const row=document.createElement('div');
                        row.className='tgx-batch-manifest-row';
                        row.dataset.batch=String(index+1);
                        const filename=String(stat?.archiveFilename||'');
                        row.textContent=stat
                            ?tr('batchManifestVerified',`Batch ${index+1} · chats ${start}–${end} · verified ZIP: ${filename||'saved in Downloads'}`,[String(index+1),String(start),String(end),filename||tr('batchManifestDownloads','saved in Downloads')])
                            :index===plan.activeIndex
                                ?tr('batchManifestCurrent',`Batch ${index+1} · chats ${start}–${end} · current batch`,[String(index+1),String(start),String(end)])
                                :state.batchRunAll
                                    ?tr('batchManifestQueued',`Batch ${index+1} · chats ${start}–${end} · queued for a separate start and verification`,[String(index+1),String(start),String(end)])
                                    :tr('batchManifestPending',`Batch ${index+1} · chats ${start}–${end} · not started`,[String(index+1),String(start),String(end)]);
                        batchManifest.appendChild(row);
                    }
                }
                if(batchPrevious){
                    batchPrevious.hidden=plan.activeIndex===0;
                    batchPrevious.disabled=state.isExporting||plan.activeIndex===0;
                    batchPrevious.textContent=tr('batchPrevious','Previous batch');
                }
                if(batchNext){
                    const nextStart=plan.end+1;
                    const nextEnd=Math.min(plan.totalChats,plan.end+CONFIG.maxChats);
                    batchNext.hidden=plan.activeIndex>=plan.totalBatches-1;
                    batchNext.disabled=state.isExporting||plan.activeIndex>=plan.totalBatches-1;
                    batchNext.textContent=tr(
                        'batchNextRange',
                        `Next: batch ${active+1} (${nextStart}–${nextEnd})`,
                        [String(active+1),String(nextStart),String(nextEnd)]
                    );
                }
                if(batchRunAll){
                    const remaining=completed<plan.totalBatches;
                    batchRunAll.hidden=!remaining;
                    batchRunAll.disabled=state.isExporting||!remaining;
                    batchRunAll.textContent=tr(
                        completed>0?'batchRunRemaining':'batchRunAll',
                        completed>0?'Run remaining batches':'Queue all batches · verify each ZIP'
                    );
                }
                persistBatchResume(mode,plan);
                return plan;
            }
            function changeActiveBatch(delta){
                const mode=q('input[name="tgx-chats"]:checked')?.value||'current';
                const plan=getBatchPlan(mode);
                const next=Math.max(0,Math.min(plan.totalBatches-1,plan.activeIndex+delta));
                if(next===plan.activeIndex)return;
                activeBatchIndex=next;
                state.batchContext=null;
                resetPrivatePreflight();
                resetHistoryGate();
                updateSummary();
                batchPlanner?.scrollIntoView({block:'nearest'});
            }
            batchRunAll?.addEventListener('click',()=>{
                if(state.isExporting)return;
                const mode=q('input[name="tgx-chats"]:checked')?.value||'current';
                const plan=getBatchPlan(mode);
                if(mode==='current'||plan.totalBatches<=1)return;
                state.batchRunAll=true;
                renderBatchPlanner(mode,plan);
                if(exportBoundary&&!historyReady?.checked)exportBoundary.open=true;
                q('#tgx-export')?.focus();
            });
            function updateCoveragePreflight(mode){
                if(!coveragePanel||!coverageRows)return;
                const chats=plannedChatsForCoverage(mode);
                coveragePanel.hidden=mode==='current'||chats.length===0;
                coverageRows.replaceChildren();
                if(coveragePanel.hidden)return;
                const openPeer=String(activeInfo?.peerId||'');
                const openDate=formatUiDateTime(oldestLoadedTimestamp);
                for(const chat of chats.slice(0,4)){
                    const row=document.createElement('div');
                    row.className='tgx-coverage-preflight-row';
                    const name=String(chat?.name||tr('unknownChat','Unknown chat'));
                    const peer=String(chat?.peerId||chat?.element?.getAttribute?.('data-peer-id')||'');
                    const isOpen=Boolean((openPeer&&peer===openPeer)||name===currentName);
                    if(isOpen&&openDate){
                        row.textContent=tr(
                            loadedMessageCount===1?'coveragePreflightOpenOne':'coveragePreflightOpen',
                            `${name} — ${loadedMessageCount} ${loadedMessageCount===1?'message':'messages'} loaded now · oldest ${openDate}`,
                            [name,String(loadedMessageCount),openDate]
                        );
                    }else if(isOpen){
                        row.textContent=tr('coveragePreflightOpenUnknown',`${name} — ${loadedMessageCount} loaded now; oldest date unavailable`,[name,String(loadedMessageCount)]);
                    }else{
                        row.textContent=tr('coveragePreflightPending',`${name} — exact range reported after export`,[name]);
                    }
                    coverageRows.appendChild(row);
                }
                const remaining=chats.length-coverageRows.childElementCount;
                if(remaining>0){
                    const more=document.createElement('div');
                    more.className='tgx-coverage-preflight-row';
                    more.textContent=tr('coveragePreflightMore',`+${remaining} more chats`,[String(remaining)]);
                    coverageRows.appendChild(more);
                }
                if(coverageNote){
                    const target=normalizeCoverageTargetDate(coverageTargetInput?.value);
                    const formattedTarget=formatUiCalendarDate(target);
                    coverageNote.textContent=target&&formattedTarget
                        ?tr('coveragePreflightTarget',`Goal: reach ${formattedTarget} in every chosen chat. The open chat is previewed now; every other range is checked during export.`,[formattedTarget])
                        :tr('coveragePreflightNote','Telegram exposes message history only for the open chat. Other chosen chats are checked during collection, and exact saved ranges appear in the receipt.');
                }
            }
            function updatePreExportBoundary(mode){
                const target=normalizeCoverageTargetDate(coverageTargetInput?.value);
                const formattedTarget=formatUiCalendarDate(target);
                const formattedOldest=formatUiDateTime(oldestLoadedTimestamp);
                const chats=plannedChatsForCoverage(mode);
                if(preExportTitle){
                    if(target&&formattedTarget&&mode==='current'){
                        preExportTitle.textContent=formattedOldest
                            ?tr('preExportTargetCurrent',`Required goal: save the open chat back to ${formattedTarget}. Its oldest currently visible date is ${formattedOldest}; Local Archive will scan older messages automatically and report whether the saved range reached the goal.`,[formattedTarget,formattedOldest])
                            :tr('preExportTargetCurrentUnknown',`Required goal: save the open chat back to ${formattedTarget}. Local Archive will scan automatically and report whether the exact saved range reached the goal.`,[formattedTarget]);
                    }else if(target&&formattedTarget){
                        preExportTitle.textContent=tr('preExportTargetMulti',`Required goal: save every chosen chat back to ${formattedTarget}. Local Archive scans each chat automatically and reports whether every exact saved range reached the goal.`,[formattedTarget]);
                    }else{
                        preExportTitle.textContent=mode==='current'
                            ?tr('preExportScopeWarning','Local Archive scans older and newer messages automatically. Preview only to check the date now; the receipt records the exact saved range.')
                            :tr('preExportMultiScopeWarning','Local Archive scans every chosen chat automatically and reports its exact saved range. Preview the open chat only to inspect the date before export.');
                    }
                }
                if(boundaryCompact){
                    const workloadLevel=workloadEstimate?.dataset.level||'light';
                    const plan=mode!=='current'?getBatchPlan(mode):null;
                    const batchLabel=plan?formatManualBatchLabel(plan.totalBatches):'';
                    const protectionText=checked('#tgx-encrypt')
                        ?tr('preparationCompactAes','AES-256 password-protected ZIP')
                        :tr('preparationCompactNone','Unencrypted ZIP');
                    const scopeText=mode==='current'
                        ?tr('preparationCompactCurrent',`1 chat · ${loadedMessageCount} messages currently visible`,[String(loadedMessageCount),formattedOldest||''])
                        :tr('preparationCompactMulti',`Multi-chat mode · ${plan?.totalChats||chats.length} chats · ${batchLabel}`,[String(plan?.totalChats||chats.length),batchLabel]);
                    const goalText=target&&formattedTarget
                        ?tr('preparationCompactGoal',`Oldest date needed: ${formattedTarget}`,[formattedTarget])
                        :'';
                    const liveHint=inspectRenderedMessageCompatibility().ok
                        ?tr('preparationCompactLive','Open chat readable')
                        :tr('preparationCompactNoMessages','Not ready · open a chat and check again');
                    const sampleHint=workloadLevel!=='light'||Boolean(normalizeCoverageTargetDate(coverageTargetInput?.value))
                        ?privatePreflight?.dataset.state==='passed'
                            ?tr('preparationCompactSamplePassed',`Optional ZIP sample passed: ${privatePreflight.dataset.messageCount||0} messages`,[privatePreflight.dataset.messageCount||'0'])
                            :tr('preparationCompactSampleRecommended','Optional ZIP sample not run')
                        :'';
                    const workloadText=workloadLevel==='heavy'?tr('preparationCompactLarge','Large export'):'';
                    const compactParts=[liveHint,scopeText,protectionText,goalText,workloadText,sampleHint].filter(Boolean);
                    const compactText=loadedMessageCount===0
                        ?tr('preparationCompactNoMessages','Not ready · open a chat and check again')
                        :compactParts.join(' · ');
                    boundaryCompact.replaceChildren();
                    if(loadedMessageCount===0){
                        boundaryCompact.textContent=compactText;
                    }else{
                        compactParts.forEach((part,index)=>{
                            const chip=document.createElement('span');
                            chip.className='tgx-compact-chip';
                            chip.textContent=part+(index<compactParts.length-1?' · ':'');
                            boundaryCompact.appendChild(chip);
                        });
                    }
                }
                if(historyReadyText)historyReadyText.textContent=mode==='current'
                    ?tr('historyReadyCurrent','Required current-tab check passed. I understand this ZIP includes only messages exposed in this tab; I reviewed workload and protection.')
                    :tr('historyReadyMulti','Required check passed for the open chat only; each selected chat is checked before it is added. I reviewed ranges, workload, and protection.');
            }
            function updatePreparationNext(mode){
                if(!preparationNextText)return;
                const inspection=inspectRenderedMessageCompatibility();
                if(!inspection.ok){
                    preparationNextText.textContent=tr('preparationNextCompatibility','Next: open a Telegram chat and use Check again before continuing.');
                    return;
                }
                const plan=getBatchPlan(mode);
                if(mode!=='current'&&plan.totalBatches>1&&!state.batchRunAll){
                    preparationNextText.textContent=tr('preparationNextBatch','Next: queue all batches, then start and verify each ZIP separately before moving to the next one.');
                    return;
                }
                if(mode!=='current'){
                    preparationNextText.textContent=tr('preparationNextMulti','Next: start the automatic chat check; Local Archive opens and checks each selected chat, builds this ZIP, then you verify it.');
                    return;
                }
                if(host.dataset.simpleMode==='true'&&!historyReady?.checked){
                    preparationNextText.textContent=tr('preparationNextSimple','Next: confirm this short review, then click Create archive. The simple ZIP opens in Firefox without an extra app.');
                    return;
                }
                preparationNextText.textContent=historyReady?.checked
                    ?tr('preparationNextReady','Next: click Create archive. The ZIP will be validated before Firefox downloads it.')
                    :tr('preparationNextCurrent','Next: check that you reviewed history, workload, and protection, then click Create archive.');
            }
            function checked(selector){return Boolean(q(selector)?.checked);}
            function setChecked(selector,value){const input=q(selector);if(input)input.checked=Boolean(value);}
            function refreshPresetState(){
                const allFormats=checked('#tgx-html')&&checked('#tgx-json');
                const readableFormat=checked('#tgx-html')&&!checked('#tgx-json');
                const photos=checked('#tgx-photos'),videos=checked('#tgx-videos'),voice=checked('#tgx-voice'),stickers=checked('#tgx-stickers'),files=checked('#tgx-files');
                let active='';
                if(readableFormat&&!photos&&!videos&&!voice&&!stickers&&!files)active='readable';
                else if(allFormats&&!photos&&!videos&&!voice&&!stickers&&!files)active='text';
                else if(allFormats&&photos&&!videos&&voice&&stickers&&!files)active='balanced';
                else if(allFormats&&photos&&videos&&voice&&stickers&&files)active='complete';
                presetButtons.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.tgxPreset===active)));
            }
            function applyPreset(name){
                resetPrivatePreflight();
                const readable=name==='readable';
                setChecked('#tgx-html',true);setChecked('#tgx-json',!readable);
                const text=name==='text'||readable;
                const complete=name==='complete';
                setChecked('#tgx-photos',!text);
                setChecked('#tgx-videos',complete);
                setChecked('#tgx-voice',!text);
                setChecked('#tgx-stickers',!text);
                setChecked('#tgx-files',complete);
                if(moreMedia)moreMedia.open=complete;
                updateSummary();
                refreshPresetState();
            }
            function selectedChatSummary(){
                const checks=Array.from(root.querySelectorAll('.tgx-chat-check')).filter(item=>item.checked);
                const names=checks.map(item=>item.closest('.tgx-chat-row')?.querySelector('.tgx-chat-name')?.textContent?.trim()||'').filter(Boolean);
                const visible=names.slice(0,3);
                if(names.length>visible.length)visible.push(tr('selectedNamesMore','+'+(names.length-visible.length)+' more',[String(names.length-visible.length)]));
                return {count:checks.length,names:visible.join(' · ')};
            }
            function updateWorkloadEstimate(mode,mediaCount){
                if(!workloadEstimate||!workloadEstimateText)return;
                const planned=mode==='current'?1:plannedChatsForCoverage(mode).length;
                const caps=[];
                if(checked('#tgx-photos'))caps.push(`${tr('mediaPhotos','Photos')} ${q('#tgx-photo-size')?.value||'10'} ${tr('megabytesShort','MB')}`);
                if(checked('#tgx-videos'))caps.push(`${tr('mediaVideos','Videos and GIFs')} ${q('#tgx-video-size')?.value||'100'} ${tr('megabytesShort','MB')}`);
                if(checked('#tgx-files'))caps.push(`${tr('mediaFiles','Files')} ${q('#tgx-file-size')?.value||'100'} ${tr('megabytesShort','MB')}`);
                const numericCaps=caps.map(value=>Number(value.match(/\d+(?:\.\d+)?/)?.[0]||0));
                const maxCap=Math.max(0,...numericCaps);
                let level='light';
                if(planned>10||loadedMessageCount>=5000||(mediaCount>=4&&maxCap>=500))level='heavy';
                else if(planned>1||loadedMessageCount>=1000||mediaCount>=4||maxCap>=500)level='moderate';
                workloadEstimate.dataset.level=level;
                const levelText=level==='heavy'
                    ?tr('workloadLevelHeavy','Heavy')
                    :level==='moderate'
                        ?tr('workloadLevelModerate','Moderate')
                        :tr('workloadLevelLight','Light');
                const mediaText=mediaCount===0
                    ?tr('workloadMediaNone','text only')
                    :mediaCount===1
                        ?tr('workloadMediaOne','1 media type')
                        :tr('workloadMediaCount',`${mediaCount} media types`,[String(mediaCount)]);
                const capsText=caps.join(' · ')||tr('workloadCapsNone','none in this selection');
                const verifierLimit=tr('workloadVerifierLimit','Local verifier reads up to 512 MB of HTML/JSON; open larger archives with PeaZip or 7-Zip.');
                if(workloadCompact)workloadCompact.textContent=mode==='current'
                    ?tr('workloadCompactCurrent',`${levelText} · ${loadedMessageCount} loaded now · ${mediaText}`,[levelText,String(loadedMessageCount),mediaText])
                    :tr('workloadCompactMulti',`${levelText} · ${planned} chats · ${mediaText}`,[levelText,String(planned),mediaText]);
                if(workloadAdvice){
                    const targetRequested=Boolean(normalizeCoverageTargetDate(coverageTargetInput?.value));
                    const advice=targetRequested
                        ?tr('workloadAdviceTarget','Recommended before a date-targeted export: test nearby history first, then confirm the saved range reaches the date you need.')
                        :level==='heavy'
                        ?tr('workloadAdviceHeavy','Recommended: split a large selection into smaller batches or export text + photos first. Per-item limits are enforced; built-in verification reads up to 512 MB of HTML/JSON, so inspect larger ZIPs directly with PeaZip or 7-Zip.')
                        :level==='moderate'
                            ?tr('workloadAdviceModerate','Recommended before a long or multi-chat export: test nearby history first. Then export one chat at a time; if media dominates, deselect Videos/GIFs or Files, or lower their per-item limits.')
                            :'';
                    workloadAdvice.hidden=!advice;
                    workloadAdvice.dataset.level=level;
                    workloadAdvice.replaceChildren();
                    if(advice){
                        workloadAdvice.appendChild(document.createTextNode(advice));
                        const sampleButton=document.createElement('button');
                        sampleButton.type='button';
                        sampleButton.className='tgx-button';
                        sampleButton.dataset.tgxRunSample='true';
                        sampleButton.textContent=tr('workloadAdviceSample','Check a small sample');
                        sampleButton.setAttribute('aria-label',sampleButton.textContent);
                        workloadAdvice.appendChild(sampleButton);
                    }
                }
                workloadEstimateText.textContent=mode==='current'
                    ?tr('workloadCurrent',`${levelText} · 1 chat · ${loadedMessageCount} loaded now · ${mediaText} · caps: ${capsText}. Local Archive may load more during export; final size is measured after fetch and peak memory can exceed the ZIP. ${verifierLimit}`,[levelText,String(loadedMessageCount),mediaText,capsText,verifierLimit])
                    :tr('workloadMulti',`${levelText} · ${planned} chats · ${loadedMessageCount} loaded in the open chat now · ${mediaText} · caps: ${capsText}. Other counts are measured during export; peak memory can exceed the ZIP. ${verifierLimit}`,[levelText,String(planned),String(loadedMessageCount),mediaText,capsText,verifierLimit]);
            }
            function updatePreparationProtection(){
                if(!preparationProtection)return;
                const protectedArchive=checked('#tgx-encrypt');
                preparationProtection.dataset.protected=String(protectedArchive);
                preparationProtection.textContent=protectedArchive
                    ?tr('preparationProtectionAes',`Write down or store the password elsewhere — Local Archive cannot recover it. ${preparationAppRecommendation} After download, use Verify downloaded ZIP below.`,[preparationAppRecommendation])
                    :tr('preparationProtectionNone','No password: anyone with the ZIP can read it. After download, use Verify downloaded ZIP below.');
                if(preparationPlainOpen)preparationPlainOpen.textContent=protectedArchive
                    ?tr('preparationPlainOpenAes','Open: Firefox for an unencrypted ZIP; PeaZip or 7-Zip for AES-256.')
                    :tr('preparationPlainOpenNone','Open with: Firefox or any archive app; this ZIP has no password.');
                if(openAesGuideButton)openAesGuideButton.hidden=!protectedArchive;
            }
            function updateRunBoundary(mode){
                if(!runBoundary)return;
                const level=workloadEstimate?.dataset.level||'light';
                const multi=mode!=='current';
                const longRun=level!=='light';
                // Multi-chat scope already has a dedicated plain-language handoff and
                // per-chat wizard above. Keep the long-run boundary only for a
                // current-chat run so the same limitation is not repeated three times.
                runBoundary.hidden=multi||!longRun;
                if(runBoundary.hidden){runBoundary.textContent='';return;}
                runBoundary.textContent=tr('runBoundaryLong','Before this larger export: only messages available in this authorized Telegram tab can be saved; this is not a complete account backup. Verify the exact saved range before relying on the ZIP.');
                if(exportBoundary&&!historyReady?.checked)exportBoundary.open=true;
            }
            function updateSummary(){
                updateCoverageTargetReadable();
                const formats=[];
                if(q('#tgx-html')?.checked)formats.push(tr('formatHtml','Readable HTML'));
                if(q('#tgx-json')?.checked)formats.push(tr('formatJson','Structured JSON'));
                const media=[];
                if(q('#tgx-photos')?.checked)media.push(tr('mediaPhotos','Photos'));
                if(q('#tgx-videos')?.checked)media.push(tr('mediaVideos','Videos and GIFs'));
                if(q('#tgx-voice')?.checked)media.push(tr('mediaVoice','Voice messages'));
                if(q('#tgx-stickers')?.checked)media.push(tr('mediaStickers','Stickers'));
                if(q('#tgx-files')?.checked)media.push(tr('mediaFiles','Files'));
                const mode=q('input[name="tgx-chats"]:checked')?.value||'current';
                const batchPlan=renderBatchPlanner(mode,getBatchPlan(mode));
                if(scopeHandoffNote)scopeHandoffNote.hidden=mode==='current';
                let scope=currentName;
                if(mode==='all')scope=categorySelect?.selectedOptions?.[0]?.textContent||tr('scopeAllType','All chats in one category');
                if(mode==='selectable'){
                    const selected=selectedChatSummary();
                    scope=batchPlan.totalBatches>1
                        ?tr('batchScopeSummary',`Batch ${batchPlan.activeIndex+1} of ${batchPlan.totalBatches}: ${batchPlan.chats.length} of ${batchPlan.totalChats} chats`,[String(batchPlan.activeIndex+1),String(batchPlan.totalBatches),String(batchPlan.chats.length),String(batchPlan.totalChats)])
                        :selected.names
                            ?tr('selectedScopeSummary',`${selected.count} selected: ${selected.names}`,[String(selected.count),selected.names])
                            :tr('selectedCount',selected.count+' selected',[String(selected.count)]);
                }
                if(mode==='all'&&batchPlan.totalBatches>1)scope+=' · '+tr('batchScopeSummary',`Batch ${batchPlan.activeIndex+1} of ${batchPlan.totalBatches}: ${batchPlan.chats.length} of ${batchPlan.totalChats} chats`,[String(batchPlan.activeIndex+1),String(batchPlan.totalBatches),String(batchPlan.chats.length),String(batchPlan.totalChats)]);
                const scopeSummary=q('#tgx-summary-scope');
                const formatSummary=q('#tgx-summary-formats');
                const mediaSummary=q('#tgx-summary-media');
                if(scopeSummary)scopeSummary.textContent=scope;
                const protectionSummary=checked('#tgx-encrypt')
                    ?tr('beginnerBoundaryProtected','AES-256 password-protected ZIP')
                    :tr('beginnerBoundaryUnencrypted','Unencrypted ZIP');
                const formatText=formats.join(' + ')||tr('presetText','Text only');
                const mediaText=media.join(', ')||tr('beginnerBoundaryNoMedia','no media');
                if(quickContent)quickContent.textContent=formats.length>1
                    ?tr('quickContentBoth','Readable page + reusable data')
                    :formats[0]||tr('quickContentHtml','Readable page');
                if(quickMedia)quickMedia.textContent=media.length>0
                    ?media.join(' · ')
                    :tr('quickMediaNone','No attachments');
                if(quickProtection)quickProtection.textContent=checked('#tgx-encrypt')
                    ?tr('quickProtectionAes','Password-protected ZIP')
                    :tr('quickProtectionNone','ZIP without password');
                if(customizeHint)customizeHint.textContent=mode==='current'
                    ?`${formats.join(' + ')||tr('quickContentHtml','Readable page')} · ${mediaText} · ${checked('#tgx-encrypt')?tr('quickProtectionAes','Password-protected ZIP'):tr('quickProtectionNone','ZIP without password')}`
                    :`${scope} · ${formats.join(' + ')||tr('quickContentHtml','Readable page')}`;
                if(beginnerGuideBoundary)beginnerGuideBoundary.textContent=mode==='current'
                    ?tr('beginnerGuideBoundaryCurrent',`Current settings: 1 chat — ${currentName} · ${protectionSummary} · ${formatText} · media: ${mediaText}`,[currentName,protectionSummary,formatText,mediaText])
                    :tr('beginnerGuideBoundaryMulti',`Current settings: multi-chat · ${scope} · ${protectionSummary} · ${formatText} · media: ${mediaText}`,[scope,protectionSummary,formatText,mediaText]);
                if(beginnerSetup){
                    const firstRun=host.dataset.firstRun==='true';
                    beginnerSetup.hidden=firstRun;
                    if(beginnerSetupChange)beginnerSetupChange.hidden=!(host.dataset.simpleMode==='true'||host.dataset.guidedMode==='protected');
                    if(beginnerSetupScope)beginnerSetupScope.textContent=mode==='current'?tr('beginnerSetupCurrent','Current chat'):scope;
                    if(beginnerSetupFormat)beginnerSetupFormat.textContent=formatText;
                    if(beginnerSetupMedia)beginnerSetupMedia.textContent=mediaText;
                    if(beginnerSetupProtection)beginnerSetupProtection.textContent=protectionSummary;
                }
                if(formatSummary)formatSummary.textContent=formats.join(' · ')||'—';
                if(mediaSummary)mediaSummary.textContent=media.join(' · ')||tr('presetText','Text only');
                if(scopeEffort){
                    const multi=mode!=='current';
                    scopeEffort.hidden=!multi;
                    if(multi){
                        const title=tr('scopeManualTitle','Automatic chat check');
                        const verifiedChats=Object.values(state.completedBatchStats||{}).reduce((sum,stat)=>sum+Math.max(0,Number(stat?.chatsIncluded)||0),0);
                        const nextChat=batchPlan.chats?.[0]?.name||tr('manualNextChatFallback','the next chat');
                        const progress=tr('manualEffortProgress',`${verifiedChats} of ${batchPlan.totalChats} chats verified · next: ${nextChat}`,[String(verifiedChats),String(batchPlan.totalChats),String(nextChat)]);
                        const batchLabel=formatManualBatchLabel(batchPlan.totalBatches);
                        const body=`${tr('scopeManualBody',`Local Archive opens ${batchPlan.totalChats} chats one by one, checks whether Telegram displays each in a readable format, and builds ${batchLabel}. Keep Telegram open; stop and save a partial archive if needed.`,[String(batchPlan.totalChats),batchLabel])} ${progress}`;
                        scopeEffort.replaceChildren();
                        const strong=document.createElement('strong');
                        strong.textContent=title;
                        const span=document.createElement('span');
                        span.textContent=` · ${body}`;
                        scopeEffort.append(strong,span);
                    }
                }
                if(commitSummary){
                    const mediaCaps=[];
                    if(checked('#tgx-photos'))mediaCaps.push(`${tr('mediaPhotos','Photos')} ≤ ${q('#tgx-photo-size')?.value||'10'} MB`);
                    if(checked('#tgx-videos'))mediaCaps.push(`${tr('mediaVideos','Videos and GIFs')} ≤ ${q('#tgx-video-size')?.value||'100'} MB`);
                    if(checked('#tgx-voice'))mediaCaps.push(tr('mediaVoice','Voice messages'));
                    if(checked('#tgx-stickers'))mediaCaps.push(tr('mediaStickers','Stickers'));
                    if(checked('#tgx-files'))mediaCaps.push(`${tr('mediaFiles','Files')} ≤ ${q('#tgx-file-size')?.value||'100'} MB`);
                    const title=tr('commitSummaryTitle','Before you start');
                    const body=tr('commitSummaryBody',`Formats: ${formats.join(' + ')||'none'} · Media: ${mediaCaps.join(', ')||'none'}. Items above a per-file limit are reported as omissions; the rest of the ZIP stays valid.`,[formats.join(' + ')||tr('commitSummaryNone','none'),mediaCaps.join(', ')||tr('commitSummaryNone','none')]);
                    commitSummary.hidden=false;
                    commitSummary.replaceChildren();
                    const strong=document.createElement('strong');
                    strong.textContent=title;
                    const span=document.createElement('span');
                    span.textContent=body;
                    commitSummary.append(strong,span);
                }
                if(capabilityLimits){
                    const limitNotes=[];
                    if(mode!=='current')limitNotes.push(tr('capabilityLimitChats',`Up to ${CONFIG.maxChats} chats per ZIP. Larger selections are split into verified batches; keep this Telegram tab open while each chat is checked.`,[String(CONFIG.maxChats)]));
                    if(formats.length>0)limitNotes.push(tr('capabilityLimitReadable','Built-in verification reads up to 512 MB of HTML/JSON. Larger ZIPs are still valid; open them with PeaZip or 7-Zip.'));
                    capabilityLimits.hidden=limitNotes.length===0;
                    capabilityLimits.textContent=limitNotes.join(' ');
                }
                updateWorkloadEstimate(mode,media.length);
                updateRunBoundary(mode);
                updatePreparationProtection();
                if(preflightStripTab)preflightStripTab.textContent=mode==='current'
                    ?tr('preflightStripTabCurrent','Keep this Telegram tab open until the ZIP is ready.')
                    :tr('preflightStripTabMulti','Keep this Telegram tab open. Local Archive opens each selected chat, checks its layout, and adds it to the current ZIP. Stop anytime; verify the ZIP after export.');
                if(preflightStripProtection)preflightStripProtection.textContent=checked('#tgx-encrypt')
                    ?tr('preflightStripPassword','Write down or store the password elsewhere; Local Archive cannot recover it.')
                    :tr('preflightStripNone','No password: anyone with the ZIP can read it.');
                if(scaleGuidance){
                    const planned=mode==='current'?1:batchPlan.chats.length;
                    const baseGuidance=mode==='current'
                        ?tr('scaleGuidanceCurrent',`Loaded in Telegram now: ${loadedMessageCount} messages. Local Archive may load more during export; large histories or many large files can take minutes and use substantial browser memory.`,[String(loadedMessageCount)])
                        :batchPlan.totalBatches>1
                            ?tr('batchScaleGuidance',`Scale: ${batchPlan.totalChats} chats are split into ${batchPlan.totalBatches} ZIPs. Current batch ${batchPlan.activeIndex+1} of ${batchPlan.totalBatches} contains ${batchPlan.chats.length} chats; use the guided next-batch action after a verified export.`,[String(batchPlan.totalChats),String(batchPlan.totalBatches),String(batchPlan.activeIndex+1),String(batchPlan.chats.length)])
                            :tr('scaleGuidanceMulti',`Scale: chats to process — ${planned} (up to ${CONFIG.maxChats} per archive). Chats are processed one at a time; for a larger selection, export batches of ${CONFIG.maxChats} and then select the next batch.`,[String(planned),String(CONFIG.maxChats)]);
                    const manualEffort=mode==='current'
                        ?''
                        :(()=>{
                            const batchLabel=formatManualBatchLabel(batchPlan.totalBatches);
                            return tr('manualEffortGuidance',`Automatic chat check: Local Archive opens ${batchPlan.totalChats} chats one by one, checks each readable format, and builds ${batchLabel}.`,[String(batchPlan.totalChats),batchLabel]);
                        })();
                    scaleGuidance.textContent=manualEffort?`${baseGuidance} ${manualEffort}`:baseGuidance;
                }
                if(moreMediaStatus){
                    const optional=[['#tgx-videos',tr('mediaVideos','Videos and GIFs')],['#tgx-stickers',tr('mediaStickers','Stickers')],['#tgx-files',tr('mediaFiles','Files')]];
                    const selectedOptional=optional.filter(([selector])=>checked(selector));
                    moreMediaStatus.textContent=selectedOptional.length>0
                        ?tr('moreMediaStatus',`${selectedOptional.length} selected · Videos, stickers, and files`,[String(selectedOptional.length)])
                        :tr('moreMediaStatusNone','Videos, stickers, and files');
                }
                if(footerScope){
                    let compactScope=tr('footerScopeCurrent',`Current: ${currentName}`,[currentName]);
                    if(mode==='selectable')compactScope=batchPlan.totalBatches>1
                        ?tr('batchScopeSummary',`Batch ${batchPlan.activeIndex+1} of ${batchPlan.totalBatches}: ${batchPlan.chats.length} of ${batchPlan.totalChats} chats`,[String(batchPlan.activeIndex+1),String(batchPlan.totalBatches),String(batchPlan.chats.length),String(batchPlan.totalChats)])
                        :tr('footerScopeSelected',`${selectedChatSummary().count} chats selected`,[String(selectedChatSummary().count)]);
                    if(mode==='all')compactScope=tr('footerScopeCategory',`Category: ${categorySelect?.selectedOptions?.[0]?.textContent||'—'}`,[categorySelect?.selectedOptions?.[0]?.textContent||'—']);
                    if(mode==='all'&&batchPlan.totalBatches>1)compactScope+=' · '+tr('batchResultSummary',`Batch ${batchPlan.activeIndex+1} of ${batchPlan.totalBatches}`,[String(batchPlan.activeIndex+1),String(batchPlan.totalBatches)]);
                    footerScope.textContent=tr('footerScopeSummary',`${compactScope} · ${formats.join(' + ')||'—'}`,[compactScope,formats.join(' + ')||'—']);
                }
                updateCoveragePreflight(mode);
                updatePreExportBoundary(mode);
                updatePreparationNext(mode);
                renderManualWizard(mode,batchPlan);
                updateBeginnerSetup(host.dataset.simpleMode==='true'?'simple':host.dataset.guidedMode==='protected'?'protected':'advanced');
                syncBoundaryDisclosure();
                syncCollapsedSample(mode);
            }
            function updateSelectedCount(){
                resetPrivatePreflight();
                const checks=Array.from(root.querySelectorAll('.tgx-chat-check'));
                const count=checks.filter(item=>item.checked).length;
                const selected=selectedChatSummary();
                if(selectedCount)selectedCount.textContent=selected.names
                    ?tr('selectedScopeSummary',`${selected.count} selected: ${selected.names}`,[String(selected.count),selected.names])
                    :tr('selectedCount',count+' selected',[String(count)]);
                if(selectAll){
                    selectAll.checked=checks.length>0&&count===checks.length;
                    selectAll.indeterminate=count>0&&count<checks.length;
                }
                updateSummary();
            }
            function resetTerminalResult(){
                q('.tgx-modal')?.removeAttribute('data-terminal');
                q('.tgx-aside')?.removeAttribute('data-terminal');
                const progress=q('#tgx-progress');
                const progressSimple=q('#tgx-progress-simple');
                const receipt=q('#tgx-receipt');
                const resultValidationRow=q('#tgx-result-validation-row');
                const resultSummary=q('#tgx-result-summary');
                const resultBatch=q('#tgx-result-batch');
                const resultNextBatch=q('#tgx-result-next-batch');
                const resultTarget=q('#tgx-result-target');
                const resultCoverage=q('#tgx-result-coverage');
                const resultOmissions=q('#tgx-result-omissions');
                const resultOmissionAction=q('#tgx-result-omission-action');
                const resultNote=q('#tgx-result-note');
                const resultAesGuide=q('#tgx-result-aes-guide');
                const resultShowDownload=q('#tgx-show-download');
                const resultShowDownloadStatus=q('#tgx-show-download-status');
                const resultVerifyDownload=q('#tgx-verify-download');
                const resultVerifyFile=q('#tgx-verify-file');
                const resultVerifyPanel=q('#tgx-verify-panel');
                const resultVerifyFilename=q('#tgx-verify-filename');
                const resultVerifyPassword=q('#tgx-verify-password');
                const resultVerifyStatus=q('#tgx-verify-status');
                const action=q('#tgx-export');
                const cancel=q('#tgx-cancel');
                if(progress){progress.hidden=true;progress.dataset.state='working';progress.removeAttribute('data-error-code');progress.setAttribute('role','status');}
                if(progressSimple)progressSimple.textContent='';
                if(receipt)receipt.hidden=true;
                if(resultValidationRow)resultValidationRow.hidden=true;
                if(resultSummary)resultSummary.textContent='';
                if(resultBatch){resultBatch.textContent='';resultBatch.hidden=true;resultBatch.removeAttribute('data-completed');resultBatch.removeAttribute('data-total');}
                if(resultNextBatch){resultNextBatch.hidden=true;resultNextBatch.disabled=false;resultNextBatch.textContent='';}
                if(resultTarget){resultTarget.textContent='';resultTarget.hidden=true;resultTarget.removeAttribute('data-state');}
                if(resultCoverage){resultCoverage.textContent='';resultCoverage.hidden=true;}
                if(resultOmissions){resultOmissions.textContent='';resultOmissions.hidden=true;}
                if(resultOmissionAction){resultOmissionAction.hidden=true;resultOmissionAction.disabled=false;resultOmissionAction.textContent=tr('resultOmissionAction','Review skipped media → change limit → re-export');resultOmissionAction.removeAttribute('data-target-selector');resultOmissionAction.removeAttribute('data-exact');}
                if(resultNote){resultNote.textContent='';resultNote.removeAttribute('data-partial');}
                if(resultAesGuide)resultAesGuide.hidden=true;
                if(resultShowDownload){
                    resultShowDownload.hidden=!EXTENSION_MODE;
                    resultShowDownload.disabled=false;
                    resultShowDownload.removeAttribute('data-mode');
                    resultShowDownload.textContent=tr('resultShowDownload','Show downloaded ZIP');
                }
                if(resultShowDownloadStatus){resultShowDownloadStatus.hidden=true;resultShowDownloadStatus.textContent='';resultShowDownloadStatus.removeAttribute('data-state');}
                if(resultVerifyDownload){resultVerifyDownload.hidden=!EXTENSION_MODE;resultVerifyDownload.disabled=false;}
                if(resultVerifyFile)resultVerifyFile.value='';
                if(resultVerifyPanel)resultVerifyPanel.hidden=true;
                if(resultVerifyFilename)resultVerifyFilename.textContent='';
                if(resultVerifyPassword)resultVerifyPassword.value='';
                if(resultVerifyStatus){resultVerifyStatus.hidden=true;resultVerifyStatus.textContent='';resultVerifyStatus.removeAttribute('data-state');}
                selectedVerificationFile=null;
                state.lastOutcome=null;
                state.lastErrorCode=null;
                state.lastDownload=null;
                state.lastExportStats=null;
                state.batchContext=null;
                state.lastProgressPct=0;
                resetPrivatePreflight();
                resetUnencryptedConfirmation();
                resetHistoryGate();
                setDefaultArchiveProtection(root);
                setPreparationDetails(false);
                root.querySelectorAll('.tgx-form input,.tgx-form select,.tgx-form button,#tgx-settings,#tgx-history-ready,#tgx-load-history,#tgx-open-aes-guide').forEach(control=>{control.disabled=false;});
                if(action){action.hidden=false;action.disabled=false;action.removeAttribute('data-next-batch');action.removeAttribute('data-terminal-secondary');refreshExportActionLabel();action.focus();}
                if(cancel)cancel.textContent=tr('close','Close');
            }
            function renderChatList(chats){
                selectableChats=chats;
                if(!chatListDiv)return;
                chatListDiv.replaceChildren();
                if(chats.length===0){
                    const empty=document.createElement('div');
                    empty.className='tgx-chat-empty';
                    empty.textContent=tr('noChatsFound','No chats found. Make sure the Telegram sidebar is visible.');
                    chatListDiv.appendChild(empty);
                    updateSelectedCount();
                    return;
                }
                chats.forEach((chat,index)=>{
                    const row=document.createElement('label');
                    row.className='tgx-chat-row';
                    row.dataset.search=String(chat.name||'').toLocaleLowerCase();
                    const input=document.createElement('input');
                    input.type='checkbox';
                    input.className='tgx-chat-check';
                    input.dataset.idx=String(index);
                    input.checked=true;
                    input.addEventListener('change',updateSelectedCount);
                    const name=document.createElement('span');
                    name.className='tgx-chat-name';
                    name.textContent=chat.name;
                    row.append(input,name);
                    chatListDiv.appendChild(row);
                });
                updateSelectedCount();
            }
            async function ensureChats(){
                if(fullChatList&&fullChatList.length>0){
                    const groups=getChatGroups(fullChatList);
                    if(categorySelect){
                        categorySelect.replaceChildren();
                        for(const key of Object.keys(groups)){
                            const option=document.createElement('option');
                            option.value=key;
                            option.textContent=categoryLabels[key]||key;
                            categorySelect.appendChild(option);
                        }
                    }
                    if(chatListDiv&&!chatListDiv.querySelector('.tgx-chat-row'))renderChatList(fullChatList);
                    return fullChatList;
                }
                if(chatsPromise)return chatsPromise;
                showChatListMessage(tr('loadingChats','Reading the chat list…'));
                chatsPromise=loadAllChatList().then(chats=>{
                    fullChatList=chats;
                    state.fullChatList=chats;
                    const groups=getChatGroups(chats&&chats.length>0?chats:undefined);
                    if(categorySelect){
                        categorySelect.replaceChildren();
                        const keys=Object.keys(groups);
                        if(keys.length===0){
                            const option=document.createElement('option');
                            option.textContent=tr('noChatsFound','No chats found. Make sure the Telegram sidebar is visible.');
                            option.value='';
                            categorySelect.appendChild(option);
                        } else {
                            keys.forEach(key=>{
                                const option=document.createElement('option');
                                option.value=key;
                                option.textContent=categoryLabels[key]||key;
                                categorySelect.appendChild(option);
                            });
                        }
                    }
                    renderChatList(chats&&chats.length>0?chats:getChatList());
                    return chats;
                }).finally(()=>{chatsPromise=null;});
                return chatsPromise;
            }
            async function handleScope(value){
                resetPrivatePreflight();
                resetHistoryGate();
                if(chatTypePanel)chatTypePanel.hidden=value!=='all';
                if(chatListPanel)chatListPanel.hidden=value!=='selectable';
                if(value==='all'||value==='selectable')await ensureChats();
                if(coverageSettings&&value!=='current')coverageSettings.open=true;
                // Keep multi-chat setup in the nontechnical presentation by default.
                // The manual/assisted handoff, plain-language checks, and required
                // acknowledgement remain visible; advanced diagnostics stay opt-in.
                if(value!=='current')setPreparationDetails(false);
                updateSummary();
            }

            root.querySelectorAll('#tgx-html,#tgx-json,#tgx-photos,#tgx-videos,#tgx-voice,#tgx-stickers,#tgx-files').forEach(input=>input.addEventListener('change',()=>{resetPrivatePreflight();updateSummary();refreshPresetState();}));
            root.querySelectorAll('#tgx-photo-size,#tgx-video-size,#tgx-file-size').forEach(input=>input.addEventListener('input',()=>{resetPrivatePreflight();updateSummary();}));
            encryptToggle?.addEventListener('change',()=>{
                resetPrivatePreflight();
                resetUnencryptedConfirmation();
                if(passwordPanel)passwordPanel.hidden=!encryptToggle.checked;
                updateArchiveProtectionChoices(root,Boolean(encryptToggle.checked));
                updateArchiveProtectionIndicator(root,Boolean(encryptToggle.checked));
                updateSummary();
                setFormError('');
                const action=q('#tgx-export');
                if(action&&!state.isExporting&&state.lastOutcome!=='complete')refreshExportActionLabel();
                if(encryptToggle.checked)passwordInput?.focus();
                else {
                    if(passwordInput)passwordInput.value='';
                    if(passwordConfirm)passwordConfirm.value='';
                }
            });
            customizeToggle?.addEventListener('click',()=>{
                if(!customize)return;
                customize.open=!customize.open;
                customizeToggle.setAttribute('aria-expanded',String(customize.open));
                if(customize.open)customize.scrollIntoView({block:'nearest'});
            });
            customize?.addEventListener('toggle',()=>{
                customizeToggle?.setAttribute('aria-expanded',String(customize.open));
            });
            quickRecheck?.addEventListener('click',()=>{
                refreshLoadedHistoryFacts();
                resetHistoryGate();
                updateSummary();
                if(!inspectRenderedMessageCompatibility().ok)quickRecheck.focus();
            });
            const chooseProtection=enabled=>{
                if(!encryptToggle)return;
                if(Boolean(encryptToggle.checked)===Boolean(enabled)){
                    updateArchiveProtectionChoices(root,Boolean(enabled));
                    if(enabled)passwordInput?.focus();
                    return;
                }
                encryptToggle.checked=Boolean(enabled);
                encryptToggle.dispatchEvent(new Event('change',{bubbles:true}));
            };
            protectionAesButton?.addEventListener('click',()=>chooseProtection(true));
            protectionNoneButton?.addEventListener('click',()=>chooseProtection(false));
            passwordInput?.addEventListener('input',resetPrivatePreflight);
            passwordConfirm?.addEventListener('input',resetPrivatePreflight);
            root.querySelectorAll('input[name="tgx-chats"]').forEach(input=>input.addEventListener('change',()=>void handleScope(input.value)));
            presetButtons.forEach(button=>button.addEventListener('click',()=>applyPreset(button.dataset.tgxPreset||'')));
            categorySelect?.addEventListener('change',()=>{resetPrivatePreflight();updateSummary();});
            coverageTargetInput?.addEventListener('change',()=>{resetPrivatePreflight();resetHistoryGate();updateSummary();});
            coverageTargetInput?.addEventListener('input',()=>{resetPrivatePreflight();resetHistoryGate();updateSummary();});
            historyReady?.addEventListener('change',()=>{
                setFormError('');
                syncHistoryGate(false);
                updateSummary();
                if(exportBoundary)exportBoundary.open=!historyReady.checked;
            });
            loadHistoryButton?.addEventListener('click',enterHistoryMode);
            historyReturnButton?.addEventListener('click',returnFromHistoryMode);
            preparationToggle?.addEventListener('click',()=>setPreparationDetails(preparationToggle.getAttribute('aria-expanded')!=='true'));
            const updateBeginnerSetup=(mode)=>{
                const guided=mode==='simple'||mode==='protected';
                if(beginnerSetup)beginnerSetup.hidden=!guided;
                if(!guided)return;
                const currentScope=tr('beginnerSetupCurrent','Current chat');
                const readableFormat=tr('beginnerSetupReadable','Readable HTML');
                const balancedFormat=tr('beginnerSetupBalancedFormat','Readable HTML + structured JSON');
                const noMedia=tr('beginnerSetupNoMedia','No media');
                const balancedMedia=tr('beginnerSetupBalancedMedia','Balanced media · photos, voice, stickers');
                const noPassword=tr('beginnerSetupUnencrypted','Unencrypted ZIP · open in Firefox');
                const protectedLabel=tr('beginnerSetupProtected','AES-256 · PeaZip or 7-Zip');
                if(beginnerSetupScope)beginnerSetupScope.textContent=currentScope;
                if(beginnerSetupFormat)beginnerSetupFormat.textContent=mode==='simple'?readableFormat:balancedFormat;
                if(beginnerSetupMedia)beginnerSetupMedia.textContent=mode==='simple'?noMedia:balancedMedia;
                if(beginnerSetupProtection)beginnerSetupProtection.textContent=mode==='simple'?noPassword:protectedLabel;
            };
            const setBeginnerChoice=(mode)=>{
                const simple=mode==='simple';
                const protectedMode=mode==='protected';
                beginnerGuideAction?.setAttribute('aria-pressed',String(simple));
                beginnerGuideProtected?.setAttribute('aria-pressed',String(protectedMode));
                updateBeginnerSetup(mode);
                if(beginnerGuideAction)beginnerGuideAction.textContent=tr(
                    simple?'beginnerGuideActionAdvanced':protectedMode?'beginnerGuideActionSimpleSwitch':'beginnerGuideAction',
                    simple?'Show advanced setup':protectedMode?'Use quick path':'Use quick path'
                );
                if(beginnerGuideProtected)beginnerGuideProtected.textContent=tr(
                    protectedMode?'beginnerGuideActionProtectedSwitch':'beginnerGuideActionProtected',
                    protectedMode?'Show advanced setup':'Use privacy path'
                );
                if(beginnerGuideProtectedTag)beginnerGuideProtectedTag.textContent=protectedMode
                    ?tr('beginnerGuideActionProtectedTag','Password-protected ZIP · AES-256')
                    :tr('beginnerGuideActionProtectedTagAdvanced','AES-256 ZIP · PeaZip/7-Zip');
            };
            const markOnboardingComplete=()=>{
                state.onboardingCompleted=true;
                preferences.onboardingCompleted=true;
                host.dataset.firstRun='false';
                void saveStoredPreferences(preferences);
            };
            const revealAdvancedSetup=()=>{
                markOnboardingComplete();
                delete host.dataset.simpleMode;
                delete host.dataset.guidedMode;
                host.dataset.firstRun='false';
                beginnerGuide?.setAttribute('data-state','idle');
                setBeginnerChoice('advanced');
                chooseProtection(true);
                if(beginnerGuideBody)beginnerGuideBody.textContent=tr('beginnerGuideBodyAdvanced','Advanced setup is active: choose AES-256 for a password-protected ZIP, or no password for easiest opening. The protection cards and footer always show the current choice.');
                updateSummary();
                beginnerGuideAction?.focus();
            };
            const activateSimpleSetup=()=>{
                markOnboardingComplete();
                const current=root.querySelector('input[name="tgx-chats"][value="current"]');
                if(current&&!current.checked)current.click();
                applyPreset('readable');
                chooseProtection(false);
                delete host.dataset.guidedMode;
                host.dataset.simpleMode='true';
                host.dataset.firstRun='false';
                beginnerGuide?.setAttribute('data-state','active');
                setBeginnerChoice('simple');
                if(beginnerGuideBody)beginnerGuideBody.textContent=tr('beginnerGuideBodySimple','Quick-open mode is active: current chat, readable HTML, unencrypted ZIP, no media. Unzip it, then open messages.html in Firefox. Advanced formats, media, dates, and chat selection are hidden until you switch back.');
                if(coverageSettings)coverageSettings.open=false;
                if(moreMedia)moreMedia.open=false;
                if(exportBoundary)exportBoundary.open=true;
                updateSummary();
                exportBoundary?.scrollIntoView({block:'center'});
                historyReady?.focus();
            };
            const activateProtectedGuidedSetup=()=>{
                markOnboardingComplete();
                const current=root.querySelector('input[name="tgx-chats"][value="current"]');
                if(current&&!current.checked)current.click();
                applyPreset('balanced');
                chooseProtection(true);
                delete host.dataset.simpleMode;
                host.dataset.firstRun='false';
                host.dataset.guidedMode='protected';
                beginnerGuide?.setAttribute('data-state','protected');
                setBeginnerChoice('protected');
                if(beginnerGuideProtected)beginnerGuideProtected.textContent=tr('beginnerGuideActionAdvanced','Show advanced setup');
                if(beginnerGuideBody)beginnerGuideBody.textContent=tr('beginnerGuideBodyProtected','Privacy mode is active: readable HTML + structured JSON are protected with AES-256. Firefox cannot open this ZIP itself; use PeaZip or 7-Zip and keep the password. Advanced controls remain below.');
                updateSummary();
                q('#tgx-protection-aes')?.focus();
            };
            beginnerGuideAction?.addEventListener('click',()=>{
                if(host.dataset.simpleMode==='true')return revealAdvancedSetup();
                activateSimpleSetup();
            });
            beginnerGuideProtected?.addEventListener('click',()=>{
                if(host.dataset.guidedMode==='protected')return revealAdvancedSetup();
                activateProtectedGuidedSetup();
            });
            beginnerSetupChange?.addEventListener('click',()=>revealAdvancedSetup());
            openAesGuideButton?.addEventListener('click',()=>{
                const guide=q('#tgx-aes-help');
                if(!guide)return;
                openPreparationDetails();
                if(exportBoundary)exportBoundary.open=true;
                guide.open=true;
                guide.scrollIntoView({block:'center'});
                focusAesGuide(guide);
            });
            protectionPrimerAction?.addEventListener('click',()=>{
                const section=q('#tgx-protection-section');
                if(section)section.scrollIntoView({block:'center'});
                q('#tgx-protection-aes')?.focus();
            });
            missingSummaryAction?.addEventListener('click',()=>{
                if(exportBoundary)exportBoundary.open=true;
                openPreparationDetails();
                q('.tgx-preparation-plain')?.scrollIntoView({block:'center'});
                q('.tgx-preparation-plain')?.focus?.();
            });
            resultAesGuideAction?.addEventListener('click',()=>{
                const guide=q('#tgx-aes-help');
                if(!guide)return;
                openPreparationDetails();
                if(exportBoundary)exportBoundary.open=true;
                guide.open=true;
                guide.scrollIntoView({block:'center'});
                focusAesGuide(guide);
            });
            if(searchInput)searchInput.addEventListener('input',()=>{
                const query=searchInput.value.trim().toLocaleLowerCase();
                root.querySelectorAll('.tgx-chat-row').forEach(row=>{row.hidden=Boolean(query&&!row.dataset.search.includes(query));});
            });
            if(selectAll)selectAll.addEventListener('change',()=>{
                root.querySelectorAll('.tgx-chat-check').forEach(input=>{input.checked=selectAll.checked;});
                updateSelectedCount();
            });
            batchPrevious?.addEventListener('click',()=>changeActiveBatch(-1));
            batchNext?.addEventListener('click',()=>changeActiveBatch(1));
            const closeIfIdle=()=>{if(!state.isExporting)closeDialog();};
            q('#tgx-close-icon')?.addEventListener('click',closeIfIdle);
            q('[data-tgx-dismiss]')?.addEventListener('mousedown',event=>{if(event.target===event.currentTarget)closeIfIdle();});
            q('#tgx-settings')?.addEventListener('click',()=>{if(EXTENSION_MODE)void browser.runtime.openOptionsPage();});
            const createLocalRequestId=createRuntimeRequestId;
            liveSmokeButton?.addEventListener('click',async()=>{
                if(liveSmokeRunning||state.isExporting)return;
                setFormError('');
                const formatHtml=Boolean(q('#tgx-html')?.checked);
                const formatJson=Boolean(q('#tgx-json')?.checked);
                if(!formatHtml&&!formatJson){
                    setLiveSmoke('error',tr('privatePreflightFormat','Select HTML, JSON, or both before running this test.'));
                    q('#tgx-html')?.focus();
                    return;
                }
                const encryptArchive=Boolean(encryptToggle?.checked);
                const password=String(passwordInput?.value||'');
                const confirmation=String(passwordConfirm?.value||'');
                if(encryptArchive&&!archivePasswordIsValid(password)){
                    setLiveSmoke('error',tr('privatePreflightPassword','Enter and confirm the archive password first so the selected AES route can be tested.'));
                    passwordInput?.focus();
                    return;
                }
                if(encryptArchive&&password!==confirmation){
                    setLiveSmoke('error',tr('validationPasswordMismatch','The two passwords do not match.'));
                    passwordConfirm?.focus();
                    return;
                }
                if(!inspectRenderedMessageCompatibility().ok){
                    setLiveSmoke('error',tr('liveSmokeFailed','One-message check did not pass. Reload Telegram Web or use Check again, then retry.'));
                    exportBoundary?.setAttribute('open','');
                    compatibilityRefreshButton?.focus();
                    return;
                }
                const revision=++liveSmokeRevision;
                liveSmokeRunning=true;
                setLiveSmoke('working',tr('liveSmokeWorking','Checking one real message and reopening the ZIP locally…'));
                try{
                    const result=await runPrivateArchivePreflight({
                        formatHtml,
                        formatJson,
                        password:encryptArchive?password:'',
                        sampleLimit:1,
                        filename:'Local_Archive_live_smoke.zip'
                    });
                    if(revision!==liveSmokeRevision)return;
                    if(liveSmoke){
                        liveSmoke.dataset.messageId=String(result.messageIds[0]||'');
                        liveSmoke.dataset.messageCount=String(result.messageCount);
                        liveSmoke.dataset.entryCount=String(result.entryCount);
                        liveSmoke.dataset.size=String(result.size);
                        liveSmoke.dataset.encrypted=String(result.encrypted);
                    }
                    setLiveSmoke('passed',tr('liveSmokePassed','Passed · 1 real message · ZIP reopened locally · no file saved'));
                    updateSummary();
                }catch(error){
                    log('Live one-message smoke failed:',error?.message||error);
                    if(revision===liveSmokeRevision)setLiveSmoke('error',tr('liveSmokeFailed','One-message check did not pass. Reload Telegram Web or use Check again, then retry.'));
                }finally{
                    liveSmokeRunning=false;
                    if(revision!==liveSmokeRevision)resetLiveSmoke();
                    else if(liveSmokeButton)liveSmokeButton.disabled=false;
                }
            });
            privatePreflightButton?.addEventListener('click',async()=>{
                if(privatePreflightRunning||state.isExporting)return;
                openPreparationDetails();
                setFormError('');
                const formatHtml=Boolean(q('#tgx-html')?.checked);
                const formatJson=Boolean(q('#tgx-json')?.checked);
                if(!formatHtml&&!formatJson){
                    setPrivatePreflight('error',tr('privatePreflightFormat','Select HTML, JSON, or both before running this test.'));
                    q('#tgx-html')?.focus();
                    return;
                }
                const encryptArchive=Boolean(encryptToggle?.checked);
                const password=String(passwordInput?.value||'');
                const confirmation=String(passwordConfirm?.value||'');
                if(encryptArchive&&!archivePasswordIsValid(password)){
                    setPrivatePreflight('error',tr('privatePreflightPassword','Enter and confirm the archive password first so the selected AES route can be tested.'));
                    passwordInput?.focus();
                    return;
                }
                if(encryptArchive&&password!==confirmation){
                    setPrivatePreflight('error',tr('validationPasswordMismatch','The two passwords do not match.'));
                    passwordConfirm?.focus();
                    return;
                }
                const inspection=inspectRenderedMessageCompatibility();
                if(!inspection.ok){
                    refreshLoadedHistoryFacts();
                    updateSummary();
                    setPrivatePreflight('error',tr('privatePreflightFailed','Not passed · the local ZIP pipeline is not ready. Reload Telegram Web or change archive protection and try again.'));
                    openPreparationDetails();
                    loadHistoryButton?.focus();
                    return;
                }
                const revision=++privatePreflightRevision;
                privatePreflightRunning=true;
                setPrivatePreflight('working',tr('privatePreflightWorking','Checking nearby history, packaging the sample, and reopening it locally…'));
                try{
                    const result=await runPrivateArchivePreflight({
                        formatHtml,
                        formatJson,
                        password:encryptArchive?password:''
                    });
                    if(revision!==privatePreflightRevision)return;
                    const protection=result.encrypted
                        ?tr('resultProtectionAes','AES-256 password')
                        :tr('resultProtectionNone','No password');
                    const checkedNewer=result.traversedDirections.includes('newer');
                    const checkedOlder=result.traversedDirections.includes('older');
                    const directions=checkedNewer&&checkedOlder
                        ?tr('privatePreflightDirectionsBoth','newer + older nearby history')
                        :checkedNewer
                            ?tr('privatePreflightDirectionsNewer','newer nearby history')
                            :checkedOlder
                                ?tr('privatePreflightDirectionsOlder','older nearby history')
                                :tr('privatePreflightDirectionsVisible','the current visible page');
                    if(privatePreflight){
                        privatePreflight.dataset.messageIds=result.messageIds.join(',');
                        privatePreflight.dataset.messageCount=String(result.messageCount);
                        privatePreflight.dataset.directions=result.traversedDirections.join(',')||'visible';
                        privatePreflight.dataset.positionRestored=String(result.positionRestored);
                        privatePreflight.dataset.scrollStart=String(result.originalScrollTop);
                        privatePreflight.dataset.scrollFinal=String(result.finalScrollTop);
                        privatePreflight.dataset.entryCount=String(result.entryCount);
                        privatePreflight.dataset.size=String(result.size);
                        privatePreflight.dataset.encrypted=String(result.encrypted);
                    }
                    setPrivatePreflight('passed',tr(
                        'privatePreflightPassed',
                        `Passed · ${result.messageCount} real messages · checked ${directions} · packaged and reopened locally · ${protection} · position restored · no file saved`,
                        [String(result.messageCount),directions,protection]
                    ));
                    updateSummary();
                }catch(error){
                    log('Private archive preflight failed:',error?.message||error);
                    if(revision===privatePreflightRevision)setPrivatePreflight('error',tr('privatePreflightFailed','Not passed · the local ZIP pipeline is not ready. Reload Telegram Web or change archive protection and try again.'));
                }finally{
                    privatePreflightRunning=false;
                    if(revision!==privatePreflightRevision)resetPrivatePreflight();
                    else if(privatePreflightButton)privatePreflightButton.disabled=false;
                }
            });
            const setVerificationStatus=(text,stateName)=>{
                if(!verifyStatus)return;
                verifyStatus.hidden=!text;
                verifyStatus.textContent=text||'';
                if(stateName)verifyStatus.dataset.state=stateName;
                else verifyStatus.removeAttribute('data-state');
            };
            const formatVerificationCount=(count,singularKey,pluralKey,singularFallback,pluralFallback)=>Number(count)===1
                ?tr(singularKey,singularFallback,[String(count)])
                :tr(pluralKey,pluralFallback,[String(count)]);
            async function verifySelectedArchive(password=null){
                if(!EXTENSION_MODE||!selectedVerificationFile)return;
                const expectedFilename=String(state.lastDownload?.filename||'');
                const requestId=createLocalRequestId();
                const file=selectedVerificationFile;
                if(!expectedFilename){
                    setVerificationStatus(tr('verificationError','The export receipt is unavailable. Create the archive again.'),'error');
                    return;
                }
                if(verifyDownload)verifyDownload.disabled=true;
                if(verifyNow)verifyNow.disabled=true;
                setVerificationStatus(tr('verificationReading','Opening and checking this ZIP locally…'),'working');
                try{
                    const response=await browser.runtime.sendMessage({
                        type:'telearchive.archive.verify.v1',requestId,blob:file,filename:file.name,expectedFilename,password
                    });
                    if(!response||response.requestId!==requestId||typeof response.ok!=='boolean')throw new Error('invalid verification response');
                    if(!response.ok){
                        const code=String(response.code||'archive-engine-failed');
                        if(code==='password-required'){
                            if(verifyPanel)verifyPanel.hidden=false;
                            setVerificationStatus(tr('verificationNeedPassword','This AES ZIP needs its password. Re-enter it below; Local Archive clears the field immediately after the check.'),'folder');
                            verifyPassword?.focus();
                            return;
                        }
                        const message=code==='wrong-password'
                            ?tr('verificationWrongPassword','That password did not open this ZIP. Nothing was changed; try again.')
                            :code==='filename-mismatch'
                                ?tr('verificationMismatch',`Selected ${file.name}, but this receipt belongs to ${expectedFilename}. Choose the matching downloaded ZIP.`,[file.name,expectedFilename])
                                :code==='not-telearchive'
                                    ?tr('verificationNotArchive','This file is not a readable Local Archive ZIP, or its report and saved outputs do not agree.')
                                    :code==='verification-limit'
                                        ?tr('verificationLimit','Archive created and downloaded successfully. Built-in verification stopped at the 512 MB readable HTML/JSON limit; extract the ZIP with PeaZip or 7-Zip and inspect the files directly. This does not mean the archive is corrupt.')
                                        :tr('verificationError','Firefox could not verify this ZIP. The file was not changed; choose it again or extract it with PeaZip or 7-Zip.');
                        if(code!=='wrong-password'&&verifyPanel)verifyPanel.hidden=true;
                        setVerificationStatus(message,code==='verification-limit'?'limit':'error');
                        if(code==='wrong-password')verifyPassword?.focus();
                        return;
                    }
                    const report=response.report;
                    if(!report?.outputsVerified||!report.reportReadable)throw new Error('incomplete verification report');
                    const outputs=Number(report.htmlFiles)>0&&Number(report.resultJsonFiles)>0
                        ?tr('verificationOutputsBoth','messages.html + result.json')
                        :Number(report.htmlFiles)>0
                            ?tr('verificationOutputsHtml','messages.html')
                            :tr('verificationOutputsJson','result.json');
                    const chats=formatVerificationCount(Number(report.chatsIncluded),'resultSummaryChat','resultSummaryChats',`${Number(report.chatsIncluded)} chat`,`${Number(report.chatsIncluded)} chats`);
                    const messages=formatVerificationCount(Number(report.messagesIncluded),'resultSummaryMessage','resultSummaryMessages',`${Number(report.messagesIncluded)} message`,`${Number(report.messagesIncluded)} messages`);
                    const protection=response.encrypted
                        ?tr('resultProtectionAes','AES-256 password')
                        :tr('resultProtectionNone','No password');
                    setVerificationStatus(tr(
                        'verificationSuccess',
                        `Verified locally: ${response.filename} · export-summary.json + ${outputs} · ${chats} · ${messages} · ${protection}. The selected file never left this device.`,
                        [String(response.filename||file.name),outputs,chats,messages,protection]
                    ),'file');
                    if(verifyPanel)verifyPanel.hidden=true;
                    selectedVerificationFile=null;
                    if(verifyFile)verifyFile.value='';
                }catch(_){
                    setVerificationStatus(tr('verificationError','Firefox could not verify this ZIP. The file was not changed; choose it again or extract it with PeaZip or 7-Zip.'),'error');
                }finally{
                    if(verifyPassword)verifyPassword.value='';
                    if(verifyDownload)verifyDownload.disabled=false;
                    if(verifyNow)verifyNow.disabled=false;
                }
            }
            if(showDownload){
                showDownload.hidden=!EXTENSION_MODE;
                showDownload.addEventListener('click',async()=>{
                    if(!EXTENSION_MODE)return;
                    const receipt=state.lastDownload;
                    const filename=String(receipt?.filename||'');
                    showDownload.disabled=true;
                    if(showDownloadStatus){showDownloadStatus.hidden=true;showDownloadStatus.textContent='';showDownloadStatus.removeAttribute('data-state');}
                    try{
                        if(!filename||!receipt?.downloadId)throw new Error('missing download receipt');
                        const response=await browser.runtime.sendMessage({
                            type:'telearchive.ui.show-download.v1',
                            requestId:String(receipt.requestId),artifactId:String(receipt.artifactId),
                            downloadId:Number(receipt.downloadId),filename,size:Number(receipt.size)
                        });
                        if(!response?.ok||response.requestId!==receipt.requestId)throw new Error('invalid response');
                        showDownload.dataset.mode=String(response.mode||'');
                        if(showDownloadStatus){
                            showDownloadStatus.hidden=false;
                            showDownloadStatus.dataset.state=response.mode==='file'?'file':'folder';
                            showDownloadStatus.textContent=response.mode==='file'
                                ?tr('resultShowDownloadFile',`Shown in its folder: ${filename}`,[filename])
                                :tr('resultShowDownloadFolder',`Exact match not found. Opened the Downloads folder — find: ${filename}`,[filename]);
                        }
                    }catch(_){
                        if(showDownloadStatus){
                            showDownloadStatus.hidden=false;
                            showDownloadStatus.dataset.state='error';
                            showDownloadStatus.textContent=tr('resultShowDownloadError',`Could not open a folder. In Firefox Downloads, find: ${filename||'the Local Archive ZIP'}`,[filename||'the Local Archive ZIP']);
                        }
                    }finally{
                        showDownload.disabled=false;
                    }
                });
            }
            if(verifyDownload&&verifyFile){
                verifyDownload.hidden=!EXTENSION_MODE;
                verifyDownload.addEventListener('click',()=>{
                    if(!EXTENSION_MODE)return;
                    verifyFile.value='';
                    verifyFile.click();
                });
                verifyFile.addEventListener('change',()=>{
                    const file=verifyFile.files?.[0]||null;
                    selectedVerificationFile=file;
                    if(verifyPanel)verifyPanel.hidden=true;
                    if(verifyPassword)verifyPassword.value='';
                    if(verifyFilename)verifyFilename.textContent=file?.name||'';
                    setVerificationStatus('',null);
                    if(file)void verifySelectedArchive(null);
                });
            }
            verifyNow?.addEventListener('click',()=>{
                const password=String(verifyPassword?.value||'');
                if(!archivePasswordIsValid(password)){
                    setVerificationStatus(tr('verificationPasswordTooShort','Enter the archive password (at least 8 characters).'),'error');
                    verifyPassword?.focus();
                    return;
                }
                void verifySelectedArchive(password);
            });
            verifyPassword?.addEventListener('keydown',event=>{
                if(event.key==='Enter'){
                    event.preventDefault();
                    verifyNow?.click();
                }
            });
            q('#tgx-cancel')?.addEventListener('click',()=>{
                if(state.isExporting){
                    setCancelled(true);
                    updateProgress(tr('statusBuildingPartial','Finishing the partial archive…'));
                } else {
                    closeDialog();
                }
            });
            q('#tgx-export')?.addEventListener('click',async()=>{
                if(state.lastOutcome==='complete'){
                    const action=q('#tgx-export');
                    const advance=action?.dataset.nextBatch==='true';
                    const completedContext=state.batchContext?{...state.batchContext}:null;
                    resetTerminalResult();
                    if(advance&&completedContext){
                        completedBatchIndexes.add(Number(completedContext.index)||0);
                        state.batchCompletedCount=completedBatchIndexes.size;
                        activeBatchIndex=Math.min(Number(completedContext.index)+1,Number(completedContext.total)-1);
                        state.batchContext=null;
                        updateSummary();
                        batchPlanner?.scrollIntoView({block:'nearest'});
                        batchPlanner?.focus();
                    }else{
                        completedBatchIndexes.clear();
                        state.batchCompletedCount=0;
                        state.batchRunAll=false;
                        state.completedBatchStats={};
                        updateSummary();
                    }
                    return;
                }
                setFormError('');
                const formatHtml=Boolean(q('#tgx-html')?.checked);
                const formatJson=Boolean(q('#tgx-json')?.checked);
                if(!formatHtml&&!formatJson){
                    setFormError(tr('validationOneFormat','Select HTML, JSON, or both.'));
                    q('#tgx-html')?.focus();
                    return;
                }
                const mode=q('input[name="tgx-chats"]:checked')?.value||'current';
                const liveInspection=inspectRenderedMessageCompatibility();
                if(!liveInspection.ok){
                    refreshLoadedHistoryFacts();
                    updateSummary();
                    setFormError(liveInspection.reason==='no_chat'||liveInspection.reason==='no_messages'
                        ?tr('validationNoMessages','No readable messages were detected. Open or load a chat, then update the pre-export review.')
                        :tr('validationLiveCheck','This Telegram message layout did not pass the live safety check. Export is blocked until Local Archive supports it.'));
                    if(exportBoundary)exportBoundary.open=true;
                    openPreparationDetails();
                    loadHistoryButton?.focus();
                    return;
                }
                const encryptArchive=Boolean(encryptToggle?.checked);
                const archivePassword=String(passwordInput?.value||'');
                const archivePasswordConfirm=String(passwordConfirm?.value||'');
                if(encryptArchive&&!archivePasswordIsValid(archivePassword)){
                    setFormError(tr('validationPasswordLength','Use a password with at least 8 characters.'));
                    passwordInput?.focus();
                    return;
                }
                if(encryptArchive&&archivePassword!==archivePasswordConfirm){
                    setFormError(tr('validationPasswordMismatch','The two passwords do not match.'));
                    passwordConfirm?.focus();
                    return;
                }
                const batchPlan=getBatchPlan(mode);
                const selectedChats=mode==='current'?[]:batchPlan.chats;
                if(mode!=='current'){
                    if(selectedChats.length===0){
                        setFormError(tr('errorSelectChat','Select at least one chat.'));
                        (mode==='selectable'?searchInput:categorySelect)?.focus();
                        return;
                    }
                }
                if(!historyReady?.checked){
                    if(exportBoundary)exportBoundary.open=true;
                    syncHistoryGate(true);
                    setFormError(tr('validationHistoryReady','Confirm the pre-export review below before creating the archive.'));
                    historyReady?.focus();
                    return;
                }
                if(!encryptArchive&&!unencryptedConfirmed){
                    unencryptedConfirmed=true;
                    if(unencryptedConfirm)unencryptedConfirm.hidden=false;
                    if(footer)footer.dataset.confirmingUnencrypted='true';
                    const action=q('#tgx-export');
                    if(action){setExportActionLabel('unencrypted');action.focus();}
                    return;
                }
                resetUnencryptedConfirmation();
                state.formatHtml=formatHtml;
                state.formatJson=formatJson;
                state.exportPhotos=Boolean(q('#tgx-photos')?.checked);
                state.exportVideos=Boolean(q('#tgx-videos')?.checked);
                state.exportVoice=Boolean(q('#tgx-voice')?.checked);
                state.exportStickers=Boolean(q('#tgx-stickers')?.checked);
                state.exportFiles=Boolean(q('#tgx-files')?.checked);
                state.maxPhotoSize=clampMegabytes(q('#tgx-photo-size')?.value,10,10000)*1024*1024;
                state.maxVideoSize=clampMegabytes(q('#tgx-video-size')?.value,100,20000)*1024*1024;
                state.maxFileSize=clampMegabytes(q('#tgx-file-size')?.value,100,20000)*1024*1024;
                state.archivePassword=encryptArchive?archivePassword:'';
                state.coverageTargetDate=normalizeCoverageTargetDate(coverageTargetInput?.value);
                state.exportMode=mode;
                state.selectedChats=selectedChats;
                state.batchContext=mode!=='current'&&batchPlan.totalBatches>1?{
                    mode,
                    index:batchPlan.activeIndex,
                    total:batchPlan.totalBatches,
                    totalChats:batchPlan.totalChats,
                    start:batchPlan.start+1,
                    end:batchPlan.end,
                    size:batchPlan.chats.length,
                    nextChatName:String(batchPlan.all[(batchPlan.activeIndex+1)*CONFIG.maxChats]?.name||'the first chat in the next batch')
                }:null;
                state.chatType=mode==='all'?categorySelect?.value||null:null;
                state.lastOutcome=null;
                state.onboardingCompleted=true;
                await saveStoredPreferences({...preferencesFromState(),onboardingCompleted:true});
                const action=q('#tgx-export');
                const cancel=q('#tgx-cancel');
                q('.tgx-modal')?.removeAttribute('data-terminal');
                q('.tgx-aside')?.removeAttribute('data-terminal');
                root.querySelectorAll('.tgx-form input,.tgx-form select,.tgx-form button,#tgx-settings,#tgx-history-ready,#tgx-load-history,#tgx-open-aes-guide').forEach(control=>{control.disabled=true;});
                if(action){action.disabled=true;action.removeAttribute('data-terminal-secondary');action.textContent=tr('exporting','Creating archive…');}
                if(cancel)cancel.textContent=tr('cancelExport','Stop and save partial archive');
                await startExport();
            });
            root.addEventListener('keydown',event=>{
                if(event.key==='Escape'){
                    if(historyMode){event.preventDefault();returnFromHistoryMode();}
                    else if(!state.isExporting){event.preventDefault();closeDialog();}
                    return;
                }
                if(event.key!=='Tab')return;
                const focusable=Array.from(root.querySelectorAll('button:not([disabled]):not([hidden]),input:not([disabled]),select:not([disabled])')).filter(el=>!el.closest('[hidden]'));
                if(focusable.length===0)return;
                const first=focusable[0],last=focusable[focusable.length-1];
                if(event.shiftKey&&root.activeElement===first){event.preventDefault();last.focus();}
                else if(!event.shiftKey&&root.activeElement===last){event.preventDefault();first.focus();}
            });
            setDefaultArchiveProtection(root);
            if(historyReady)historyReady.checked=inspectRenderedMessageCompatibility().ok;
            unencryptedConfirmed=true;
            if(host.dataset.firstRun==='true'&&encryptToggle?.checked)beginnerGuideProtected?.setAttribute('aria-pressed','true');
            syncHistoryGate(false);
            updateSummary();
            refreshPresetState();
            setTimeout(()=>{
                if(!root.activeElement||root.activeElement===root.host)q('#tgx-export')?.focus();
            },0);
        } finally {
            state.dialogOpening=false;
        }
    }

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
    function getDialogSurface() {
        return state.dialogRoot||state.dialog;
    }
    function updateArchiveProtectionIndicator(surface,enabled) {
        const indicator=surface?.querySelector?.('#tgx-footer-protection');
        if(indicator){
            indicator.dataset.protected=String(Boolean(enabled));
            indicator.textContent=enabled
                ?tr('footerProtectionAes','AES-256 · keep password elsewhere · open with PeaZip or 7-Zip')
                :tr('footerProtectionNone','Unencrypted ZIP — unzip, then open in Firefox; anyone with the file can read it');
        }
        const primer=surface?.querySelector?.('#tgx-protection-primer');
        const primerText=surface?.querySelector?.('#tgx-protection-primer-text');
        if(primer){
            primer.dataset.protected=String(Boolean(enabled));
            if(primerText)primerText.textContent=enabled
                ?tr('protectionPrimerAes','AES-256 password ZIP selected. Open with PeaZip or 7-Zip; write down or store the password elsewhere before export.')
                :tr('protectionPrimerNone','Unencrypted ZIP selected. It opens in Firefox; anyone with the file can read it.');
        }
    }
    function updateArchiveProtectionChoices(surface,enabled) {
        const protectedArchive=Boolean(enabled);
        const workbench=surface?.querySelector?.('.tgx-protection-workbench');
        if(workbench)workbench.dataset.protected=String(protectedArchive);
        const aes=surface?.querySelector?.('#tgx-protection-aes');
        const none=surface?.querySelector?.('#tgx-protection-none');
        if(aes)aes.setAttribute('aria-pressed',String(protectedArchive));
        if(none)none.setAttribute('aria-pressed',String(!protectedArchive));
    }
    function clearArchivePassword(surface=getDialogSurface(), preserveCompletedState=false) {
        state.archivePassword='';
        if(!surface)return;
        const toggle=surface.querySelector?.('#tgx-encrypt');
        const panel=surface.querySelector?.('#tgx-password-panel');
        const password=surface.querySelector?.('#tgx-password');
        const confirm=surface.querySelector?.('#tgx-password-confirm');
        const protectedState=Boolean(preserveCompletedState&&state.lastExportStats?.archiveEncrypted);
        if(toggle)toggle.checked=protectedState;
        if(panel)panel.hidden=true;
        if(password)password.value='';
        if(confirm)confirm.value='';
        updateArchiveProtectionChoices(surface,protectedState);
        updateArchiveProtectionIndicator(surface,protectedState);
    }
    function setDefaultArchiveProtection(surface=getDialogSurface()) {
        clearArchivePassword(surface);
        if(!surface)return;
        const toggle=surface.querySelector?.('#tgx-encrypt');
        const panel=surface.querySelector?.('#tgx-password-panel');
        if(toggle)toggle.checked=false;
        if(panel)panel.hidden=true;
        updateArchiveProtectionChoices(surface,false);
        updateArchiveProtectionIndicator(surface,false);
    }
    function closeDialog() {
        if(!state.dialog) return;
        const previous=state.previousFocus;
        if(typeof state.dialogCleanup==='function'){
            try{state.dialogCleanup();}catch(_){}
        }
        state.dialogCleanup=null;
        clearArchivePassword();
        state.dialog.remove();
        state.dialog=null;
        state.dialogRoot=null;
        state.previousFocus=null;
        state.lastOutcome=null;
        state.lastErrorCode=null;
        state.lastDownload=null;
        state.lastExportStats=null;
        state.batchContext=null;
        state.completedBatchStats={};
        state.lastProgressPct=0;
        if(previous&&previous.isConnected){
            try{previous.focus();}catch(_){}
        }
    }

    function interpolateQuick(template,values={}) {
        return String(template||'').replace(/\{([a-zA-Z]+)\}/g,(_,name)=>String(values[name]??`{${name}}`));
    }

    function formatQuickElapsed(milliseconds) {
        const totalSeconds=Math.max(0,Math.floor(Number(milliseconds||0)/1000));
        const minutes=Math.floor(totalSeconds/60);
        const seconds=totalSeconds%60;
        return String(minutes).padStart(2,'0')+':'+String(seconds).padStart(2,'0');
    }

    function quickElapsedLabel() {
        const started=Number(state.quickStartedAt)||Date.now();
        return interpolateQuick(state.quickLabels?.elapsed||'Elapsed: {time}',{time:formatQuickElapsed(Date.now()-started)});
    }

    function updateQuickBar(value) {
        const root=state.quickRoot;
        if(!root)return;
        const pct=Math.max(0,Math.min(100,Number(value)||0));
        const bar=root.querySelector('.bar');
        const track=root.querySelector('.track');
        if(bar)bar.style.width=pct+'%';
        if(track)track.setAttribute('aria-valuenow',String(Math.round(pct)));
    }

    function renderQuickElapsed() {
        const root=state.quickRoot;
        if(!root||!state.quickStartedAt)return;
        const meta=root.querySelector('.meta');
        if(meta)meta.textContent=quickElapsedLabel();
    }

    function closeQuickPanel() {
        if(state.quickElapsedTimer){clearInterval(state.quickElapsedTimer);state.quickElapsedTimer=null;}
        state.quickHost?.remove();
        state.quickHost=null;
        state.quickRoot=null;
        state.quickMode=false;
        clearBackgroundJobState();
        state.quickStartedAt=0;
    }

    function createQuickPanel(labels) {
        state.quickHost?.remove();
        state.quickLabels={...labels};
        state.quickMode=true;
        if(state.quickElapsedTimer){clearInterval(state.quickElapsedTimer);state.quickElapsedTimer=null;}
        state.quickStartedAt=Date.now();
        const host=document.createElement('div');
        host.id='local-archive-progress-root';
        const root=host.attachShadow({mode:'open'});
        root.innerHTML=`<style>
          :host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;width:min(340px,calc(100vw - 32px));font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#15171a;color-scheme:light}
          *{box-sizing:border-box}.panel{overflow:hidden;border:1px solid #cfcfd4;border-radius:12px;background:#fff;box-shadow:0 10px 36px rgba(0,0,0,.22)}
          .head{display:grid;grid-template-columns:32px 1fr auto;align-items:center;gap:10px;padding:12px 12px 9px}.mark{display:grid;width:32px;height:32px;place-items:center;border-radius:9px;background:#e7f1ff;color:#0060df;font-size:16px;font-weight:800}.copy{min-width:0}.brand{display:block;color:#666671;font-size:9px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.status{display:block;overflow:hidden;margin-top:1px;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.detail{margin:0;padding:0 12px 2px 54px;color:#666671;font-size:10.5px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{margin:0;padding:0 12px 10px 54px;color:#898991;font-size:10px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track{height:3px;background:#e7e7eb}.bar{display:block;width:8%;height:100%;background:#0060df;transition:width .2s ease}.actions{display:flex;justify-content:flex-end;gap:7px;padding:9px 12px;border-top:1px solid #ededf0}.button{min-height:30px;padding:5px 10px;border:0;border-radius:6px;background:#e8e8ed;color:#202024;cursor:pointer;font:600 11px system-ui}.button.primary{background:#0060df;color:#fff}.button[hidden],.actions[hidden]{display:none}.panel[data-state=complete] .mark{background:#e5f7f1;color:#087e67}.panel[data-state=error] .mark{background:#ffe8e8;color:#a22d37}.panel[data-state=error] .bar{background:#c43d49}.icon-button{width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:#666671;cursor:pointer;font-size:18px}.icon-button[hidden]{display:none}
          @media(prefers-color-scheme:dark){:host{color:#f2f2f3;color-scheme:dark}.panel{border-color:#55545f;background:#2b2a33}.brand,.detail{color:#b7b6c1}.meta{color:#9998a5}.mark{background:#253c5b;color:#80b8ff}.track{background:#45444f}.actions{border-color:#45444f}.button{background:#45444f;color:#f2f2f3}.panel[data-state=complete] .mark{background:#1e4a40;color:#7ee2c9}.panel[data-state=error] .mark{background:#592e34;color:#ffadb5}.icon-button{color:#b7b6c1}}
        </style><section class="panel" data-state="working" role="status" aria-live="polite"><div class="head"><span class="mark">↓</span><div class="copy"><span class="brand"></span><strong class="status"></strong></div><button class="icon-button close" type="button" hidden aria-label="Close">×</button></div><p class="detail"></p><p class="meta" aria-live="off"></p><div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="bar"></span></div><div class="actions"><button class="button show" type="button" hidden></button><button class="button cancel" type="button"></button></div></section>`;
        document.documentElement.appendChild(host);
        state.quickHost=host;
        state.quickRoot=root;
        root.querySelector('.brand').textContent=labels.title||'Local Archive';
        root.querySelector('.status').textContent=labels.preparing||'Preparing export…';
        root.querySelector('.detail').textContent=labels.keepOpen||'';
        root.querySelector('.meta').textContent=interpolateQuick(labels.elapsed||'Elapsed: {time}',{time:'00:00'});
        root.querySelector('.cancel').textContent=labels.cancel||'Cancel';
        root.querySelector('.show').textContent=labels.showFile||'Show file';
        root.querySelector('.close').setAttribute('aria-label',labels.close||'Close');
        root.querySelector('.cancel').addEventListener('click',()=>{
            if(state.backgroundRemote&&state.backgroundJobId&&typeof browser!=='undefined'&&typeof browser.runtime?.sendMessage==='function'){
                root.querySelector('.cancel').disabled=true;
                try{void browser.runtime.sendMessage({type:'telearchive.background-export.cancel.v1',jobId:String(state.backgroundJobId),sourceTabId:Number(globalThis.__LOCAL_ARCHIVE_SOURCE_TAB_ID__||0)}).catch(()=>{});}catch(_){ }
                return;
            }
            setCancelled(true);
        });
        root.querySelector('.close').addEventListener('click',closeQuickPanel);
        root.querySelector('.show').addEventListener('click',async()=>{
            const receipt=state.lastDownload;
            if(!receipt)return;
            try{await browser.runtime.sendMessage({
                type:'telearchive.ui.show-download.v1',requestId:String(receipt.requestId),
                artifactId:String(receipt.artifactId),downloadId:Number(receipt.downloadId),
                filename:String(receipt.filename),size:Number(receipt.size)
            });}catch(_){}
        });
        renderQuickElapsed();
        state.quickElapsedTimer=setInterval(renderQuickElapsed,1000);
    }

    function renderQuickProgress(stage='reading',pct) {
        const root=state.quickRoot,labels=state.quickLabels;
        if(!root||!labels)return;
        const panel=root.querySelector('.panel');
        panel.dataset.state='working';
        root.querySelector('.mark').textContent='↓';
        root.querySelector('.status').textContent=stage==='saving'?(labels.saving||'Saving archive…'):(labels.reading||'Reading messages…');
        root.querySelector('.detail').textContent=interpolateQuick(labels.messages||'{count} messages',{count:state.messages.size});
        renderQuickElapsed();
        updateQuickBar(Math.max(6,Math.min(96,Number(pct)||Math.min(84,8+state.messages.size/5))));
    }

    function renderBackgroundProgress(message={}) {
        const root=state.quickRoot,labels=state.quickLabels;
        if(!root||!labels)return {ok:false};
        const panel=root.querySelector('.panel');
        const phase=String(message.phase||'reading');
        const pct=Math.max(0,Math.min(100,Number(message.pct)||0));
        panel.dataset.state='working';
        root.querySelector('.mark').textContent=phase==='saving'?'↓':'↗';
        root.querySelector('.status').textContent=phase==='preparing'?(labels.preparing||'Preparing export…'):(phase==='saving'?(labels.saving||'Saving archive…'):(labels.reading||'Reading messages…'));
        const count=Number(message.messages)||0;
        const detail=phase==='preparing'
            ?String(labels.keepOpen||message.text||labels.preparing||'Preparing export…')
            :String(message.text||interpolateQuick(labels.messages||'{count} messages',{count}));
        root.querySelector('.detail').textContent=detail;
        const countText=interpolateQuick(labels.messages||'{count} messages',{count});
        root.querySelector('.meta').textContent=phase==='preparing'?quickElapsedLabel():countText+' · '+quickElapsedLabel();
        updateQuickBar(Math.max(4,Math.min(96,pct||4)));
        root.querySelector('.cancel').hidden=false;
        root.querySelector('.cancel').disabled=false;
        root.querySelector('.show').hidden=true;
        root.querySelector('.close').hidden=true;
        return {ok:true};
    }

    function beginBackgroundProgress(payload={}) {
        const jobId=String(payload?.jobId||'');
        if(!jobId||isQuickExportBusy())return false;
        state.backgroundJobId=jobId;
        state.backgroundRemote=true;
        globalThis.__LOCAL_ARCHIVE_SOURCE_TAB_ID__=Number(payload?.sourceTabId||0);
        createQuickPanel(payload?.labels||{});
        state.backgroundRemote=true;
        renderBackgroundProgress({phase:'preparing',pct:2,messages:0,text:payload?.labels?.keepOpen||'You can keep working while Local Archive loads the history in the background.'});
        return true;
    }

    function restoreBackgroundProgress(payload={}) {
        const jobId=String(payload?.jobId||'');
        const progress=payload?.progress&&typeof payload.progress==='object'?payload.progress:null;
        if(!jobId||!progress)return false;
        if(state.backgroundJobId===jobId&&state.quickRoot){
            return Boolean(backgroundProgress(progress)?.ok);
        }
        state.backgroundJobId=jobId;
        state.backgroundRemote=true;
        globalThis.__LOCAL_ARCHIVE_SOURCE_TAB_ID__=Number(payload?.sourceTabId||0);
        createQuickPanel(payload?.labels||{});
        state.backgroundRemote=true;
        return Boolean(backgroundProgress(progress)?.ok);
    }

    function backgroundProgress(message={}) {
        if(String(message?.jobId||'')!==String(state.backgroundJobId||''))return {ok:false};
        if(Number.isInteger(Number(message?.workerTabId))&&Number(message.workerTabId)>0){
            globalThis.__LOCAL_ARCHIVE_BACKGROUND_WORKER_TAB_ID__=Number(message.workerTabId);
        }
        const phase=String(message.phase||'reading');
        if(phase==='complete'){
            state.lastOutcome='complete';
            state.lastDownload=message.receipt||null;
            state.lastExportStats=message.stats&&typeof message.stats==='object'?JSON.parse(JSON.stringify(message.stats)):createExportStats();
            renderQuickComplete(state.lastDownload,state.lastExportStats);
            clearBackgroundJobState();
            return {ok:true};
        }
        if(phase==='error'){
            state.lastOutcome='error';
            state.lastErrorCode=String(message.errorCode||'background-export-failed');
            renderQuickError(String(message.text||'The background export failed.'),state.lastErrorCode);
            clearBackgroundJobState();
            return {ok:true};
        }
        return renderBackgroundProgress(message);
    }

    function renderQuickComplete(receipt,stats) {
        const root=state.quickRoot,labels=state.quickLabels;
        if(!root||!labels)return;
        const panel=root.querySelector('.panel');
        panel.dataset.state='complete';
        root.querySelector('.mark').textContent='✓';
        root.querySelector('.status').textContent=labels.saved||'Archive saved';
        const parts=[interpolateQuick(labels.messages||'{count} messages',{count:Number(stats?.messagesIncluded)||0})];
        const skipped=Number(stats?.media?.skipped)||0;
        if(skipped)parts.push(interpolateQuick(labels.mediaSkipped||'{count} attachments skipped',{count:skipped}));
        const size=Number(receipt?.size)||0;
        const filename=String(receipt?.filename||'');
        if(filename)parts.push(interpolateQuick(labels.file||'ZIP: {filename} · {size}',{filename,size:size?formatFileSize(size):'unknown'}));
        root.querySelector('.detail').textContent=parts.join(' · ');
        root.querySelector('.meta').textContent=quickElapsedLabel();
        updateQuickBar(100);
        root.querySelector('.cancel').hidden=true;
        root.querySelector('.show').hidden=!receipt;
        root.querySelector('.close').hidden=false;
    }

    function renderQuickError(message,code) {
        const root=state.quickRoot,labels=state.quickLabels;
        if(!root||!labels)return;
        const panel=root.querySelector('.panel');
        panel.dataset.state='error';
        panel.dataset.errorCode=String(code||'unexpected');
        root.querySelector('.mark').textContent='!';
        root.querySelector('.status').textContent=labels.failed||'Export failed';
        root.querySelector('.detail').textContent=code==='empty-range'?(labels.emptyRange||message):String(message||'');
        root.querySelector('.meta').textContent=quickElapsedLabel();
        updateQuickBar(100);
        root.querySelector('.cancel').hidden=true;
        root.querySelector('.show').hidden=true;
        root.querySelector('.close').hidden=false;
    }

    function updateProgress(text, pct) {
        state.progressText=String(text||'');
        if(state.quickMode)renderQuickProgress(Number(pct)>=88?'saving':'reading',pct);
        if(state.backgroundJobId&&!state.backgroundRemote){
            const numericPct=Number(pct)||0;
            const phase=numericPct===0&&state.messages.size===0?'preparing':(numericPct>=88?'saving':'reading');
            sendBackgroundProgress(phase,state.progressText,numericPct);
        }
        if(!state.dialog) return;
        const surface=getDialogSurface();
        const p=surface?.querySelector('#tgx-progress');
        if(!p) return;
        if(state.dialogRoot){
            p.hidden=false;
            p.dataset.state='working';
            p.setAttribute('role','status');
            p.removeAttribute('data-error-code');
            const title=surface.querySelector('#tgx-progress-title');
            const copy=surface.querySelector('#tgx-progress-text');
            const icon=surface.querySelector('#tgx-progress-icon');
            const bar=surface.querySelector('#tgx-progress-bar');
            const receipt=surface.querySelector('#tgx-receipt');
            if(title)title.textContent=tr('exporting','Creating archive…');
            if(copy)copy.textContent=state.progressText;
            const simpleStatus=surface.querySelector('#tgx-progress-simple');
            if(simpleStatus){
                const batch=state.batchContext;
                if(state.exportMode!=='current'&&Number(state.exportStats?.chatsRequested)>0){
                    const total=Number(state.exportStats.chatsRequested)||0;
                    const current=Math.min(total,Number(state.currentChatIndex||0)+1);
                    const remaining=Math.max(0,total-current);
                    const batchHint=batch&&Number(batch.total)>1
                        ?tr('progressBatchHint',`One ZIP per batch · ${Number(batch.total)} planned`,[String(Number(batch.total))])
                        :'';
                    simpleStatus.textContent=tr('progressChatsRemaining',`${current} of ${total} chats checked · ${remaining} remaining${batchHint?` · ${batchHint}`:''}`,[String(current),String(total),String(remaining),batchHint]);
                }else{
                    const found=Number(state.messages?.size)||0;
                    simpleStatus.textContent=found===1
                        ?tr('progressCurrentHintOne','1 message collected so far · keep this Telegram tab open')
                        :tr('progressCurrentHint',`${found} messages collected so far · keep this Telegram tab open`,[String(found)]);
                }
            }
            if(copy){
                let scopeNote=surface.querySelector('#tgx-progress-boundary');
                if(!scopeNote){
                    scopeNote=document.createElement('small');
                    scopeNote.id='tgx-progress-boundary';
                    scopeNote.className='tgx-progress-boundary';
                    copy.after(scopeNote);
                }
                scopeNote.textContent=tr('progressScopeNote','Local archive in this browser · older history loads automatically · the receipt records the exact range reached in this Telegram tab.');
            }
            if(icon)icon.textContent='↯';
            if(receipt)receipt.hidden=true;
            if(pct!==undefined)state.lastProgressPct=Math.max(0,Math.min(100,Number(pct)||0));
            else if(state.lastProgressPct===0)state.lastProgressPct=4;
            if(bar)bar.style.width=state.lastProgressPct+'%';
            return;
        }
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
    function formatMediaReason(reason) {
        const labels = {
            size_limit: tr('mediaReasonSize', 'size limit'),
            network: tr('mediaReasonNetwork', 'network or access'),
            cancelled: tr('mediaReasonCancelled', 'stopped by you'),
            invalid: tr('mediaReasonInvalid', 'invalid item'),
            thumbnail_unavailable: tr('mediaReasonThumbnail', 'thumbnail unavailable'),
            unknown: tr('mediaReasonUnknown', 'unknown reason')
        };
        return labels[reason] || String(reason || labels.unknown);
    }

    function formatExportSummary(stats) {
        const value = stats || createExportStats();
        const media = value.media || {};
        const parts = [];
        if(value.batch&&Number(value.batch.total)>1)parts.push(tr('batchResultSummary',`Batch ${Number(value.batch.index)+1} of ${value.batch.total}`,[String(Number(value.batch.index)+1),String(value.batch.total)]));
        if (Number.isFinite(value.chatsIncluded)) parts.push(tr(value.chatsIncluded===1?'resultSummaryChat':'resultSummaryChats', `${value.chatsIncluded} ${value.chatsIncluded===1?'chat':'chats'}`, [String(value.chatsIncluded)]));
        if (Number.isFinite(value.messagesIncluded)) parts.push(tr(value.messagesIncluded===1?'resultSummaryMessage':'resultSummaryMessages', `${value.messagesIncluded} ${value.messagesIncluded===1?'message':'messages'}`, [String(value.messagesIncluded)]));
        const includedMedia=Number(media.included)||0;
        parts.push(tr(includedMedia===1?'resultSummaryMediaOne':'resultSummaryMedia', `${includedMedia} media ${includedMedia===1?'item':'items'} included`, [String(includedMedia)]));
        if (Number(media.skipped) > 0) parts.push(tr('resultSummarySkipped', `${media.skipped} skipped`, [String(media.skipped)]));
        if (Number(media.notSelected) > 0) parts.push(tr('resultSummaryNotSelected', `${media.notSelected} not selected`, [String(media.notSelected)]));
        if (Number(media.pending) > 0) parts.push(tr('resultSummaryPending', `${media.pending} pending`, [String(media.pending)]));
        if(value.oldestMessageDate&&value.newestMessageDate){
            const oldest=formatUiDateTime(value.oldestMessageDate);
            const newest=formatUiDateTime(value.newestMessageDate);
            if(oldest&&newest)parts.push(tr('resultSummaryRange',`Saved range: ${oldest} – ${newest}`,[oldest,newest]));
        }
        const reasons = Object.entries(media.skippedByReason || {})
            .filter(([, count]) => Number(count) > 0)
            .map(([reason, count]) => `${formatMediaReason(reason)}: ${count}`);
        if (reasons.length > 0) parts.push(tr('resultSummaryReasons', `Reasons: ${reasons.join(', ')}`, [reasons.join(', ')]));
        return parts.join(' · ');
    }

    function formatChatCoverage(stats) {
        const chats=Array.isArray(stats?.chatCoverage)?stats.chatCoverage:[];
        if(chats.length<=1)return '';
        const shown=chats.slice(0,4);
        const lines=[tr('resultCoverageTitle','Saved by chat:')];
        for(const chat of shown){
            const name=String(chat?.name||tr('unknownChat','Unknown chat'));
            const count=Number(chat?.messagesIncluded)||0;
            const oldest=formatUiDateTime(chat?.oldestMessageDate);
            const newest=formatUiDateTime(chat?.newestMessageDate);
            if(oldest&&newest){
                lines.push(tr(
                    count===1?'resultCoverageRowOne':'resultCoverageRow',
                    `${name} — ${count} ${count===1?'message':'messages'} · ${oldest} – ${newest}`,
                    [name,String(count),oldest,newest]
                ));
            }else{
                lines.push(tr(
                    count===1?'resultCoverageRowNoDateOne':'resultCoverageRowNoDate',
                    `${name} — ${count} ${count===1?'message':'messages'}`,
                    [name,String(count)]
                ));
            }
        }
        const remaining=chats.length-shown.length;
        if(remaining>0)lines.push(tr('resultCoverageMore',`…and ${remaining} more chats; see export-summary.json.`,[String(remaining)]));
        return lines.join('\n');
    }

    function formatCoverageTarget(stats) {
        const target=normalizeCoverageTargetDate(stats?.coverageTargetDate);
        if(!target)return null;
        const date=formatUiCalendarDate(target)||target;
        const chats=Array.isArray(stats?.chatCoverage)?stats.chatCoverage:[];
        const requested=Math.max(Number(stats?.chatsRequested)||0,chats.length);
        const reached=chats.filter(chat=>chat?.coverageTargetReached===true).length;
        if(stats?.coverageTargetReached===true){
            return {
                state:'reached',
                text:tr('resultTargetReached',`Saved range reaches ${date} in ${reached}/${requested} requested chats. This verifies the saved dates, not complete Telegram history.`,[date,String(reached),String(requested)])
            };
        }
        if(stats?.partial){
            return {
                state:'missed',
                text:tr('resultTargetStopped',`The export was stopped, so the saved range back to ${date} is not confirmed for every requested chat.`,[date])
            };
        }
        const missed=chats.filter(chat=>chat?.coverageTargetReached!==true).map(chat=>String(chat?.name||tr('unknownChat','Unknown chat')));
        if(missed.length>0){
            const shown=missed.slice(0,3);
            if(missed.length>shown.length)shown.push(`+${missed.length-shown.length}`);
            return {
                state:'missed',
                text:tr('resultTargetMissed',`Saved range does not reach ${date} in: ${shown.join(', ')}. Load older messages and export again.`,[date,shown.join(', ')])
            };
        }
        const unverified=Math.max(0,requested-chats.length);
        return {
            state:'missed',
            text:tr('resultTargetUnverified',`Saved range back to ${date} could not be verified for ${unverified} requested chats because they were skipped.`,[date,String(unverified)])
        };
    }

    function formatCoverageTargetStatus(stats) {
        const target=normalizeCoverageTargetDate(stats?.coverageTargetDate);
        if(!target)return null;
        const date=formatUiCalendarDate(target)||target;
        const chats=Array.isArray(stats?.chatCoverage)?stats.chatCoverage:[];
        const requested=Math.max(Number(stats?.chatsRequested)||0,chats.length);
        const reached=chats.filter(chat=>chat?.coverageTargetReached===true).length;
        if(stats?.coverageTargetReached===true){
            return {
                state:'reached',
                text:tr('resultTargetStatusReached',`History goal reached · ${date} · ${reached}/${requested} chats`,[date,String(reached),String(requested)])
            };
        }
        if(stats?.partial){
            return {
                state:'unknown',
                text:tr('resultTargetStatusUnknown',`History goal unknown · ${date}`,[date])
            };
        }
        return {
            state:'missed',
            text:tr('resultTargetStatusMissed',`History goal not reached · ${date} · ${reached}/${requested} chats`,[date,String(reached),String(requested)])
        };
    }

    function formatSkippedItemDetails(stats) {
        const media=stats?.media||{};
        const items=Array.isArray(media.skippedItems)?media.skippedItems:[];
        if(items.length===0)return '';
        const shown=items.slice(0,3);
        const lines=[tr('resultOmissionsTitle','Skipped items:')];
        for(const item of shown){
            const name=String(item?.name||'unnamed-media');
            const reason=formatMediaReason(item?.reason);
            if(Number(item?.actualBytes)>0&&Number(item?.limitBytes)>0){
                const actualBytes=Number(item.actualBytes);
                const limitBytes=Number(item.limitBytes);
                let actual=formatFileSize(actualBytes);
                let limit=formatFileSize(limitBytes);
                if(actual===limit&&actualBytes!==limitBytes){
                    actual+=' ('+actualBytes.toLocaleString()+' B)';
                    limit+=' ('+limitBytes.toLocaleString()+' B)';
                }
                lines.push(item.actualBytesExact===false
                    ?tr('resultOmissionAtLeast',`${name} — ${reason} (at least ${actual}; limit ${limit})`,[name,reason,actual,limit])
                    :tr('resultOmissionSize',`${name} — ${reason} (${actual} > ${limit})`,[name,reason,actual,limit]));
            }else{
                lines.push(tr('resultOmissionBasic',`${name} — ${reason}`,[name,reason]));
            }
        }
        const remaining=Math.max(0,items.length-shown.length)+(Number(media.skippedItemsTruncated)||0);
        if(remaining>0)lines.push(tr(remaining===1?'resultOmissionsMoreOne':'resultOmissionsMore',`…and ${remaining} more ${remaining===1?'item':'items'}; see export-summary.json.`,[String(remaining)]));
        return lines.join('\n');
    }

    async function monitorDownloadCompletion(receipt,surface) {
        if(!EXTENSION_MODE||!receipt?.filename||!receipt?.downloadId||!surface)return;
        const progress=surface.querySelector('#tgx-progress');
        const title=surface.querySelector('#tgx-progress-title');
        const primaryTitle=surface.querySelector('#tgx-result-primary strong');
        const simpleStatus=surface.querySelector('#tgx-progress-simple');
        if(!progress||!title||!primaryTitle)return;
        const applyState=(downloadState)=>{
            progress.dataset.downloadState=downloadState;
            if(downloadState==='complete'){
                title.textContent=tr('downloadCompleteTitle','Download complete');
                primaryTitle.textContent=tr('resultPrimaryDownloadedTitle','Saved ZIP checked locally · download complete');
                if(simpleStatus)simpleStatus.textContent=tr('downloadCompleteHint','ZIP downloaded · you can close this tab.');
            }else if(downloadState==='interrupted'){
                title.textContent=tr('downloadInterruptedTitle','ZIP created · Firefox download interrupted');
                primaryTitle.textContent=tr('resultPrimaryInterruptedTitle','ZIP checked locally · Firefox download interrupted');
                if(simpleStatus)simpleStatus.textContent=tr('downloadInterruptedHint','Download stopped · keep this tab open and try again.');
            }else if(downloadState==='unknown'){
                title.textContent=tr('downloadUnknownTitle','ZIP created · check Firefox Downloads');
                primaryTitle.textContent=tr('resultPrimaryDownloadUnknownTitle','ZIP checked locally · confirm the saved file in Firefox Downloads');
                if(simpleStatus)simpleStatus.textContent=tr('downloadUnknownHint','Check Firefox Downloads before closing this tab.');
            }else{
                title.textContent=tr('downloadSavingTitle','ZIP created · Firefox is saving it');
                primaryTitle.textContent=tr('resultPrimarySavingTitle','ZIP checked locally · Firefox is saving it');
                if(simpleStatus)simpleStatus.textContent=tr('downloadSavingHint','Firefox is saving the ZIP · keep this tab open.');
            }
        };
        applyState('saving');
        const deadline=Date.now()+15000;
        while(Date.now()<deadline&&state.lastOutcome==='complete'&&state.lastDownload===receipt){
            try{
                const response=await browser.runtime.sendMessage({
                    type:'telearchive.ui.download-status.v1',
                    requestId:String(receipt.requestId),artifactId:String(receipt.artifactId),
                    downloadId:Number(receipt.downloadId),filename:String(receipt.filename),size:Number(receipt.size)
                });
                if(response?.ok&&response.requestId===receipt.requestId&&response.found){
                    if(response.state==='complete'){applyState('complete');return;}
                    if(response.state==='interrupted'){applyState('interrupted');return;}
                    applyState('saving');
                }
            }catch(_){
                // Keep the honest saving state while Firefox registers the download.
            }
            await new Promise(resolve=>setTimeout(resolve,180));
        }
        if(state.lastOutcome==='complete'&&state.lastDownload===receipt)applyState('unknown');
    }

    function showComplete(message, receipt, stats) {
        if(state.quickMode){
            state.lastOutcome='complete';
            state.lastErrorCode=null;
            state.lastDownload=receipt||null;
            state.lastExportStats=stats?JSON.parse(JSON.stringify(stats)):snapshotExportStats();
            renderQuickComplete(receipt,state.lastExportStats);
            if(state.backgroundJobId&&!state.backgroundRemote){
                sendBackgroundProgress('complete',String(message||state.quickLabels?.saved||'Archive saved'),100,{receipt:receipt||undefined,stats:state.lastExportStats});
            }
            if(!state.dialog)return;
        }
        if(state.dialog){
            state.lastOutcome='complete';
            state.lastErrorCode=null;
            state.lastDownload=receipt||null;
            state.lastExportStats=stats ? JSON.parse(JSON.stringify(stats)) : snapshotExportStats();
            const completedBatch=state.lastExportStats?.batch;
            if(completedBatch&&Number(completedBatch.total)>1){
                state.completedBatchStats[String(Number(completedBatch.index)||0)]={
                    ...JSON.parse(JSON.stringify(state.lastExportStats)),
                    archiveFilename:String(receipt?.filename||'')
                };
                if(state.batchResume?.key){
                    const completedIndexes=new Set((state.batchResume.completedIndexes||[]).map(Number));
                    completedIndexes.add(Number(completedBatch.index)||0);
                    state.batchResume.completedIndexes=[...completedIndexes].sort((a,b)=>a-b);
                    state.batchResume.activeIndex=Math.min((Number(completedBatch.index)||0)+1,Math.max(0,(Number(completedBatch.total)||1)-1));
                    state.batchResume.completedBatchStats=JSON.parse(JSON.stringify(state.completedBatchStats||{}));
                    if(state.batchResume.completedIndexes.length>=Number(completedBatch.total)){
                        state.batchResume=null;
                        clearBatchResumeSession();
                    }else persistBatchResumeSession(state.batchResume);
                }
            }
            const surface=getDialogSurface();
            const p=surface?.querySelector('#tgx-progress');
            if(state.dialogRoot&&p){
                surface.querySelector('.tgx-modal')?.setAttribute('data-terminal','true');
                surface.querySelector('.tgx-aside')?.setAttribute('data-terminal','true');
                p.hidden=false;
                p.dataset.state='complete';
                const title=surface.querySelector('#tgx-progress-title');
                const copy=surface.querySelector('#tgx-progress-text');
                const simpleStatus=surface.querySelector('#tgx-progress-simple');
                const icon=surface.querySelector('#tgx-progress-icon');
                const bar=surface.querySelector('#tgx-progress-bar');
                const receiptPanel=surface.querySelector('#tgx-receipt');
                const resultFile=surface.querySelector('#tgx-result-file');
                const resultSize=surface.querySelector('#tgx-result-size');
                const resultProtection=surface.querySelector('#tgx-result-protection');
                const resultValidationRow=surface.querySelector('#tgx-result-validation-row');
                const resultValidation=surface.querySelector('#tgx-result-validation');
                const resultTargetRow=surface.querySelector('#tgx-result-target-row');
                const resultTargetStatus=surface.querySelector('#tgx-result-target-status');
                const resultSummary=surface.querySelector('#tgx-result-summary');
                const resultBatch=surface.querySelector('#tgx-result-batch');
                let resultNextBatch=surface.querySelector('#tgx-result-next-batch');
                if(!resultNextBatch&&resultBatch){
                    resultNextBatch=document.createElement('button');
                    resultNextBatch.type='button';
                    resultNextBatch.className='tgx-button tgx-button--step tgx-result-next-batch';
                    resultNextBatch.id='tgx-result-next-batch';
                    resultBatch.after(resultNextBatch);
                    resultNextBatch.addEventListener('click',()=>surface.querySelector('#tgx-export')?.click());
                }
                const resultTarget=surface.querySelector('#tgx-result-target');
                const resultCoverage=surface.querySelector('#tgx-result-coverage');
                const resultOmissions=surface.querySelector('#tgx-result-omissions');
                const resultNote=surface.querySelector('#tgx-result-note');
                const resultHelp=surface.querySelector('#tgx-result-help');
                const resultAesGuide=surface.querySelector('#tgx-result-aes-guide');
                const resultGuideTitle=surface.querySelector('#tgx-result-guide-title');
                const resultGuideBody=surface.querySelector('#tgx-result-guide-body');
                const resultGuideStepStart=surface.querySelector('#tgx-result-guide-step-start');
            const resultGuideStepPassword=surface.querySelector('#tgx-result-guide-step-password');
            const resultGuideStepExtract=surface.querySelector('#tgx-result-guide-step-extract');
            const resultGuideSources=surface.querySelector('#tgx-result-guide-sources');
                const resultPrimaryFile=surface.querySelector('#tgx-result-primary-file');
                const resultPrimarySummary=surface.querySelector('#tgx-result-primary-summary');
                let resultPrimaryMissing=surface.querySelector('#tgx-result-primary-missing');
                if(!resultPrimaryMissing&&resultPrimarySummary){
                    resultPrimaryMissing=document.createElement('span');
                    resultPrimaryMissing.id='tgx-result-primary-missing';
                    resultPrimaryMissing.className='tgx-result-primary-missing';
                    resultPrimarySummary.after(resultPrimaryMissing);
                }
                const resultPrimaryOmissions=surface.querySelector('#tgx-result-primary-omissions');
                const resultPrimaryNext=surface.querySelector('#tgx-result-primary-next');
                const resultReceiptActions=surface.querySelector('.tgx-receipt-actions');
                let resultOmissionAction=surface.querySelector('#tgx-result-omission-action');
                if(!resultOmissionAction&&(resultReceiptActions||resultPrimaryNext)){
                    resultOmissionAction=document.createElement('button');
                    resultOmissionAction.type='button';
                    resultOmissionAction.className='tgx-button tgx-button--receipt tgx-result-omission-action';
                    resultOmissionAction.id='tgx-result-omission-action';
                    if(resultReceiptActions)resultReceiptActions.prepend(resultOmissionAction);
                    else resultPrimaryNext.before(resultOmissionAction);
                }
                if(resultOmissionAction&&!resultOmissionAction.dataset.bound){
                    resultOmissionAction.dataset.bound='true';
                    resultOmissionAction.addEventListener('click',()=>{
                        const exportAction=surface.querySelector('#tgx-export');
                        if(exportAction){
                            exportAction.dataset.nextBatch='false';
                            exportAction.click();
                        }
                        const customize=surface.querySelector('#tgx-customize');
                        const customizeToggle=surface.querySelector('#tgx-customize-toggle');
                        if(customize)customize.open=true;
                        if(customizeToggle)customizeToggle.setAttribute('aria-expanded','true');
                        const moreMedia=surface.querySelector('#tgx-more-media');
                        if(moreMedia){
                            moreMedia.open=true;
                            moreMedia.scrollIntoView({block:'nearest',behavior:'smooth'});
                        }
                        surface.querySelectorAll('[data-omission-target="true"]').forEach((element)=>element.removeAttribute('data-omission-target'));
                        const targetSelector=resultOmissionAction.dataset.targetSelector||'#tgx-file-size';
                        const target=surface.querySelector(targetSelector)
                            ||surface.querySelector('#tgx-photos:not(:checked), #tgx-voice:not(:checked), #tgx-more-media input[type="checkbox"]:not(:checked), #tgx-photo-size, #tgx-video-size, #tgx-file-size');
                        if(target){
                            target.setAttribute('data-omission-target','true');
                            target.scrollIntoView({block:'center',behavior:'smooth'});
                            target.focus({preventScroll:true});
                        }
                    });
                }
                let resultReadableLimit=surface.querySelector('#tgx-result-readable-limit');
                if(!resultReadableLimit&&resultHelp){
                    resultReadableLimit=document.createElement('span');
                    resultReadableLimit.id='tgx-result-readable-limit';
                    resultReadableLimit.className='tgx-result-readable-limit';
                    resultHelp.after(resultReadableLimit);
                }
                const resultVerifyDownload=surface.querySelector('#tgx-verify-download');
                const action=surface.querySelector('#tgx-export');
                const cancel=surface.querySelector('#tgx-cancel');
                if(title)title.textContent=tr('completeTitle','ZIP created · Firefox is saving it');
                if(copy)copy.textContent=String(message||'');
                if(simpleStatus)simpleStatus.textContent=tr('downloadSavingHint','Firefox is saving the ZIP · keep this tab open.');
                if(icon)icon.textContent='✓';
                if(bar)bar.style.width='100%';
                p.setAttribute('role','status');
                p.removeAttribute('data-error-code');
                if(receiptPanel&&receipt){
                    receiptPanel.hidden=false;
                    if(resultFile)resultFile.textContent=receipt.filename||'';
                    if(resultSize)resultSize.textContent=formatFileSize(Number(receipt.size)||0);
                    if(resultProtection)resultProtection.textContent=state.lastExportStats?.archiveEncrypted
                        ?tr('resultProtectionAes','AES-256 password')
                        :tr('resultProtectionNone','No password');
                    const validation=receipt.validation;
                    if(resultValidationRow)resultValidationRow.hidden=!validation?.structureVerified;
                    if(resultValidation&&validation?.structureVerified){
                        const count=Number(validation.entryCount)||0;
                        resultValidation.textContent=validation.reportReadable
                            ?tr('resultValidationPassed',`Passed · ${count} files · report readable`,[String(count)])
                            :tr('resultValidationStructure',`Passed · ${count} files`,[String(count)]);
                    }
                    const targetStatus=formatCoverageTargetStatus(state.lastExportStats);
                    if(resultTargetRow)resultTargetRow.hidden=!targetStatus;
                    if(resultTargetStatus){
                        resultTargetStatus.textContent=targetStatus?.text||'';
                        if(targetStatus)resultTargetStatus.dataset.state=targetStatus.state;
                        else resultTargetStatus.removeAttribute('data-state');
                    }
                    if(resultSummary)resultSummary.textContent=formatExportSummary(state.lastExportStats);
                    const primaryStats=state.lastExportStats||{};
                    const primaryStatusParts=[];
                    if(primaryStats.partial)primaryStatusParts.push(tr('resultPrimaryStatusPartial','Partial archive'));
                    if(targetStatus?.state==='reached')primaryStatusParts.push(tr('resultPrimaryStatusReachedYes','Reached: yes'));
                    else if(targetStatus?.state==='unknown')primaryStatusParts.push(tr('resultPrimaryStatusReachedUnknown','Reached: unknown'));
                    else if(targetStatus?.state==='missed')primaryStatusParts.push(tr('resultPrimaryStatusReachedNo','Reached: no'));
                    const primaryBatch=primaryStats.batch;
                    if(primaryBatch&&Number(primaryBatch.total)>1){
                        const remaining=Math.max(0,Number(primaryBatch.total)-(Number(primaryBatch.index)+1));
                        if(remaining===0)primaryStatusParts.push(tr('resultPrimaryStatusBatchesComplete','All planned batches complete'));
                        else if(remaining===1)primaryStatusParts.push(tr('resultPrimaryStatusBatchRemaining','1 batch remaining'));
                        else primaryStatusParts.push(tr('resultPrimaryStatusBatchesRemaining',`${remaining} batches remaining`,[String(remaining)]));
                    }
                    const primarySummaryText=[formatExportSummary(primaryStats),...primaryStatusParts].filter(Boolean).join(' · ');
                    if(resultPrimaryMissing){
                        const includedChats=Number(primaryStats.chatsIncluded)||0;
                        const includedMessages=Number(primaryStats.messagesIncluded)||0;
                        const includedMedia=Number(primaryStats.media?.included)||0;
                        const includedLabel=`${includedChats} ${includedChats===1?'chat':'chats'} · ${includedMessages} ${includedMessages===1?'message':'messages'} · ${includedMedia} media`;
                        const missingParts=[];
                        if(primaryStats.partial)missingParts.push('content after stopping');
                        if(Number(primaryStats.media?.skipped)||0)missingParts.push(`${Number(primaryStats.media.skipped)} media omission${Number(primaryStats.media.skipped)===1?'':'s'}`);
                        if(Number(primaryStats.media?.pending)||0)missingParts.push(`${Number(primaryStats.media.pending)} media pending`);
                        missingParts.push('older messages not loaded in this tab');
                        resultPrimaryMissing.textContent=tr('resultPrimaryMissing','Scope: this Telegram tab only · exact saved range in Full receipt · not a complete Telegram backup',[includedLabel,missingParts.join(', ')]);
                    }
                    if(resultBatch){
                        const batch=state.lastExportStats?.batch;
                        if(batch&&Number(batch.total)>1){
                            const currentIndex=Number(batch.index)||0;
                            const completed=Math.min(Number(batch.total),Number(state.batchCompletedCount||0)+(Number(state.batchCompletedCount||0)>currentIndex?0:1));
                            const completedChats=Math.min(Number(batch.totalChats)||0,completed*CONFIG.maxChats);
                            const aggregateRecords=Object.values(state.completedBatchStats||{});
                            const aggregateTarget=aggregateRecords.find(item=>item?.coverageTargetDate)?.coverageTargetDate||state.lastExportStats?.coverageTargetDate||null;
                            const aggregateRequested=aggregateRecords.reduce((sum,item)=>sum+(Number(item?.chatsRequested)||0),0);
                            const aggregateReached=aggregateRecords.reduce((sum,item)=>sum+(Array.isArray(item?.chatCoverage)?item.chatCoverage.filter(chat=>chat?.coverageTargetReached===true).length:0),0);
                            const aggregateDate=aggregateTarget?formatUiCalendarDate(aggregateTarget):'';
                            const aggregateCoverage=aggregateDate&&aggregateRequested
                                ?` ${tr('batchAggregateCoverage',`Date goal: ${aggregateReached}/${aggregateRequested} chats reached ${aggregateDate}.`,[String(aggregateReached),String(aggregateRequested),aggregateDate])}`
                                :'';
                            resultBatch.hidden=false;
                            resultBatch.dataset.completed=String(completed);
                            resultBatch.dataset.total=String(batch.total);
                            resultBatch.textContent=completed===Number(batch.total)
                                ?`${tr('batchProgressComplete',`All ${batch.total} batches complete · ${batch.totalChats} chats archived.`,[String(batch.total),String(batch.totalChats)])}${aggregateCoverage}`
                                :tr(state.batchRunAll?'batchResultQueued': 'batchResultProgress',state.batchRunAll
                                    ?`Batch ${currentIndex+1} complete · ${completed} of ${batch.total} batches · ${completedChats} of ${batch.totalChats} chats archived. Continue to the next verified batch; all remaining batches are queued.`
                                    :`Batch ${currentIndex+1} complete · ${completed} of ${batch.total} batches · ${completedChats} of ${batch.totalChats} chats archived. Continue with the next verified batch below.`,[String(currentIndex+1),String(completed),String(batch.total),String(completedChats),String(batch.totalChats)])+aggregateCoverage;
                        }else{
                            resultBatch.hidden=true;
                            resultBatch.textContent='';
                            resultBatch.removeAttribute('data-completed');
                            resultBatch.removeAttribute('data-total');
                        }
                    }
                    if(resultTarget){
                        const targetResult=formatCoverageTarget(state.lastExportStats);
                        resultTarget.textContent=targetResult?.text||'';
                        resultTarget.hidden=!targetResult;
                        if(targetResult)resultTarget.dataset.state=targetResult.state;
                        else resultTarget.removeAttribute('data-state');
                    }
                    if(resultCoverage){
                        const coverageText=formatChatCoverage(state.lastExportStats);
                        resultCoverage.textContent=coverageText;
                        resultCoverage.hidden=!coverageText;
                    }
                    const skippedMediaItems=Array.isArray(state.lastExportStats?.media?.skippedItems)
                        ?state.lastExportStats.media.skippedItems
                        :[];
                    const firstSkippedMedia=skippedMediaItems[0]||null;
                    const skippedRawName=String(firstSkippedMedia?.name||'');
                    const skippedDisplayName=skippedRawName.replace(/^[^@]+@\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}_/u,'')||skippedRawName;
                    const skippedType=String(firstSkippedMedia?.type||'file');
                    const skippedTypeLabel=skippedType==='photo'
                        ?tr('mediaPhotos','Photos')
                        :['video_file','video_message','animation'].includes(skippedType)
                            ?tr('mediaVideos','Videos and GIFs')
                            :skippedType==='voice_message'
                                ?tr('mediaVoice','Voice messages')
                                :skippedType==='sticker'
                                    ?tr('mediaStickers','Stickers')
                                    :tr('mediaFiles','Files');
                    const skippedTargetSelector=skippedType==='photo'
                        ?'#tgx-photo-size'
                        :['video_file','video_message','animation'].includes(skippedType)
                            ?'#tgx-video-size'
                            :'#tgx-file-size';
                    const skippedActual=Number(firstSkippedMedia?.actualBytes)>0?formatFileSize(Number(firstSkippedMedia.actualBytes)):'';
                    const skippedLimit=Number(firstSkippedMedia?.limitBytes)>0?formatFileSize(Number(firstSkippedMedia.limitBytes)):'';
                    if(resultOmissions){
                        const omissionText=formatSkippedItemDetails(state.lastExportStats);
                        resultOmissions.textContent=omissionText;
                        resultOmissions.hidden=!omissionText;
                        const exactOmission=firstSkippedMedia&&skippedActual&&skippedLimit
                            ?tr('resultPrimaryOmissionExact',`Skipped: ${skippedDisplayName} · ${skippedTypeLabel} · ${skippedActual} exceeds the ${skippedLimit} limit · message ${String(firstSkippedMedia.messageId||'—')} in ${String(firstSkippedMedia.chat||'this chat')}`,[skippedDisplayName,skippedTypeLabel,skippedActual,skippedLimit,String(firstSkippedMedia.messageId||'—'),String(firstSkippedMedia.chat||'this chat')])
                            :'';
                        const firstOmissionDetail=omissionText.split('\n').find((line)=>line.includes(' — '))||'';
                        if(resultPrimaryOmissions)resultPrimaryOmissions.textContent=exactOmission
                            ||(firstOmissionDetail
                                ?tr('resultPrimaryOmissionSpecific',`Skipped: ${firstOmissionDetail}`,[firstOmissionDetail])
                                :'')
                            ||(omissionText
                                ?tr('resultPrimaryOmissions','Some items were omitted; see full receipt details below.')
                                :tr('resultPrimaryNoOmissions','No item omissions were recorded.'));
                    }
                    if(resultPrimaryFile)resultPrimaryFile.textContent=tr('resultPrimaryFile',`File: ${receipt.filename||''}`,[receipt.filename||'']);
                    if(resultPrimarySummary)resultPrimarySummary.textContent=primarySummaryText;
                    if(resultHelp)resultHelp.textContent=state.lastExportStats?.archiveEncrypted
                        ?tr('resultOpenHelpEncrypted','Verify this AES ZIP below by re-entering the password, then open it with PeaZip or 7-Zip and open messages.html.')
                        :tr('resultOpenHelp','Verify the downloaded ZIP below, then extract it and open messages.html. Keep result.json for reusable data.');
                    const encrypted=Boolean(state.lastExportStats?.archiveEncrypted);
                    if(resultAesGuide)resultAesGuide.hidden=false;
                    if(resultGuideTitle)resultGuideTitle.textContent=encrypted
                        ?tr('resultAesGuideTitle','Next: open this protected ZIP')
                        :tr('resultOpenGuideTitle','Next: open this ZIP in Firefox');
                    if(resultGuideBody)resultGuideBody.textContent=encrypted
                        ?tr('resultAesGuideBody','The archive is ready. Open it with PeaZip or 7-Zip; Firefox can open messages.html after extraction.')
                        :tr('resultOpenGuideBody','No password is required. Verify it below, then open the downloaded ZIP in Firefox or any archive app and open messages.html. Keep result.json for reusable data.');
                    if(resultGuideStepStart)resultGuideStepStart.textContent=encrypted
                        ?tr('resultAesGuideStepStart','Open the downloaded ZIP in PeaZip or 7-Zip.')
                        :tr('resultOpenGuideStepOpen','Open the downloaded ZIP in Firefox or any archive app — no password is required.');
                    if(resultGuideStepPassword)resultGuideStepPassword.textContent=encrypted
                        ?tr('aesHelpStepPassword','Enter the password you saved before export.')
                        :tr('resultOpenGuideStepHtml','Open messages.html in Firefox.');
                    if(resultGuideStepExtract)resultGuideStepExtract.textContent=encrypted
                        ?tr('aesHelpStepExtract','Extract the folder, then open messages.html in Firefox; keep result.json for reusable data.')
                        :tr('resultOpenGuideStepJson','Keep result.json for reusable data.');
                    if(resultGuideSources)resultGuideSources.hidden=!encrypted;
                    if(resultPrimaryNext){
                        const partialResult=Boolean(state.lastExportStats?.partial);
                        const omittedMediaCount=Number(state.lastExportStats?.media?.skipped||0)
                            +Number(state.lastExportStats?.media?.pending||0);
                        const omittedMedia=omittedMediaCount>0;
                        if(resultOmissionAction){
                            resultOmissionAction.hidden=!omittedMedia;
                            resultOmissionAction.disabled=!omittedMedia;
                            const exactRecovery=omittedMediaCount===1&&firstSkippedMedia?.reason==='size_limit'&&skippedActual&&skippedLimit;
                            resultOmissionAction.textContent=exactRecovery
                                ?tr('resultOmissionActionExact',`Fix ${skippedDisplayName}: open ${skippedTypeLabel} limit (${skippedLimit} → at least ${skippedActual})`,[skippedDisplayName,skippedTypeLabel,skippedLimit,skippedActual])
                                :omittedMediaCount===1
                                    ?tr('resultOmissionActionOne','Review 1 skipped media item → change limit → re-export')
                                    :tr('resultOmissionActionMany',`Review ${omittedMediaCount} skipped media items → change limit → re-export`,[String(omittedMediaCount)]);
                            resultOmissionAction.dataset.targetSelector=skippedTargetSelector;
                            resultOmissionAction.dataset.exact=String(Boolean(exactRecovery));
                            resultOmissionAction.setAttribute('aria-controls','tgx-more-media');
                        }
                        const multiChatResult=String(primaryStats.scopeMode||'current')!=='current';
                        const exactRecovery=omittedMediaCount===1&&firstSkippedMedia?.reason==='size_limit'&&skippedActual&&skippedLimit;
                        resultPrimaryNext.textContent=partialResult
                            ?multiChatResult
                                ?tr('resultPrimaryNextPartialMulti','Next: verify this partial ZIP, then reopen the incomplete chat and export it again; remaining chats stay pending.')
                                :tr('resultPrimaryNextPartial','Next: return to this chat, load more history, and export again; this ZIP keeps only messages collected before Stop.')
                            :multiChatResult
                                ?primaryBatch&&Number(primaryBatch.total)>1&&Number(primaryBatch.index)<Number(primaryBatch.total)-1
                                    ?exactRecovery
                                        ?tr('resultPrimaryNextBatchOmissionExact',`Recovery for this batch: increase the highlighted ${skippedTypeLabel} limit from ${skippedLimit} to at least ${skippedActual} → Create another archive → Verify the new ZIP. Or keep this omission and continue with the next batch, “${String(primaryBatch.nextChatName||'the first chat in the next batch')}”.`,[skippedTypeLabel,skippedLimit,skippedActual,String(primaryBatch.nextChatName||'the first chat in the next batch')])
                                        :tr(omittedMedia?'resultPrimaryNextBatchOmissions':'resultPrimaryNextBatch',`Next: verify this ZIP, then switch Telegram to “${String(primaryBatch.nextChatName||'the first chat in the next batch')}” and continue with the next batch.`,[String(primaryBatch.nextChatName||'the first chat in the next batch')])
                                    :primaryBatch&&Number(primaryBatch.total)>1
                                        ?exactRecovery
                                            ?tr('resultPrimaryNextSelectedOmissionExact',`Recovery: increase the highlighted ${skippedTypeLabel} limit from ${skippedLimit} to at least ${skippedActual} → Create another archive → Verify the new ZIP. All selected chats and other included items are already in this ZIP.`,[skippedTypeLabel,skippedLimit,skippedActual])
                                            :tr(omittedMedia?'resultPrimaryNextBatchesCompleteOmissions':'resultPrimaryNextBatchesComplete','Next: verify this ZIP; all planned batches are complete.')
                                        :exactRecovery
                                            ?tr('resultPrimaryNextSelectedOmissionExact',`Recovery: increase the highlighted ${skippedTypeLabel} limit from ${skippedLimit} to at least ${skippedActual} → Create another archive → Verify the new ZIP. All selected chats and other included items are already in this ZIP.`,[skippedTypeLabel,skippedLimit,skippedActual])
                                            :tr(omittedMedia?'resultPrimaryNextSelectedOmissions':'resultPrimaryNextSelected','Next: verify this ZIP; all selected chats are already in this archive.')
                                :exactRecovery
                                    ?tr('resultPrimaryNextOmissionExact',`Next: increase the highlighted ${skippedTypeLabel} limit from ${skippedLimit} to at least ${skippedActual}, then click Create another. This ZIP already contains all text and other included media.`,[skippedTypeLabel,skippedLimit,skippedActual])
                                :omittedMedia
                                    ?tr('resultPrimaryNextOmissions','Next: raise the per-file limit or enable the media type, then export again; text and included media are already saved.')
                                :encrypted
                                    ?tr('resultPrimaryNextAes','Next: verify the ZIP with your password, then open it with PeaZip or 7-Zip.')
                                    :tr('resultPrimaryNextNone','Next: verify the downloaded ZIP, then open messages.html in Firefox.');
                    }
                    if(resultReadableLimit)resultReadableLimit.textContent=tr('resultReadableLimit','Built-in verifier limit: 512 MB of readable HTML/JSON. Larger ZIPs remain valid; open them with PeaZip or 7-Zip.');
                    if(resultNote){
                        const partial=Boolean(state.lastExportStats?.partial);
                        const notes=[];
                        if(partial)notes.push(tr('resultSummaryPartial','Partial archive: only content collected before stopping was saved.'));
                        const historyLoad=primaryStats.historyLoad||{};
                        notes.push(historyLoad.edgeReached===true
                            ?tr('resultSummaryHistoryReached','History scan reached Telegram’s oldest available point in this tab. This is not a complete account backup.')
                            :tr('resultSummaryRendered','This is not a complete Telegram backup. Local Archive saved the messages it could load in this tab; older messages remain outside this ZIP if Telegram did not reach them.'));
                        resultNote.textContent=notes.join(' ');
                        resultNote.dataset.partial=String(partial);
                    }
                }
                clearArchivePassword(surface,true);
                if(resultVerifyDownload)resultVerifyDownload.hidden=!EXTENSION_MODE;
                if(action){
                    const batch=state.lastExportStats?.batch;
                    const canAdvance=Boolean(
                        batch
                        &&Number(batch.total)>1
                        &&Number(batch.index)<Number(batch.total)-1
                        &&state.lastExportStats?.partial!==true
                        &&Number(state.lastExportStats?.chatsRequested)>0
                        &&Number(state.lastExportStats?.chatsIncluded)===Number(state.lastExportStats?.chatsRequested)
                        &&Number(state.lastExportStats?.chatsSkipped)===0
                    );
                    action.hidden=false;
                    action.disabled=false;
                    if(canAdvance){
                        action.removeAttribute('data-terminal-secondary');
                        action.dataset.nextBatch='true';
                        const nextChatName=String(batch.nextChatName||'the first chat in the next batch');
                        action.textContent=tr('batchNextActionHandoff',`Continue to batch ${Number(batch.index)+2} of ${batch.total}: open “${nextChatName}”, create and verify its ZIP`,[String(Number(batch.index)+2),String(batch.total),nextChatName]);
                    }else{
                        action.removeAttribute('data-next-batch');
                        action.dataset.terminalSecondary='true';
                        action.textContent=tr('createAnother','Create another');
                    }
                    if(resultNextBatch){
                        resultNextBatch.hidden=!canAdvance;
                        resultNextBatch.disabled=!canAdvance;
                        if(canAdvance){
                            const nextChatName=String(batch.nextChatName||'the first chat in the next batch');
                            resultNextBatch.textContent=tr('batchNextActionHandoff',`Continue to batch ${Number(batch.index)+2} of ${batch.total}: open “${nextChatName}”, create and verify its ZIP`,[String(Number(batch.index)+2),String(batch.total),nextChatName]);
                        }
                    }
                }
                if(cancel)cancel.textContent=tr('close','Close');
                void monitorDownloadCompletion(receipt,surface);
                return;
            }
            if(p){p.style.display='block';p.textContent='✓ '+String(message||'');}
            setTimeout(()=>{if(state.dialog&&!state.isExporting)closeDialog();},5000);
        }
    }
    function describeExportError(error) {
        const code=String(error?.code||'unexpected');
        if(code==='empty-range')return {code,message:state.quickLabels?.emptyRange||tr('errorNoMessages','No messages were found in the selected range.')};
        if(code==='invalid-request')return {code,message:String(error?.message||tr('errorExportRequest','The export settings are invalid.'))};
        if(code==='invalid-transition')return {code,message:tr('errorExportState','The export entered an invalid state. Reload Telegram Web and retry.')};
        if(code==='archive-service-unavailable')return {code,message:tr('errorArchiveService','The local archive process did not start. Reload Telegram Web and try again.')};
        if(code==='invalid-entry')return {code,message:tr('errorArchiveEntry','One item could not be added safely. Try again without media; if it repeats, report the problem.')};
        if(code==='archive-engine-failed')return {code,message:tr('errorArchiveEngine','Firefox could not finish the ZIP. Try text only or lower media limits, then retry.')};
        return {code,message:tr('errorExportSafe','No ZIP was saved. Your Telegram data was not changed. Retry, or reopen Telegram Web if the problem repeats.')};
    }
    function showError(message, code='unexpected') {
        if(state.quickMode){
            state.lastOutcome='error';
            state.lastErrorCode=code;
            renderQuickError(message,code);
            if(state.backgroundJobId&&!state.backgroundRemote){
                sendBackgroundProgress('error',String(message||'Export failed.'),100,{errorCode:String(code||'unexpected')});
            }
            if(!state.dialog)return;
        }
        if(state.dialog){
            setDefaultArchiveProtection();
            state.lastOutcome='error';
            state.lastErrorCode=String(code||'unexpected');
            const surface=getDialogSurface();
            const p=surface?.querySelector('#tgx-progress');
            if(state.dialogRoot&&p){
                surface.querySelector('.tgx-modal')?.removeAttribute('data-terminal');
                surface.querySelector('.tgx-aside')?.setAttribute('data-terminal','true');
                p.hidden=false;
                p.dataset.state='error';
                const title=surface.querySelector('#tgx-progress-title');
                const copy=surface.querySelector('#tgx-progress-text');
                const simpleStatus=surface.querySelector('#tgx-progress-simple');
                const icon=surface.querySelector('#tgx-progress-icon');
                const bar=surface.querySelector('#tgx-progress-bar');
                const receipt=surface.querySelector('#tgx-receipt');
                const resultSummary=surface.querySelector('#tgx-result-summary');
                const resultNote=surface.querySelector('#tgx-result-note');
                const resultAesGuide=surface.querySelector('#tgx-result-aes-guide');
                const action=surface.querySelector('#tgx-export');
                const cancel=surface.querySelector('#tgx-cancel');
                if(title)title.textContent=tr('errorTitle','Export stopped');
                if(copy)copy.textContent=String(message||'');
                if(simpleStatus)simpleStatus.textContent='';
                if(icon)icon.textContent='!';
                if(bar)bar.style.width='0%';
                if(receipt)receipt.hidden=true;
                if(resultAesGuide)resultAesGuide.hidden=true;
                if(resultSummary)resultSummary.textContent='';
                if(resultNote){resultNote.textContent='';resultNote.removeAttribute('data-partial');}
                p.setAttribute('role','alert');
                p.dataset.errorCode=state.lastErrorCode;
                if(action){action.hidden=false;action.disabled=false;action.removeAttribute('data-terminal-secondary');action.textContent=tr('retryExport','Try again');}
                if(cancel)cancel.textContent=tr('close','Close');
                return;
            }
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
    async function buildExportZip(messages, chatInfo, isMultiChat, chatIndex, existingZip, archiveRequestId=null) {
        if(typeof JSZip==='undefined') {
            await new Promise(r=>setTimeout(r,2000));
            if(typeof JSZip==='undefined') throw new Error(tr('errorZipUnavailable','The archive library did not load. Reload Telegram Web and try again.'));
        }
        if(!state.formatHtml&&!state.formatJson) throw new Error(tr('validationOneFormat','Select HTML, JSON, or both.'));
        recordMessageRange(messages);
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
            const nativeMediaRef=typeof msg._telegram_media_ref==='string'&&/^-?\d+:-?\d+:\d+$/u.test(msg._telegram_media_ref)
                ?msg._telegram_media_ref
                :'';
            const normalizedPhoto=msg.photo?normalizeMediaUrl(msg.photo):'';
            const normalizedFile=msg.file?normalizeMediaUrl(msg.file):'';
            if(msg.photo&&normalizedPhoto){
                mediaType='photo'; sourceUrl=normalizedPhoto;
            } else if(msg.file&&normalizedFile){
                mediaType=msg.media_type||'file'; sourceUrl=normalizedFile; sourceName=msg.file_name||'file';
            }
            if(!sourceUrl&&nativeMediaRef&&typeof NATIVE_HISTORY?.downloadMedia==='function'){
                mediaType=msg.media_type||'file';
                sourceName=msg.media_file_name||'file';
            }
            if(!sourceUrl&&!nativeMediaRef){
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
            recordMediaDiscovery(mediaType, enabled);
            if(!enabled) continue;

            const maxBytes=mediaLimitForType(mediaType);
            if(mediaType==='photo'){
                photoCount++;
                const photoExt=getFileExtension(sourceUrl,'photo');
                const fn=makeMediaFilename('photo',photoCount,msg,photoExt==='bin'?'jpg':photoExt);
                const rel='photos/'+fn;
                queueMedia(async()=>{
                    const result=await downloadAndAddMedia(zip,prefix+'photos/',fn,sourceUrl,{maxBytes,mediaType,messageId:msg.id,nativeMediaRef});
                    if(result.ok){msg.photo=rel;msg.photo_file_size=result.size;}
                });
                const thumbName=fn.replace(/\.[^.]+$/i,'_thumb.jpg');
                queueMedia(async()=>{ await downloadAndAddMedia(zip,prefix+'photos/',thumbName,sourceUrl,{maxBytes,isThumb:true,messageId:msg.id,nativeMediaRef}); });
                delete msg.file; delete msg.file_name; delete msg.file_size; delete msg.media_type; delete msg.thumbnail;
            } else if(mediaType==='video_file'||mediaType==='animation'){
                videoCount++;
                const ext=getFileExtension(sourceUrl,mediaType);
                const fn=makeMediaFilename(mediaType,videoCount,msg,ext);
                const folder=mediaType==='video_file'?'video_files/':'animations/';
                queueMedia(async()=>{
                    const result=await downloadAndAddMedia(zip,prefix+folder,fn,sourceUrl,{maxBytes,mediaType,messageId:msg.id,nativeMediaRef});
                    if(result.ok){msg.file=folder+fn;msg.file_name=fn;msg.file_size=result.size;if(result.mime)msg.mime_type=result.mime;}
                });
                if(thumbnailSource){
                    const thumbName=fn+'_thumb.jpg';
                    queueMedia(async()=>{
                        const result=await downloadAndAddMedia(zip,prefix+folder,thumbName,thumbnailSource,{maxBytes:state.maxPhotoSize,isThumb:true,messageId:msg.id});
                        if(result.ok){msg.thumbnail=folder+thumbName;msg.thumbnail_file_size=result.size;}
                    });
                }
            } else if(mediaType==='voice_message'){
                voiceCount++;
                const ext=getFileExtension(sourceUrl,mediaType);
                const fn=makeMediaFilename('audio',voiceCount,msg,ext);
                queueMedia(async()=>{
                    const result=await downloadAndAddMedia(zip,prefix+'voice_messages/',fn,sourceUrl,{maxBytes,mediaType,messageId:msg.id,nativeMediaRef});
                    if(result.ok){msg.file='voice_messages/'+fn;msg.file_name=fn;msg.file_size=result.size;if(result.mime)msg.mime_type=result.mime;}
                });
            } else if(mediaType==='sticker'){
                stickerCount++;
                const ext=getFileExtension(sourceUrl,mediaType);
                const fn=sanitizeFilename('sticker_'+stickerCount+'.'+ext);
                queueMedia(async()=>{
                    const result=await downloadAndAddMedia(zip,prefix+'stickers/',fn,sourceUrl,{maxBytes,mediaType,messageId:msg.id,nativeMediaRef});
                    if(result.ok){msg.file='stickers/'+fn;msg.file_name=fn;msg.file_size=result.size;if(result.mime)msg.mime_type=result.mime;}
                });
            } else if(mediaType==='video_message'){
                videoMsgCount++;
                const ext=getFileExtension(sourceUrl,mediaType);
                const fn=makeMediaFilename('video',videoMsgCount,msg,ext);
                queueMedia(async()=>{
                    const result=await downloadAndAddMedia(zip,prefix+'video_message_files/',fn,sourceUrl,{maxBytes,mediaType,messageId:msg.id,nativeMediaRef});
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
                    const result=await downloadAndAddMedia(zip,prefix+'files/',fn,sourceUrl,{maxBytes,mediaType,messageId:msg.id,nativeMediaRef});
                    if(result.ok){msg.file='files/'+fn;msg.file_name=fn;msg.file_size=result.size;if(result.mime)msg.mime_type=result.mime;}
                });
                delete msg.media_type;
            }
        }

        const total=mediaTasks.length;
        let done=0;
        if(total>0) updateProgress(tr('statusDownloadingMedia','Saving media… 0 of '+total,['0',String(total)]),0);
        let next=0;
        async function worker(){
            while(!state.cancelled){
                const idx=next++;
                if(idx>=total) return;
                try{await mediaTasks[idx]();}catch(e){log('Media task failed:',e?.message||e);}
                done++;
                updateProgress(tr('statusDownloadingMedia','Saving media… '+done+' of '+total,[String(done),String(total)]),Math.round(done/total*100));
            }
        }
        const workers=Array.from({length:Math.min(CONFIG.mediaConcurrency,total)},()=>worker());
        await Promise.all(workers);

        // Build outputs only after media URLs have been converted to local paths.
        for(const msg of messages) delete msg._telegram_media_ref;
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

        if(!existingZip) addExportSummary(zip);
        state.downloadedMedia.clear();
        if(existingZip) return;
        updateProgress(tr('statusBuilding','Building the archive…'),90);
        return await zip.generateAsync({
            type:'blob',
            requestId:archiveRequestId||undefined,
            compression:'DEFLATE',
            password:state.archivePassword||undefined,
            compressionOptions:{level:6}
        });
    }

    function addExportSummary(zip) {
        const summary=snapshotExportStats();
        state.lastExportStats=summary;
        zip.file('export-summary.json',JSON.stringify(summary,null,2));
        return summary;
    }

    async function fetchMediaBlob(url,maxBytes,options={}) {
        const nativeMediaRef=typeof options.nativeMediaRef==='string'&&options.nativeMediaRef?options.nativeMediaRef:'';
        const normalized=nativeMediaRef?'':normalizeMediaUrl(url);
        if(!normalized&&!nativeMediaRef) throw new Error('Blocked unsafe media URL');
        const cacheKey=(nativeMediaRef?'telegram-native:'+nativeMediaRef:normalized)+'|'+String(maxBytes||0);
        if(state.downloadedMedia.has(cacheKey)) return await state.downloadedMedia.get(cacheKey);

        const promise=(async()=>{
            const controller=new AbortController();
            state.activeControllers.add(controller);
            const timer=setTimeout(()=>controller.abort(),CONFIG.mediaFetchTimeoutMs);
            try{
                if(nativeMediaRef){
                    if(typeof NATIVE_HISTORY?.downloadMedia!=='function') throw new Error('Telegram Web media manager is unavailable.');
                    return await NATIVE_HISTORY.downloadMedia(nativeMediaRef,{maxBytes:maxBytes||0,signal:controller.signal});
                }
                let credentials='omit';
                if(normalized.startsWith(location.origin+'/')) credentials='same-origin';
                const resp=await fetch(normalized,{mode:'cors',credentials,signal:controller.signal,cache:'no-store',referrerPolicy:'no-referrer'});
                if(!resp.ok) throw new Error('HTTP '+resp.status);
                const declared=Number(resp.headers.get('content-length'))||0;
                if(maxBytes&&declared>maxBytes) throw createMediaSizeError(declared,maxBytes);
                const mime=(resp.headers.get('content-type')||'').split(';')[0].trim();
                if(normalized.startsWith('blob:')){
                    const blob=await resp.blob();
                    if(maxBytes&&blob.size>maxBytes)throw createMediaSizeError(blob.size,maxBytes);
                    return blob;
                }
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
                            throw createMediaSizeError(total,maxBytes,false);
                        }
                        chunks.push(value);
                    }
                    return new Blob(chunks,{type:mime||'application/octet-stream'});
                }
                const blob=await resp.blob();
                if(maxBytes&&blob.size>maxBytes) throw createMediaSizeError(blob.size,maxBytes);
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
        const safeName=sanitizeFilename(filename);
        if(state.cancelled){
            recordMediaSkipped(options.mediaType, 'cancelled', {
                thumbnail:Boolean(options.isThumb),name:safeName,limitBytes:options.maxBytes,messageId:options.messageId,chat:state.chatName
            });
            return {ok:false,cancelled:true,reason:'cancelled'};
        }
        try{
            const blob=await fetchMediaBlob(url,options.maxBytes||0,options);
            const payload=options.isThumb?(await makeImageThumbnail(blob)):blob;
            if(!payload){
                recordMediaSkipped(options.mediaType, 'thumbnail_unavailable', {
                    thumbnail:Boolean(options.isThumb),name:safeName,limitBytes:options.maxBytes,messageId:options.messageId,chat:state.chatName
                });
                return {ok:false,reason:'thumbnail-unavailable'};
            }
            zip.file(folder+safeName,payload);
            if(!options.isThumb) recordMediaIncluded(options.mediaType);
            return {ok:true,size:payload.size,mime:payload.type||blob.type||''};
        } catch(e) {
            recordMediaSkipped(options.mediaType, mediaSkipReason(e), {
                thumbnail:Boolean(options.isThumb),name:safeName,actualBytes:e?.actualBytes,actualBytesExact:e?.actualBytesExact!==false,limitBytes:e?.limitBytes||options.maxBytes,messageId:options.messageId,chat:state.chatName
            });
            log('Media skipped: '+safeName+' — '+(e?.message||e));
            return {ok:false,error:e,reason:mediaSkipReason(e)};
        }
    }

    /* ================================================================
       JSON BUILDER
       ================================================================ */
    function buildResultJson(messages, chatInfo, isMultiChat, statsOverride=null) {
        const exportStats=statsOverride
            ?JSON.parse(JSON.stringify(statsOverride))
            :snapshotExportStats();
        const localRange=getMessageRange(messages);
        const oldestCalendarDate=getOldestMessageCalendarDate(messages);
        const coverageTargetDate=normalizeCoverageTargetDate(exportStats.coverageTargetDate)||null;
        const telearchive={
            format_version:'1.1',
            history_source:exportStats.historySource||'rendered-telegram-web',
            complete_history_not_guaranteed:exportStats.completeHistoryNotGuaranteed!==false,
            history_complete:exportStats.historyComplete===true,
            content_uploaded:false,
            archive_encrypted:Boolean(exportStats.archiveEncrypted),
            encryption:exportStats.archiveEncrypted?'AES-256':null,
            requested_range:exportStats.requestedRange||normalizeExportRange(state.exportRange),
            range_messages_included:Number(exportStats.rangeMessagesIncluded)||messages.length,
            history_load:exportStats.historyLoad||null,
            coverage_target_date:coverageTargetDate,
            coverage_target_reached:coverageTargetDate?coverageTargetReachedForMessages(messages,coverageTargetDate):null,
            oldest_message_calendar_date:oldestCalendarDate||null,
            oldest_message_date:localRange.oldestMessageDate,
            newest_message_date:localRange.newestMessageDate,
            partial:Boolean(exportStats.partial),
            scope_mode:exportStats.scopeMode||state.exportMode,
            scope_label:exportStats.scopeLabel||chatInfo.name||'',
            batch:exportStats.batch?{
                index:Number(exportStats.batch.index)+1,
                total:Number(exportStats.batch.total),
                selected_total:Number(exportStats.batch.totalChats),
                range_start:Number(exportStats.batch.start),
                range_end:Number(exportStats.batch.end),
                chats_in_batch:Number(exportStats.batch.size)
            }:null,
            messages_in_this_chat:messages.length,
            media:exportStats.media||createExportStats().media
        };
        if(isMultiChat){
            return {
                telearchive,
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
            telearchive,
            name:chatInfo.name,
            type:chatInfo.type||'personal_chat',
            id:chatInfo.id||0,
            messages:messages
        };
    }

    function stripPrivatePreflightMedia(message) {
        const clean=JSON.parse(JSON.stringify(message));
        for(const key of [
            'photo','file','thumbnail','_thumbnail_source','file_name','file_size',
            'photo_file_size','thumbnail_file_size','media_type','mime_type','width','height','_telegram_media_ref'
        ]) delete clean[key];
        return clean;
    }

    function comparePrivatePreflightMessages(left,right) {
        const leftTime=Number(left?.date_unixtime)||0;
        const rightTime=Number(right?.date_unixtime)||0;
        return leftTime-rightTime||(Number(left?.id)||0)-(Number(right?.id)||0);
    }

    function limitPrivatePreflightMessages(messages,limit=10) {
        const ordered=[...messages].sort(comparePrivatePreflightMessages);
        if(limit<=1)return ordered.slice(0,1);
        if(ordered.length<=limit)return ordered;
        const oldestCount=Math.ceil(limit/2);
        const newestCount=limit-oldestCount;
        const chosen=[...ordered.slice(0,oldestCount),...ordered.slice(-newestCount)];
        return [...new Map(chosen.map(message=>[message.id,message])).values()].sort(comparePrivatePreflightMessages);
    }

    async function collectPrivatePreflightSample(limit=10) {
        const container=findScrollContainer();
        if(!container)throw new Error('message list unavailable');
        const originalTop=Number(container.scrollTop)||0;
        const collected=new Map();
        const traversedDirections=[];
        const settleMs=Math.min(1200,Math.max(250,Number(CONFIG.scrollWaitMs)||800));
        const collectCurrent=()=>{
            for(const element of Array.from(getMessageElements())){
                try{
                    const message=extractMessage(element,true);
                    if(message)collected.set(message.id,stripPrivatePreflightMedia(message));
                }catch(error){
                    log('Private preflight sample skipped one element:',error?.message||error);
                }
            }
        };
        const visit=async(direction,target)=>{
            const before=Number(container.scrollTop)||0;
            container.scrollTop=target;
            await sleep(60);
            if(Math.abs((Number(container.scrollTop)||0)-before)<=1)return false;
            traversedDirections.push(direction);
            await sleep(settleMs);
            collectCurrent();
            return true;
        };

        collectCurrent();
        const maxTop=Math.max(0,Number(container.scrollHeight||0)-Number(container.clientHeight||0));
        await visit('newer',Math.min(maxTop,originalTop+CONFIG.scrollStep));
        container.scrollTop=originalTop;
        await sleep(Math.ceil(settleMs/2));
        collectCurrent();
        await visit('older',Math.max(0,originalTop-CONFIG.scrollStep));
        container.scrollTop=originalTop;
        await sleep(settleMs);
        collectCurrent();
        const restored=Math.abs((Number(container.scrollTop)||0)-originalTop)<=2;
        if(!restored){
            container.scrollTop=originalTop;
            await sleep(100);
        }
        const finalInspection=inspectRenderedMessageCompatibility();
        if(!finalInspection.ok)throw new Error('message layout changed during preflight');
        const messages=limitPrivatePreflightMessages(collected.values(),limit);
        if(messages.length===0)throw new Error('no readable messages');
        return {
            messages,
            traversedDirections:[...new Set(traversedDirections)],
            restored:Math.abs((Number(container.scrollTop)||0)-originalTop)<=2,
            originalTop,
            finalTop:Number(container.scrollTop)||0
        };
    }

    function createPrivatePreflightStats(messages,chatInfo,encrypted) {
        const stats=createExportStats();
        const range=getMessageRange(messages);
        stats.scopeMode='current';
        stats.scopeLabel=chatInfo.name||'Unknown Chat';
        stats.archiveEncrypted=Boolean(encrypted);
        stats.chatsRequested=1;
        stats.chatsIncluded=1;
        stats.messagesIncluded=messages.length;
        stats.oldestMessageDate=range.oldestMessageDate;
        stats.newestMessageDate=range.newestMessageDate;
        stats.chatCoverage=[{
            name:stats.scopeLabel,
            messagesIncluded:messages.length,
            oldestMessageDate:range.oldestMessageDate,
            newestMessageDate:range.newestMessageDate,
            oldestCalendarDate:getOldestMessageCalendarDate(messages)||null,
            coverageTargetReached:null
        }];
        return stats;
    }

    async function runPrivateArchivePreflight({formatHtml,formatJson,password,sampleLimit=10,filename='Local_Archive_private_preflight.zip'}) {
        if(!EXTENSION_MODE||typeof browser?.runtime?.sendMessage!=='function')throw new Error('archive service unavailable');
        if(typeof JSZip==='undefined')throw new Error('archive library unavailable');
        if(!formatHtml&&!formatJson)throw new Error('format required');
        const inspection=inspectRenderedMessageCompatibility();
        if(!inspection.ok)throw new Error('live layout check failed');

        const sample=await collectPrivatePreflightSample(sampleLimit);
        if(!sample.restored)throw new Error('message position was not restored');
        const messages=sample.messages;
        const activeInfo=getActiveChatInfo();
        const activePeer=parseSignedId(activeInfo?.peerId||'');
        const chatInfo={
            name:activeInfo?.name||getChatTitle()||'Unknown Chat',
            type:detectChatType(),
            id:Number.isFinite(Number(activeInfo?.id))?Number(activeInfo.id):(activePeer??0)
        };
        const encrypted=Boolean(password);
        const stats=createPrivatePreflightStats(messages,chatInfo,encrypted);
        const zip=new JSZip();
        if(formatJson)zip.file('result.json',JSON.stringify(buildResultJson(messages,chatInfo,false,stats),null,1));
        if(formatHtml){
            zip.file('css/style.css',EXPORT_CSS);
            zip.file('js/script.js',EXPORT_RUNTIME_JS);
            for(const [name,b64] of Object.entries(IMAGES))zip.file('images/'+name,b64,{base64:true});
            zip.file('messages.html',buildMessagesHtml(messages,chatInfo,false));
        }
        zip.file('export-summary.json',JSON.stringify(stats,null,2));
        const blob=await zip.generateAsync({
            type:'blob',
            compression:'DEFLATE',
            password:password||undefined,
            compressionOptions:{level:6}
        });
        const generatedValidation=blob?.telearchiveValidation;
        if(
            !generatedValidation?.structureVerified
            ||generatedValidation.reportReadable!==true
            ||generatedValidation.encrypted!==encrypted
            ||!Number.isInteger(generatedValidation.entryCount)
            ||generatedValidation.entryCount<2
        )throw new Error('generated archive was not validated');

        const requestId=createRuntimeRequestId();
        const response=await browser.runtime.sendMessage({
            type:'telearchive.archive.verify.v1',requestId,blob,filename,expectedFilename:filename,password:password||null
        });
        if(
            !response?.ok
            ||response.requestId!==requestId
            ||response.encrypted!==encrypted
            ||response.report?.outputsVerified!==true
            ||response.report?.reportReadable!==true
            ||Number(response.report?.chatsIncluded)!==1
            ||Number(response.report?.messagesIncluded)!==messages.length
            ||Number(response.report?.mediaIncluded)!==0
            ||Number(response.report?.htmlFiles)!==(formatHtml?1:0)
            ||Number(response.report?.resultJsonFiles)!==(formatJson?1:0)
        )throw new Error('local archive verification failed');
        return {
            encrypted,
            size:blob.size,
            entryCount:Number(response.entryCount)||generatedValidation.entryCount,
            messageIds:messages.map(message=>message.id),
            messageCount:messages.length,
            traversedDirections:sample.traversedDirections,
            positionRestored:sample.restored,
            originalScrollTop:sample.originalTop,
            finalScrollTop:sample.finalTop,
            htmlFiles:Number(response.report.htmlFiles),
            resultJsonFiles:Number(response.report.resultJsonFiles)
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

        const primaryMediaCount=messages.reduce((count,message)=>count+(message?.photo?1:0)+(message?.file?1:0),0);
        return '<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="local-archive-message-count" content="'+messages.length+'"/><meta name="local-archive-media-count" content="'+primaryMediaCount+'"/><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; img-src \'self\' data: blob:; media-src \'self\' data: blob:; style-src \'self\' \'unsafe-inline\'; script-src \'self\'; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'"/><title>Exported Data</title><meta content="width=device-width,initial-scale=1.0" name="viewport"/><link href="css/style.css" rel="stylesheet"/><script src="js/script.js" type="text/javascript"></script></head><body><div class="page_wrap"><div class="page_header"><div class="content"><div class="text bold">'+name+'</div></div></div><div class="page_body chat_page">'+body+'</div></div></body></html>';
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
            else if(e.type==='spoiler') html+=t;
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
        return {name:state.chatName||getChatTitle(),type:state.chatType||detectChatType(),id:chatId||Number(state.chatId)||0};
    }

    async function exportSingleChat(zip, chatIndex) {
        state.messages.clear(); state.scrollAttempts=0; state.staleCount=0;
        state._currentTopic=null;

        const liveInspection=inspectRenderedMessageCompatibility();
        const nativeInspection=NATIVE_HISTORY?await NATIVE_HISTORY.inspect():null;
        const nativeReady=Boolean(nativeInspection?.ready);
        if(!nativeReady&&!liveInspection.ok){recordChatSkip('live_layout_check_failed');return false;}

        state.scrollContainer=nativeReady?null:findScrollContainer();
        if(!nativeReady&&!state.scrollContainer){recordChatSkip('message_list_missing');return false;}

        state.chatName=String(nativeInspection?.chatName||getChatTitle());
        state.chatType=String(nativeInspection?.chatType||detectChatType());

        await detectAndExportTopics();
        if(state.cancelled) return false;

        const msgs=filterMessagesForRange(Array.from(state.messages.values()));
        if(msgs.length===0){log('No messages in chat:',state.chatName);if(!state.cancelled)recordChatSkip('no_messages');return false;}

        const chatInfo=getCurrentChatInfo();
        const isMulti=state.exportMode!=='current';
        await buildExportZip(msgs, chatInfo, isMulti, chatIndex, zip);
        recordChatCoverage(chatInfo,msgs);
        state.exportStats.chatsIncluded++;
        state.exportStats.messagesIncluded+=msgs.length;
        return true;
    }

    async function runExportInternal() {
        state.cancelled=false;
        state.downloadedMedia.clear(); state.mediaSkipped=0; state.exportStartTime=Date.now();
        state.currentChatIndex=0;
        resetExportStats();
        state.exportStats.archiveEncrypted=Boolean(state.archivePassword);

        updateProgress(tr('statusStarting','Preparing the export…'),0);

        if(state.exportMode==='current'){
            // Single chat export
            state.messages.clear();
            state.scrollAttempts=0;
            state.staleCount=0;
            state._currentTopic=null;
            const liveInspection=inspectRenderedMessageCompatibility();
            const nativeInspection=NATIVE_HISTORY?await NATIVE_HISTORY.inspect():null;
            const nativeReady=Boolean(nativeInspection?.ready);
            if(!nativeReady&&!liveInspection.ok){failAndShowExport(tr('errorLiveLayoutCheck','The open chat no longer passes Local Archive’s live layout check. Refresh Telegram Web or update Local Archive before retrying.'),'live-layout-check-failed');state.isExporting=false;return;}
            state.scrollContainer=nativeReady?null:findScrollContainer();
            if(!nativeReady&&!state.scrollContainer){failAndShowExport(tr('errorNoMessageList','Open a chat before starting the export.'),'message-list-missing');state.isExporting=false;return;}
            state.chatName=String(nativeInspection?.chatName||getChatTitle());
            state.chatType=String(nativeInspection?.chatType||detectChatType());
            state.exportStats.scopeLabel=state.chatName;
            state.exportStats.chatsRequested=1;
            const peerEl=document.querySelector('.input-message-input[data-peer-id]')||document.querySelector('a.chatlist-chat.active[data-peer-id],.chatlist-chat.active[data-peer-id]');
            if(peerEl) state.chatId=parseSignedId(peerEl.getAttribute('data-peer-id'));
            if(nativeReady) state.chatId=Number(nativeInspection.peerId)||state.chatId||0;
            state.exportSession?.beginCollection();
            await detectAndExportTopics();
            const msgs=state.exportSession
                ?state.exportSession.finishCollection(Array.from(state.messages.values()))
                :filterMessagesForRange(Array.from(state.messages.values()));
            if(state.exportStats)state.exportStats.rangeMessagesIncluded=msgs.length;
            if(msgs.length===0){failAndShowExport(state.quickLabels?.emptyRange||tr('errorNoMessages','No messages were found in the selected range.'),'empty-range');state.isExporting=false;return;}
            state.exportStats.chatsIncluded=1;
            state.exportStats.messagesIncluded=msgs.length;
            updateProgress(tr('statusBuilding','Building the archive…'),30);
            const chatInfo={name:state.chatName,type:state.chatType,id:state.chatId||0};
            recordChatCoverage(chatInfo,msgs);
            try {
                const archiveRequestId=createRuntimeRequestId();
                state.exportSession?.beginArchive(archiveRequestId);
                const blob=await buildExportZip(msgs, chatInfo, false, 1, undefined, archiveRequestId);
                updateProgress(tr('statusSaving','Saving the ZIP…'),95);
                const isPartial=state.cancelled;
                const filename=sanitizeFilename(state.chatName,'Telegram_chat')+'_'+new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)+(isPartial?'_partial':'')+'.zip';
                const validation=blob?.telearchiveValidation;
                state.exportSession?.archiveReady(validation);
                state.exportSession?.beginSave(filename);
                const startedReceipt=await downloadBlob(blob,filename);
                const receipt=await waitForDownloadCompletion(startedReceipt);
                state.exportSession?.complete(receipt);
                const elapsed=Math.round((Date.now()-state.exportStartTime)/1000);
                const skipped=state.mediaSkipped?tr(state.mediaSkipped===1?'mediaSkippedSuffixOne':'mediaSkippedSuffix',' · '+state.mediaSkipped+' media '+(state.mediaSkipped===1?'item':'items')+' skipped',[String(state.mediaSkipped)]):'';
                showComplete(isPartial
                    ?tr(msgs.length===1?'resultPartialMessage':'resultPartialMessages','Partial archive saved: '+msgs.length+' '+(msgs.length===1?'message':'messages')+' in '+elapsed+'s'+skipped,[String(msgs.length),String(elapsed),skipped])
                    :tr(msgs.length===1?'resultCompleteMessage':'resultCompleteMessages',msgs.length+' '+(msgs.length===1?'message':'messages')+' saved in '+elapsed+'s'+skipped,[String(msgs.length),String(elapsed),skipped]),receipt,state.lastExportStats||snapshotExportStats());
                dispatchDownloadCompletion(receipt);
            } catch(e) {
                failTypedExportSession(e);
                const failure=describeExportError(e);
                showError(failure.message,failure.code);
                log(e);
            }
            state.isExporting=false;
            return;
        }

        // Multi-chat export
        if(typeof JSZip==='undefined') {
            await new Promise(r=>setTimeout(r,2000));
            if(typeof JSZip==='undefined'){showError(tr('errorZipUnavailable','The archive library did not load. Reload Telegram Web and try again.'));state.isExporting=false;return;}
        }
        const zip=new JSZip();
        let chatList=[];
        if(state.exportMode==='selectable'||(state.exportMode==='all'&&state.selectedChats.length>0)){
            chatList=state.selectedChats;
        } else if(state.exportMode==='all'&&state.chatType){
            const groups = getChatGroups(state.fullChatList && state.fullChatList.length > 0 ? state.fullChatList : undefined);
            chatList=groups[state.chatType]||getChatList();
        } else {
            chatList=getChatList();
        }
        if(!chatList||chatList.length===0){showError(tr('errorNoChats','No chats were found for this selection.'));state.isExporting=false;return;}
        if(chatList.length>CONFIG.maxChats){showError(tr('errorTooManyChats',`${chatList.length} chats were selected; each archive supports up to ${CONFIG.maxChats}. Select the first batch of ${CONFIG.maxChats}, export it, then select the next batch.`,[String(chatList.length),String(CONFIG.maxChats)]));state.isExporting=false;return;}
        state.exportStats.chatsRequested=chatList.length;
        state.exportStats.scopeLabel=state.exportMode==='all'
            ?String(state.chatType||'')
            :tr('selectedCount',chatList.length+' selected',[String(chatList.length)]);

        let successCount=0;
        for(let i=0;i<chatList.length;i++){
            if(state.cancelled) break;
            state.currentChatIndex=i;
            const chat=chatList[i];
            updateProgress(tr('statusChatProgress','Chat '+(i+1)+' of '+chatList.length+': '+chat.name,[String(i+1),String(chatList.length),chat.name]), Math.round(i/chatList.length*80));
            const activated=await activateChat(chat);
            if(!activated){log('Skipping chat because it could not be activated:',chat.name);recordChatSkip('activation_failed');continue;}
            // Verify chat type matches expected group (mitigates -100 prefix ambiguity)
            if(state.exportMode==='all' && !verifyCurrentChatType()){
                log('Skipping "'+chat.name+'" — type mismatch (expected '+state.chatType+', got '+detectChatType()+')');
                recordChatSkip('type_mismatch');
                continue;
            }
            const ok=await exportSingleChat(zip, i+1);
            if(ok) successCount++;
        }

        updateProgress(state.cancelled
            ?tr('statusBuildingPartial','Finishing the partial archive…')
            :tr('statusBuildingFinal','Finishing the archive…'),90);

        if(successCount===0){
            showError(tr('errorNoExportedChats','No selected chat produced exportable messages. Keep the Telegram sidebar visible and try again.'));
            state.isExporting=false;
            return;
        }
        state.exportStats.partial=Boolean(state.cancelled);
        addExportSummary(zip);
        const blob=await zip.generateAsync({
            type:'blob',
            compression:'DEFLATE',
            password:state.archivePassword||undefined,
            compressionOptions:{level:6}
        });
        const batchSuffix=state.batchContext&&Number(state.batchContext.total)>1
            ?`_batch-${String(Number(state.batchContext.index)+1).padStart(2,'0')}-of-${String(state.batchContext.total).padStart(2,'0')}`
            :'';
        const startedReceipt=await downloadBlob(blob,'Telegram_Export'+batchSuffix+'_'+new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)+(state.cancelled?'_partial':'')+'.zip');
        const receipt=await waitForDownloadCompletion(startedReceipt);
        const elapsed=Math.round((Date.now()-state.exportStartTime)/1000);
        const skipped=state.mediaSkipped?tr(state.mediaSkipped===1?'mediaSkippedSuffixOne':'mediaSkippedSuffix',' · '+state.mediaSkipped+' media '+(state.mediaSkipped===1?'item':'items')+' skipped',[String(state.mediaSkipped)]):'';
        showComplete(state.cancelled
            ?tr(successCount===1?'resultPartialChat':'resultPartialChats','Partial archive saved: '+successCount+' '+(successCount===1?'chat':'chats')+' in '+elapsed+'s'+skipped,[String(successCount),String(elapsed),skipped])
            :tr(successCount===1?'resultCompleteChat':'resultCompleteChats',successCount+' '+(successCount===1?'chat':'chats')+' saved in '+elapsed+'s'+skipped,[String(successCount),String(elapsed),skipped]),receipt,state.lastExportStats||snapshotExportStats());
        dispatchDownloadCompletion(receipt);
        state.isExporting=false;
    }

    async function downloadBlob(blob, filename) {
        const safeFilename=sanitizeFilename(filename,'Telegram_Export.zip');
        const validation=blob?.telearchiveValidation&&typeof blob.telearchiveValidation==='object'
            ?{...blob.telearchiveValidation}
            :null;
        if(EXTENSION_MODE&&typeof browser?.runtime?.sendMessage==='function'){
            if(!validation?.requestId||!validation?.artifactId||Number(validation?.size)!==Number(blob?.size)){
                const error=new Error('The Rust archive validation receipt is missing or inconsistent.');
                error.code='archive-engine-failed';
                throw error;
            }
            const response=await browser.runtime.sendMessage({
                type:'telearchive.archive.save.v1',requestId:String(validation.requestId),
                artifactId:String(validation.artifactId),blob,filename:safeFilename,validation
            });
            if(
                !response?.ok
                ||response.requestId!==validation.requestId
                ||response.artifactId!==validation.artifactId
                ||!Number.isInteger(response.downloadId)
                ||Number(response.downloadId)<=0
                ||Number(response.size)!==Number(blob.size)
            ){
                const error=new Error(String(response?.message||'Firefox could not start the exact ZIP download.'));
                error.code='download-start-failed';
                throw error;
            }
            const receipt={
                requestId:String(response.requestId),artifactId:String(response.artifactId),
                downloadId:Number(response.downloadId),filename:String(response.filename||safeFilename),
                size:Number(response.size),state:'in_progress',startedAt:Date.now(),validation
            };
            return receipt;
        }

        const url=URL.createObjectURL(blob);
        const a=document.createElement('a');
        a.href=url;
        a.download=safeFilename;
        a.style.display='none';
        document.body.appendChild(a);
        const startedAt=Date.now();
        a.click();
        a.remove();
        setTimeout(()=>URL.revokeObjectURL(url),30000);
        return {filename:a.download,size:Number(blob?.size)||0,startedAt,validation,state:'complete'};
    }

    async function waitForDownloadCompletion(receipt,timeoutMs=120000) {
        if(!EXTENSION_MODE||!receipt?.downloadId)return {...receipt,state:'complete'};
        const deadline=Date.now()+timeoutMs;
        while(Date.now()<deadline){
            const response=await browser.runtime.sendMessage({
                type:'telearchive.ui.download-status.v1',requestId:String(receipt.requestId),
                artifactId:String(receipt.artifactId),downloadId:Number(receipt.downloadId),
                filename:String(receipt.filename),size:Number(receipt.size)
            });
            if(
                response?.ok
                &&response.requestId===receipt.requestId
                &&response.artifactId===receipt.artifactId
                &&Number(response.downloadId)===Number(receipt.downloadId)
                &&response.found
            ){
                if(response.state==='complete'){
                    const completed={
                        ...receipt,filename:String(response.filename||receipt.filename),
                        size:Number(response.size)||Number(receipt.size),state:'complete'
                    };
                    return completed;
                }
                if(response.state==='interrupted'){
                    const error=new Error('Firefox interrupted the ZIP download before completion.');
                    error.code='download-interrupted';
                    throw error;
                }
            }else if(response?.ok===false){
                const error=new Error(String(response.message||'Firefox could not verify the ZIP download.'));
                error.code='download-unconfirmed';
                throw error;
            }
            await new Promise(resolve=>setTimeout(resolve,180));
        }
        const error=new Error('Firefox did not confirm the ZIP download before the verification deadline.');
        error.code='download-unconfirmed';
        throw error;
    }

    function dispatchDownloadCompletion(receipt) {
        if(!receipt)return;
        document.dispatchEvent(new CustomEvent(DOWNLOAD_EVENT,{detail:{
            ...receipt,partial:Boolean(receipt.validation?.partial)
                ||/(?:^|_)partial(?:_|\.)/i.test(String(receipt.filename||''))
        }}));
    }

    async function startExport() {
        if(state.isExporting) return;
        state.isExporting=true;
        updateExportButton('✕ Cancel Export',true);
        try {
            releaseTypedExportSession();
            beginTypedExportSession();
            await runExportInternal();
        } catch(e) {
            log('Export failed:',e);
            failTypedExportSession(e);
            const failure=describeExportError(e);
            showError(failure.message,failure.code);
        } finally {
            if(state.observer){state.observer.disconnect();state.observer=null;}
            state.isExporting=false;
            state.isDownloading=false;
            updateExportButton('📋 Export Chats',false);
            if(state.dialog){
                const surface=getDialogSurface();
                surface?.querySelectorAll('.tgx-form input,.tgx-form select,.tgx-form button,#tgx-settings,#tgx-history-ready,#tgx-load-history,#tgx-open-aes-guide').forEach(control=>{control.disabled=false;});
                const action=surface?.querySelector('#tgx-export');
                const cancel=surface?.querySelector('#tgx-cancel');
                if(state.dialogRoot){
                    if(action&&state.lastOutcome!=='complete'){
                        action.hidden=false;
                        action.disabled=false;
                        if(state.lastOutcome==='error')action.textContent=tr('retryExport','Try again');
                        else {
                            const encrypted=surface?.querySelector('#tgx-encrypt')?.checked!==false;
                            const key=encrypted?'exportNow':'exportNowUnencrypted';
                            const fallback=encrypted?'Save protected ZIP · open with PeaZip or 7-Zip':'Save unencrypted ZIP · open in Firefox after unzipping';
                            const text=tr(key,fallback);
                            const label=action.querySelector('span:first-child');
                            if(label)label.textContent=text;
                            else action.textContent=text;
                            action.setAttribute('aria-label',text);
                            action.title=text;
                        }
                    }
                    if(cancel)cancel.textContent=tr('close','Close');
                } else {
                    if(action){action.disabled=false;action.textContent='Export';action.style.opacity='1';}
                    if(cancel) cancel.textContent='Close';
                }
            }
            releaseTypedExportSession();
        }
    }

    function inspectQuickExportContext() {
        const inspection=inspectRenderedMessageCompatibility();
        const active=getActiveChatInfo();
        const nativeReady=state.nativeReady===true;
        return {
            ready:Boolean((inspection.ok||nativeReady)&&(active||nativeReady)),
            chatName:String(nativeReady?state.chatName:(active?.name||getChatTitle()||'')),
            visibleMessages:Number(inspection.renderedCount)||getMessageElements().length,
            busy:isQuickExportBusy()
        };
    }

    async function startQuickExport(request) {
        if(isQuickExportBusy())return false;
        const input=RUST_CORE
            ?RUST_CORE.normalizeQuickExportRequest(request)
            :(request&&typeof request==='object'?request:{});
        const labels=input.labels&&typeof input.labels==='object'?input.labels:{};
        createQuickPanel(labels);
        clearBackgroundJobState();
        state.backgroundJobId=String(globalThis.__LOCAL_ARCHIVE_BACKGROUND_JOB_ID__||'');
        try{
            applyPreferencesToState(await loadStoredPreferences());
            state.exportMode='current';
            state.selectedChats=[];
            state.chatType=detectChatType();
            state.archivePassword='';
            state.coverageTargetDate='';
            state.exportRange=input.range||normalizeExportRange(null);
            state.quickLocale=String(input.locale||'en').slice(0,16);
            state.formatHtml=input.format!=='json';
            state.formatJson=input.format!=='html';
            const includeMedia=input.includeMedia!==false;
            state.exportPhotos=includeMedia;
            state.exportVideos=includeMedia;
            state.exportVoice=includeMedia;
            state.exportStickers=includeMedia;
            state.exportFiles=includeMedia;
            state.maxPhotoSize=10*1024*1024;
            state.maxVideoSize=100*1024*1024;
            state.maxFileSize=100*1024*1024;
            await startExport();
            return true;
        }catch(error){
            const failure=describeExportError(error);
            showError(failure.message,failure.code);
            return false;
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

    document.addEventListener(OPEN_EVENT,()=>{void showModernExportDialog();});
    if(EXTENSION_MODE||EXTENSION_BUILD){
        globalThis.TeleArchiveExporter=Object.freeze({
            version:'5.0.0',
            engine:'rust-wasm',
            coreVersion:RUST_CORE.version,
            open:()=>showModernExportDialog(),
            inspect:()=>inspectQuickExportContext(),
            quickExport:value=>startQuickExport(value),
            beginBackgroundProgress:value=>beginBackgroundProgress(value),
            restoreBackgroundProgress:value=>restoreBackgroundProgress(value),
            backgroundProgress:value=>backgroundProgress(value),
            backgroundJobId:()=>backgroundJobId(),
            cancel:()=>setCancelled(true),
            isExporting:()=>isQuickExportBusy()
        });
    } else if(document.readyState==='loading') {
        document.addEventListener('DOMContentLoaded',init);
    } else {
        init();
    }

    if(globalThis.__TELEARCHIVE_TEST__){
        globalThis.__TELEARCHIVE_TEST_API__={
            sanitizeFilename,
            safeHref,
            normalizeMediaUrl,
            parseSignedId,
            parseMessageId,
            normalizePreferences,
            buildResultJson,
            normalizeExportRange,
            filterMessagesForRange,
            inspectQuickExportContext,
            startQuickExport,
            getMessageElements,
            findScrollContainer,
            collectVisibleMessages,
            scrollAllMessages,
            getChatList,
            getActiveChatInfo,
            showModernExportDialog,
            closeDialog,
            state
        };
    }

})();
