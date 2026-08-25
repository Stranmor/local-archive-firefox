use std::fmt::{Display, Formatter};

use serde::Serialize;

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreError {
    pub code: String,
    pub message: String,
}

impl CoreError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new("invalid-request", message)
    }

    pub fn invalid_entry(message: impl Into<String>) -> Self {
        Self::new("invalid-entry", message)
    }

    pub fn invalid_transition(message: impl Into<String>) -> Self {
        Self::new("invalid-transition", message)
    }

    pub fn archive_engine(message: impl Into<String>) -> Self {
        Self::new("archive-engine-failed", message)
    }
}

impl Display for CoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CoreError {}
