import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Client } = pg;
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const schemaPath = new URL('../supabase-schema.sql', import.meta.url);
const schemaSql = fs.readFileSync(schemaPath, 'utf8');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is missing. Fill in .env first.');
}

const client = new Client({ connectionString });

try {
  await client.connect();
  await client.query(schemaSql);

  const result = await client.query(
    "select table_name from information_schema.tables where table_schema='public' and table_name in ('brands','products','variants','scrape_runs','price_history','stock_history') order by table_name",
  );

  console.log(JSON.stringify(result.rows));
} finally {
  await client.end();
}
