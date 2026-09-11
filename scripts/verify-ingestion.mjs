import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const brandKey = process.argv[2] ?? 'cambridge-pk';
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is missing. Fill in .env first.');

const client = new pg.Client({ connectionString });

try {
  await client.connect();

  const latestRun = await client.query(
    `select r.id, r.status, r.products_found, r.products_parsed, r.request_count
       from scrape_runs r
       join brands b on b.id = r.brand_id
      where b.key = $1
      order by r.started_at desc
      limit 1`,
    [brandKey],
  );
  const counts = await client.query(
    `select
       (select count(*)::int from products p join brands b on b.id = p.brand_id where b.key = $1) as products,
       (select count(*)::int from variants v join products p on p.id = v.product_id join brands b on b.id = p.brand_id where b.key = $1) as variants,
       (select count(*)::int from price_history h join products p on p.id = h.product_id join brands b on b.id = p.brand_id where b.key = $1 and h.variant_id is null) as product_prices,
       (select count(*)::int from price_history h join products p on p.id = h.product_id join brands b on b.id = p.brand_id where b.key = $1 and h.variant_id is not null) as variant_prices,
       (select count(*)::int from stock_history h join products p on p.id = h.product_id join brands b on b.id = p.brand_id where b.key = $1) as stock_snapshots`,
    [brandKey],
  );

  console.log(JSON.stringify({ brandKey, latestRun: latestRun.rows[0] ?? null, counts: counts.rows[0] }));
} finally {
  await client.end();
}