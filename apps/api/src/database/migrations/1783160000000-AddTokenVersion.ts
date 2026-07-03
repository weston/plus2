import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds users.token_version — bumped on logout to invalidate every outstanding
 * refresh token (the refresh token embeds this value as its `tv` claim, and
 * refresh rejects any token whose `tv` no longer matches).
 *
 * Postgres only (prod). In dev (sqlite) `synchronize` adds the column from the
 * entity definition.
 */
export class AddTokenVersion1783160000000 implements MigrationInterface {
  name = 'AddTokenVersion1783160000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "token_version" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "token_version"`);
  }
}
