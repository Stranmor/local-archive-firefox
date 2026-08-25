use std::cmp::Ordering;

use num_traits::ToPrimitive;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

use crate::error::{CoreError, CoreResult};

const DEFAULT_RECENT_COUNT: u32 = 500;
const MAX_RECENT_COUNT: u32 = 100_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum ExportRange {
    Recent { count: u32 },
    Dates { from: String, to: String },
    All,
}

impl Default for ExportRange {
    fn default() -> Self {
        Self::Recent {
            count: DEFAULT_RECENT_COUNT,
        }
    }
}

pub fn normalize_export_range(value: &Value) -> CoreResult<ExportRange> {
    let Some(object) = value.as_object() else {
        return Ok(ExportRange::default());
    };

    match object.get("mode").and_then(Value::as_str) {
        Some("all") => Ok(ExportRange::All),
        Some("dates") => {
            let from = object
                .get("from")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let to = object.get("to").and_then(Value::as_str).unwrap_or_default();
            if !is_calendar_date(from) || !is_calendar_date(to) {
                return Err(CoreError::invalid_request(
                    "A valid start and end date are required.",
                ));
            }
            if from > to {
                return Err(CoreError::invalid_request(
                    "The start date must not be later than the end date.",
                ));
            }
            Ok(ExportRange::Dates {
                from: from.to_owned(),
                to: to.to_owned(),
            })
        }
        _ => {
            let count = object
                .get("count")
                .and_then(number_from_value)
                .filter(|value| value.is_finite())
                .and_then(|value| {
                    value
                        .round()
                        .clamp(1.0, f64::from(MAX_RECENT_COUNT))
                        .to_u32()
                })
                .unwrap_or(DEFAULT_RECENT_COUNT);
            Ok(ExportRange::Recent { count })
        }
    }
}

pub fn filter_messages_for_range(messages: &[Value], range: &ExportRange) -> Vec<Value> {
    let mut ordered = messages.to_vec();
    ordered.sort_by(compare_messages_chronologically);

    match range {
        ExportRange::Recent { count } => {
            let keep = usize::try_from(*count).unwrap_or(usize::MAX);
            let start = ordered.len().saturating_sub(keep);
            ordered.split_off(start)
        }
        ExportRange::Dates { from, to } => ordered
            .into_iter()
            .filter(|message| {
                message_calendar_date(message).is_some_and(|date| {
                    date.as_str() >= from.as_str() && date.as_str() <= to.as_str()
                })
            })
            .collect(),
        ExportRange::All => ordered,
    }
}

pub fn is_calendar_date(value: &str) -> bool {
    if value.len() != 10 {
        return false;
    }
    let bytes = value.as_bytes();
    if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return false;
    }
    if bytes
        .iter()
        .enumerate()
        .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return false;
    }
    let Ok(year) = value[0..4].parse::<i32>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u32>() else {
        return false;
    };
    if year == 0 || !(1..=12).contains(&month) {
        return false;
    }
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

fn is_leap_year(year: i32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn number_from_value(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

fn compare_messages_chronologically(left: &Value, right: &Value) -> Ordering {
    let left_time = message_unix_seconds(left).unwrap_or(0.0);
    let right_time = message_unix_seconds(right).unwrap_or(0.0);
    left_time
        .total_cmp(&right_time)
        .then_with(|| message_id(left).cmp(&message_id(right)))
}

fn message_unix_seconds(message: &Value) -> Option<f64> {
    let object = message.as_object()?;
    object.get("date_unixtime").and_then(number_from_value)
}

fn message_id(message: &Value) -> i64 {
    message
        .as_object()
        .and_then(|object| object.get("id"))
        .and_then(number_from_value)
        .and_then(|value| value.round().to_i64())
        .unwrap_or_default()
}

fn message_calendar_date(message: &Value) -> Option<String> {
    let object = message.as_object()?;
    if let Some(prefix) = object
        .get("date")
        .and_then(Value::as_str)
        .and_then(|date| date.get(..10))
        .filter(|prefix| is_calendar_date(prefix))
    {
        return Some(prefix.to_owned());
    }

    let seconds = object
        .get("date_unixtime")
        .and_then(number_from_value)?
        .floor()
        .to_i64()?;
    OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .map(|date_time| date_time.date().to_string())
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::{ExportRange, filter_messages_for_range, is_calendar_date, normalize_export_range};

    #[test]
    fn validates_calendar_dates() {
        assert!(is_calendar_date("2024-02-29"));
        assert!(!is_calendar_date("2023-02-29"));
        assert!(!is_calendar_date("2026-13-01"));
    }

    #[test]
    fn normalizes_recent_count() {
        assert_eq!(
            normalize_export_range(&json!({"mode": "recent", "count": 0}))
                .expect("recent range should normalize"),
            ExportRange::Recent { count: 1 }
        );
        assert_eq!(
            normalize_export_range(&json!({"mode": "recent", "count": 200_000}))
                .expect("recent range should clamp"),
            ExportRange::Recent { count: 100_000 }
        );
    }

    #[test]
    fn filters_dates_inclusively_and_sorts() {
        let messages = vec![
            json!({"id": 3, "date": "2026-08-03T10:00:00.000Z", "date_unixtime": 3}),
            json!({"id": 1, "date": "2026-08-01T10:00:00.000Z", "date_unixtime": 1}),
            json!({"id": 2, "date": "2026-08-02T10:00:00.000Z", "date_unixtime": 2}),
        ];
        let filtered = filter_messages_for_range(
            &messages,
            &ExportRange::Dates {
                from: "2026-08-02".to_owned(),
                to: "2026-08-03".to_owned(),
            },
        );
        assert_eq!(
            filtered,
            vec![
                messages.get(2).expect("third fixture message").clone(),
                messages.first().expect("first fixture message").clone(),
            ]
        );
    }
}
