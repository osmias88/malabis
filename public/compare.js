const el = (id) => document.getElementById(id);

const dom = {
  form: el('controls'),
  base: el('base'),
  targets: el('targets'),
  limit: el('limit'),
  currency: el('currency'),
  run: el('run'),
  status: el('status'),
  warnings: el('warnings'),
  summary: el('summary'),
  wrap: el('table-wrap'),
  thead: el('thead'),
  tbody: el('tbody'),
};

let brands = [];

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const major = (money) =>
  money ? money.amount / 100 : null;
const fmt = (money) =>
  money
    ? (money.amount / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';

function setStatus(message, isError = false) {
  dom.status.hidden = !message;
  dom.status.textContent = message ?? '';
  dom.status.classList.toggle('error', Boolean(isError));
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function refreshTargets() {
  const base = brands.find((b) => b.key === dom.base.value);
  const options = brands.filter((b) => b.key !== base.key);
  dom.targets.innerHTML = options
    .map(
      (b) =>
        `<option value="${b.key}" ${b.family === base.family ? 'selected' : ''}>${escape(b.name)} (${b.currency})</option>`,
    )
    .join('');
}

async function loadBrands() {
  ({ brands } = await getJson('/api/brands'));
  dom.base.innerHTML = brands
    .map((b) => `<option value="${b.key}">${escape(b.name)} — ${b.currency}</option>`)
    .join('');
  dom.base.value = brands.find((b) => b.market === 'PK')?.key ?? brands[0].key;
  refreshTargets();
}

function renderSummary(report) {
  const cards = [
    `<article><span>${report.summary.matched}/${report.summary.compared}</span><small>matched</small></article>`,
  ];

  for (const key of report.targetBrandKeys) {
    const markup = report.summary.medianMarkup[key];
    const spread = report.summary.medianSpread[key];
    cards.push(`
      <article>
        <span class="${markup > 1.05 ? 'good' : markup < 0.95 ? 'bad' : ''}">${
          markup ? `${markup.toFixed(2)}×` : '—'
        }</span>
        <small>median vs ${escape(key)}</small>
      </article>`);
    cards.push(`
      <article>
        <span>${spread ? `+${fmt(spread)}` : '—'}</span>
        <small>gross spread / item (${report.reportCurrency})</small>
      </article>`);
  }

  cards.push(
    `<article><span>${escape(report.fx.source)}</span><small>FX source</small></article>`,
  );

  dom.summary.innerHTML = cards.join('');
  dom.summary.hidden = false;
}

function renderTable(report) {
  const head = [
    '<th>Product</th>',
    `<th>${escape(report.baseBrandKey)}<br /><small>buy price</small></th>`,
  ];
  for (const key of report.targetBrandKeys) {
    head.push(`<th>${escape(key)}<br /><small>their price</small></th>`, '<th>gap</th>');
  }
  dom.thead.innerHTML = `<tr>${head.join('')}</tr>`;

  dom.tbody.innerHTML = report.rows
    .map((row) => {
      const cells = [
        `<td class="product">
           ${row.image ? `<img loading="lazy" src="${escape(row.image)}" alt="" />` : ''}
           <a href="${escape(row.base.url)}" target="_blank" rel="noreferrer noopener">${escape(row.title)}</a>
         </td>`,
        `<td class="num">${fmt(row.base.normalized)}<small>${escape(row.base.currency ?? '')} ${fmt(row.base.price)}</small></td>`,
      ];

      for (const key of report.targetBrandKeys) {
        const quote = row.targets.find((t) => t.brandKey === key);
        const markup = row.markups[key];
        if (!quote?.found) {
          cells.push(`<td class="num muted" colspan="2">${escape(quote?.note ?? 'not found')}</td>`);
          continue;
        }
        cells.push(
          `<td class="num">${fmt(quote.normalized)}<small>${escape(quote.currency)} ${fmt(quote.price)}</small></td>`,
          `<td class="num ${markup > 1.05 ? 'good' : markup < 0.95 ? 'bad' : ''}">${
            markup ? `${markup.toFixed(2)}×` : '—'
          }</td>`,
        );
      }
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');

  dom.wrap.hidden = false;
}

function renderWarnings(report) {
  dom.warnings.hidden = report.warnings.length === 0;
  dom.warnings.innerHTML = report.warnings.map((w) => `<p>⚠ ${escape(w)}</p>`).join('');
}

dom.base.addEventListener('change', refreshTargets);

dom.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const targets = [...dom.targets.selectedOptions].map((o) => o.value);
  if (targets.length === 0) return setStatus('Pick at least one market to compare against.', true);

  dom.run.disabled = true;
  setStatus('Scraping both storefronts live — a comparison costs one request per product per market…');
  try {
    const params = new URLSearchParams({
      base: dom.base.value,
      targets: targets.join(','),
      limit: dom.limit.value,
      currency: dom.currency.value,
    });
    const report = await getJson(`/api/compare?${params}`);
    renderWarnings(report);
    renderSummary(report);
    renderTable(report);
    setStatus(`Compared ${report.summary.compared} products.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    dom.run.disabled = false;
  }
});

await loadBrands();
setStatus('Pick the market you buy in, then the markets you sell into.');
