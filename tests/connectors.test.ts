import { describe, expect, it } from 'vitest';
import {
  archiveConnectors,
  defaultArchiveConnector,
  findArchiveConnector,
} from '@/src/connectors';

describe('archive connector registry', () => {
  it('identifies the shipped Telegram Web connector by origin', () => {
    expect(findArchiveConnector('https://web.telegram.org/k/')).toBe(defaultArchiveConnector);
    expect(findArchiveConnector('https://web.telegram.org/a/')).toBe(defaultArchiveConnector);
  });

  it('fails closed for unsupported and malformed locations', () => {
    expect(findArchiveConnector('https://discord.com/channels/1/2')).toBeUndefined();
    expect(findArchiveConnector('https://example.com/channels/1/2')).toBeUndefined();
    expect(findArchiveConnector('not a url')).toBeUndefined();
    expect(findArchiveConnector(undefined)).toBeUndefined();
  });

  it('keeps source-specific launch and injection data in the connector owner', () => {
    expect(archiveConnectors).toHaveLength(1);
    expect(defaultArchiveConnector).toMatchObject({
      id: 'telegram-web',
      launchUrl: 'https://web.telegram.org/k/',
      entrypoint: '/telegram-exporter.js',
    });
    expect(Object.isFrozen(defaultArchiveConnector.allowedOrigins)).toBe(true);
  });
});
