#!/usr/bin/env node
import { Command, Option } from 'commander';
import { BRANDS, brandFromUrl, getBrand, getFamily } from './config/brands.js';
import { createContext, resolveAdapter, scrapeBrand, scrapeSingleProduct } from './core/pipeline.js';
import { createLogger, setLogLevel } from './core/logger.js';
import { printSummary, writeResults, type OutputFormat } from './output/writer.js';
import { printComparison, writeComparison } from './output/compare-writer.js';
import { comparePrices } from './compare/compare.js';
import { createConverter, parseRateOverrides } from './compare/fx.js';
import { printDoctor, runDoctor } from './diagnostics/doctor.js';
import { startServer } from './server.js';

const log = createLogger('cli');

const program = new Command()
  .name('malabis-scraper')
  .description('Proof-of-concept product scraper for Pakistani clothing brands')
  .version('0.1.0');

const logLevelOption = new Option('--log-level <level>', 'log verbosity')
  .choices(['debug', 'info', 'warn', 'error'])
  .default('info');

program
  .command('brands')
  .description('List brands in the registry')
  .action(() => {
    for (const brand of BRANDS) {
      process.stdout.write(
        `${brand.key.padEnd(14)} ${brand.name.padEnd(16)} ${brand.market.padEnd(3)} ${brand.currency} ${brand.baseUrl} [${brand.adapter}]\n`,
      );
    }
  });

program
  .command('doctor')
  .description('Check the egress IP and whether each storefront serves its own market')
  .option('-b, --brand <keys>', 'comma separated brand keys to check')
  .addOption(logLevelOption)
  .action(async (options: { brand?: string; logLevel: string }) => {
    setLogLevel(options.logLevel as 'info');
    const keys = options.brand?.split(',').map((key) => key.trim()).filter(Boolean);
    const report = await runDoctor(keys);
    printDoctor(report);
    if (report.checks.some((check) => !check.ok)) process.exitCode = 1;
  });

program
  .command('compare')
  .description('Compare the same SKUs across a brand\'s market storefronts')
  .option('-b, --base <key>', 'baseline market (where you buy)', 'khaadi-pk')
  .option('-t, --targets <list>', 'comma separated markets to compare against')
  .option('-l, --limit <n>', 'products to compare', (v) => Number.parseInt(v, 10), 12)
  .option('-c, --currency <code>', 'report currency', 'USD')
  .option('--rate <list>', 'pin FX rates per USD, e.g. PKR=280,GBP=0.75')
  .option('-o, --out <dir>', 'output directory', './output')
  .option('-f, --format <list>', 'comma separated: json,csv', 'json,csv')
  .option('--dry-run', 'do not write files', false)
  .addOption(logLevelOption)
  .action(async (options: CompareOptions) => {
    setLogLevel(options.logLevel as 'info');
    const base = getBrand(options.base);
    const targets = options.targets
      ? options.targets.split(',').map((key) => key.trim()).filter(Boolean)
      : getFamily(base.family).filter((b) => b.key !== base.key).map((b) => b.key);

    if (targets.length === 0) {
      throw new Error(`No other markets registered for "${base.family}". Pass --targets explicitly.`);
    }

    const converter = await createConverter(parseRateOverrides(options.rate));
    const report = await comparePrices({
      baseBrandKey: base.key,
      targetBrandKeys: targets,
      limit: options.limit,
      reportCurrency: options.currency,
      converter,
    });
    printComparison(report);

    if (!options.dryRun && report.rows.length > 0) {
      const files = await writeComparison(report, options.out, parseFormats(options.format));
      files.forEach((file) => log.info(`wrote ${file}`));
    }
  });

program
  .command('probe')
  .description('Detect which adapter can handle a brand or URL')
  .option('-b, --brand <key>', 'brand key from the registry')
  .option('-u, --url <url>', 'arbitrary storefront URL')
  .addOption(logLevelOption)
  .action(async (options: { brand?: string; url?: string; logLevel: string }) => {
    setLogLevel(options.logLevel as 'info');
    const brand = options.brand ? getBrand(options.brand) : brandFromUrl(requireUrl(options.url));
    const context = createContext(brand, { limit: 1 });
    const adapter = await resolveAdapter(context);
    process.stdout.write(`${brand.key} → ${adapter.name}\n`);
  });

program
  .command('scrape', { isDefault: true })
  .description('Scrape products for a brand (or every brand with --all)')
  .option('-b, --brand <key>', 'brand key from the registry')
  .option('-a, --all', 'scrape every registered brand', false)
  .option('-l, --limit <n>', 'max products per brand', (v) => Number.parseInt(v, 10), 25)
  .option('-c, --concurrency <n>', 'parallel requests', (v) => Number.parseInt(v, 10), 4)
  .option('-o, --out <dir>', 'output directory', './output')
  .option('-f, --format <list>', 'comma separated: json,csv', 'json,csv')
  .option('--no-robots', 'skip robots.txt checks (development only)')
  .option('--dry-run', 'do not write files', false)
  .addOption(logLevelOption)
  .action(async (options: ScrapeOptions) => {
    setLogLevel(options.logLevel as 'info');
    const formats = parseFormats(options.format);
    const brands = options.all
      ? BRANDS
      : [getBrand(options.brand ?? requireBrand())];

    for (const brand of brands) {
      log.info(`scraping ${brand.name} (limit ${options.limit})`);
      try {
        const result = await scrapeBrand(brand, {
          limit: options.limit,
          concurrency: options.concurrency,
          respectRobots: options.robots,
        });
        printSummary(result);

        if (!options.dryRun && result.products.length > 0) {
          const files = await writeResults(result, options.out, formats);
          files.forEach((file) => log.info(`wrote ${file}`));
        }
      } catch (error) {
        log.error(`brand "${brand.key}" failed`, { error: String(error) });
        process.exitCode = 1;
      }
    }
  });

program
  .command('ingest')
  .description('Scrape products and persist them to Supabase (one brand or every brand with --all)')
  .option('-b, --brand <key>', 'brand key from the registry')
  .option('-a, --all', 'ingest every registered brand', false)
  .option('-l, --limit <n>', 'max products to ingest', (v) => Number.parseInt(v, 10), 25)
  .option('-c, --concurrency <n>', 'parallel requests', (v) => Number.parseInt(v, 10), 4)
  .option('--no-robots', 'skip robots.txt checks (development only)')
  .addOption(logLevelOption)
  .action(async (options: IngestOptions) => {
    setLogLevel(options.logLevel as 'info');
    if (options.all && options.brand) throw new Error('Use either --brand <key> or --all, not both.');
    const brands = options.all ? BRANDS : [getBrand(options.brand ?? requireBrand())];
    const { ingestBrand } = await import('./db/ingest.js');

    for (const brand of brands) {
      log.info(`ingesting ${brand.name} (limit ${options.limit})`);
      try {
        const summary = await ingestBrand(brand, {
          limit: options.limit,
          concurrency: options.concurrency,
          respectRobots: options.robots,
        });
        log.info(`saved ${summary.products} products and ${summary.variants} variants`, {
          brand: summary.brandKey,
          runId: summary.runId,
        });
      } catch (error) {
        log.error(`brand "${brand.key}" failed`, { error: String(error) });
        process.exitCode = 1;
      }
    }
  });

program
  .command('serve')
  .description('Start the dashboard for browsing scraped products')
  .option('-p, --port <n>', 'port to listen on', (v) => Number.parseInt(v, 10), 5173)
  .addOption(logLevelOption)
  .action((options: { port: number; logLevel: string }) => {
    setLogLevel(options.logLevel as 'info');
    startServer(options.port);
  });

program
  .command('product')
  .description('Scrape a single product URL and print the normalised record')
  .argument('<url>', 'product page URL')
  .addOption(logLevelOption)
  .action(async (url: string, options: { logLevel: string }) => {
    setLogLevel(options.logLevel as 'info');
    const brand = BRANDS.find((b) => url.startsWith(b.baseUrl)) ?? brandFromUrl(url);
    const product = await scrapeSingleProduct(brand, url, { limit: 1 });
    if (!product) {
      log.error('no product data found on that page');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(product, null, 2)}\n`);
  });

interface ScrapeOptions {
  brand?: string;
  all: boolean;
  limit: number;
  concurrency: number;
  out: string;
  format: string;
  robots: boolean;
  dryRun: boolean;
  logLevel: string;
}

interface CompareOptions {
  base: string;
  targets?: string;
  limit: number;
  currency: string;
  rate?: string;
  out: string;
  format: string;
  dryRun: boolean;
  logLevel: string;
}

interface IngestOptions {
  brand?: string;
  all: boolean;
  limit: number;
  concurrency: number;
  robots: boolean;
  logLevel: string;
}

function parseFormats(value: string): OutputFormat[] {
  const formats = value
    .split(',')
    .map((f) => f.trim().toLowerCase())
    .filter((f): f is OutputFormat => f === 'json' || f === 'csv');
  if (formats.length === 0) throw new Error('--format must include at least one of: json, csv');
  return formats;
}

function requireBrand(): never {
  throw new Error('Provide --brand <key> or --all. Run `npm run brands` to list options.');
}

function requireUrl(url: string | undefined): string {
  if (!url) throw new Error('Provide --brand <key> or --url <url>');
  return url;
}

program.parseAsync(process.argv).catch((error: unknown) => {
  log.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
