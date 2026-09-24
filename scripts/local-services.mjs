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
 * reproduce. Object storage is the real MinIO server binary, so lifecycle rules and
 * object tagging behave as they do in production.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devDir = path.join(repoRoot, '.dev');
const minioBinary = path.join(devDir, 'bin', 'minio');
const MINIO_DOWNLOAD = 'https://dl.min.io/server/minio/release';

export const DEFAULTS = {
  postgresPort: 5433,
  postgresUser: 'inlet',
  postgresPassword: 'inlet',
  postgresDatabase: 'inlet',
  minioPort: 9010,
  minioConsolePort: 9011,
  minioAccessKey: 'inletdev',
  minioSecretKey: 'inletdevsecret',
};

export function databaseUrl(options = {}) {
  const { postgresPort, postgresUser, postgresPassword, postgresDatabase } = {
    ...DEFAULTS,
    ...options,
  };
  return `postgresql://${postgresUser}:${postgresPassword}@127.0.0.1:${postgresPort}/${postgresDatabase}`;
}

export function s3Endpoint(options = {}) {
  return `http://127.0.0.1:${{ ...DEFAULTS, ...options }.minioPort}`;
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

async function ensureMinioBinary() {
  if (existsSync(minioBinary)) return minioBinary;

  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const url = `${MINIO_DOWNLOAD}/${platform}-${arch}/minio`;

  await fs.mkdir(path.dirname(minioBinary), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) {
    // MinIO withdrew its community binaries on September 11, 2026; dl.min.io answers 410.
    throw new Error(
      response.status === 410
        ? `MinIO no longer publishes server binaries (${url} answered 410). Build it from source with scripts/build-minio.sh (needs Go and git), which puts it in .dev/bin/minio, or start any S3-compatible server on port ${DEFAULTS.minioPort} with the access key ${DEFAULTS.minioAccessKey} and secret ${DEFAULTS.minioSecretKey}.`
        : `Could not download the MinIO server binary from ${url}: ${response.status}`,
    );
  }
  await fs.writeFile(minioBinary, Buffer.from(await response.arrayBuffer()));
  await fs.chmod(minioBinary, 0o755);
  return minioBinary;
}

/** Starts MinIO, or attaches to one already listening. */
export async function startMinio(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const dataDir = options.dataDir ?? path.join(devDir, 'minio');

  if (await portIsOpen(config.minioPort)) {
    return { endpoint: s3Endpoint(config), stop: async () => {}, reused: true };
  }

  const binary = await ensureMinioBinary();
  await fs.mkdir(dataDir, { recursive: true });

  // Bound to loopback, not every interface. These are development credentials, and
  // Inlet reaches the store over 127.0.0.1, so there is no reason for a local object
  // store holding submitted screenshots to answer the network.
  const child = spawn(
    binary,
    [
      'server',
      dataDir,
      '--address',
      `127.0.0.1:${config.minioPort}`,
      '--console-address',
      `127.0.0.1:${config.minioConsolePort}`,
    ],
    {
      env: {
        ...process.env,
        MINIO_ROOT_USER: config.minioAccessKey,
        MINIO_ROOT_PASSWORD: config.minioSecretKey,
        MINIO_UPDATE: 'off',
      },
      stdio: options.quiet === false ? 'inherit' : 'ignore',
      detached: false,
    },
  );
  child.unref();

  await waitForPort(config.minioPort, 'MinIO');

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
  const minio = await startMinio(options);
  const config = { ...DEFAULTS, ...options };

  return {
    postgres,
    minio,
    env: {
      INLET_DATABASE_URL: postgres.url,
      INLET_S3_ENDPOINT: minio.endpoint,
      INLET_S3_ACCESS_KEY_ID: config.minioAccessKey,
      INLET_S3_SECRET_ACCESS_KEY: config.minioSecretKey,
      INLET_S3_FORCE_PATH_STYLE: 'true',
    },
    stop: async () => {
      await minio.stop();
      await postgres.stop();
    },
  };
}
