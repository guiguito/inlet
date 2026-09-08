/** Starts local PostgreSQL and MinIO and keeps them running until interrupted. */
import { startLocalServices } from './local-services.mjs';

const services = await startLocalServices({ quiet: false });
console.log(`PostgreSQL  ${services.env.INLET_DATABASE_URL}${services.postgres.reused ? '  (reused)' : ''}`);
console.log(`MinIO       ${services.env.INLET_S3_ENDPOINT}${services.minio.reused ? '  (reused)' : ''}`);
console.log('Press Ctrl-C to stop.');

const shutdown = async () => {
  await services.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await new Promise(() => {});
