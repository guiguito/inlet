import { sql } from 'drizzle-orm';
import { newId } from '@inlet/shared';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../lib/crypto.js';

/**
 * FR-001B: the deployment provisions its first project-independent Admin account from
 * configuration at first start.
 *
 * Idempotent, and deliberately non-destructive: if the account already exists its
 * password is left alone, so restarting with the variables still set does not silently
 * reset a password the operator has since changed. There is no registration route
 * (FR-001A), so this is the only way an account exists in Release 1.
 */
export async function bootstrapAdmin(ctx: AppContext): Promise<'created' | 'exists' | 'skipped'> {
  const email = ctx.env.INLET_ADMIN_EMAIL?.trim();
  const password = ctx.env.INLET_ADMIN_PASSWORD;

  if (!email || !password) {
    const existing = await ctx.db.select({ id: users.id }).from(users).limit(1);
    if (existing.length === 0) {
      ctx.log.warn(
        'No user accounts exist and INLET_ADMIN_EMAIL / INLET_ADMIN_PASSWORD are unset. Nobody can sign in.',
      );
    }
    return 'skipped';
  }

  const found = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  if (found[0]) return 'exists';

  await ctx.db.insert(users).values({
    id: newId('user'),
    email,
    passwordHash: await hashPassword(password),
    displayName: ctx.env.INLET_ADMIN_NAME,
  });
  ctx.log.info({ email }, 'bootstrapped the first Admin account');
  return 'created';
}
