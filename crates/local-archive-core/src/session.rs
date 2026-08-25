use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::archive::{ArchiveArtifactReceipt, matches_archive_filename};
use crate::error::{CoreError, CoreResult};
use crate::range::filter_messages_for_range;
use crate::request::QuickExportRequest;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportPhase {
    Ready,
    Collecting,
    Collected,
    BuildingArchive,
    ArchiveReady,
    Saving,
    Complete,
    Cancelled,
    Failed,
}

impl ExportPhase {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Complete | Self::Cancelled | Self::Failed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFailure {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionSnapshot {
    pub phase: ExportPhase,
    pub partial_requested: bool,
    pub message_count: usize,
    pub archive_entry_count: usize,
    pub archive_size: usize,
    pub encrypted: bool,
    pub archive_request_id: Option<String>,
    pub artifact_id: Option<String>,
    pub download_id: Option<u64>,
    pub filename: Option<String>,
    pub failure: Option<ExportFailure>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadCompleteReceipt {
    pub request_id: String,
    pub artifact_id: String,
    pub download_id: u64,
    pub filename: String,
    pub size: usize,
    pub state: String,
}

#[derive(Debug)]
pub struct ExportSessionCore {
    request: QuickExportRequest,
    phase: ExportPhase,
    partial_requested: bool,
    message_count: usize,
    archive_entry_count: usize,
    archive_size: usize,
    encrypted: bool,
    archive_request_id: Option<String>,
    artifact_id: Option<String>,
    download_id: Option<u64>,
    filename: Option<String>,
    failure: Option<ExportFailure>,
}

impl ExportSessionCore {
    pub fn new(request: QuickExportRequest) -> Self {
        Self {
            request,
            phase: ExportPhase::Ready,
            partial_requested: false,
            message_count: 0,
            archive_entry_count: 0,
            archive_size: 0,
            encrypted: false,
            archive_request_id: None,
            artifact_id: None,
            download_id: None,
            filename: None,
            failure: None,
        }
    }

    pub const fn request(&self) -> &QuickExportRequest {
        &self.request
    }

    pub fn snapshot(&self) -> ExportSessionSnapshot {
        ExportSessionSnapshot {
            phase: self.phase,
            partial_requested: self.partial_requested,
            message_count: self.message_count,
            archive_entry_count: self.archive_entry_count,
            archive_size: self.archive_size,
            encrypted: self.encrypted,
            archive_request_id: self.archive_request_id.clone(),
            artifact_id: self.artifact_id.clone(),
            download_id: self.download_id,
            filename: self.filename.clone(),
            failure: self.failure.clone(),
        }
    }

    pub fn begin_collection(&mut self) -> CoreResult<()> {
        self.transition(ExportPhase::Ready, ExportPhase::Collecting)
    }

    pub fn finish_collection(&mut self, messages: &[Value]) -> CoreResult<Vec<Value>> {
        self.require_phase(ExportPhase::Collecting)?;
        let filtered = filter_messages_for_range(messages, &self.request.range);
        if filtered.is_empty() {
            return Err(CoreError::new(
                "empty-range",
                "No messages were found in the selected range.",
            ));
        }
        self.message_count = filtered.len();
        self.phase = ExportPhase::Collected;
        Ok(filtered)
    }

    pub fn begin_archive(&mut self, request_id: String) -> CoreResult<()> {
        self.require_phase(ExportPhase::Collected)?;
        if request_id.is_empty() || request_id.len() > 128 {
            return Err(CoreError::invalid_transition("The archive request identity is invalid."));
        }
        self.archive_request_id = Some(request_id);
        self.phase = ExportPhase::BuildingArchive;
        Ok(())
    }

    pub fn archive_ready(&mut self, receipt: ArchiveArtifactReceipt) -> CoreResult<()> {
        self.require_phase(ExportPhase::BuildingArchive)?;
        receipt.validate()?;
        if self.archive_request_id.as_deref() != Some(receipt.request_id.as_str()) {
            return Err(CoreError::invalid_transition(
                "The archive receipt belongs to another export request.",
            ));
        }
        if receipt.partial != self.partial_requested {
            return Err(CoreError::invalid_transition(
                "The archive report disagrees with the session partial state.",
            ));
        }
        if usize::try_from(receipt.messages_included).ok() != Some(self.message_count) {
            return Err(CoreError::invalid_transition(
                "The archive report disagrees with the collected message count.",
            ));
        }
        self.archive_entry_count = receipt.entry_count;
        self.archive_size = receipt.size;
        self.encrypted = receipt.encrypted;
        self.artifact_id = Some(receipt.artifact_id);
        self.phase = ExportPhase::ArchiveReady;
        Ok(())
    }

    pub fn begin_save(&mut self, filename: String) -> CoreResult<()> {
        self.require_phase(ExportPhase::ArchiveReady)?;
        if filename.trim().is_empty() {
            return Err(CoreError::invalid_transition(
                "A download filename is required before saving.",
            ));
        }
        self.filename = Some(filename);
        self.phase = ExportPhase::Saving;
        Ok(())
    }

    pub fn complete(&mut self, receipt: &DownloadCompleteReceipt) -> CoreResult<()> {
        self.require_phase(ExportPhase::Saving)?;
        let requested_filename = self.filename.as_deref().ok_or_else(|| {
            CoreError::invalid_transition("The export has no bound download filename.")
        })?;
        if receipt.state != "complete"
            || receipt.download_id == 0
            || self.archive_request_id.as_deref() != Some(receipt.request_id.as_str())
            || self.artifact_id.as_deref() != Some(receipt.artifact_id.as_str())
            || self.archive_size != receipt.size
            || !matches_archive_filename(&receipt.filename, requested_filename)
        {
            return Err(CoreError::invalid_transition(
                "Firefox did not confirm the exact archive download as complete.",
            ));
        }
        self.download_id = Some(receipt.download_id);
        self.phase = ExportPhase::Complete;
        Ok(())
    }

    pub fn request_partial(&mut self) -> CoreResult<()> {
        if !matches!(
            self.phase,
            ExportPhase::Ready | ExportPhase::Collecting | ExportPhase::Collected
        ) {
            return Err(CoreError::invalid_transition(
                "An archive build or download cannot be relabelled as partial after it starts.",
            ));
        }
        self.partial_requested = true;
        Ok(())
    }

    pub fn fail(&mut self, code: String, message: String) -> CoreResult<()> {
        if self.phase.is_terminal() {
            return Err(CoreError::invalid_transition(
                "A terminal export session cannot fail again.",
            ));
        }
        self.failure = Some(ExportFailure { code, message });
        self.phase = ExportPhase::Failed;
        Ok(())
    }

    fn transition(&mut self, expected: ExportPhase, next: ExportPhase) -> CoreResult<()> {
        self.require_phase(expected)?;
        self.phase = next;
        Ok(())
    }

    fn require_phase(&self, expected: ExportPhase) -> CoreResult<()> {
        if self.phase == expected {
            return Ok(());
        }
        Err(CoreError::invalid_transition(format!(
            "Expected export phase {expected:?}, found {:?}.",
            self.phase
        )))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::archive::ArchiveArtifactReceipt;
    use crate::range::ExportRange;
    use crate::request::{ExportFormat, QuickExportLabels, QuickExportRequest};

    use super::{DownloadCompleteReceipt, ExportPhase, ExportSessionCore};

    fn request() -> QuickExportRequest {
        let label = String::new();
        QuickExportRequest {
            format: ExportFormat::Both,
            include_media: true,
            locale: "en".to_owned(),
            range: ExportRange::Recent { count: 2 },
            labels: QuickExportLabels {
                title: label.clone(),
                preparing: label.clone(),
                reading: label.clone(),
                saving: label.clone(),
                saved: label.clone(),
                failed: label.clone(),
                empty_range: label.clone(),
                messages: label.clone(),
                media_skipped: label.clone(),
                cancel: label.clone(),
                close: label.clone(),
                show_file: label.clone(),
                keep_open: label.clone(),
                elapsed: label.clone(),
                file: label,
            },
        }
    }

    #[test]
    fn rejects_out_of_order_transitions() {
        let mut session = ExportSessionCore::new(request());
        assert!(session.begin_archive("request-1".to_owned()).is_err());
        assert_eq!(session.snapshot().phase, ExportPhase::Ready);
    }

    #[test]
    fn owns_the_complete_export_lifecycle() {
        let mut session = ExportSessionCore::new(request());
        session.begin_collection().expect("collection should start");
        session.request_partial().expect("partial result should be requestable");
        let filtered = session
            .finish_collection(&[
                json!({"id": 1, "date_unixtime": 1}),
                json!({"id": 2, "date_unixtime": 2}),
                json!({"id": 3, "date_unixtime": 3}),
            ])
            .expect("collection should finish");
        assert_eq!(filtered.len(), 2);
        session.begin_archive("request-1".to_owned()).expect("archive build should start");
        session
            .archive_ready(ArchiveArtifactReceipt {
                request_id: "request-1".to_owned(),
                artifact_id: "a".repeat(64),
                size: 512,
                entry_count: 3,
                encrypted: false,
                partial: true,
                messages_included: 2,
                structure_verified: true,
                report_readable: true,
            })
            .expect("archive should become ready");
        session.begin_save("archive.zip".to_owned()).expect("save should start");
        session
            .complete(&DownloadCompleteReceipt {
                request_id: "request-1".to_owned(),
                artifact_id: "a".repeat(64),
                download_id: 42,
                filename: "archive.zip".to_owned(),
                size: 512,
                state: "complete".to_owned(),
            })
            .expect("save should complete");
        assert_eq!(session.snapshot().phase, ExportPhase::Complete);
        assert!(session.snapshot().partial_requested);
        assert!(session.request_partial().is_err());
    }
}
