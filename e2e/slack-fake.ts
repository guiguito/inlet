import http from 'node:http';
import { E2E } from './env';

/**
 * A fake Slack for the end-to-end suites.
 *
 * The real webhook is not used: the automated suites must not post into anybody's
 * workspace. This speaks Slack's actual contract — 200 with the body `ok`, or a
 * plain-text error code — so the sender, the error taxonomy and the retry machinery are
 * exercised rather than stubbed.
 *
 * It listens on a fixed loopback port that the server under test is configured to allow,
 * which means the origin allowlist is exercised too rather than bypassed.
 *
 * The port is shared by the whole run, and the server retries a failed delivery with backoff,
 * so a message another suite queued (a config database's "Config published", say) can arrive
 * during a later test. Each test therefore posts to a webhook of its own, from `webhook()`,
 * and reads only what reached it, with `messagesTo()`.
 */

type Message = { body: Record<string, unknown>; raw: string; path: string };

export type FakeSlack = {
  webhookUrl: string;
  /** A webhook address no other test posts to. */
  webhook: () => string;
  /** The messages that reached one webhook address, oldest first. */
  messagesTo: (webhookUrl: string) => Message[];
  received: Message[];
  /** Replaced per test to script Slack's answer. */
  reply: () => { status: number; body: string; headers?: Record<string, string> };
  reset: () => void;
  close: () => Promise<void>;
};

export async function startFakeSlack(): Promise<FakeSlack> {
  const fake: Partial<FakeSlack> & Pick<FakeSlack, 'received' | 'reply'> = {
    received: [],
    reply: () => ({ status: 200, body: 'ok' }),
  };

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Kept as raw text either way.
      }
      fake.received.push({ body, raw, path: request.url ?? '' });
      const answer = fake.reply();
      response.writeHead(answer.status, { 'content-type': 'text/plain', ...answer.headers });
      response.end(answer.body);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(E2E.slackPort, '127.0.0.1', resolve);
  });

  let hooks = 0;
  return {
    webhookUrl: `${E2E.slackOrigin}/services/T01E2ETEST/B01E2ETEST/e2eSecretValue01`,
    webhook: () => `${E2E.slackOrigin}/services/T01E2ETEST/B01E2ETEST/e2eSecretValue01x${(hooks += 1)}x${process.pid}`,
    messagesTo: (webhookUrl) => fake.received.filter((message) => message.path === new URL(webhookUrl).pathname),
    received: fake.received,
    get reply() {
      return fake.reply;
    },
    set reply(next: FakeSlack['reply']) {
      fake.reply = next;
    },
    reset: () => {
      fake.received.length = 0;
      fake.reply = () => ({ status: 200, body: 'ok' });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  } as FakeSlack;
}
