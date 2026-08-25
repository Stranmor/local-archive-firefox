use serde::Serialize;
use serde_json::Value;
use wasm_bindgen::prelude::*;

use crate::archive::{
    ArchiveArtifactCore, ArchiveArtifactReceipt, ArchiveBuilderCore, validate_archive_password,
    verify_archive,
};
use crate::connector::{connector_matches_origin, normalize_connector_descriptor};
use crate::error::CoreError;
use crate::range::{filter_messages_for_range, normalize_export_range};
use crate::request::normalize_quick_export_request;
use crate::session::{DownloadCompleteReceipt, ExportSessionCore};
use crate::settings::{normalize_preferences, normalize_quick_export_defaults};

fn from_js(value: JsValue, description: &str) -> Result<Value, JsValue> {
    serde_wasm_bindgen::from_value(value).map_err(|_| {
        to_js_error(CoreError::invalid_request(format!(
            "{description} is not valid structured data."
        )))
    })
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
        .map_err(|error| {
            to_js_error(CoreError::archive_engine(format!(
                "Rust could not serialize its result: {error}"
            )))
        })
}

fn to_js_error(error: CoreError) -> JsValue {
    error
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
        .unwrap_or_else(|_| JsValue::from_str("local-archive-core-error"))
}

#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[wasm_bindgen(js_name = normalizeExportRange)]
pub fn normalize_export_range_js(value: JsValue) -> Result<JsValue, JsValue> {
    let value = from_js(value, "Export range")?;
    normalize_export_range(&value)
        .map_err(to_js_error)
        .and_then(|range| to_js(&range))
}

#[wasm_bindgen(js_name = normalizeQuickExportRequest)]
pub fn normalize_quick_export_request_js(value: JsValue) -> Result<JsValue, JsValue> {
    let value = from_js(value, "Export request")?;
    normalize_quick_export_request(&value)
        .map_err(to_js_error)
        .and_then(|request| to_js(&request))
}

#[wasm_bindgen(js_name = normalizePreferences)]
pub fn normalize_preferences_js(value: JsValue) -> Result<JsValue, JsValue> {
    let value = from_js(value, "Preferences")?;
    to_js(&normalize_preferences(&value))
}

#[wasm_bindgen(js_name = normalizeQuickExportDefaults)]
pub fn normalize_quick_export_defaults_js(value: JsValue) -> Result<JsValue, JsValue> {
    let value = from_js(value, "Quick export defaults")?;
    to_js(&normalize_quick_export_defaults(&value))
}

#[wasm_bindgen(js_name = normalizeConnectorDescriptor)]
pub fn normalize_connector_descriptor_js(value: JsValue) -> Result<JsValue, JsValue> {
    let value = from_js(value, "Connector descriptor")?;
    normalize_connector_descriptor(&value)
        .map_err(to_js_error)
        .and_then(|descriptor| to_js(&descriptor))
}

#[wasm_bindgen(js_name = connectorMatchesOrigin)]
pub fn connector_matches_origin_js(
    allowed_origins: JsValue,
    origin: &str,
) -> Result<bool, JsValue> {
    let value = from_js(allowed_origins, "Allowed connector origins")?;
    let allowed_origins = serde_json::from_value::<Vec<String>>(value).map_err(|_| {
        to_js_error(CoreError::invalid_request(
            "Allowed connector origins must be an array of strings.",
        ))
    })?;
    Ok(connector_matches_origin(&allowed_origins, origin))
}

#[wasm_bindgen(js_name = filterMessagesForRange)]
pub fn filter_messages_for_range_js(messages: JsValue, range: JsValue) -> Result<JsValue, JsValue> {
    let messages = from_js(messages, "Messages")?;
    let messages = messages
        .as_array()
        .ok_or_else(|| to_js_error(CoreError::invalid_request("Messages must be an array.")))?;
    let range = from_js(range, "Export range")?;
    let range = normalize_export_range(&range).map_err(to_js_error)?;
    to_js(&filter_messages_for_range(messages, &range))
}

#[wasm_bindgen(js_name = matchesArchiveFilename)]
pub fn matches_archive_filename_js(actual_name: &str, requested_name: &str) -> bool {
    crate::archive::matches_archive_filename(actual_name, requested_name)
}

#[wasm_bindgen(js_name = validateArchivePassword)]
pub fn validate_archive_password_js(value: &str) -> Result<(), JsValue> {
    validate_archive_password(value).map_err(to_js_error)
}

#[wasm_bindgen(js_name = ArchiveBuilder)]
pub struct WasmArchiveBuilder {
    inner: Option<ArchiveBuilderCore>,
}

#[wasm_bindgen(js_class = ArchiveBuilder)]
impl WasmArchiveBuilder {
    #[wasm_bindgen(constructor)]
    pub fn new(
        request_id: String,
        compression_level: f64,
        password: Option<String>,
    ) -> Result<Self, JsValue> {
        if !compression_level.is_finite()
            || compression_level.fract() != 0.0
            || !(0.0..=9.0).contains(&compression_level)
        {
            return Err(to_js_error(CoreError::invalid_request(
                "Compression level must be an integer between 0 and 9.",
            )));
        }
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let compression_level = compression_level as u8;
        ArchiveBuilderCore::new(request_id, compression_level, password)
            .map(|inner| Self { inner: Some(inner) })
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = addEntry)]
    pub fn add_entry(&mut self, name: &str, bytes: &[u8]) -> Result<(), JsValue> {
        self.inner
            .as_mut()
            .ok_or_else(|| {
                to_js_error(CoreError::invalid_transition(
                    "This archive builder has already been finished.",
                ))
            })?
            .add_entry(name, bytes)
            .map_err(to_js_error)
    }

    pub fn finish(&mut self) -> Result<WasmArchiveArtifact, JsValue> {
        let inner = self.inner.take().ok_or_else(|| {
            to_js_error(CoreError::invalid_transition(
                "This archive builder has already been finished.",
            ))
        })?;
        inner
            .finish()
            .map(WasmArchiveArtifact::from)
            .map_err(to_js_error)
    }
}

#[wasm_bindgen(js_name = ArchiveArtifact)]
pub struct WasmArchiveArtifact {
    inner: ArchiveArtifactCore,
}

impl From<ArchiveArtifactCore> for WasmArchiveArtifact {
    fn from(inner: ArchiveArtifactCore) -> Self {
        Self { inner }
    }
}

#[wasm_bindgen(js_class = ArchiveArtifact)]
impl WasmArchiveArtifact {
    #[wasm_bindgen(getter, js_name = requestId)]
    pub fn request_id(&self) -> String {
        self.inner.request_id.clone()
    }

    #[wasm_bindgen(getter, js_name = artifactId)]
    pub fn artifact_id(&self) -> String {
        self.inner.artifact_id.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn size(&self) -> usize {
        self.inner.size
    }

    #[wasm_bindgen(getter, js_name = entryCount)]
    pub fn entry_count(&self) -> usize {
        self.inner.entry_count
    }

    #[wasm_bindgen(getter)]
    pub fn encrypted(&self) -> bool {
        self.inner.encrypted
    }

    #[wasm_bindgen(getter)]
    pub fn partial(&self) -> bool {
        self.inner.partial
    }

    #[wasm_bindgen(getter, js_name = messagesIncluded)]
    pub fn messages_included(&self) -> u64 {
        self.inner.messages_included
    }

    #[wasm_bindgen(getter, js_name = structureVerified)]
    pub fn structure_verified(&self) -> bool {
        self.inner.structure_verified
    }

    #[wasm_bindgen(getter, js_name = reportReadable)]
    pub fn report_readable(&self) -> bool {
        self.inner.report_readable
    }

    pub fn bytes(&self) -> Vec<u8> {
        self.inner.bytes.clone()
    }
}

#[wasm_bindgen(js_name = verifyArchive)]
pub fn verify_archive_js(
    bytes: &[u8],
    request_id: String,
    filename: String,
    expected_filename: String,
    password: Option<String>,
) -> Result<JsValue, JsValue> {
    verify_archive(
        bytes,
        request_id,
        filename,
        &expected_filename,
        password.as_deref(),
    )
    .map_err(to_js_error)
    .and_then(|receipt| to_js(&receipt))
}

#[wasm_bindgen(js_name = ExportSession)]
pub struct WasmExportSession {
    inner: ExportSessionCore,
}

#[wasm_bindgen(js_class = ExportSession)]
impl WasmExportSession {
    #[wasm_bindgen(constructor)]
    pub fn new(request: JsValue) -> Result<Self, JsValue> {
        let value = from_js(request, "Export request")?;
        let request = normalize_quick_export_request(&value).map_err(to_js_error)?;
        Ok(Self {
            inner: ExportSessionCore::new(request),
        })
    }

    pub fn request(&self) -> Result<JsValue, JsValue> {
        to_js(self.inner.request())
    }

    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        to_js(&self.inner.snapshot())
    }

    #[wasm_bindgen(js_name = beginCollection)]
    pub fn begin_collection(&mut self) -> Result<(), JsValue> {
        self.inner.begin_collection().map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = finishCollection)]
    pub fn finish_collection(&mut self, messages: JsValue) -> Result<JsValue, JsValue> {
        let value = from_js(messages, "Messages")?;
        let messages = value
            .as_array()
            .ok_or_else(|| to_js_error(CoreError::invalid_request("Messages must be an array.")))?;
        self.inner
            .finish_collection(messages)
            .map_err(to_js_error)
            .and_then(|filtered| to_js(&filtered))
    }

    #[wasm_bindgen(js_name = beginArchive)]
    pub fn begin_archive(&mut self, request_id: String) -> Result<(), JsValue> {
        self.inner.begin_archive(request_id).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = archiveReady)]
    pub fn archive_ready(&mut self, receipt: JsValue) -> Result<(), JsValue> {
        let receipt =
            serde_wasm_bindgen::from_value::<ArchiveArtifactReceipt>(receipt).map_err(|_| {
                to_js_error(CoreError::invalid_request(
                    "The archive validation receipt is incomplete.",
                ))
            })?;
        self.inner.archive_ready(receipt).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = beginSave)]
    pub fn begin_save(&mut self, filename: String) -> Result<(), JsValue> {
        self.inner.begin_save(filename).map_err(to_js_error)
    }

    pub fn complete(&mut self, receipt: JsValue) -> Result<(), JsValue> {
        let receipt =
            serde_wasm_bindgen::from_value::<DownloadCompleteReceipt>(receipt).map_err(|_| {
                to_js_error(CoreError::invalid_request(
                    "The Firefox download receipt is incomplete.",
                ))
            })?;
        self.inner.complete(&receipt).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = requestPartial)]
    pub fn request_partial(&mut self) -> Result<(), JsValue> {
        self.inner.request_partial().map_err(to_js_error)
    }

    pub fn fail(&mut self, code: String, message: String) -> Result<(), JsValue> {
        self.inner.fail(code, message).map_err(to_js_error)
    }
}
