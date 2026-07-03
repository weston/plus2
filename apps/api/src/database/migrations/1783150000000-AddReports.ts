import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/** Cheating reports + admin flag; grants admin to the site owner. */
export class AddReports1783150000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fresh databases get everything from synchronize().
    if (!(await queryRunner.hasTable('users'))) return;

    if (!(await queryRunner.hasColumn('users', 'is_admin'))) {
      await queryRunner.query(
        `ALTER TABLE "users" ADD COLUMN "is_admin" boolean NOT NULL DEFAULT false`,
      );
    }
    await queryRunner.query(
      `UPDATE "users" SET "is_admin" = true WHERE "email" = 'wmizumoto@gmail.com'`,
    );

    if (!(await queryRunner.hasTable('reports'))) {
      await queryRunner.createTable(
        new Table({
          name: 'reports',
          columns: [
            { name: 'id', type: 'varchar', length: '36', isPrimary: true },
            { name: 'reporter_id', type: 'varchar', length: '36' },
            { name: 'reported_user_id', type: 'varchar', length: '36' },
            { name: 'context_type', type: 'varchar', length: '16' },
            { name: 'match_id', type: 'varchar', length: '36', isNullable: true },
            { name: 'ghost_session_id', type: 'varchar', length: '36', isNullable: true },
            { name: 'reason', type: 'varchar', length: '500', isNullable: true },
            { name: 'status', type: 'varchar', length: '24', default: "'pending'" },
            { name: 'reviewed_by', type: 'varchar', length: '36', isNullable: true },
            { name: 'reviewed_at', type: 'timestamp', isNullable: true },
            { name: 'created_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
          ],
          indices: [
            { columnNames: ['reported_user_id'] },
            { columnNames: ['reporter_id'] },
            { columnNames: ['status'] },
          ],
        }),
        true,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('reports')) await queryRunner.dropTable('reports');
  }
}
