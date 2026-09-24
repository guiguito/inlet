/**
 * Local PostgreSQL and S3 for development and tests, without Docker.
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
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

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

export const DEFAULTS = {
  postgresPort: 5433,
  postgresUser: 'inlet',
  postgresPassword: 'inlet',
  postgresDatabase: 'inlet',
  storagePort: 9010,
  storageAccessKey: 'inletdev',
  storageSecretKey: 'inletdevsecret',
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

/** Both services, with the environment variables Inlet expects. */
export async function startLocalServices(options = {}) {
  const postgres = await startPostgres(options);
  const storage = await startObjectStore(options);
  const config = { ...DEFAULTS, ...options };

  return {
    postgres,
    storage,
    env: {
      INLET_DATABASE_URL: postgres.url,
      INLET_S3_ENDPOINT: storage.endpoint,
      INLET_S3_ACCESS_KEY_ID: config.storageAccessKey,
      INLET_S3_SECRET_ACCESS_KEY: config.storageSecretKey,
      INLET_S3_FORCE_PATH_STYLE: 'true',
    },
    stop: async () => {
      await storage.stop();
      await postgres.stop();
    },
  };
}
