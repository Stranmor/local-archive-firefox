use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::io::{Cursor, Read, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{AesMode, CompressionMethod, HasZipMetadata, ZipArchive, ZipWriter};

use crate::error::{CoreError, CoreResult};

const MAX_ENTRY_COUNT: usize = 100_000;
const MAX_ENTRY_NAME_LENGTH: usize = 1_024;
const MAX_ARCHIVE_BYTES: usize = 2_147_483_648;
const MAX_VERIFICATION_TEXT_BYTES: u64 = 512 * 1_024 * 1_024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct ArchivePath(String);

impl ArchivePath {
    fn parse(value: &str) -> CoreResult<Self> {
        if !is_safe_archive_path(value) {
            return Err(CoreError::invalid_entry(format!("Unsafe archive path: {value}")));
        }
        Ok(Self(value.to_owned()))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug)]
struct ArchiveEntry {
    path: ArchivePath,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)]
pub struct ArchiveArtifactCore {
    pub request_id: String,
    pub artifact_id: String,
    #[serde(skip)]
    pub bytes: Vec<u8>,
    pub size: usize,
    pub entry_count: usize,
    pub encrypted: bool,
    pub partial: bool,
    pub messages_included: u64,
    pub structure_verified: bool,
    pub report_readable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(clippy::struct_excessive_bools)]
pub struct ArchiveArtifactReceipt {
    pub request_id: String,
    pub artifact_id: String,
    pub size: usize,
    pub entry_count: usize,
    pub encrypted: bool,
    pub partial: bool,
    pub messages_included: u64,
    pub structure_verified: bool,
    pub report_readable: bool,
}

impl ArchiveArtifactReceipt {
    pub(crate) fn validate(&self) -> CoreResult<()> {
        validate_request_id(&self.request_id)?;
        if self.artifact_id.len() != 64
            || !self
                .artifact_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(CoreError::invalid_transition("The archive identity is invalid."));
        }
        if self.size == 0
            || self.entry_count == 0
            || !self.structure_verified
            || !self.report_readable
        {
            return Err(CoreError::invalid_transition(
                "The archive has no complete Rust validation receipt.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct ArchiveBuilderCore {
    request_id: String,
    compression_level: u8,
    password: Option<Zeroizing<String>>,
    entries: Vec<ArchiveEntry>,
    names: HashSet<String>,
    uncompressed_bytes: usize,
}

impl ArchiveBuilderCore {
    pub fn new(
        request_id: String,
        compression_level: u8,
        password: Option<String>,
    ) -> CoreResult<Self> {
        validate_request_id(&request_id)?;
        if compression_level > 9 {
            return Err(CoreError::invalid_request("Compression level must be between 0 and 9."));
        }
        let password = password
            .filter(|value| !value.is_empty())
            .map(|value| validate_archive_password(&value).map(|()| Zeroizing::new(value)))
            .transpose()?;
        Ok(Self {
            request_id,
            compression_level,
            password,
            entries: Vec::new(),
            names: HashSet::new(),
            uncompressed_bytes: 0,
        })
    }

    pub fn add_entry(&mut self, name: &str, bytes: &[u8]) -> CoreResult<()> {
        if self.entries.len() >= MAX_ENTRY_COUNT {
            return Err(CoreError::invalid_request(
                "The archive entry count exceeds the supported limit.",
            ));
        }
        let path = ArchivePath::parse(name)?;
        if !self.names.insert(path.0.clone()) {
            return Err(CoreError::invalid_entry("Archive entries must have unique paths."));
        }
        self.uncompressed_bytes = self
            .uncompressed_bytes
            .checked_add(bytes.len())
            .filter(|total| *total <= MAX_ARCHIVE_BYTES)
            .ok_or_else(|| {
                CoreError::invalid_request("The archive exceeds the 2 GB in-memory build limit.")
            })?;
        self.entries.push(ArchiveEntry { path, bytes: bytes.to_vec() });
        Ok(())
    }

    pub fn finish(self) -> CoreResult<ArchiveArtifactCore> {
        if self.entries.is_empty() {
            return Err(CoreError::invalid_request("The archive must contain at least one file."));
        }

        let encrypted = self.password.is_some();
        let expected_names =
            self.entries.iter().map(|entry| entry.path.0.clone()).collect::<Vec<_>>();
        let cursor = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        for entry in &self.entries {
            let mut options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .compression_level(Some(i64::from(self.compression_level)));
            if let Some(password) = &self.password {
                options = options.with_aes_encryption(AesMode::Aes256, password.as_str());
            }
            writer
                .start_file(entry.path.as_str(), options)
                .map_err(|error| CoreError::archive_engine(error.to_string()))?;
            writer
                .write_all(&entry.bytes)
                .map_err(|error| CoreError::archive_engine(error.to_string()))?;
        }
        let bytes = writer
            .finish()
            .map_err(|error| CoreError::archive_engine(error.to_string()))?
            .into_inner();
        if bytes.is_empty() || bytes.len() > MAX_ARCHIVE_BYTES {
            return Err(CoreError::archive_engine("The generated archive size is invalid."));
        }
        let validation = validate_generated_archive(
            &bytes,
            &expected_names,
            self.password.as_deref().map(String::as_str),
        )?;
        Ok(ArchiveArtifactCore {
            request_id: self.request_id,
            artifact_id: hex_sha256(&bytes),
            size: bytes.len(),
            bytes,
            entry_count: validation.entry_count,
            encrypted,
            partial: validation.partial,
            messages_included: validation.messages_included,
            structure_verified: true,
            report_readable: validation.report_readable,
        })
    }
}

pub fn validate_archive_password(value: &str) -> CoreResult<()> {
    if !(8..=256).contains(&value.chars().count()) {
        return Err(CoreError::invalid_request(
            "Archive passwords must contain between 8 and 256 Unicode characters.",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct GeneratedArchiveValidation {
    entry_count: usize,
    report_readable: bool,
    partial: bool,
    messages_included: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveVerifyReport {
    pub outputs_verified: bool,
    pub report_readable: bool,
    pub chats_included: u64,
    pub messages_included: u64,
    pub media_included: u64,
    pub partial: bool,
    pub html_files: usize,
    pub result_json_files: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveVerifyReceipt {
    pub request_id: String,
    pub filename: String,
    pub size: usize,
    pub entry_count: usize,
    pub encrypted: bool,
    pub report: ArchiveVerifyReport,
}

pub fn verify_archive(
    bytes: &[u8],
    request_id: String,
    filename: String,
    expected_filename: &str,
    password: Option<&str>,
) -> CoreResult<ArchiveVerifyReceipt> {
    validate_archive_request(bytes, &request_id, &filename, expected_filename)?;
    let mut archive = open_archive(bytes)?;
    let inventory = inspect_archive(&mut archive, password)?;
    let outputs = OutputFiles::from_inventory(&inventory)?;
    validate_readable_size(&inventory, &outputs)?;
    let summary = verify_summary(&mut archive, password, inventory.encrypted, &outputs)?;
    let html_counts = verify_html_outputs(&mut archive, password, &outputs.html)?;
    let json_counts =
        verify_json_outputs(&mut archive, password, inventory.encrypted, &outputs.json)?;
    verify_output_counts(&summary, &outputs, &html_counts, &json_counts)?;
    let mut referenced_media_paths = html_counts.media_paths.clone();
    referenced_media_paths.extend(json_counts.media_paths.iter().cloned());
    verify_media_inventory(&inventory, summary.media_included, &referenced_media_paths)?;
    verify_all_entries(&mut archive, password, &inventory)?;
    Ok(ArchiveVerifyReceipt {
        request_id,
        filename,
        size: bytes.len(),
        entry_count: inventory.ordered_names.len(),
        encrypted: inventory.encrypted,
        report: ArchiveVerifyReport {
            outputs_verified: true,
            report_readable: true,
            chats_included: summary.chats_included,
            messages_included: summary.messages_included,
            media_included: summary.media_included,
            partial: summary.partial,
            html_files: outputs.html.len(),
            result_json_files: outputs.json.len(),
        },
    })
}

#[derive(Debug)]
struct ArchiveInventory {
    names: HashSet<String>,
    ordered_names: Vec<String>,
    sizes: HashMap<String, u64>,
    encrypted: bool,
}

#[derive(Debug)]
struct OutputFiles {
    html: Vec<String>,
    json: Vec<String>,
}

impl OutputFiles {
    fn from_inventory(inventory: &ArchiveInventory) -> CoreResult<Self> {
        if !inventory.names.contains("export-summary.json") {
            return Err(CoreError::new("not-telearchive", "export-summary.json is missing."));
        }
        let html = matching_outputs(&inventory.ordered_names, "messages.html");
        let json = matching_outputs(&inventory.ordered_names, "result.json");
        if html.is_empty() && json.is_empty() {
            return Err(CoreError::new(
                "not-telearchive",
                "No Local Archive HTML or JSON output was found.",
            ));
        }
        Ok(Self { html, json })
    }
}

#[derive(Debug, Clone, Copy)]
struct VerifiedSummary {
    chats_included: u64,
    messages_included: u64,
    media_included: u64,
    partial: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct OutputCounts {
    messages: u64,
    media: u64,
    media_paths: HashSet<String>,
}

fn validate_archive_request(
    bytes: &[u8],
    request_id: &str,
    filename: &str,
    expected_filename: &str,
) -> CoreResult<()> {
    validate_request_id(request_id)?;
    if bytes.is_empty() || bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(CoreError::invalid_request(
            "The selected ZIP size is outside the supported range.",
        ));
    }
    if !is_safe_basename(filename) || !is_safe_basename(expected_filename) {
        return Err(CoreError::invalid_request("The selected ZIP filename is invalid."));
    }
    if !matches_archive_filename(filename, expected_filename) {
        return Err(CoreError::new(
            "filename-mismatch",
            "The selected file does not match the ZIP named in this export receipt.",
        ));
    }
    Ok(())
}

fn open_archive(bytes: &[u8]) -> CoreResult<ZipArchive<Cursor<Vec<u8>>>> {
    let archive = ZipArchive::new(Cursor::new(bytes.to_vec()))
        .map_err(|_| CoreError::new("not-telearchive", "The ZIP could not be opened."))?;
    if archive.is_empty() || archive.len() > MAX_ENTRY_COUNT {
        return Err(CoreError::new("not-telearchive", "The ZIP has an invalid file count."));
    }
    Ok(archive)
}

fn inspect_archive<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    password: Option<&str>,
) -> CoreResult<ArchiveInventory> {
    let mut names = HashSet::new();
    let mut ordered_names = Vec::new();
    let mut sizes = HashMap::new();
    let mut encryption_state = None;
    let mut all_aes_256 = true;
    let mut uncompressed_bytes = 0_u64;
    for index in 0..archive.len() {
        let file = archive
            .by_index_raw(index)
            .map_err(|_| CoreError::new("not-telearchive", "The ZIP directory is invalid."))?;
        if file.is_dir() {
            return Err(CoreError::new(
                "not-telearchive",
                "The ZIP contains an unsupported directory entry.",
            ));
        }
        let name = file
            .name()
            .map_err(|_| CoreError::new("not-telearchive", "The ZIP has an invalid filename."))?
            .into_owned();
        if !is_safe_archive_path(&name) || !names.insert(name.clone()) {
            return Err(CoreError::new(
                "not-telearchive",
                "The ZIP contains an unsafe or duplicate path.",
            ));
        }
        let encrypted = file.encrypted();
        if encryption_state.replace(encrypted).is_some_and(|state| state != encrypted) {
            return Err(CoreError::new(
                "not-telearchive",
                "The ZIP mixes encrypted and unencrypted files.",
            ));
        }
        all_aes_256 &=
            !encrypted || matches!(file.get_metadata().aes_mode, Some((AesMode::Aes256, _)));
        uncompressed_bytes = uncompressed_bytes
            .checked_add(file.size())
            .filter(|total| *total <= MAX_ARCHIVE_BYTES as u64)
            .ok_or_else(|| {
                CoreError::new("not-telearchive", "The ZIP expands beyond the supported limit.")
            })?;
        sizes.insert(name.clone(), file.size());
        ordered_names.push(name);
    }
    if ordered_names.is_empty() {
        return Err(CoreError::new("not-telearchive", "The ZIP contains no files."));
    }
    let encrypted = encryption_state.unwrap_or(false);
    if encrypted && !all_aes_256 {
        return Err(CoreError::new(
            "not-telearchive",
            "The ZIP does not use AES-256 for every encrypted entry.",
        ));
    }
    if encrypted && password.is_none() {
        return Err(CoreError::new(
            "password-required",
            "Enter the password used for this archive.",
        ));
    }
    Ok(ArchiveInventory { names, ordered_names, sizes, encrypted })
}

fn matching_outputs(names: &[String], basename: &str) -> Vec<String> {
    names
        .iter()
        .filter(|name| name.as_str() == basename || name.ends_with(&format!("/{basename}")))
        .cloned()
        .collect()
}

fn validate_readable_size(inventory: &ArchiveInventory, outputs: &OutputFiles) -> CoreResult<()> {
    std::iter::once("export-summary.json")
        .chain(outputs.html.iter().map(String::as_str))
        .chain(outputs.json.iter().map(String::as_str))
        .try_fold(0_u64, |total, name| {
            total.checked_add(inventory.sizes.get(name).copied().unwrap_or_default())
        })
        .filter(|total| *total <= MAX_VERIFICATION_TEXT_BYTES)
        .map(|_| ())
        .ok_or_else(|| {
            CoreError::new(
                "verification-limit",
                "The readable HTML and JSON exceed the 512 MB local verification limit.",
            )
        })
}

fn verify_summary<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    password: Option<&str>,
    encrypted: bool,
    outputs: &OutputFiles,
) -> CoreResult<VerifiedSummary> {
    let text = read_text_entry(archive, "export-summary.json", password)?;
    let summary: Value = serde_json::from_str(&text).map_err(|_| {
        CoreError::new("not-telearchive", "export-summary.json is not a JSON object.")
    })?;
    let object = summary.as_object().ok_or_else(|| {
        CoreError::new("not-telearchive", "export-summary.json is not a JSON object.")
    })?;
    let media = object
        .get("media")
        .and_then(Value::as_object)
        .ok_or_else(|| CoreError::new("not-telearchive", "The export report is incomplete."))?;
    if object.get("formatVersion").and_then(Value::as_str).is_none()
        || !is_supported_history_source(object.get("historySource").and_then(Value::as_str))
        || object.get("contentUploaded").and_then(Value::as_bool) != Some(false)
        || object.get("completeHistoryNotGuaranteed").and_then(Value::as_bool) != Some(true)
        || object.get("archiveEncrypted").and_then(Value::as_bool) != Some(encrypted)
        || object.get("partial").and_then(Value::as_bool).is_none()
    {
        return Err(CoreError::new(
            "not-telearchive",
            "export-summary.json lacks Local Archive integrity markers.",
        ));
    }
    let chats_included = required_u64(object.get("chatsIncluded"), "chatsIncluded", 1)?;
    let chats_as_usize = usize::try_from(chats_included)
        .map_err(|_| CoreError::new("not-telearchive", "The export chat count is too large."))?;
    if (!outputs.html.is_empty() && outputs.html.len() != chats_as_usize)
        || (!outputs.json.is_empty() && outputs.json.len() != chats_as_usize)
    {
        return Err(CoreError::new(
            "not-telearchive",
            "The output file count does not match the export report.",
        ));
    }
    Ok(VerifiedSummary {
        chats_included,
        messages_included: required_u64(object.get("messagesIncluded"), "messagesIncluded", 0)?,
        media_included: required_u64(media.get("included"), "media.included", 0)?,
        partial: object.get("partial").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn verify_html_outputs<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    password: Option<&str>,
    names: &[String],
) -> CoreResult<OutputCounts> {
    let mut counts = OutputCounts::default();
    for name in names {
        let html = read_text_entry(archive, name, password)?;
        let lower = html.trim_start().to_ascii_lowercase();
        if (!lower.starts_with("<!doctype html") && !lower.starts_with("<html"))
            || !lower.contains("<head")
            || !lower.contains("<body")
            || !lower.contains("</html>")
        {
            return Err(CoreError::new("not-telearchive", format!("{name} is not readable HTML.")));
        }
        counts.messages = counts
            .messages
            .checked_add(required_html_meta(&lower, name, "local-archive-message-count")?)
            .ok_or_else(|| {
                CoreError::new("not-telearchive", "The HTML message count overflowed.")
            })?;
        counts.media = counts
            .media
            .checked_add(required_html_meta(&lower, name, "local-archive-media-count")?)
            .ok_or_else(|| CoreError::new("not-telearchive", "The HTML media count overflowed."))?;
        counts.media_paths.extend(collect_html_media_paths(&html, name)?);
    }
    Ok(counts)
}

fn verify_json_outputs<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    password: Option<&str>,
    encrypted: bool,
    names: &[String],
) -> CoreResult<OutputCounts> {
    let mut counts = OutputCounts::default();
    for name in names {
        let text = read_text_entry(archive, name, password)?;
        let current = verify_json_output(&text, name, encrypted)?;
        counts.messages = counts.messages.checked_add(current.messages).ok_or_else(|| {
            CoreError::new("not-telearchive", "The JSON message count overflowed.")
        })?;
        counts.media = counts
            .media
            .checked_add(current.media)
            .ok_or_else(|| CoreError::new("not-telearchive", "The JSON media count overflowed."))?;
        counts.media_paths.extend(current.media_paths);
    }
    Ok(counts)
}

fn verify_json_output(text: &str, name: &str, encrypted: bool) -> CoreResult<OutputCounts> {
    let result: Value = serde_json::from_str(text)
        .map_err(|_| CoreError::new("not-telearchive", format!("{name} is not readable JSON.")))?;
    let object = result.as_object().ok_or_else(|| {
        CoreError::new("not-telearchive", format!("{name} is not Local Archive JSON."))
    })?;
    let message_arrays = json_message_arrays(object, name)?;
    let marker = object.get("telearchive").and_then(Value::as_object).ok_or_else(|| {
        CoreError::new("not-telearchive", format!("{name} has no Local Archive marker."))
    })?;
    let mut counts = OutputCounts::default();
    for messages in message_arrays {
        counts.messages = counts
            .messages
            .checked_add(u64::try_from(messages.len()).map_err(|_| {
                CoreError::new("not-telearchive", "The JSON message count is too large.")
            })?)
            .ok_or_else(|| {
                CoreError::new("not-telearchive", "The JSON message count overflowed.")
            })?;
        let (media_count, media_paths) = collect_message_media(messages, name)?;
        counts.media = counts
            .media
            .checked_add(media_count)
            .ok_or_else(|| CoreError::new("not-telearchive", "The JSON media count overflowed."))?;
        counts.media_paths.extend(media_paths);
    }
    if !is_supported_history_source(marker.get("history_source").and_then(Value::as_str))
        || marker.get("content_uploaded").and_then(Value::as_bool) != Some(false)
        || marker.get("complete_history_not_guaranteed").and_then(Value::as_bool) != Some(true)
        || marker.get("archive_encrypted").and_then(Value::as_bool) != Some(encrypted)
        || required_u64(marker.get("messages_in_this_chat"), "messages_in_this_chat", 0)?
            != counts.messages
    {
        return Err(CoreError::new(
            "not-telearchive",
            format!("{name} has inconsistent integrity markers."),
        ));
    }
    Ok(counts)
}

fn is_supported_history_source(value: Option<&str>) -> bool {
    matches!(value, Some("rendered-telegram-web" | "telegram-web-api" | "rendered-discord-web"))
}

fn json_message_arrays<'a>(
    object: &'a serde_json::Map<String, Value>,
    name: &str,
) -> CoreResult<Vec<&'a Vec<Value>>> {
    if let Some(messages) = object.get("messages").and_then(Value::as_array) {
        return Ok(vec![messages]);
    }
    let chats = object
        .get("chats")
        .and_then(Value::as_object)
        .and_then(|value| value.get("list"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CoreError::new("not-telearchive", format!("{name} has no messages array."))
        })?;
    chats
        .iter()
        .map(|chat| {
            chat.as_object()
                .and_then(|value| value.get("messages"))
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    CoreError::new("not-telearchive", format!("{name} has an invalid chat output."))
                })
        })
        .collect()
}

fn collect_message_media(messages: &[Value], name: &str) -> CoreResult<(u64, HashSet<String>)> {
    let mut paths = HashSet::new();
    let count = messages.iter().try_fold(0_u64, |count, message| {
        let object = message.as_object().ok_or_else(|| {
            CoreError::new("not-telearchive", format!("{name} contains an invalid message."))
        })?;
        let mut current = count;
        if let Some(attachments) = object.get("attachments") {
            let attachments = attachments.as_array().ok_or_else(|| {
                CoreError::new("not-telearchive", format!("{name} contains invalid attachments."))
            })?;
            if attachments.is_empty() {
                current = collect_legacy_message_media(object, name, current, &mut paths)?;
            } else {
                for attachment in attachments {
                    let attachment = attachment.as_object().ok_or_else(|| {
                        CoreError::new(
                            "not-telearchive",
                            format!("{name} contains an invalid attachment."),
                        )
                    })?;
                    let path = attachment
                        .get("url")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            CoreError::new(
                                "not-telearchive",
                                format!("{name} contains an attachment without a local path."),
                            )
                        })?;
                    if is_external_media_reference(path) {
                        continue;
                    }
                    current = add_primary_media_path(&mut paths, current, path, name)?;
                }
            }
        } else {
            current = collect_legacy_message_media(object, name, current, &mut paths)?;
        }

        if object
            .get("thumbnail")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .is_some_and(|thumbnail| !is_local_media_path(thumbnail))
        {
            return Err(CoreError::new(
                "not-telearchive",
                format!("{name} contains a non-local thumbnail reference."),
            ));
        }
        Ok(current)
    })?;
    Ok((count, paths))
}

fn collect_legacy_message_media(
    object: &serde_json::Map<String, Value>,
    name: &str,
    mut count: u64,
    paths: &mut HashSet<String>,
) -> CoreResult<u64> {
    for field in ["photo", "file"] {
        let Some(path) =
            object.get(field).and_then(Value::as_str).filter(|value| !value.is_empty())
        else {
            continue;
        };
        count = add_primary_media_path(paths, count, path, name)?;
    }
    Ok(count)
}

fn add_primary_media_path(
    paths: &mut HashSet<String>,
    count: u64,
    path: &str,
    name: &str,
) -> CoreResult<u64> {
    if !is_primary_media_path(path) {
        return Err(CoreError::new(
            "not-telearchive",
            format!("{name} contains a non-local media reference."),
        ));
    }
    paths.insert(path.to_owned());
    count
        .checked_add(1)
        .ok_or_else(|| CoreError::new("not-telearchive", "The media count overflowed."))
}

fn is_external_media_reference(path: &str) -> bool {
    path.starts_with("http://")
        || path.starts_with("https://")
        || path.starts_with("blob:")
        || path.starts_with("data:")
}

fn collect_html_media_paths(html: &str, name: &str) -> CoreResult<HashSet<String>> {
    const ATTRIBUTES: [&str; 2] = ["href", "src"];
    let mut paths = HashSet::new();
    for attribute in ATTRIBUTES {
        let mut cursor = 0;
        while let Some(relative_start) = html[cursor..].find(attribute) {
            let start = cursor + relative_start;
            if start > 0
                && (html.as_bytes()[start - 1].is_ascii_alphanumeric()
                    || html.as_bytes()[start - 1] == b'-')
            {
                cursor = start + attribute.len();
                continue;
            }
            let after_attribute = &html[start + attribute.len()..];
            let attribute_whitespace = after_attribute.len() - after_attribute.trim_start().len();
            let mut rest = &after_attribute[attribute_whitespace..];
            if !rest.starts_with('=') {
                cursor = start + attribute.len();
                continue;
            }
            let after_equals = &rest[1..];
            let equals_whitespace = after_equals.len() - after_equals.trim_start().len();
            rest = &after_equals[equals_whitespace..];
            let Some(quote) = rest.chars().next() else {
                return Err(CoreError::new(
                    "not-telearchive",
                    format!("{name} has an incomplete {attribute} attribute."),
                ));
            };
            if quote != '"' && quote != '\'' {
                cursor = start + attribute.len();
                continue;
            }
            let value = &rest[quote.len_utf8()..];
            let end = value.find(quote).ok_or_else(|| {
                CoreError::new(
                    "not-telearchive",
                    format!("{name} has an unterminated {attribute} attribute."),
                )
            })?;
            let value = &value[..end];
            if looks_like_media_path(value) {
                if !is_local_media_path(value) {
                    return Err(CoreError::new(
                        "not-telearchive",
                        format!("{name} contains an unsafe local media reference."),
                    ));
                }
                if is_primary_media_path(value) {
                    paths.insert(value.to_owned());
                }
            }
            cursor = start
                + attribute.len()
                + attribute_whitespace
                + 1
                + equals_whitespace
                + quote.len_utf8()
                + end
                + quote.len_utf8();
        }
    }
    Ok(paths)
}

fn looks_like_media_path(value: &str) -> bool {
    if value.is_empty()
        || value.starts_with('/')
        || value.contains("://")
        || value.starts_with("data:")
    {
        return false;
    }
    let segments = value.split('/').collect::<Vec<_>>();
    segments.windows(2).any(|pair| {
        matches!(
            pair[0],
            "photos"
                | "video_files"
                | "animations"
                | "voice_messages"
                | "stickers"
                | "video_message_files"
                | "files"
        ) && !pair[1].is_empty()
    })
}

fn required_html_meta(html: &str, name: &str, marker: &str) -> CoreResult<u64> {
    let prefix = format!("<meta name=\"{marker}\" content=\"");
    let value = html
        .split_once(&prefix)
        .and_then(|(_, remainder)| remainder.split_once('\"').map(|(value, _)| value))
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| {
            CoreError::new(
                "not-telearchive",
                format!("{name} lacks the {marker} integrity marker."),
            )
        })?;
    Ok(value)
}

fn verify_output_counts(
    summary: &VerifiedSummary,
    outputs: &OutputFiles,
    html: &OutputCounts,
    json: &OutputCounts,
) -> CoreResult<()> {
    for (present, counts, label) in
        [(!outputs.html.is_empty(), html, "HTML"), (!outputs.json.is_empty(), json, "JSON")]
    {
        if present
            && (counts.messages != summary.messages_included
                || counts.media != summary.media_included)
        {
            return Err(CoreError::new(
                "not-telearchive",
                format!("The {label} output counts do not match export-summary.json."),
            ));
        }
    }
    Ok(())
}

fn verify_media_inventory(
    inventory: &ArchiveInventory,
    expected: u64,
    referenced_paths: &HashSet<String>,
) -> CoreResult<()> {
    let actual_paths = inventory
        .ordered_names
        .iter()
        .filter(|name| is_primary_media_path(name))
        .cloned()
        .collect::<HashSet<_>>();
    let actual = u64::try_from(actual_paths.len())
        .map_err(|_| CoreError::new("not-telearchive", "The ZIP media count is too large."))?;
    if actual != expected || actual_paths != *referenced_paths {
        return Err(CoreError::new(
            "not-telearchive",
            "The ZIP media files do not match the references in the export outputs.",
        ));
    }
    Ok(())
}

fn is_primary_media_path(path: &str) -> bool {
    if !is_local_media_path(path) {
        return false;
    }
    let mut segments = path.split('/').collect::<Vec<_>>();
    let Some(filename) = segments.pop() else {
        return false;
    };
    let Some(folder) = segments.pop() else {
        return false;
    };
    matches!(
        folder,
        "photos"
            | "video_files"
            | "animations"
            | "voice_messages"
            | "stickers"
            | "video_message_files"
            | "files"
    ) && !filename.to_ascii_lowercase().contains("_thumb.")
}

fn is_local_media_path(path: &str) -> bool {
    if !is_safe_archive_path(path) {
        return false;
    }
    let mut segments = path.split('/');
    let Some(filename) = segments.next_back() else {
        return false;
    };
    let Some(folder) = segments.next_back() else {
        return false;
    };
    !filename.is_empty()
        && matches!(
            folder,
            "photos"
                | "video_files"
                | "animations"
                | "voice_messages"
                | "stickers"
                | "video_message_files"
                | "files"
        )
}

pub fn matches_archive_filename(actual_name: &str, requested_name: &str) -> bool {
    if actual_name == requested_name {
        return true;
    }
    let dot = requested_name.rfind('.').unwrap_or(requested_name.len());
    let (stem, extension) = requested_name.split_at(dot);
    let Some(remainder) = actual_name.strip_prefix(stem) else {
        return false;
    };
    let Some(number_with_suffix) = remainder.strip_prefix(" (") else {
        return false;
    };
    let Some(number) = number_with_suffix.strip_suffix(&format!("){extension}")) else {
        return false;
    };
    !number.is_empty()
        && !number.starts_with('0')
        && number.bytes().all(|byte| byte.is_ascii_digit())
        && number.parse::<u64>().is_ok_and(|value| value > 0)
}

fn validate_generated_archive(
    bytes: &[u8],
    expected_names: &[String],
    password: Option<&str>,
) -> CoreResult<GeneratedArchiveValidation> {
    let mut archive = ZipArchive::new(Cursor::new(bytes.to_vec()))
        .map_err(|error| CoreError::archive_engine(error.to_string()))?;
    let inventory = inspect_archive(&mut archive, password)?;
    if inventory.encrypted != password.is_some() {
        return Err(CoreError::archive_engine(
            "Generated archive encryption state was inconsistent.",
        ));
    }
    let mut actual_names = inventory.ordered_names.clone();
    actual_names.sort_unstable();
    let mut expected = expected_names.to_vec();
    expected.sort_unstable();
    if actual_names != expected {
        return Err(CoreError::archive_engine(
            "Generated archive entries did not match the requested files.",
        ));
    }
    let outputs = OutputFiles::from_inventory(&inventory)?;
    validate_readable_size(&inventory, &outputs)?;
    let summary = verify_summary(&mut archive, password, inventory.encrypted, &outputs)?;
    let html_counts = verify_html_outputs(&mut archive, password, &outputs.html)?;
    let json_counts =
        verify_json_outputs(&mut archive, password, inventory.encrypted, &outputs.json)?;
    verify_output_counts(&summary, &outputs, &html_counts, &json_counts)?;
    let mut referenced_media_paths = html_counts.media_paths.clone();
    referenced_media_paths.extend(json_counts.media_paths.iter().cloned());
    verify_media_inventory(&inventory, summary.media_included, &referenced_media_paths)?;
    verify_all_entries(&mut archive, password, &inventory)?;
    Ok(GeneratedArchiveValidation {
        entry_count: actual_names.len(),
        report_readable: true,
        partial: summary.partial,
        messages_included: summary.messages_included,
    })
}

fn verify_all_entries<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    password: Option<&str>,
    inventory: &ArchiveInventory,
) -> CoreResult<()> {
    for name in &inventory.ordered_names {
        let index = archive.index_for_name(name).ok_or_else(|| {
            CoreError::new("not-telearchive", format!("{name} disappeared from the ZIP directory."))
        })?;
        let encrypted =
            archive.by_index_raw(index).map_err(|error| map_zip_read_error(&error))?.encrypted();
        let mut file = if encrypted {
            let password = password.ok_or_else(|| {
                CoreError::new("password-required", "Enter the password used for this archive.")
            })?;
            archive
                .by_index_decrypt(index, password.as_bytes())
                .map_err(|error| map_zip_read_error(&error))?
        } else {
            archive.by_index(index).map_err(|error| map_zip_read_error(&error))?
        };
        std::io::copy(&mut file, &mut std::io::sink()).map_err(|_| {
            CoreError::new(
                "not-telearchive",
                format!("{name} could not be authenticated and read completely."),
            )
        })?;
    }
    Ok(())
}

fn read_text_entry<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    password: Option<&str>,
) -> CoreResult<String> {
    let index = archive.index_for_name(name).ok_or_else(|| {
        CoreError::new("not-telearchive", format!("{name} is missing from the ZIP."))
    })?;
    let encrypted =
        archive.by_index_raw(index).map_err(|error| map_zip_read_error(&error))?.encrypted();
    let mut file = if encrypted {
        let password = password.ok_or_else(|| {
            CoreError::new("password-required", "Enter the password used for this archive.")
        })?;
        archive
            .by_index_decrypt(index, password.as_bytes())
            .map_err(|error| map_zip_read_error(&error))?
    } else {
        archive.by_index(index).map_err(|error| map_zip_read_error(&error))?
    };
    let capacity = usize::try_from(file.size()).unwrap_or(0).min(8 * 1_024 * 1_024);
    let mut text = String::with_capacity(capacity);
    file.read_to_string(&mut text).map_err(|error| {
        CoreError::new("not-telearchive", format!("{name} is not readable UTF-8 text: {error}"))
    })?;
    Ok(text)
}

fn map_zip_read_error(error: &ZipError) -> CoreError {
    match error {
        ZipError::InvalidPassword => {
            CoreError::new("wrong-password", "The archive password is incorrect.")
        },
        ZipError::UnsupportedArchive(message) if *message == ZipError::PASSWORD_REQUIRED => {
            CoreError::new("password-required", "Enter the password used for this archive.")
        },
        _ => CoreError::new("not-telearchive", "The ZIP contents could not be read safely."),
    }
}

fn required_u64(value: Option<&Value>, field: &str, minimum: u64) -> CoreResult<u64> {
    let parsed = value.and_then(Value::as_u64).ok_or_else(|| {
        CoreError::new("not-telearchive", format!("export-summary.json has an invalid {field}."))
    })?;
    if parsed < minimum {
        return Err(CoreError::new(
            "not-telearchive",
            format!("export-summary.json has an invalid {field}."),
        ));
    }
    Ok(parsed)
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        write!(&mut result, "{byte:02x}").expect("writing to a String cannot fail");
    }
    result
}

fn validate_request_id(value: &str) -> CoreResult<()> {
    if value.is_empty() || value.len() > 128 {
        return Err(CoreError::invalid_request("The request ID is invalid."));
    }
    Ok(())
}

fn is_safe_basename(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
}

fn is_safe_archive_path(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_ENTRY_NAME_LENGTH
        || value.starts_with('/')
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return false;
    }
    let bytes = value.as_bytes();
    if bytes.first().is_some_and(u8::is_ascii_alphabetic) && bytes.get(1) == Some(&b':') {
        return false;
    }
    value.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        ArchiveBuilderCore, collect_html_media_paths, matches_archive_filename, verify_archive,
    };

    fn summary(encrypted: bool) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "formatVersion": "1.1",
            "historySource": "rendered-telegram-web",
            "contentUploaded": false,
            "completeHistoryNotGuaranteed": true,
            "archiveEncrypted": encrypted,
            "partial": false,
            "chatsIncluded": 1,
            "messagesIncluded": 1,
            "media": {"included": 0}
        }))
        .expect("summary fixture should serialize")
    }

    fn summary_with_media(encrypted: bool, media: u64) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "formatVersion": "1.1",
            "historySource": "rendered-telegram-web",
            "contentUploaded": false,
            "completeHistoryNotGuaranteed": true,
            "archiveEncrypted": encrypted,
            "partial": false,
            "chatsIncluded": 1,
            "messagesIncluded": 1,
            "media": {"included": media}
        }))
        .expect("summary fixture should serialize")
    }

    fn discord_result(encrypted: bool) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "messages": [{"id": 1, "file": "files/1.txt", "file_size": 4}],
            "telearchive": {
                "history_source": "rendered-discord-web",
                "content_uploaded": false,
                "complete_history_not_guaranteed": true,
                "archive_encrypted": encrypted,
                "messages_in_this_chat": 1
            }
        }))
        .expect("discord result fixture should serialize")
    }

    fn discord_summary() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "formatVersion": "1.1",
            "historySource": "rendered-discord-web",
            "contentUploaded": false,
            "completeHistoryNotGuaranteed": true,
            "archiveEncrypted": false,
            "partial": false,
            "chatsIncluded": 1,
            "messagesIncluded": 1,
            "media": {"included": 1}
        }))
        .expect("discord summary should serialize")
    }

    fn discord_summary_with_media(media: u64) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "formatVersion": "1.1",
            "historySource": "rendered-discord-web",
            "contentUploaded": false,
            "completeHistoryNotGuaranteed": true,
            "archiveEncrypted": false,
            "partial": false,
            "chatsIncluded": 1,
            "messagesIncluded": 1,
            "media": {"included": media}
        }))
        .expect("discord summary should serialize")
    }

    fn discord_result_with_attachments() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "messages": [{
                "id": 1,
                "file": "files/0001-one.txt",
                "attachments": [
                    {"type": "file", "url": "files/0001-one.txt", "name": "one.txt"},
                    {"type": "file", "url": "files/0002-two.txt", "name": "two.txt"}
                ]
            }],
            "telearchive": {
                "history_source": "rendered-discord-web",
                "content_uploaded": false,
                "complete_history_not_guaranteed": true,
                "archive_encrypted": false,
                "messages_in_this_chat": 1
            }
        }))
        .expect("discord attachment result should serialize")
    }

    fn discord_result_with_remote_attachment() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "messages": [{
                "id": 1,
                "attachments": [{
                    "type": "photo",
                    "url": "https://media.discordapp.net/attachments/1/image.png",
                    "name": "image.png"
                }]
            }],
            "telearchive": {
                "history_source": "rendered-discord-web",
                "content_uploaded": false,
                "complete_history_not_guaranteed": true,
                "archive_encrypted": false,
                "messages_in_this_chat": 1
            }
        }))
        .expect("discord remote attachment result should serialize")
    }

    fn result(encrypted: bool) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "messages": [{"id": 1}],
            "telearchive": {
                "history_source": "rendered-telegram-web",
                "content_uploaded": false,
                "complete_history_not_guaranteed": true,
                "archive_encrypted": encrypted,
                "messages_in_this_chat": 1
            }
        }))
        .expect("result fixture should serialize")
    }

    fn native_summary() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "formatVersion": "1.1",
            "historySource": "telegram-web-api",
            "contentUploaded": false,
            "completeHistoryNotGuaranteed": true,
            "archiveEncrypted": false,
            "partial": false,
            "chatsIncluded": 1,
            "messagesIncluded": 1,
            "media": {"included": 0}
        }))
        .expect("native summary fixture should serialize")
    }

    fn native_result() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "messages": [{"id": 1}],
            "telearchive": {
                "history_source": "telegram-web-api",
                "content_uploaded": false,
                "complete_history_not_guaranteed": true,
                "archive_encrypted": false,
                "messages_in_this_chat": 1
            }
        }))
        .expect("native result fixture should serialize")
    }

    #[test]
    fn creates_and_verifies_unencrypted_archive() {
        let mut builder = ArchiveBuilderCore::new("request-1".to_owned(), 6, None)
            .expect("builder should be valid");
        builder
            .add_entry("export-summary.json", &summary(false))
            .expect("summary should be accepted");
        builder.add_entry("result.json", &result(false)).expect("result should be accepted");
        let artifact = builder.finish().expect("archive should build");
        let receipt = verify_archive(
            &artifact.bytes,
            "verify-1".to_owned(),
            "archive.zip".to_owned(),
            "archive.zip",
            None,
        )
        .expect("archive should verify");
        assert_eq!(receipt.report.messages_included, 1);
        assert!(!receipt.encrypted);
    }

    #[test]
    fn creates_and_verifies_aes_archive() {
        let password = "correct horse battery staple";
        let mut builder =
            ArchiveBuilderCore::new("request-2".to_owned(), 6, Some(password.to_owned()))
                .expect("encrypted builder should be valid");
        builder
            .add_entry("export-summary.json", &summary(true))
            .expect("summary should be accepted");
        builder.add_entry("result.json", &result(true)).expect("result should be accepted");
        let artifact = builder.finish().expect("encrypted archive should build");
        assert!(
            verify_archive(
                &artifact.bytes,
                "verify-2".to_owned(),
                "archive.zip".to_owned(),
                "archive.zip",
                Some("wrong password")
            )
            .is_err()
        );
        let receipt = verify_archive(
            &artifact.bytes,
            "verify-3".to_owned(),
            "archive.zip".to_owned(),
            "archive.zip",
            Some(password),
        )
        .expect("encrypted archive should verify");
        assert!(receipt.encrypted);
    }

    #[test]
    fn accepts_telegram_web_api_history_source() {
        let mut builder = ArchiveBuilderCore::new("request-native".to_owned(), 6, None)
            .expect("builder should be valid");
        builder
            .add_entry("export-summary.json", &native_summary())
            .expect("native summary should be accepted");
        builder
            .add_entry("result.json", &native_result())
            .expect("native result should be accepted");
        let artifact = builder.finish().expect("archive should build");
        let receipt = verify_archive(
            &artifact.bytes,
            "verify-native".to_owned(),
            "native.zip".to_owned(),
            "native.zip",
            None,
        )
        .expect("native archive should verify");
        assert_eq!(receipt.report.messages_included, 1);
    }

    #[test]
    fn accepts_rendered_discord_archive_source() {
        let mut builder = ArchiveBuilderCore::new("request-discord".to_owned(), 6, None)
            .expect("builder should be valid");
        builder
            .add_entry("export-summary.json", &discord_summary())
            .expect("summary should be accepted");
        builder
            .add_entry("result.json", &discord_result(false))
            .expect("discord result should be accepted");
        builder.add_entry("files/1.txt", b"test").expect("attachment should be accepted");
        let artifact = builder.finish().expect("archive should build");
        let receipt = verify_archive(
            &artifact.bytes,
            "verify-discord".to_owned(),
            "discord.zip".to_owned(),
            "discord.zip",
            None,
        )
        .expect("discord archive should verify");
        assert_eq!(receipt.report.messages_included, 1);
        assert_eq!(receipt.report.media_included, 1);
    }

    #[test]
    fn accepts_discord_multiple_attachments() {
        let mut builder =
            ArchiveBuilderCore::new("request-discord-attachments".to_owned(), 6, None)
                .expect("builder should be valid");
        builder
            .add_entry("export-summary.json", &discord_summary_with_media(2))
            .expect("summary should be accepted");
        builder
            .add_entry("result.json", &discord_result_with_attachments())
            .expect("result should be accepted");
        builder
            .add_entry("files/0001-one.txt", b"one")
            .expect("first attachment should be accepted");
        builder
            .add_entry("files/0002-two.txt", b"two")
            .expect("second attachment should be accepted");
        let artifact = builder.finish().expect("archive should build");
        let receipt = verify_archive(
            &artifact.bytes,
            "verify-discord-attachments".to_owned(),
            "discord.zip".to_owned(),
            "discord.zip",
            None,
        )
        .expect("multi-attachment Discord archive should verify");
        assert_eq!(receipt.report.media_included, 2);
    }

    #[test]
    fn accepts_discord_remote_attachments_when_media_is_not_included() {
        let mut builder = ArchiveBuilderCore::new("request-discord-remote".to_owned(), 6, None)
            .expect("builder should be valid");
        builder
            .add_entry("export-summary.json", &discord_summary_with_media(0))
            .expect("summary should be accepted");
        builder
            .add_entry("result.json", &discord_result_with_remote_attachment())
            .expect("result should be accepted");
        let artifact = builder.finish().expect("archive should build");
        let receipt = verify_archive(
            &artifact.bytes,
            "verify-discord-remote".to_owned(),
            "discord.zip".to_owned(),
            "discord.zip",
            None,
        )
        .expect("Discord archive with remote-only attachments should verify");
        assert_eq!(receipt.report.media_included, 0);
    }

    #[test]
    fn accepts_telegram_thumbnail_entries_as_auxiliary_media() {
        let html = br#"<!doctype html><html><head>
            <meta name="local-archive-message-count" content="1">
            <meta name="local-archive-media-count" content="1">
            </head><body>
            <a href="video_files/video.mp4"><img src="video_files/video.mp4_thumb.jpg"></a>
            </body></html>"#;
        let mut builder = ArchiveBuilderCore::new("request-telegram-thumbnail".to_owned(), 6, None)
            .expect("builder should be valid");
        builder
            .add_entry("export-summary.json", &summary_with_media(false, 1))
            .expect("summary should be accepted");
        builder.add_entry("messages.html", html).expect("HTML should be accepted");
        builder
            .add_entry("video_files/video.mp4", b"video")
            .expect("primary video should be accepted");
        builder
            .add_entry("video_files/video.mp4_thumb.jpg", b"thumbnail")
            .expect("thumbnail should be accepted");
        let artifact = builder.finish().expect("archive should build");
        let receipt = verify_archive(
            &artifact.bytes,
            "verify-telegram-thumbnail".to_owned(),
            "telegram.zip".to_owned(),
            "telegram.zip",
            None,
        )
        .expect("Telegram archive with a thumbnail should verify");
        assert_eq!(receipt.report.media_included, 1);
    }

    #[test]
    fn rejects_unreferenced_or_missing_media_entries() {
        let mut builder = ArchiveBuilderCore::new("request-adversarial-media".to_owned(), 6, None)
            .expect("archive builder should be valid");
        builder
            .add_entry("export-summary.json", &discord_summary())
            .expect("summary should be accepted");
        builder
            .add_entry("result.json", &discord_result(false))
            .expect("result should be accepted");
        builder
            .add_entry("files/fake.txt", b"wrong")
            .expect("unreferenced media should be accepted until validation");
        assert!(
            builder.finish().is_err(),
            "archive validation must reject a ZIP whose media files do not match JSON references"
        );
    }

    #[test]
    fn extracts_only_local_media_paths_from_html() {
        let html = r#"<!doctype html><html><head></head><body>
            <a href="files/1.txt">local</a>
            <a href="https://cdn.example/files/remote.txt">remote</a>
        </body></html>"#;
        let paths = collect_html_media_paths(html, "messages.html")
            .expect("HTML media references should parse");
        assert_eq!(paths, ["files/1.txt".to_owned()].into_iter().collect());
    }

    #[test]
    fn accepts_firefox_duplicate_download_names() {
        assert!(matches_archive_filename("archive.zip", "archive.zip"));
        assert!(matches_archive_filename("archive (12).zip", "archive.zip"));
        assert!(!matches_archive_filename("archive (0).zip", "archive.zip"));
        assert!(!matches_archive_filename("other.zip", "archive.zip"));
    }
}
