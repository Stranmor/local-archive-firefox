mod archive;
mod connector;
mod error;
mod range;
mod request;
mod session;
mod settings;

pub use archive::{
    ArchiveArtifactCore, ArchiveBuilderCore, ArchiveVerifyReceipt, matches_archive_filename,
    verify_archive,
};
pub use connector::{
    ArchiveConnectorDescriptor, CapabilitySupport, ConnectorCapabilities,
    ConnectorHistoryCapabilities, ConnectorHistoryMode, connector_matches_origin,
    normalize_connector_descriptor,
};
pub use error::{CoreError, CoreResult};
pub use range::{ExportRange, filter_messages_for_range, normalize_export_range};
pub use request::{
    ExportFormat, QuickExportLabels, QuickExportRequest, normalize_quick_export_request,
};
pub use session::{ExportPhase, ExportSessionCore, ExportSessionSnapshot};
pub use settings::{
    ExportPreferences, PreferenceFlag, QuickExportDefaults, normalize_preferences,
    normalize_quick_export_defaults,
};

#[cfg(target_arch = "wasm32")]
mod wasm;
