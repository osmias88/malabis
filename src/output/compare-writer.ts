import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ComparisonReport } from '../compare/compare.js';

const csvEscape = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const major = (amount: number): string => (amount / 100).toFixed(2);

export function comparisonToCsv(report: ComparisonReport): string {
  const header = [
    'external_id',
    'title',
    'base_market',
    'base_currency',
    'base_price',
    `base_price_${report.reportCurrency.toLowerCase()}`,
    'base_stock',
  ];
  for (const key of report.targetBrandKeys) {
    header.push(`${key}_currency`, `${key}_price`, `${key}_price_${report.reportCurrency.toLowerCase()}`, `${key}_markup`, `${key}_stock`);
  }

  const rows = [header.join(',')];
  for (const row of report.rows) {
    const cells: unknown[] = [
      row.externalId,
      row.title,
      row.base.market,
      row.base.currency,
      row.base.price ? major(row.base.price.amount) : '',
      row.base.normalized ? major(row.base.normalized.amount) : '',
      row.base.stockStatus,
    ];
    for (const key of report.targetBrandKeys) {
      const quote = row.targets.find((t) => t.brandKey === key);
      cells.push(
        quote?.currency ?? '',
        quote?.price ? major(quote.price.amount) : '',
        quote?.normalized ? major(quote.normalized.amount) : '',
        row.markups[key] ?? '',
        quote?.found ? quote.stockStatus : (quote?.note ?? 'not found'),
      );
    }
    rows.push(cells.map(csvEscape).join(','));
  }

  return `${rows.join('\n')}\n`;
}

export async function writeComparison(
  report: ComparisonReport,
  outputDir: string,
  formats: Array<'json' | 'csv'>,
): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `compare-${report.family}-${stamp}`;
  const written: string[] = [];

  if (formats.includes('json')) {
    const file = path.join(outputDir, `${base}.json`);
    await writeFile(file, JSON.stringify(report, null, 2), 'utf8');
    written.push(file);
  }
  if (formats.includes('csv')) {
    const file = path.join(outputDir, `${base}.csv`);
    await writeFile(file, comparisonToCsv(report), 'utf8');
    written.push(file);
  }
  return written;
}

export function printComparison(report: ComparisonReport): void {
  const lines: string[] = [
    '',
    `Baseline   : ${report.baseBrandKey}`,
    `Markets    : ${report.targetBrandKeys.join(', ')}`,
    `Reported in: ${report.reportCurrency} (FX ${report.fx.source}, ${report.fx.asOf})`,
    `Matched    : ${report.summary.matched}/${report.summary.compared}`,
    '',
  ];

  for (const warning of report.warnings) lines.push(`! ${warning}`);
  if (report.warnings.length > 0) lines.push('');

  const width = 34;
  const header = ['product'.padEnd(width), 'base'.padStart(12)];
  for (const key of report.targetBrandKeys) header.push(key.padStart(12), 'x'.padStart(6));
  lines.push(header.join(' '));
  lines.push('-'.repeat(header.join(' ').length));

  for (const row of report.rows) {
    const cells = [
      row.title.slice(0, width).padEnd(width),
      (row.base.normalized ? major(row.base.normalized.amount) : '-').padStart(12),
    ];
    for (const key of report.targetBrandKeys) {
      const quote = row.targets.find((t) => t.brandKey === key);
      const markup = row.markups[key];
      cells.push(
        (quote?.normalized ? major(quote.normalized.amount) : '-').padStart(12),
        (markup ? `${markup.toFixed(2)}x` : '-').padStart(6),
      );
    }
    lines.push(cells.join(' '));
  }

  lines.push('');
  for (const key of report.targetBrandKeys) {
    const markup = report.summary.medianMarkup[key];
    const spread = report.summary.medianSpread[key];
    lines.push(
      `Median vs ${key}: ${markup ? `${markup.toFixed(2)}x` : 'n/a'}` +
        (spread ? `  (+${major(spread.amount)} ${report.reportCurrency} per item)` : ''),
    );
  }
  lines.push('');

  process.stdout.write(`${lines.join('\n')}\n`);
}
