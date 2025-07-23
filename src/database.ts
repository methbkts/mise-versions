import { drizzle } from 'drizzle-orm/d1';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// GitHub tokens table for round-robin usage (user tokens only)
export const tokens = sqliteTable('tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  user_id: text('user_id'), // GitHub user ID or username
  user_name: text('user_name'), // GitHub display name
  user_email: text('user_email'), // GitHub email (if available)
  token: text('token').notNull(),
  expires_at: text('expires_at').notNull(),
  created_at: text('created_at').notNull(),
  last_used: text('last_used'),
  usage_count: integer('usage_count').notNull().default(0),
  is_active: integer('is_active').notNull().default(1), // 1 for active, 0 for inactive
  refresh_token: text('refresh_token'), // For GitHub apps with expiring tokens
  refresh_token_expires_at: text('refresh_token_expires_at'), // Refresh token expiration
  scopes: text('scopes'), // JSON array of token scopes
  last_validated: text('last_validated'), // Last time token was validated
  rate_limited_at: text('rate_limited_at'), // When token was rate limited (expires after 1 hour)
});

// Token usage tracking for rate limiting
export const token_usage = sqliteTable('token_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  token_id: integer('token_id').notNull().references(() => tokens.id),
  endpoint: text('endpoint').notNull(),
  used_at: text('used_at').notNull(),
  remaining_requests: integer('remaining_requests'),
  reset_at: text('reset_at'),
});

export function setupDatabase(db: ReturnType<typeof drizzle>) {
  return {
    // Create all tables (idempotent - safe to run multiple times)
    async setup() {
      console.log('Initializing database tables...');
      
      console.log('Database initialization complete');
    },

    // Get least recently used active token for round-robin
    async getNextToken() {
      const result = await db.select()
        .from(tokens)
        .where(sql`
          is_active = 1 
          AND expires_at > datetime('now')
          AND (rate_limited_at IS NULL OR rate_limited_at <= datetime('now'))
        `)
        .orderBy(sql`COALESCE(last_used, '1970-01-01') ASC, usage_count ASC`)
        .limit(1)
        .get();
      
      if (result) {
        // Update last_used and increment usage_count
        await db.update(tokens)
          .set({
            last_used: new Date().toISOString(),
            usage_count: sql`usage_count + 1`
          })
          .where(sql`id = ${result.id}`)
          .run();
      }
      
      return result;
    },

    // Mark a token as rate-limited for 1 hour
    async markTokenRateLimited(tokenId: number, resetAt?: string) {
      const rateLimitedUntil = resetAt || new Date(Date.now() + 30 * 60 * 1000).toISOString(); // Default to 30 minutes from now
      
      await db.update(tokens)
        .set({
          rate_limited_at: rateLimitedUntil
        })
        .where(sql`id = ${tokenId}`)
        .run();
      
      console.log(`Token ${tokenId} marked as rate-limited until ${rateLimitedUntil}`);
    },

    // Get all active tokens (all are user tokens now)
    async getAllTokens() {
      return await db.select()
        .from(tokens)
        .where(sql`is_active = 1 AND expires_at > datetime('now')`)
        .orderBy(sql`COALESCE(last_used, '1970-01-01') ASC`)
        .all();
    },

    // Store new token
    async storeToken(
      userId: string | null, 
      token: string, 
      expiresAt: string,
      options?: {
        userName?: string;
        userEmail?: string;
        refreshToken?: string;
        refreshTokenExpiresAt?: string;
        scopes?: string[];
      }
    ) {
      const now = new Date().toISOString();
      
      return await db.insert(tokens)
        .values({
          user_id: userId,
          user_name: options?.userName,
          user_email: options?.userEmail,
          token,
          expires_at: expiresAt,
          created_at: now,
          last_validated: now,
          refresh_token: options?.refreshToken,
          refresh_token_expires_at: options?.refreshTokenExpiresAt,
          scopes: options?.scopes ? JSON.stringify(options.scopes) : null,
        })
        .returning()
        .get();
    },

    // Update token validation timestamp
    async updateTokenValidation(tokenId: number) {
      return await db.update(tokens)
        .set({ 
          last_validated: new Date().toISOString() 
        })
        .where(sql`id = ${tokenId}`)
        .run();
    },

    // Record token usage for rate limit tracking
    async recordTokenUsage(tokenId: number, endpoint: string, remainingRequests?: number, resetAt?: string) {
      return await db.insert(token_usage)
        .values({
          token_id: tokenId,
          endpoint,
          used_at: new Date().toISOString(),
          remaining_requests: remainingRequests,
          reset_at: resetAt,
        })
        .run();
    },

    // Deactivate expired tokens
    async deactivateExpiredTokens() {
      const result = await db.update(tokens)
        .set({ is_active: 0 })
        .where(sql`expires_at <= datetime('now') AND is_active = 1`)
        .run();
      
      console.log('Deactivated expired tokens');
      
      return result;
    },

    // Get tokens that will expire soon (within 24 hours) for proactive refresh
    async getExpiringTokens() {
      return await db.select()
        .from(tokens)
        .where(sql`is_active = 1 AND expires_at <= datetime('now', '+24 hours') AND expires_at > datetime('now')`)
        .all();
    },

    // Get tokens with refresh tokens that can be refreshed
    async getRefreshableTokens() {
      return await db.select()
        .from(tokens)
        .where(sql`
          is_active = 1 
          AND refresh_token IS NOT NULL 
          AND (refresh_token_expires_at IS NULL OR refresh_token_expires_at > datetime('now'))
          AND expires_at <= datetime('now', '+1 hour')
        `)
        .all();
    },

    // Get token statistics
    async getTokenStats() {
      const active = await db.select({ count: sql<number>`count(*)` })
        .from(tokens)
        .where(sql`is_active = 1 AND expires_at > datetime('now') AND (rate_limited_at IS NULL OR rate_limited_at <= datetime('now'))`)
        .get();
      
      const total = await db.select({ count: sql<number>`count(*)` })
        .from(tokens)
        .get();

      return {
        active: active?.count || 0,
        total: total?.count || 0,
      };
    }
  };
} 
