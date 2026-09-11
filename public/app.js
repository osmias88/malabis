const el = (id) => document.getElementById(id);

const state = {
  products: [],
  stats: null,
};

const dom = {
  form: el('controls'),
  brand: el('brand'),
  limit: el('limit'),
  run: el('run'),
  runFile: el('run-file'),
  status: el('status'),
  stats: el('stats'),
  filters: el('filters'),
  grid: el('grid'),
  search: el('search'),
  stock: el('stock'),
  sort: el('sort'),
  count: el('result-count'),
  drawer: el('drawer'),
  drawerBody: el('drawer-body'),
};

const money = (value) =>
  `${value.currency} ${(value.amount / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const STOCK_LABEL = {
  in_stock: 'In stock',
  partially_in_stock: 'Partial',
  out_of_stock: 'Sold out',
  unknown: 'Unknown',
};

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

async function loadBrands() {
  const { brands } = await getJson('/api/brands');
  dom.brand.innerHTML = brands
    .map((b) => `<option value="${b.key}">${b.name} — ${b.adapter}</option>`)
    .join('');
}

async function loadRuns() {
  const { runs } = await getJson('/api/runs');
  dom.runFile.innerHTML =
    '<option value="">—</option>' +
    runs
      .map((r) => `<option value="${r.file}">${r.file.replace('.json', '')}</option>`)
      .join('');
}

function render() {
  const term = dom.search.value.trim().toLowerCase();
  const stock = dom.stock.value;

  let items = state.products.filter((product) => {
    if (stock !== 'all' && product.stockStatus !== stock) return false;
    if (!term) return true;
    const haystack = [
      product.title,
      product.productType ?? '',
      ...product.variants.map((v) => `${v.size ?? ''} ${v.color ?? ''}`),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(term);
  });

  if (dom.sort.value === 'price-asc') items = [...items].sort((a, b) => a.priceMin.amount - b.priceMin.amount);
  if (dom.sort.value === 'price-desc') items = [...items].sort((a, b) => b.priceMin.amount - a.priceMin.amount);
  if (dom.sort.value === 'title') items = [...items].sort((a, b) => a.title.localeCompare(b.title));

  dom.count.textContent = `${items.length} of ${state.products.length} products`;
  dom.grid.innerHTML = items.length
    ? items.map(card).join('')
    : '<p class="empty">No products match these filters.</p>';

  for (const node of dom.grid.querySelectorAll('.card')) {
    node.addEventListener('click', () => openDetail(node.dataset.key));
  }
}

function card(product) {
  const image = product.images[0]?.url;
  const discounted = product.variants.find((v) => v.compareAtPrice);
  const price =
    product.priceMin.amount === product.priceMax.amount
      ? money(product.priceMin)
      : `${money(product.priceMin)} – ${money(product.priceMax)}`;

  const sizes = product.variants
    .map((v) => `<span class="size ${v.available ? '' : 'out'}">${escape(v.size ?? v.title)}</span>`)
    .join('');

  return `
    <article class="card" data-key="${escape(product.externalId)}">
      <figure>${image ? `<img loading="lazy" src="${escape(image)}" alt="${escape(product.title)}" />` : ''}</figure>
      <div class="card-body">
        <h2>${escape(product.title)}</h2>
        <div class="price">${price}${
          discounted ? `<del>${money(discounted.compareAtPrice)}</del>` : ''
        }</div>
        <span class="badge ${product.stockStatus}">${STOCK_LABEL[product.stockStatus]}</span>
        <div class="sizes">${sizes}</div>
        <div class="meta">${escape(product.brandName)} · ${product.variants.length} variants</div>
      </div>
    </article>`;
}

function openDetail(key) {
  const product = state.products.find((p) => p.externalId === key);
  if (!product) return;

  const rows = product.variants
    .map(
      (v) => `
        <tr>
          <td>${escape(v.size ?? v.title)}</td>
          <td>${escape(v.rawSize ?? '—')}</td>
          <td>${escape(v.color ?? '—')}</td>
          <td>${money(v.price)}</td>
          <td class="${v.available ? 'yes' : 'no'}">${v.available ? 'in stock' : 'sold out'}</td>
          <td>${escape(v.sku ?? '—')}</td>
        </tr>`,
    )
    .join('');

  dom.drawerBody.innerHTML = `
    <h2>${escape(product.title)}</h2>
    <p class="meta">${escape(product.brandName)} · ${escape(product.externalId)} ·
      <a href="${escape(product.url)}" target="_blank" rel="noreferrer noopener">open on storefront</a></p>
    <div class="detail-images">
      ${product.images
        .slice(0, 6)
        .map((i) => `<img loading="lazy" src="${escape(i.url)}" alt="" />`)
        .join('')}
    </div>
    ${product.description ? `<p class="meta">${escape(product.description.slice(0, 400))}</p>` : ''}
    <table>
      <thead>
        <tr><th>Size</th><th>Raw</th><th>Colour</th><th>Price</th><th>Stock</th><th>SKU</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  dom.drawer.hidden = false;
}

function showResult({ products, stats }) {
  state.products = products;
  state.stats = stats;

  el('stat-products').textContent = stats.productsParsed;
  el('stat-variants').textContent = stats.variants;
  el('stat-instock').textContent = products.filter((p) => p.stockStatus === 'in_stock').length;
  el('stat-partial').textContent = products.filter((p) => p.stockStatus === 'partially_in_stock').length;
  el('stat-oos').textContent = products.filter((p) => p.stockStatus === 'out_of_stock').length;
  el('stat-requests').textContent = stats.requests;
  el('stat-duration').textContent = `${(stats.durationMs / 1000).toFixed(1)}s`;
  el('stat-adapter').textContent = stats.adapter;

  dom.stats.hidden = false;
  dom.filters.hidden = false;
  render();
}

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

dom.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const brand = dom.brand.value;
  const limit = dom.limit.value;

  dom.run.disabled = true;
  setStatus(`Scraping ${brand} live — this hits the real storefront, so give it a moment…`);
  try {
    const result = await getJson(`/api/scrape?brand=${encodeURIComponent(brand)}&limit=${limit}`);
    showResult(result);
    setStatus(`Scraped ${result.stats.productsParsed} products from ${brand}.`);
    await loadRuns();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    dom.run.disabled = false;
  }
});

dom.runFile.addEventListener('change', async () => {
  if (!dom.runFile.value) return;
  setStatus(`Loading saved run ${dom.runFile.value}…`);
  try {
    const result = await getJson(`/api/run?file=${encodeURIComponent(dom.runFile.value)}`);
    showResult(result);
    setStatus(`Loaded ${result.products.length} products from ${dom.runFile.value}.`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

for (const control of [dom.search, dom.stock, dom.sort]) {
  control.addEventListener('input', render);
}

el('drawer-close').addEventListener('click', () => {
  dom.drawer.hidden = true;
});
dom.drawer.addEventListener('click', (event) => {
  if (event.target === dom.drawer) dom.drawer.hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') dom.drawer.hidden = true;
});

await loadBrands();
await loadRuns();
setStatus('Pick a brand and scrape live, or load a saved run.');
