export function firefoxProxyPreferences() {
  const raw = process.env.LOCAL_ARCHIVE_FIREFOX_PROXY
    || (!process.env.CI && (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY));
  if (!raw) return {};
  let proxy;
  try {
    proxy = new URL(raw);
  } catch {
    return {};
  }
  if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname) return {};
  const port = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return {};
  return {
    'network.proxy.type': 1,
    'network.proxy.http': proxy.hostname,
    'network.proxy.http_port': port,
    'network.proxy.ssl': proxy.hostname,
    'network.proxy.ssl_port': port,
    'network.proxy.no_proxies_on': '',
  };
}
