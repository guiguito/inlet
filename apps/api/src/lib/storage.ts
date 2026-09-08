import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Env } from '../env.js';

/**
 * S3-compatible object storage (section 12.6). The bundled deployment runs MinIO;
 * pointing at AWS S3 or another gateway is configuration only.
 *
 * Pending-upload expiry (FR-067, section 12.3) is a storage lifecycle rule keyed on
 * an object *tag*, not a key prefix. That choice matters: an attachment's storage key
 * is fixed when it is uploaded and never changes, which is what makes its asset URL
 * stable for life (FR-069). Binding an attachment to a submission retags the object
 * in place instead of copying it to a second prefix, so there is no window in which
 * an attachment's bytes live at a key the database does not know about.
 */

export const PENDING_TAG = { key: 'inlet-state', value: 'pending' } as const;
export const BOUND_TAG_VALUE = 'bound';
const LIFECYCLE_RULE_ID = 'inlet-expire-pending-uploads';

export type ObjectBody = { stream: Readable; contentType: string; contentLength?: number };

export class Storage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly expiryDays: number;

  constructor(env: Env) {
    this.bucket = env.INLET_S3_BUCKET;
    this.expiryDays = env.INLET_PENDING_UPLOAD_EXPIRY_DAYS;
    this.client = new S3Client({
      region: env.INLET_S3_REGION,
      ...(env.INLET_S3_ENDPOINT ? { endpoint: env.INLET_S3_ENDPOINT } : {}),
      forcePathStyle: env.INLET_S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.INLET_S3_ACCESS_KEY_ID,
        secretAccessKey: env.INLET_S3_SECRET_ACCESS_KEY,
      },
    });
  }

  /** The stable storage key for an attachment. Fixed at upload, never rewritten. */
  static keyFor(attachmentId: string): string {
    return `attachments/${attachmentId}.webp`;
  }

  async ensureBucket(create: boolean): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      if (!create) throw error;
    }
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      // Another instance may have created it between the head and the create.
      const name = (error as { name?: string }).name;
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
    }
  }

  /**
   * Installs the pending-upload expiry rule. Idempotent: an existing rule with the
   * same ID and expiry is left alone so a restart does not rewrite bucket policy.
   *
   * Returns false when the backend rejects tag-filtered lifecycle rules, which is
   * reported at startup rather than silently ignored: without it, unreferenced
   * uploads would accumulate.
   */
  async ensureLifecycleRule(): Promise<boolean> {
    const desired = {
      ID: LIFECYCLE_RULE_ID,
      Status: 'Enabled' as const,
      Filter: { Tag: { Key: PENDING_TAG.key, Value: PENDING_TAG.value } },
      Expiration: { Days: this.expiryDays },
    };

    try {
      const existing = await this.client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }),
      );
      const current = existing.Rules?.find((rule) => rule.ID === LIFECYCLE_RULE_ID);
      if (current?.Expiration?.Days === this.expiryDays && current.Status === 'Enabled') {
        return true;
      }
      const others = (existing.Rules ?? []).filter((rule) => rule.ID !== LIFECYCLE_RULE_ID);
      await this.client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: this.bucket,
          LifecycleConfiguration: { Rules: [...others, desired] },
        }),
      );
      return true;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'NoSuchLifecycleConfiguration') {
        await this.client.send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket: this.bucket,
            LifecycleConfiguration: { Rules: [desired] },
          }),
        );
        return true;
      }
      return false;
    }
  }

  /** Uploads an object tagged pending, so the lifecycle rule owns it until it is bound. */
  async putPending(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        Tagging: `${PENDING_TAG.key}=${PENDING_TAG.value}`,
      }),
    );
  }

  /**
   * Takes an object out of the lifecycle rule's reach. Called before the finalization
   * transaction commits: if it fails the intent stays active and the client retries,
   * and if the commit then fails the object is still tagged bound and is only ever
   * orphaned bytes, never a submission with missing screenshots.
   */
  async markBound(key: string): Promise<void> {
    await this.client.send(
      new PutObjectTaggingCommand({
        Bucket: this.bucket,
        Key: key,
        Tagging: { TagSet: [{ Key: PENDING_TAG.key, Value: BOUND_TAG_VALUE }] },
      }),
    );
  }

  async get(key: string): Promise<ObjectBody | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!result.Body) return null;
      return {
        stream: result.Body as Readable,
        contentType: result.ContentType ?? 'application/octet-stream',
        ...(result.ContentLength !== undefined ? { contentLength: result.ContentLength } : {}),
      };
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** DeleteObjects caps at 1000 keys per request. */
  async deleteMany(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      if (batch.length === 0) continue;
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  destroy(): void {
    this.client.destroy();
  }
}
