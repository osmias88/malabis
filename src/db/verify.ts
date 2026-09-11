import { supabaseAdmin } from './supabase.js';

async function main() {
  const { data, error } = await supabaseAdmin.from('brands').select('count').limit(1);
  if (error) {
    console.error('SUPABASE_ERROR', error.message);
    process.exit(1);
  }

  console.log('Supabase connection OK');
  console.log(JSON.stringify(data));
}

main().catch((error) => {
  console.error('Connection failed', error);
  process.exit(1);
});
