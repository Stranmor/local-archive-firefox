use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::error::{CoreError, CoreResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CapabilitySupport(bool);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectorHistoryMode {
    None,
    RenderedCurrent,
    RenderedScroll,
    BackgroundRendered,
    Native,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorHistoryCapabilities {
    pub mode: ConnectorHistoryMode,
    pub full_conversation: CapabilitySupport,
    pub date_range: CapabilitySupport,
    pub automatic: CapabilitySupport,
    pub user_visible_scroll: CapabilitySupport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorCapabilities {
    pub current_conversation: CapabilitySupport,
    pub multiple_conversations: CapabilitySupport,
    pub categories: CapabilitySupport,
    pub media: CapabilitySupport,
    pub history_target: CapabilitySupport,
    pub history: ConnectorHistoryCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveConnectorDescriptor {
    pub id: String,
    pub display_name: String,
    pub conversation_label: String,
    pub conversations_label: String,
    pub surface_label: String,
    pub launch_url: String,
    pub allowed_origins: Vec<String>,
    pub entrypoint: String,
    pub capabilities: ConnectorCapabilities,
}

pub fn normalize_connector_descriptor(value: &Value) -> CoreResult<ArchiveConnectorDescriptor> {
    let descriptor: ArchiveConnectorDescriptor = serde_json::from_value(value.clone())
        .map_err(|_| CoreError::invalid_request("The connector descriptor is incomplete."))?;
    validate_identifier(&descriptor.id)?;
    validate_text(&descriptor.display_name, "display name", 64)?;
    validate_text(&descriptor.conversation_label, "conversation label", 32)?;
    validate_text(&descriptor.conversations_label, "conversations label", 32)?;
    validate_text(&descriptor.surface_label, "surface label", 120)?;
    let launch = Url::parse(&descriptor.launch_url)
        .map_err(|_| CoreError::invalid_request("The connector launch URL is invalid."))?;
    if launch.scheme() != "https" || launch.host_str().is_none() {
        return Err(CoreError::invalid_request("The connector launch URL must use HTTPS."));
    }
    if descriptor.allowed_origins.is_empty() || descriptor.allowed_origins.len() > 32 {
        return Err(CoreError::invalid_request(
            "A connector must declare between one and 32 allowed origins.",
        ));
    }
    for origin in &descriptor.allowed_origins {
        validate_origin(origin)?;
    }
    let launch_origin = launch.origin().ascii_serialization();
    if !descriptor.allowed_origins.iter().any(|origin| origin == &launch_origin) {
        return Err(CoreError::invalid_request(
            "The connector launch URL must belong to an allowed origin.",
        ));
    }
    if !is_safe_extension_entrypoint(&descriptor.entrypoint) {
        return Err(CoreError::invalid_request(
            "The connector entrypoint must be an absolute extension JavaScript path.",
        ));
    }
    Ok(descriptor)
}

fn is_safe_extension_entrypoint(value: &str) -> bool {
    if value.len() < 4
        || value.len() > 256
        || !value.starts_with('/')
        || value.starts_with("//")
        || value.contains(['\\', '?', '#', '%'])
        || !std::path::Path::new(value)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("js"))
        || value.chars().any(char::is_control)
    {
        return false;
    }
    value[1..].split('/').all(|segment| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    })
}

pub fn connector_matches_origin(allowed_origins: &[String], origin: &str) -> bool {
    validate_origin(origin).is_ok() && allowed_origins.iter().any(|allowed| allowed == origin)
}

fn validate_identifier(value: &str) -> CoreResult<()> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(CoreError::invalid_request("The connector ID is invalid."));
    }
    Ok(())
}

fn validate_text(value: &str, field: &str, maximum: usize) -> CoreResult<()> {
    if value.trim().is_empty()
        || value.chars().count() > maximum
        || value.chars().any(char::is_control)
    {
        return Err(CoreError::invalid_request(format!("The connector {field} is invalid.")));
    }
    Ok(())
}

fn validate_origin(value: &str) -> CoreResult<()> {
    let url = Url::parse(value)
        .map_err(|_| CoreError::invalid_request("A connector origin is invalid."))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.origin().ascii_serialization() != value
    {
        return Err(CoreError::invalid_request(
            "Connector origins must be canonical HTTPS origins.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{connector_matches_origin, normalize_connector_descriptor};

    #[test]
    fn validates_and_matches_connector_origins() {
        let connector = normalize_connector_descriptor(&json!({
            "id": "telegram-web",
            "displayName": "Telegram",
            "conversationLabel": "chat",
            "conversationsLabel": "chats",
            "surfaceLabel": "this Telegram tab",
            "launchUrl": "https://web.telegram.org/k/",
            "allowedOrigins": ["https://web.telegram.org"],
            "entrypoint": "/telegram-exporter.js",
            "capabilities": {
                "currentConversation": true,
                "multipleConversations": true,
                "categories": true,
                "media": true,
                "historyTarget": true,
                "history": {
                    "mode": "background-rendered",
                    "fullConversation": true,
                    "dateRange": true,
                    "automatic": true,
                    "userVisibleScroll": false
                }
            }
        }))
        .expect("connector fixture should be valid");
        assert!(connector_matches_origin(&connector.allowed_origins, "https://web.telegram.org"));
        assert!(!connector_matches_origin(&connector.allowed_origins, "https://discord.com"));
    }

    #[test]
    fn rejects_entrypoint_path_confusion() {
        for entrypoint in [
            "/../other.js",
            "/folder/./other.js",
            "/other.js?next=/trusted.js",
            "/other.js#trusted",
            "/folder\\other.js",
            "//other.js",
        ] {
            let result = normalize_connector_descriptor(&json!({
                "id": "telegram-web",
                "displayName": "Telegram",
                "conversationLabel": "chat",
                "conversationsLabel": "chats",
                "surfaceLabel": "this Telegram tab",
                "launchUrl": "https://web.telegram.org/k/",
                "allowedOrigins": ["https://web.telegram.org"],
                "entrypoint": entrypoint,
                "capabilities": {
                    "currentConversation": true,
                    "multipleConversations": true,
                    "categories": true,
                "media": true,
                    "historyTarget": true,
                    "history": {
                        "mode": "background-rendered",
                        "fullConversation": true,
                        "dateRange": true,
                        "automatic": true,
                        "userVisibleScroll": false
                    }
                }
            }));
            assert!(result.is_err(), "accepted unsafe entrypoint {entrypoint}");
        }
    }
}
