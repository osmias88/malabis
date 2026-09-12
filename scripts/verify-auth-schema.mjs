import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const result = await client.query(
    "select table_name from information_schema.tables where table_schema = 'public' and table_name = 'profiles'",
  );
  console.log(JSON.stringify(result.rows));
} finally {
  await client.end();
}
