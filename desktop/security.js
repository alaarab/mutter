const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);
const APP_PATHS = new Set(['/', '/app/index.html']);
const APP_PERMISSIONS = new Set(['media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection']);

export function isExternalURL(value) {
  try {
    const url = new URL(value);
    return EXTERNAL_PROTOCOLS.has(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isAppURL(value, appURL) {
  try {
    const url = new URL(value);
    return url.origin === new URL(appURL).origin && APP_PATHS.has(url.pathname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function allowsPermission(permission, requestingURL, contentsURL, appURL, isMainFrame = true) {
  return isMainFrame !== false && APP_PERMISSIONS.has(permission) &&
    isAppURL(requestingURL, appURL) && isAppURL(contentsURL, appURL);
}
