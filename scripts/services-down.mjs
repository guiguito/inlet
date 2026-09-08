/** Stops the local PostgreSQL and MinIO started by services-up.mjs. */
import { execFileSync } from 'node:child_process';

for (const pattern of ['postgres -D', 'minio server']) {
  try {
    execFileSync('pkill', ['-f', pattern], { stdio: 'ignore' });
    console.log(`stopped: ${pattern}`);
  } catch {
    console.log(`not running: ${pattern}`);
  }
}
