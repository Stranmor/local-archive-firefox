export type ConnectorHistoryMode =
  | 'none'
  | 'rendered-current'
  | 'rendered-scroll'
  | 'background-rendered'
  | 'native';

export interface ArchiveConnectorHistoryCapabilities {
  mode: ConnectorHistoryMode;
  fullConversation: boolean;
  dateRange: boolean;
  automatic: boolean;
  userVisibleScroll: boolean;
}

export interface ArchiveConnectorDescriptor {
  id: string;
  displayName: string;
  conversationLabel: string;
  conversationsLabel: string;
  surfaceLabel: string;
  launchUrl: string;
  allowedOrigins: readonly string[];
  entrypoint: string;
  capabilities: {
    currentConversation: boolean;
    multipleConversations: boolean;
    categories: boolean;
    media: boolean;
    historyTarget: boolean;
    history: ArchiveConnectorHistoryCapabilities;
  };
}

export function defineArchiveConnector(
  descriptor: ArchiveConnectorDescriptor,
): Readonly<ArchiveConnectorDescriptor> {
  const normalized = normalizeConnectorDescriptorInRust<ArchiveConnectorDescriptor>(descriptor);
  return Object.freeze({
    ...normalized,
    allowedOrigins: Object.freeze([...normalized.allowedOrigins]),
    capabilities: Object.freeze({ ...normalized.capabilities }),
  });
}

export function connectorMatchesUrl(
  connector: ArchiveConnectorDescriptor,
  value: string | undefined,
): boolean {
  if (!value) return false;
  try {
    return connectorMatchesOriginInRust(connector.allowedOrigins, new URL(value).origin);
  } catch {
    return false;
  }
}
import {
  connectorMatchesOriginInRust,
  normalizeConnectorDescriptorInRust,
} from '@/src/rust/core';
