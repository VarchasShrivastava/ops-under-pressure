import 'dotenv/config';
import { DataSource } from 'typeorm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.DATABASE_URL_OWNER;

if (!databaseUrl) {
  throw new Error('DATABASE_URL_OWNER is missing from the environment');
}

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  logging: false,
  entities: [join(currentDir, '..', '**', '*.entity{.ts,.js}')],
  migrations: [join(currentDir, 'migrations', '*{.ts,.js}')],
  migrationsTableName: 'typeorm_migrations',
});

export default dataSource;
