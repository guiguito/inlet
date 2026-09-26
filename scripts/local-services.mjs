/**
 * Local PostgreSQL, S3 and ClickHouse for development and tests, without Docker.
 *
 * The shipped deployment is the Docker stack in docker-compose.yml. These helpers
 * exist because a real PostgreSQL and a real S3-compatible store are needed to run
 * the integration suite, and because a contributor should be able to `npm test`
 * without a container runtime.
 *
 * PostgreSQL comes from the `embedded-postgres` package, which unpacks genuine
 * PostgreSQL 18 binaries: the integration tests exercise real transactions, row
 * locks and `select for update`, which a WASM or in-memory substitute cannot
 * reproduce. Object storage is the real RustFS server binary, the same server the bundled
 * deployment runs, so lifecycle rules and object tagging behave as they do in production.
 * The analytics event store is the real ClickHouse server binary (UX Analytics section 11:
 * the harness resets the tables of a real ClickHouse), the release the compose profile
 * `analytics` pins.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { ensureIpCountryDb } from './ip-country-db.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devDir = path.join(repoRoot, '.dev');
const rustfsBinary = path.join(devDir, 'bin', 'rustfs');
const RUSTFS_VERSION = '1.0.0';
/** From https://github.com/rustfs/rustfs/releases/download/1.0.0/SHA256SUMS */
const RUSTFS_SHA256 = {
  'macos-aarch64': '06e32a681c16930fb5414df64c96151fe3370321fab0403a83a83a015874c39a',
  'linux-x86_64-musl': 'c30a95b76546f25122c9ca387090ddb30c391ca5605621b0d7c881703c0f21c8',
  'linux-aarch64-musl': '88202c0446d0aa31fa475b1dc8cdb92f6d32e62d6f34a63f2018899c1943f100',
};

const clickhouseBinary = path.join(devDir, 'bin', 'clickhouse');
/** Keep in step with the image tag in docker-compose.yml and the cache key in ci.yml. */
export const CLICKHOUSE_VERSION = '26.8.12.53';
/**
 * SHA-256 of each download, computed here from the file itself. ClickHouse publishes no
 * checksum for its macOS binaries and only SHA-512 files for the Linux archives, so these
 * were computed from the downloads of September 26, 2026 and cross-checked against the
 * digest GitHub reports for each release asset (and, for Linux, against the release's
 * `.sha512` file). Upgrading is changing CLICKHOUSE_VERSION and all four together.
 */
const CLICKHOUSE_DOWNLOADS = {
  'darwin-arm64': {
    asset: 'clickhouse-macos-aarch64',
    sha256: 'e848f9a32c81d1c651a454d674183ed46a0b1aa69e836bde9d4f9952d9a9b01a',
  },
  'darwin-x64': {
    asset: 'clickhouse-macos',
    sha256: '3994660e055c088e296cbdd43bce458bde756ed1502caf4d89b09ee4e71a6465',
  },
  'linux-x64': {
    asset: `clickhouse-common-static-${CLICKHOUSE_VERSION}-amd64.tgz`,
    sha256: '6c32cca4716b2d1adccf9784d90834086c923f85317bd9dfd85aca1daaab28cf',
  },
  'linux-arm64': {
    asset: `clickhouse-common-static-${CLICKHOUSE_VERSION}-arm64.tgz`,
    sha256: 'ba073edd2b608cff3644bf1f2562ddcab34e279136df50a124ddcf9fd3dde301',
  },
};

export const DEFAULTS = {
  postgresPort: 5433,
  postgresUser: 'inlet',
  postgresPassword: 'inlet',
  postgresDatabase: 'inlet',
  storagePort: 9010,
  storageAccessKey: 'inletdev',
  storageSecretKey: 'inletdevsecret',
  clickhouseHttpPort: 8124,
  // Native protocol, for `.dev/bin/clickhouse client --port 9124`. Inlet itself speaks HTTP.
  clickhouseTcpPort: 9124,
  clickhouseWriter: 'inlet',
  clickhouseWriterPassword: 'inlet',
  clickhouseReader: 'inlet_reader',
  clickhouseReaderPassword: 'inlet_reader',
};

export function databaseUrl(options = {}) {
  const { postgresPort, postgresUser, postgresPassword, postgresDatabase } = {
    ...DEFAULTS,
    ...options,
  };
  return `postgresql://${postgresUser}:${postgresPassword}@127.0.0.1:${postgresPort}/${postgresDatabase}`;
}

export function s3Endpoint(options = {}) {
  return `http://127.0.0.1:${{ ...DEFAULTS, ...options }.storagePort}`;
}

/** The writer's address, which carries its credentials (INLET_CLICKHOUSE_URL). */
export function clickhouseUrl(options = {}) {
  const c = { ...DEFAULTS, ...options };
  return `http://${c.clickhouseWriter}:${c.clickhouseWriterPassword}@127.0.0.1:${c.clickhouseHttpPort}`;
}

/** The read-only user's address (INLET_CLICKHOUSE_READ_URL). */
export function clickhouseReadUrl(options = {}) {
  const c = { ...DEFAULTS, ...options };
  return `http://${c.clickhouseReader}:${c.clickhouseReaderPassword}@127.0.0.1:${c.clickhouseHttpPort}`;
}

async function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForPort(port, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portIsOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not start listening on port ${port} within ${timeoutMs}ms.`);
}

/**
 * Starts PostgreSQL, or attaches to one already listening on the port so repeated
 * test runs and a parallel `npm run dev` do not fight over the data directory.
 */
export async function startPostgres(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const dataDir = options.dataDir ?? path.join(devDir, 'pgdata');

  if (await portIsOpen(config.postgresPort)) {
    return { url: databaseUrl(config), stop: async () => {}, reused: true };
  }

  const postgres = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: config.postgresUser,
    password: config.postgresPassword,
    port: config.postgresPort,
    persistent: true,
    onLog: () => {},
  });

  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
    await fs.mkdir(path.dirname(dataDir), { recursive: true });
    await postgres.initialise();
  }
  await postgres.start();

  try {
    await postgres.createDatabase(config.postgresDatabase);
  } catch {
    // Already there from an earlier run.
  }

  return {
    url: databaseUrl(config),
    reused: false,
    stop: async () => {
      await postgres.stop();
    },
  };
}

/**
 * The RustFS release binary for this machine, downloaded once into .dev/bin and checked
 * against a checksum pinned here, so a changed or tampered release is refused rather than
 * run. Upgrading RustFS is changing RUSTFS_VERSION and these four sums together, from the
 * release's SHA256SUMS.
 */
async function ensureRustfsBinary() {
  if (existsSync(rustfsBinary)) return rustfsBinary;

  const target =
    process.platform === 'darwin'
      ? 'macos-aarch64'
      : process.arch === 'arm64'
        ? 'linux-aarch64-musl'
        : 'linux-x86_64-musl';
  if (process.platform === 'darwin' && process.arch !== 'arm64') {
    throw new Error('RustFS publishes no Intel macOS binary. Run the object store with `docker compose -f docker-compose.dev.yml up -d storage` instead; the scripts reuse anything listening on port 9010.');
  }
  const asset = `rustfs-${target}-v${RUSTFS_VERSION}.zip`;
  const url = `https://github.com/rustfs/rustfs/releases/download/${RUSTFS_VERSION}/${asset}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download RustFS from ${url}: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const sum = createHash('sha256').update(archive).digest('hex');
  if (sum !== RUSTFS_SHA256[target]) {
    throw new Error(`${asset} has SHA-256 ${sum}, not the pinned ${RUSTFS_SHA256[target]}. Refusing to run it.`);
  }

  await fs.mkdir(path.dirname(rustfsBinary), { recursive: true });
  const zip = `${rustfsBinary}.zip`;
  await fs.writeFile(zip, archive);
  // The archive holds the one `rustfs` binary. `unzip` ships with macOS and the CI image.
  execFileSync('unzip', ['-o', '-q', zip, 'rustfs', '-d', path.dirname(rustfsBinary)]);
  await fs.rm(zip);
  await fs.chmod(rustfsBinary, 0o755);
  return rustfsBinary;
}

/** Starts RustFS, or attaches to any S3 server already listening on the port. */
export async function startObjectStore(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const dataDir = options.dataDir ?? path.join(devDir, 'storage');

  if (await portIsOpen(config.storagePort)) {
    return { endpoint: s3Endpoint(config), stop: async () => {}, reused: true };
  }

  const binary = await ensureRustfsBinary();
  await fs.mkdir(dataDir, { recursive: true });

  // Bound to loopback, not every interface. These are development credentials, and
  // Inlet reaches the store over 127.0.0.1, so there is no reason for a local object
  // store holding submitted screenshots to answer the network, and the console is off.
  const child = spawn(binary, ['server', dataDir, '--address', `127.0.0.1:${config.storagePort}`], {
    env: {
      ...process.env,
      RUSTFS_ACCESS_KEY: config.storageAccessKey,
      RUSTFS_SECRET_KEY: config.storageSecretKey,
      // The binary starts its web console on every interface unless told not to.
      RUSTFS_CONSOLE_ENABLE: 'false',
      RUSTFS_OBS_LOGGER_LEVEL: 'error',
    },
    stdio: options.quiet === false ? 'inherit' : 'ignore',
    detached: false,
  });
  child.unref();

  await waitForPort(config.storagePort, 'RustFS');

  return {
    endpoint: s3Endpoint(config),
    reused: false,
    stop: async () => {
      child.kill('SIGTERM');
    },
  };
}

/**
 * The ClickHouse release binary for this machine, downloaded once into .dev/bin and checked
 * against the SHA-256 pinned above. macOS gets the single binary ClickHouse builds for it;
 * Linux gets `usr/bin/clickhouse` out of the clickhouse-common-static archive, which is
 * what the server packages install.
 */
async function ensureClickhouseBinary() {
  if (existsSync(clickhouseBinary)) return clickhouseBinary;

  const download = CLICKHOUSE_DOWNLOADS[`${process.platform}-${process.arch}`];
  if (!download) {
    throw new Error(`No ClickHouse binary is pinned for ${process.platform}-${process.arch}. Run it with \`docker compose -f docker-compose.dev.yml up -d clickhouse\`; the scripts reuse anything listening on port ${DEFAULTS.clickhouseHttpPort}.`);
  }
  const url = `https://github.com/ClickHouse/ClickHouse/releases/download/v${CLICKHOUSE_VERSION}-lts/${download.asset}`;
  console.log(`Downloading ClickHouse ${CLICKHOUSE_VERSION} (about 200 MB, once) from ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ClickHouse from ${url}: ${response.status}`);
  const file = Buffer.from(await response.arrayBuffer());
  const sum = createHash('sha256').update(file).digest('hex');
  if (sum !== download.sha256) {
    throw new Error(`${download.asset} has SHA-256 ${sum}, not the pinned ${download.sha256}. Refusing to run it.`);
  }

  await fs.mkdir(path.dirname(clickhouseBinary), { recursive: true });
  if (download.asset.endsWith('.tgz')) {
    const archive = `${clickhouseBinary}.tgz`;
    await fs.writeFile(archive, file);
    const member = `clickhouse-common-static-${CLICKHOUSE_VERSION}/usr/bin/clickhouse`;
    // `tar` ships with every Linux the CI and a contributor run on.
    execFileSync('tar', ['-xzf', archive, '-C', path.dirname(clickhouseBinary), '--strip-components=3', member]);
    await fs.rm(archive);
  } else {
    await fs.writeFile(clickhouseBinary, file);
  }
  await fs.chmod(clickhouseBinary, 0o755);
  return clickhouseBinary;
}

/**
 * The server's configuration, written on every start so it always matches this script.
 *
 * Sized for a laptop running the test suite beside PostgreSQL and a browser: a 4 GB memory
 * ceiling, small caches, a small background pool, and none of the system log tables, which
 * on an idle server are most of its disk writes. Loopback only, HTTP on 8124 (8123 is the
 * port a contributor's own ClickHouse would use), native TCP on 9124, and no interserver,
 * MySQL or PostgreSQL port at all: none is configured, so none is opened.
 *
 * Two users, as the bundled deployment has (deploy/clickhouse/users.xml): a writer that may
 * run DDL, inserts and deletes, and a reader held to `readonly = 2`, which refuses every
 * write and DDL but still lets a query set its own limits.
 */
function clickhouseConfig(config, dataDir) {
  const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  return {
    'config.xml': `<clickhouse>
  <logger>
    <level>warning</level>
    <log>${xml(path.join(dataDir, 'log', 'clickhouse-server.log'))}</log>
    <errorlog>${xml(path.join(dataDir, 'log', 'clickhouse-server.err.log'))}</errorlog>
    <size>10M</size>
    <count>2</count>
  </logger>
  <listen_host>127.0.0.1</listen_host>
  <http_port>${config.clickhouseHttpPort}</http_port>
  <tcp_port>${config.clickhouseTcpPort}</tcp_port>
  <path>${xml(dataDir)}/</path>
  <tmp_path>${xml(path.join(dataDir, 'tmp'))}/</tmp_path>
  <user_files_path>${xml(path.join(dataDir, 'user_files'))}/</user_files_path>
  <format_schema_path>${xml(path.join(dataDir, 'format_schemas'))}/</format_schema_path>
  <user_directories><users_xml><path>users.xml</path></users_xml></user_directories>
  <max_server_memory_usage>4294967296</max_server_memory_usage>
  <mark_cache_size>268435456</mark_cache_size>
  <index_mark_cache_size>67108864</index_mark_cache_size>
  <uncompressed_cache_size>0</uncompressed_cache_size>
  <primary_index_cache_size>67108864</primary_index_cache_size>
  <background_pool_size>4</background_pool_size>
  <!-- Pool size times this ratio must be at least 25, the largest default free-slot threshold
       (optimize_entire_partition; mutations need 20). A table with projections is checked
       against the built-in defaults even when config.xml's <merge_tree> lowers them, so the
       ratio is raised instead (DECISIONS 33.1). -->
  <background_merges_mutations_concurrency_ratio>8</background_merges_mutations_concurrency_ratio>
  <background_schedule_pool_size>16</background_schedule_pool_size>
  <background_common_pool_size>4</background_common_pool_size>
  <background_move_pool_size>2</background_move_pool_size>
  <background_fetches_pool_size>2</background_fetches_pool_size>
  <background_buffer_flush_schedule_pool_size>2</background_buffer_flush_schedule_pool_size>
  <background_distributed_schedule_pool_size>2</background_distributed_schedule_pool_size>
  <background_message_broker_schedule_pool_size>2</background_message_broker_schedule_pool_size>
  <mlock_executable>false</mlock_executable>
</clickhouse>
`,
    'users.xml': `<clickhouse>
  <profiles>
    <default>
      <max_threads>4</max_threads>
      <!-- UX Analytics 9.4: one asynchronous flush may mix databases and late weeks. -->
      <max_partitions_per_insert_block>1000</max_partitions_per_insert_block>
    </default>
    <reader>
      <max_threads>4</max_threads>
      <readonly>2</readonly>
    </reader>
  </profiles>
  <users>
    <${config.clickhouseWriter}>
      <password>${xml(config.clickhouseWriterPassword)}</password>
      <networks><ip>127.0.0.1</ip><ip>::1</ip></networks>
      <profile>default</profile>
      <quota>default</quota>
    </${config.clickhouseWriter}>
    <${config.clickhouseReader}>
      <password>${xml(config.clickhouseReaderPassword)}</password>
      <networks><ip>127.0.0.1</ip><ip>::1</ip></networks>
      <profile>reader</profile>
      <quota>default</quota>
    </${config.clickhouseReader}>
  </users>
  <quotas><default /></quotas>
</clickhouse>
`,
  };
}

/** Starts ClickHouse, or attaches to whatever already listens on its HTTP port. */
export async function startClickhouse(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const dataDir = options.dataDir ?? path.join(devDir, 'clickhouse');
  const result = { url: clickhouseUrl(config), readUrl: clickhouseReadUrl(config) };

  if (await portIsOpen(config.clickhouseHttpPort)) {
    return { ...result, stop: async () => {}, reused: true };
  }

  const binary = await ensureClickhouseBinary();
  const configDir = path.join(dataDir, 'etc');
  await fs.mkdir(path.join(dataDir, 'log'), { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  for (const [name, content] of Object.entries(clickhouseConfig(config, dataDir))) {
    await fs.writeFile(path.join(configDir, name), content);
  }

  const child = spawn(binary, ['server', `--config-file=${path.join(configDir, 'config.xml')}`], {
    cwd: dataDir,
    stdio: options.quiet === false ? 'inherit' : 'ignore',
    detached: false,
  });
  child.unref();

  // A first start creates the system database and loads timezone data, which takes a few
  // seconds on a laptop; the port opens only once the server can answer. A configuration
  // the server refuses makes it exit at once, so that is reported rather than waited out.
  const log = path.join(dataDir, 'log', 'clickhouse-server.err.log');
  await Promise.race([
    waitForPort(config.clickhouseHttpPort, 'ClickHouse', 120_000),
    new Promise((_, reject) =>
      child.once('exit', (code) => reject(new Error(`ClickHouse exited with code ${code} before listening. See ${log}.`))),
    ),
  ]);

  return {
    ...result,
    reused: false,
    stop: async () => {
      child.kill('SIGTERM');
    },
  };
}

/** Every service, with the environment variables Inlet expects. */
export async function startLocalServices(options = {}) {
  // AN-033: the IP-to-country database the API reads by default, fetched once. Without it
  // the API still runs and derives no country, so a failed download only warns.
  await ensureIpCountryDb().catch((error) => console.warn(`No IP-to-country database: ${error.message}`));
  const postgres = await startPostgres(options);
  const storage = await startObjectStore(options);
  const clickhouse = await startClickhouse(options);
  const config = { ...DEFAULTS, ...options };

  return {
    postgres,
    storage,
    clickhouse,
    env: {
      INLET_DATABASE_URL: postgres.url,
      INLET_S3_ENDPOINT: storage.endpoint,
      INLET_S3_ACCESS_KEY_ID: config.storageAccessKey,
      INLET_S3_SECRET_ACCESS_KEY: config.storageSecretKey,
      INLET_S3_FORCE_PATH_STYLE: 'true',
      INLET_CLICKHOUSE_URL: clickhouse.url,
      INLET_CLICKHOUSE_READ_URL: clickhouse.readUrl,
    },
    stop: async () => {
      await clickhouse.stop();
      await storage.stop();
      await postgres.stop();
    },
  };
}
