import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/** Global chat message storage (see chat-message.entity). */
export class AddChatMessages1783140000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fresh dev databases get the table from synchronize(); prod gets it here.
    if (await queryRunner.hasTable('chat_messages')) return;

    await queryRunner.createTable(
      new Table({
        name: 'chat_messages',
        columns: [
          { name: 'id', type: 'varchar', length: '36', isPrimary: true },
          { name: 'user_id', type: 'varchar', length: '36' },
          { name: 'username', type: 'varchar', length: '50' },
          { name: 'country', type: 'varchar', length: '8', isNullable: true },
          { name: 'text', type: 'varchar', length: '280' },
          { name: 'created_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
        ],
        indices: [
          { columnNames: ['user_id'] },
          { columnNames: ['created_at'] },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('chat_messages')) {
      await queryRunner.dropTable('chat_messages');
    }
  }
}
