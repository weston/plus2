import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration to reset all data in the database.
 * This will truncate all tables, removing all users, matches, ghost recordings, etc.
 *
 * WARNING: This is destructive and cannot be undone!
 */
export class ResetAllData1737802500000 implements MigrationInterface {
  name = 'ResetAllData1737802500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Detect database type
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    console.log('Starting database reset migration...');

    if (isPostgres) {
      // PostgreSQL: Use TRUNCATE CASCADE
      const tables = [
        'solves',
        'matches',
        'ghost_races',
        'solo_solves',
        'solo_sessions',
        'keybinding_profiles',
        'user_puzzle_stats',
        'users',
      ];

      for (const table of tables) {
        console.log(`Truncating table: ${table}`);
        await queryRunner.query(`TRUNCATE TABLE "${table}" CASCADE`);
      }
    } else {
      // SQLite: Disable foreign keys, delete, re-enable
      await queryRunner.query('PRAGMA foreign_keys = OFF');

      const tables = [
        'solves',
        'matches',
        'ghost_races',
        'solo_solves',
        'solo_sessions',
        'keybinding_profiles',
        'user_puzzle_stats',
        'users',
      ];

      for (const table of tables) {
        console.log(`Deleting from table: ${table}`);
        await queryRunner.query(`DELETE FROM "${table}"`);
      }

      await queryRunner.query('PRAGMA foreign_keys = ON');
    }

    console.log('Database reset complete!');
  }

  public async down(): Promise<void> {
    // Cannot restore deleted data
    console.log('WARNING: Cannot restore deleted data from reset migration');
  }
}
