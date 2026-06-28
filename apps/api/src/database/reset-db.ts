/**
 * Database Reset Script
 *
 * This script truncates all tables in the database.
 * Run with: npx ts-node -r tsconfig-paths/register src/database/reset-db.ts
 *
 * For production, set the environment variables:
 * DB_TYPE=postgres DB_HOST=xxx DB_PORT=5432 DB_USERNAME=xxx DB_PASSWORD=xxx DB_DATABASE=plus2 npx ts-node -r tsconfig-paths/register src/database/reset-db.ts
 */

import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function resetDatabase() {
  const dbType = process.env.DB_TYPE || 'sqlite';

  let dataSource: DataSource;

  if (dbType === 'sqlite') {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: process.env.DB_DATABASE || 'plus2.db',
      entities: [__dirname + '/../**/*.entity{.ts,.js}'],
      synchronize: false,
    });
  } else {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_DATABASE || 'plus2',
      entities: [__dirname + '/../**/*.entity{.ts,.js}'],
      synchronize: false,
    });
  }

  try {
    await dataSource.initialize();
    console.log('Connected to database');

    // Get all table names
    const entities = dataSource.entityMetadatas;
    const tableNames = entities.map(entity => `"${entity.tableName}"`).join(', ');

    if (entities.length === 0) {
      console.log('No tables found');
      await dataSource.destroy();
      return;
    }

    console.log('Tables to truncate:', tableNames);

    // Confirm before proceeding (skip in non-interactive mode)
    if (process.argv.includes('--force') || process.argv.includes('-f')) {
      console.log('Force flag detected, proceeding...');
    } else {
      console.log('\nWARNING: This will DELETE ALL DATA from these tables!');
      console.log('Run with --force or -f to proceed without confirmation\n');

      // Simple readline for confirmation
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question('Type "yes" to confirm: ', resolve);
      });
      rl.close();

      if (answer.toLowerCase() !== 'yes') {
        console.log('Aborted');
        await dataSource.destroy();
        return;
      }
    }

    // Truncate tables (order matters due to foreign keys)
    // We'll disable foreign key checks temporarily
    const queryRunner = dataSource.createQueryRunner();

    try {
      if (dbType === 'postgres') {
        // PostgreSQL: Use TRUNCATE CASCADE
        for (const entity of entities) {
          const tableName = entity.tableName;
          console.log(`Truncating table: ${tableName}`);
          await queryRunner.query(`TRUNCATE TABLE "${tableName}" CASCADE`);
        }
      } else {
        // SQLite: Disable foreign keys, delete, re-enable
        await queryRunner.query('PRAGMA foreign_keys = OFF');
        for (const entity of entities) {
          const tableName = entity.tableName;
          console.log(`Deleting from table: ${tableName}`);
          await queryRunner.query(`DELETE FROM "${tableName}"`);
        }
        await queryRunner.query('PRAGMA foreign_keys = ON');
      }
    } finally {
      await queryRunner.release();
    }

    console.log('\nDatabase reset complete!');
    await dataSource.destroy();
  } catch (error) {
    console.error('Error resetting database:', error);
    process.exit(1);
  }
}

resetDatabase();
