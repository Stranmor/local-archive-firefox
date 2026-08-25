import {
  connectorMatchesUrl,
  type ArchiveConnectorDescriptor,
} from '@/src/shared/connector';
import { telegramWebConnector } from '@/src/connectors/telegram-web';

export const archiveConnectors = Object.freeze([
  telegramWebConnector,
] satisfies readonly ArchiveConnectorDescriptor[]);

export const defaultArchiveConnector = telegramWebConnector;

export function findArchiveConnector(
  url: string | undefined,
): ArchiveConnectorDescriptor | undefined {
  return archiveConnectors.find((connector) => connectorMatchesUrl(connector, url));
}
