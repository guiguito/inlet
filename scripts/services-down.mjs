/** Stops the local PostgreSQL and RustFS started by services-up.mjs. */
import { execFileSync } from 'node:child_process';

// SIGINT, not the default SIGTERM, for PostgreSQL: SIGTERM is its "smart" shutdown, which
// waits for every client to disconnect, so a dev server or a test still holding a connection
// kept it running indefinitely. SIGINT is the fast shutdown: clients are disconnected and the
// database stops cleanly. RustFS stops on SIGTERM.
for (const [pattern, signal] of [
  ['postgres -D', 'INT'],
  ['rustfs server', 'TERM'],
]) {
  try {
    execFileSync('pkill', [`-${signal}`, '-f', pattern], { stdio: 'ignore' });
    console.log(`stopped: ${pattern}`);
  } catch {
    console.log(`not running: ${pattern}`);
  }
}
