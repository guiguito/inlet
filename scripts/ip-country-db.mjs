/**
 * The IP-to-country database the platform bundles (UX Analytics AN-033, Foundations FD-032):
 * DB-IP's "IP to Country Lite", in the MaxMind DB format, licensed CC BY 4.0, which allows
 * bundling it as long as it is attributed ("IP to country data by DB-IP", shown in Settings
 * and in docs/DEPLOYMENT.md). MaxMind's GeoLite licence does not allow bundling.
 *
 * Pinned to one dated monthly file and the SHA-256 of its download, so every build and every
 * test run looks addresses up in the same data, and a changed file is refused rather than used.
 *
 * To update: pick the month at https://db-ip.com/db/download/ip-to-country-lite, set
 * DBIP_MONTH, download https://download.db-ip.com/free/dbip-country-lite-<month>.mmdb.gz,
 * set DBIP_SHA256 to `shasum -a 256` of that .gz, and delete the old file under
 * apps/api/ip-country/ so the next `npm run services:up` fetches the new one. DB-IP keeps
 * only recent months online, so an old pin eventually fails to download; move it then.
 *
 * Used by scripts/local-services.mjs for development and tests, and run by the Dockerfile at
 * image build: `node scripts/ip-country-db.mjs [destination]`.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DBIP_MONTH = '2026-09';
export const DBIP_SHA256 = 'cb0578ce59f569f2c933bb40feb820804a334855a60739011b0a89cab1d6e4ed';
/** Where the API looks when INLET_IP_COUNTRY_DB is unset (BUNDLED_IP_COUNTRY_DB in apps/api/src/lib/country.ts). */
export const IP_COUNTRY_DB_PATH = path.join(repoRoot, 'apps', 'api', 'ip-country', 'dbip-country-lite.mmdb');

/** Downloads, checks and unpacks the pinned file once. Returns its path. */
export async function ensureIpCountryDb(destination = IP_COUNTRY_DB_PATH) {
  if (existsSync(destination)) return destination;
  const url = `https://download.db-ip.com/free/dbip-country-lite-${DBIP_MONTH}.mmdb.gz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the IP-to-country database from ${url}: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const sum = createHash('sha256').update(archive).digest('hex');
  if (sum !== DBIP_SHA256) throw new Error(`${url} has SHA-256 ${sum}, not the pinned ${DBIP_SHA256}. Refusing to use it.`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  // Written under a temporary name first, so an interrupted run never leaves half a database.
  await fs.writeFile(`${destination}.part`, gunzipSync(archive));
  await fs.rename(`${destination}.part`, destination);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = await ensureIpCountryDb(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  console.log(`IP to country data by DB-IP (db-ip.com), CC BY 4.0: ${file}`);
}
