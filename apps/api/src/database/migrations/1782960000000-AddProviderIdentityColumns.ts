import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-provider identity columns so one account can link BOTH Google and WCA:
 *  - users.google_id, users.wca_oauth_id (nullable, unique)
 *  - backfilled from the legacy oauth_provider/oauth_id pair
 *
 * Postgres only (prod). In dev (sqlite) `synchronize` adds the columns/indexes;
 * this migration also covers the data backfill, which synchronize does not do.
 */
export class AddProviderIdentityColumns1782960000000 implements MigrationInterface {
  name = 'AddProviderIdentityColumns1782960000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_id" character varying(255)`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "wca_oauth_id" character varying(255)`);
    // Backfill from the legacy single-provider fields.
    await queryRunner.query(`UPDATE "users" SET "google_id" = "oauth_id" WHERE "oauth_provider" = 'google' AND "google_id" IS NULL`);
    await queryRunner.query(`UPDATE "users" SET "wca_oauth_id" = "oauth_id" WHERE "oauth_provider" = 'wca' AND "wca_oauth_id" IS NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_google_id" ON "users" ("google_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_wca_oauth_id" ON "users" ("wca_oauth_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_users_google_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_users_wca_oauth_id"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "google_id"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "wca_oauth_id"`);
  }
}
