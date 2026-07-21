// @acbp/core — account profile read/update use cases (ACBP-P1-003; CDR-010; ACC-003).
//
// Provider-neutral. The profile view joins the account, its 1:1 profile, and the identity `users` row
// for the email. Email + verification are Clerk-authoritative and READ-ONLY here: ProfileUpdateInput
// has no email field, so an email change cannot be made through this path — it is performed in Clerk
// (which re-verifies) and syncs back via the P1-002 user.updated webhook. Every mutation resolves the
// account from the SERVER-VERIFIED internal user id (`created_by_user_id`), never a client-supplied id.
import {
  withTransaction,
  AccountRepository,
  AccountProfileRepository,
  type DatabaseClient,
  type AccountExecutor,
  type AccountProfileUpdate,
} from '@acbp/database';
import { validationError } from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

/** The account profile as shown to its owner. Email/verification are read-only (Clerk-authoritative). */
export interface AccountProfileView {
  readonly accountId: string;
  readonly displayName: string | null;
  readonly locale: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
}

/** Editable profile fields. NO email — email changes go through Clerk (CDR-010 #6). */
export interface ProfileUpdateInput {
  readonly displayName?: string | null;
  readonly locale?: string;
}

export interface ProfileUpdateOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}

const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const DISPLAY_NAME_MAX = 200;

/**
 * Validate + normalize a profile edit into a database patch (pure; unit-testable). Only the provided
 * keys appear in the result. `displayName` is trimmed; an empty/whitespace value CLEARS it (→ null);
 * an over-long value is rejected. `locale` must be a BCP-47-ish tag. Throws a validation PlatformError
 * carrying only field NAMES (never the offending value) on bad input.
 */
export function normalizeProfileUpdate(input: ProfileUpdateInput): AccountProfileUpdate {
  const patch: { display_name?: string | null; locale?: string } = {};

  if ('displayName' in input) {
    const value = input.displayName;
    if (value === null) {
      patch.display_name = null;
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        patch.display_name = null; // clearing via empty/whitespace
      } else if (trimmed.length > DISPLAY_NAME_MAX) {
        throw validationError({ message: 'Display name is too long.', fields: ['displayName'] });
      } else {
        patch.display_name = trimmed;
      }
    } else {
      throw validationError({ message: 'Display name must be text.', fields: ['displayName'] });
    }
  }

  if ('locale' in input) {
    const value = input.locale;
    if (typeof value !== 'string' || !LOCALE_RE.test(value)) {
      throw validationError({ message: 'Locale is not a valid language tag.', fields: ['locale'] });
    }
    patch.locale = value;
  }

  return patch;
}

/** Join account + profile + identity email for the owning user. Undefined when the user has no account. */
async function readProfileView(db: AccountExecutor, userId: string): Promise<AccountProfileView | undefined> {
  const row = await db
    .selectFrom('accounts as a')
    .innerJoin('users as u', 'u.id', 'a.created_by_user_id')
    .leftJoin('account_profiles as p', 'p.account_id', 'a.id')
    .select(['a.id as accountId', 'p.display_name as displayName', 'p.locale as locale', 'u.primary_email as email', 'u.email_verified as emailVerified'])
    .where('a.created_by_user_id', '=', userId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    accountId: row.accountId,
    displayName: row.displayName ?? null,
    locale: row.locale ?? 'en',
    email: row.email ?? null,
    emailVerified: row.emailVerified,
  };
}

/** Read the owner's profile view, or undefined if the user has no account yet. */
export function getProfileForOwner(client: DatabaseClient, userId: string): Promise<AccountProfileView | undefined> {
  return readProfileView(client.kysely, userId);
}

/**
 * Apply a profile edit for the owning user and return the resulting view. Returns undefined when the
 * user has no account (caller provisions first). Validation runs before any write. Emits an interim
 * `account.profile_updated` audit event (non-PII: account id only). Email is never modified here.
 */
export async function updateProfileForOwner(
  client: DatabaseClient,
  userId: string,
  input: ProfileUpdateInput,
  options: ProfileUpdateOptions = {},
): Promise<AccountProfileView | undefined> {
  const patch = normalizeProfileUpdate(input);
  return withTransaction(
    client,
    async (tx) => {
      const account = await new AccountRepository(tx.kysely).findByOwner(userId);
      if (account === undefined) return undefined;
      const changed = Object.keys(patch).length > 0;
      if (changed) {
        await new AccountProfileRepository(tx.kysely).update(account.id, patch);
        // Audit only actual edits — a no-op PATCH (empty patch) emits nothing.
        options.logger?.info('account.profile_updated', { metadata: { accountId: account.id } });
      }
      return readProfileView(tx.kysely, userId);
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );
}
