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
 */

export type FakeSlack = {
  webhookUrl: string;
  received: { body: Record<string, unknown>; raw: string }[];
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
      fake.received.push({ body, raw });
      const answer = fake.reply();
      response.writeHead(answer.status, { 'content-type': 'text/plain', ...answer.headers });
      response.end(answer.body);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(E2E.slackPort, '127.0.0.1', resolve);
  });

  return {
    webhookUrl: `${E2E.slackOrigin}/services/T01E2ETEST/B01E2ETEST/e2eSecretValue01`,
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
