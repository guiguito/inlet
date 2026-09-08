import type { FastifyRequest } from 'fastify';

/**
 * FR-062C, section 12.1: the observed request IP, resolved after applying the
 * deployment's trusted-proxy configuration.
 *
 * Fastify's `trustProxy` option does the resolution: with it unset, `request.ip` is
 * the socket peer and any `X-Forwarded-For` header is ignored, which is the safe
 * default for a directly exposed listener. A deployment behind a reverse proxy names
 * that proxy in INLET_TRUSTED_PROXIES and `request.ip` becomes the client address the
 * proxy reported.
 *
 * For a server-to-server submission this identifies the integrating server, not the
 * respondent, and the product never presents it as respondent location (section 4).
 */
export function observedIp(request: FastifyRequest): string | null {
  const ip = request.ip;
  if (!ip) return null;
  // Normalize the IPv4-mapped IPv6 form so stored values compare cleanly.
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}
