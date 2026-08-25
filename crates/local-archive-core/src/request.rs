use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{CoreError, CoreResult};
use crate::range::{ExportRange, normalize_export_range};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Both,
    Html,
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickExportLabels {
    pub title: String,
    pub preparing: String,
    pub reading: String,
    pub saving: String,
    pub saved: String,
    pub failed: String,
    pub empty_range: String,
    pub messages: String,
    pub media_skipped: String,
    pub cancel: String,
    pub close: String,
    pub show_file: String,
    pub keep_open: String,
    pub elapsed: String,
    pub file: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickExportRequest {
    pub format: ExportFormat,
    pub include_media: bool,
    pub locale: String,
    pub range: ExportRange,
    pub labels: QuickExportLabels,
}

pub fn normalize_quick_export_request(value: &Value) -> CoreResult<QuickExportRequest> {
    let object = value
        .as_object()
        .ok_or_else(|| CoreError::invalid_request("Export request is missing."))?;

    let format = match object.get("format").and_then(Value::as_str) {
        Some("html") => ExportFormat::Html,
        Some("json") => ExportFormat::Json,
        _ => ExportFormat::Both,
    };
    let include_media = object.get("includeMedia").and_then(Value::as_bool) != Some(false);
    let locale = object
        .get("locale")
        .and_then(Value::as_str)
        .unwrap_or("en")
        .chars()
        .take(16)
        .collect::<String>();
    let range = normalize_export_range(object.get("range").unwrap_or(&Value::Null))?;
    let labels_value = object
        .get("labels")
        .cloned()
        .ok_or_else(|| CoreError::invalid_request("Export labels are missing."))?;
    let labels = serde_json::from_value(labels_value)
        .map_err(|_| CoreError::invalid_request("Export labels are incomplete."))?;

    Ok(QuickExportRequest {
        format,
        include_media,
        locale: if locale.is_empty() {
            "en".to_owned()
        } else {
            locale
        },
        range,
        labels,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{ExportFormat, normalize_quick_export_request};

    fn labels() -> Value {
        json!({
            "title": "Export",
            "preparing": "Preparing",
            "reading": "Reading",
            "saving": "Saving",
            "saved": "Saved",
            "failed": "Failed",
            "emptyRange": "Empty",
            "messages": "messages",
            "mediaSkipped": "skipped",
            "cancel": "Cancel",
            "close": "Close",
            "showFile": "Show",
            "keepOpen": "Keep open",
            "elapsed": "Elapsed: {time}",
            "file": "ZIP: {filename} · {size}"
        })
    }

    #[test]
    fn normalizes_complete_request() {
        let request = normalize_quick_export_request(&json!({
            "format": "json",
            "includeMedia": false,
            "locale": "ru-RU-extra-long-locale",
            "range": {"mode": "recent", "count": 42},
            "labels": labels()
        }))
        .expect("complete request should normalize");
        assert_eq!(request.format, ExportFormat::Json);
        assert!(!request.include_media);
        assert_eq!(request.locale, "ru-RU-extra-long");
    }
}
