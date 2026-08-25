use num_traits::ToPrimitive;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::request::ExportFormat;

const DEFAULT_RECENT_COUNT: u32 = 500;
const MAX_RECENT_COUNT: u32 = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PreferenceFlag(bool);

impl PreferenceFlag {
    const fn value(self) -> bool {
        self.0
    }
}

impl From<bool> for PreferenceFlag {
    fn from(value: bool) -> Self {
        Self(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreferences {
    pub onboarding_completed: PreferenceFlag,
    pub format_html: PreferenceFlag,
    pub format_json: PreferenceFlag,
    pub export_photos: PreferenceFlag,
    pub export_videos: PreferenceFlag,
    pub export_voice: PreferenceFlag,
    pub export_stickers: PreferenceFlag,
    pub export_files: PreferenceFlag,
    pub max_photo_size_mb: u32,
    pub max_video_size_mb: u32,
    pub max_file_size_mb: u32,
}

impl Default for ExportPreferences {
    fn default() -> Self {
        Self {
            onboarding_completed: false.into(),
            format_html: true.into(),
            format_json: true.into(),
            export_photos: true.into(),
            export_videos: false.into(),
            export_voice: true.into(),
            export_stickers: true.into(),
            export_files: false.into(),
            max_photo_size_mb: 10,
            max_video_size_mb: 100,
            max_file_size_mb: 100,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickExportDefaults {
    pub format: ExportFormat,
    pub include_media: bool,
    pub recent_count: u32,
}

impl Default for QuickExportDefaults {
    fn default() -> Self {
        Self {
            format: ExportFormat::Both,
            include_media: true,
            recent_count: DEFAULT_RECENT_COUNT,
        }
    }
}

pub fn normalize_preferences(value: &Value) -> ExportPreferences {
    let defaults = ExportPreferences::default();
    let Some(object) = value.as_object() else {
        return defaults;
    };
    let raw_html = boolean(object.get("formatHtml"), defaults.format_html.value());
    let raw_json = boolean(object.get("formatJson"), defaults.format_json.value());
    let (format_html, format_json) = if raw_html || raw_json {
        (raw_html.into(), raw_json.into())
    } else {
        (true.into(), true.into())
    };
    ExportPreferences {
        onboarding_completed: boolean(
            object.get("onboardingCompleted"),
            defaults.onboarding_completed.value(),
        )
        .into(),
        format_html,
        format_json,
        export_photos: boolean(object.get("exportPhotos"), defaults.export_photos.value()).into(),
        export_videos: boolean(object.get("exportVideos"), defaults.export_videos.value()).into(),
        export_voice: boolean(object.get("exportVoice"), defaults.export_voice.value()).into(),
        export_stickers: boolean(
            object.get("exportStickers"),
            defaults.export_stickers.value(),
        )
        .into(),
        export_files: boolean(object.get("exportFiles"), defaults.export_files.value()).into(),
        max_photo_size_mb: bounded_u32(object.get("maxPhotoSizeMb"), 1, 10_000, 10),
        max_video_size_mb: bounded_u32(object.get("maxVideoSizeMb"), 1, 20_000, 100),
        max_file_size_mb: bounded_u32(object.get("maxFileSizeMb"), 1, 20_000, 100),
    }
}

pub fn normalize_quick_export_defaults(value: &Value) -> QuickExportDefaults {
    let Some(object) = value.as_object() else {
        return QuickExportDefaults::default();
    };
    let format = match object.get("format").and_then(Value::as_str) {
        Some("html") => ExportFormat::Html,
        Some("json") => ExportFormat::Json,
        _ => ExportFormat::Both,
    };
    QuickExportDefaults {
        format,
        include_media: object.get("includeMedia").and_then(Value::as_bool) != Some(false),
        recent_count: bounded_u32(
            object.get("recentCount"),
            1,
            MAX_RECENT_COUNT,
            DEFAULT_RECENT_COUNT,
        ),
    }
}

fn boolean(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

fn bounded_u32(value: Option<&Value>, minimum: u32, maximum: u32, fallback: u32) -> u32 {
    value
        .and_then(number_from_value)
        .filter(|number| number.is_finite())
        .and_then(|number| {
            number
                .round()
                .clamp(f64::from(minimum), f64::from(maximum))
                .to_u32()
        })
        .unwrap_or(fallback)
}

fn number_from_value(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::{
        ExportPreferences, QuickExportDefaults, normalize_preferences,
        normalize_quick_export_defaults,
    };
    use crate::request::ExportFormat;

    #[test]
    fn repairs_invalid_preferences() {
        assert_eq!(
            normalize_preferences(&json!({
                "formatHtml": false,
                "formatJson": false,
                "maxPhotoSizeMb": -8,
                "maxVideoSizeMb": "invalid",
                "maxFileSizeMb": 999_999
            })),
            ExportPreferences {
                format_html: true.into(),
                format_json: true.into(),
                max_photo_size_mb: 1,
                max_file_size_mb: 20_000,
                ..ExportPreferences::default()
            }
        );
    }

    #[test]
    fn normalizes_quick_defaults() {
        assert_eq!(
            normalize_quick_export_defaults(&json!({
                "format": "pdf",
                "includeMedia": false,
                "recentCount": 999_999
            })),
            QuickExportDefaults {
                format: ExportFormat::Both,
                include_media: false,
                recent_count: 100_000,
            }
        );
    }
}
