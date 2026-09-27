import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { Reader, type CountryResponse } from 'mmdb-lib';

/**
 * The country of a request, and nothing finer (UX Analytics AN-033, Remote Config RC-045,
 * Foundations §12.1, §12.2, FD-032). Not analytics-specific: Remote Config's fetch reuses it.
 *
 * Two sources, in order:
 *
 * 1. The trusted proxy's country header, named by `INLET_COUNTRY_HEADER` (Cloudflare's
 *    `CF-IPCountry`, for one), honoured only when the request's address was resolved through
 *    a trusted proxy (`INLET_TRUSTED_PROXIES`): otherwise any client could claim a country
 *    by sending the header. `XX` and `T1` (unknown, Tor) mean no country, and nothing else
 *    is asked, because the proxy knows better than a database looking at a Tor exit.
 * 2. The bundled DB-IP Lite country database (CC BY 4.0, whose licence allows bundling it;
 *    MaxMind's GeoLite does not), read with `mmdb-lib`. `INLET_IP_COUNTRY_DB` names another
 *    file. The Docker image fetches it at build and `npm run services:up` for development;
 *    without it no country is derived, which startup says once.
 *
 * The address is read from the request for the lookup and held nowhere else: not returned,
 * not stored, not logged.
 */

export type CountrySource = {
  /** An ISO 3166-1 alpha-2 code in upper case, or null when neither source answers. */
  countryOf(request: FastifyRequest): string | null;
};

/** Where the Docker image and `scripts/ip-country-db.mjs` put the database, relative to the API package. */
export const BUNDLED_IP_COUNTRY_DB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ip-country/dbip-country-lite.mmdb');

const ISO_CODE = /^[A-Za-z]{2}$/;
const NO_COUNTRY = new Set(['XX', 'T1']);

/** One reader per file for the whole process, loaded once: Remote Config asks for the same file. */
const readers = new Map<string, Reader<CountryResponse> | null>();

function readerFor(file: string, log: FastifyBaseLogger): Reader<CountryResponse> | null {
  if (readers.has(file)) return readers.get(file)!;
  let reader: Reader<CountryResponse> | null = null;
  try {
    reader = new Reader<CountryResponse>(readFileSync(file));
    log.info({ database: reader.metadata.databaseType, built: reader.metadata.buildEpoch.toISOString().slice(0, 10) }, 'IP to country data by DB-IP (db-ip.com), CC BY 4.0, is loaded');
  } catch (error) {
    log.warn(
      { file, reason: error instanceof Error ? error.message : String(error) },
      'The IP-to-country database could not be read, so no country is derived from addresses. Run `npm run services:up` in development, or set INLET_IP_COUNTRY_DB to a DB-IP Lite country database.',
    );
  }
  readers.set(file, reader);
  return reader;
}

/** The IPv4-mapped IPv6 form and the plain one are the same address. */
function plain(address: string | undefined): string {
  if (!address) return '';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

export function createCountrySource(options: {
  header: string;
  databaseFile: string;
  trustProxy: boolean | number | string[];
  log: FastifyBaseLogger;
}): CountrySource {
  const header = options.header.trim().toLowerCase();
  const reader = readerFor(options.databaseFile || BUNDLED_IP_COUNTRY_DB, options.log);
  return {
    countryOf(request) {
      // Fastify resolved `request.ip` from X-Forwarded-For only if the socket's peer is a
      // trusted proxy; when it differs from the peer, a trusted proxy reported it.
      const throughTrustedProxy = options.trustProxy !== false && plain(request.ip) !== plain(request.socket.remoteAddress);
      if (header && throughTrustedProxy) {
        const raw = request.headers[header];
        const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
        if (value && NO_COUNTRY.has(value)) return null;
        if (value && ISO_CODE.test(value)) return value;
      }
      if (!reader) return null;
      try {
        const code = reader.get(plain(request.ip))?.country?.iso_code;
        return code && ISO_CODE.test(code) ? code.toUpperCase() : null;
      } catch {
        // Not an address the database can look up; there is no country to derive.
        return null;
      }
    },
  };
}
