import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';
import { randomUUID } from 'crypto';

/**
 * Scramble-set lineage: every match / ghost session gets a scramble_set_id
 * identifying the scramble sequence it used. All ghosts descended from the
 * same original scrambles share the id, so players are never offered
 * scrambles they've already seen.
 *
 * Backfill: existing rows are grouped by their first-round scramble — a
 * match and the ghost sessions snapshotted from it (and any race snapshots
 * of those ghosts) all share round-1 scrambles, which reconstructs the
 * lineage for historical data.
 */
export class AddScrambleSetIds1783130000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // On a FRESH database, migrations run before synchronize creates the
    // tables — nothing exists yet and synchronize will create the columns
    // straight from the entities, so there is nothing to migrate or backfill.
    if (!(await queryRunner.hasTable('matches')) || !(await queryRunner.hasTable('solo_sessions'))) {
      return;
    }

    // Guarded: dev runs synchronize() which may have added the columns already.
    if (!(await queryRunner.hasColumn('matches', 'scramble_set_id'))) {
      await queryRunner.addColumn(
        'matches',
        new TableColumn({ name: 'scramble_set_id', type: 'varchar', length: '64', isNullable: true }),
      );
    }
    if (!(await queryRunner.hasColumn('solo_sessions', 'scramble_set_id'))) {
      await queryRunner.addColumn(
        'solo_sessions',
        new TableColumn({ name: 'scramble_set_id', type: 'varchar', length: '64', isNullable: true }),
      );
    }

    // ---- Backfill lineage by first-round scramble --------------------------
    // Only UUIDs are ever inlined into SQL below (safe charset, and the
    // placeholder syntax differs between sqlite and postgres).
    const setForScramble = new Map<string, string>();
    const idFor = (scramble: string) => {
      let id = setForScramble.get(scramble);
      if (!id) {
        id = randomUUID();
        setForScramble.set(scramble, id);
      }
      return id;
    };

    const matches: Array<{ id: string; scramble: string | null }> = await queryRunner.query(
      `SELECT m.id AS id,
              (SELECT s.scramble FROM solves s WHERE s.match_id = m.id ORDER BY s.round_number ASC LIMIT 1) AS scramble
         FROM matches m
        WHERE m.scramble_set_id IS NULL`,
    );
    for (const row of matches) {
      if (!row.scramble) continue;
      await queryRunner.query(
        `UPDATE matches SET scramble_set_id = '${idFor(row.scramble)}' WHERE id = '${row.id}'`,
      );
    }

    const sessions: Array<{ id: string; scramble: string | null }> = await queryRunner.query(
      `SELECT ss.id AS id,
              (SELECT sv.scramble FROM solo_solves sv WHERE sv.session_id = ss.id ORDER BY sv.round_number ASC LIMIT 1) AS scramble
         FROM solo_sessions ss
        WHERE ss.scramble_set_id IS NULL`,
    );
    for (const row of sessions) {
      if (!row.scramble) continue;
      await queryRunner.query(
        `UPDATE solo_sessions SET scramble_set_id = '${idFor(row.scramble)}' WHERE id = '${row.id}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('matches', 'scramble_set_id')) {
      await queryRunner.dropColumn('matches', 'scramble_set_id');
    }
    if (await queryRunner.hasColumn('solo_sessions', 'scramble_set_id')) {
      await queryRunner.dropColumn('solo_sessions', 'scramble_set_id');
    }
  }
}
