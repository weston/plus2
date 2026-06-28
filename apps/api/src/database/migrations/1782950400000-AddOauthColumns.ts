import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the OAuth/WCA columns to `users`:
 *  - `wca_id` (nullable) — linked World Cube Association ID
 *  - makes `password_hash` nullable — OAuth-only accounts have no password
 *
 * Only runs against Postgres (production). In development (sqlite) `synchronize`
 * already applies these from the entity definition, and sqlite cannot ALTER a
 * column's nullability anyway — so this is a no-op there.
 */
export class AddOauthColumns1782950400000 implements MigrationInterface {
  name = 'AddOauthColumns1782950400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "wca_id" character varying(20)`,
    );
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "wca_id"`);
    // Intentionally NOT restoring password_hash NOT NULL: OAuth-only rows may
    // legitimately have a NULL password_hash, which would make re-adding the
    // constraint fail.
  }
}
