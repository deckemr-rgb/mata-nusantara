import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  host = 'localhost',
  port = 4173,
  allowedHosts,
} = {}) {
  const resolvedPort = parseInt(port, 10) || 4173;
  const bindsPublicly = host === '0.0.0.0' || host === '::';

  /**
   * Hosts this server answers to.
   *
   * Vite refuses requests whose Host header it does not recognise — a DNS
   * rebinding defence. Behind a domain that guard is what a deployment hits
   * first, as a flat "Blocked request. This host is not allowed", so the
   * deploying operator names the domain through ALLOWED_HOSTS.
   */
  const hostAllowList = allowedHosts
    ? String(allowedHosts)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : null;
  const resolvedAllowedHosts =
    hostAllowList && hostAllowList.length
      ? hostAllowList
      : bindsPublicly
        ? true
        : ['localhost', '127.0.0.1', '.local'];

  // These headers protect the document containing Provider Settings.
  const securityHeaders = {
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
  };

  return {
    plugins: [cesium(), applicationHtmlPlugin(), ...plugins],
    ...(publicDir === undefined ? {} : { publicDir }),
    server: {
      host: host || 'localhost',
      port: resolvedPort,
      allowedHosts: resolvedAllowedHosts,
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      headers: securityHeaders,
    },
    /*
     * The built server. `vite preview` does NOT inherit `server`, so without
     * this block a deployment ignores HOST and PORT entirely and binds to
     * localhost — reachable from inside the machine and from nowhere else.
     * The provider middleware registers on both servers (configureServer AND
     * configurePreviewServer), so this is the same application, API included.
     */
    preview: {
      host: host || 'localhost',
      port: resolvedPort,
      allowedHosts: resolvedAllowedHosts,
      headers: securityHeaders,
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
