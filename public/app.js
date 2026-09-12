const el = (id) => document.getElementById(id);
const state = { products: [], brands: [], fx: null };
const dom = {
  search: el('search'), brand: el('brand'), category: el('category'), size: el('size'),
  sort: el('sort'), inStock: el('in-stock'), clear: el('clear'), count: el('result-count'),
  updated: el('updated'), status: el('status'), grid: el('grid'), heroReel: el('hero-reel'),
  drawer: el('drawer'), drawerBody: el('drawer-body'),
};

const STOCK_LABEL = { in_stock: 'In stock', partially_in_stock: 'Limited sizes', out_of_stock: 'Sold out', unknown: 'Check availability' };
const money = (value) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: value.currency,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(value.amount / 100);

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

async function loadCatalogue() {
  try {
    const [{ brands }, result] = await Promise.all([getJson('/api/brands'), getJson('/api/catalog?limit=500')]);
    state.brands = brands;
    state.products = result.products;
    state.fx = result.fx;
    renderHeroReel();
    hydrateFilters();
    render();
    dom.grid.setAttribute('aria-busy', 'false');
    dom.status.hidden = true;
  } catch (error) {
    dom.grid.setAttribute('aria-busy', 'false');
    dom.status.textContent = 'The collection could not be loaded. Please try again shortly.';
    dom.status.classList.add('error');
    console.error(error);
  }
}

function renderHeroReel() {
  const featured = state.brands
    .map((brand) => state.products.find((product) => product.brandKey === brand.key && product.images[0]?.url))
    .filter(Boolean);

  dom.heroReel.innerHTML = featured.map((product, index) => `
    <figure class="hero-scene" style="--scene:${index}">
      <img src="${escape(product.images[0].url)}" alt="" />
      <figcaption><span>${escape(cleanBrand(product.brandName))}</span><strong>${escape(product.title)}</strong></figcaption>
    </figure>`).join('');
  dom.heroReel.style.setProperty('--scene-count', featured.length || 1);
}

function hydrateFilters() {
  dom.brand.insertAdjacentHTML('beforeend', state.brands.map((brand) => `<option value="${escape(brand.key)}">${escape(cleanBrand(brand.name))}</option>`).join(''));
  const categories = unique(state.products.map((product) => product.productType).filter(Boolean));
  dom.category.insertAdjacentHTML('beforeend', categories.map((category) => `<option value="${escape(category)}">${escape(category)}</option>`).join(''));
  const sizes = unique(state.products.flatMap((product) => product.variants.map((variant) => variant.size).filter(Boolean))).sort(sizeSort);
  dom.size.insertAdjacentHTML('beforeend', sizes.map((size) => `<option value="${escape(size)}">${escape(size)}</option>`).join(''));
  const latest = Math.max(...state.products.map((product) => Date.parse(product.scrapedAt)));
  const catalogDate = Number.isFinite(latest)
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(latest)
    : 'recently';
  const rate = state.fx
    ? ` · USD rate ${state.fx.source === 'live' ? 'live' : 'estimated'} at PKR ${state.fx.pkrPerUsd.toFixed(2)}`
    : '';
  dom.updated.textContent = `Catalogue updated ${catalogDate}${rate}`;
}

function render() {
  const term = dom.search.value.trim().toLowerCase();
  let products = state.products.filter((product) => {
    if (dom.brand.value !== 'all' && product.brandKey !== dom.brand.value) return false;
    if (dom.category.value !== 'all' && product.productType !== dom.category.value) return false;
    if (dom.size.value !== 'all' && !product.variants.some((variant) => variant.size === dom.size.value)) return false;
    if (dom.inStock.checked && !product.variants.some((variant) => variant.available)) return false;
    if (!term) return true;
    return [product.title, product.brandName, product.productType, product.vendor, ...product.tags].filter(Boolean).join(' ').toLowerCase().includes(term);
  });

  if (dom.sort.value === 'price-asc') products = [...products].sort((a, b) => a.priceMin.amount - b.priceMin.amount);
  if (dom.sort.value === 'price-desc') products = [...products].sort((a, b) => b.priceMin.amount - a.priceMin.amount);
  if (dom.sort.value === 'title') products = [...products].sort((a, b) => a.title.localeCompare(b.title));
  if (dom.sort.value === 'newest') products = [...products].sort((a, b) => b.scrapedAt.localeCompare(a.scrapedAt));

  dom.count.textContent = `${products.length} ${products.length === 1 ? 'piece' : 'pieces'}`;
  dom.grid.innerHTML = products.length ? products.map(productCard).join('') : '<div class="empty"><strong>No pieces found</strong><span>Try changing a filter or search term.</span></div>';
  for (const card of dom.grid.querySelectorAll('.product-card')) {
    card.addEventListener('click', () => openDetail(card.dataset.key));
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter') openDetail(card.dataset.key); });
  }
}

function productCard(product) {
  const image = product.images[0]?.url;
  const discounted = product.variants.find((variant) => variant.compareAtPrice);
  const sizes = unique(product.variants.filter((variant) => variant.available).map((variant) => variant.size).filter(Boolean));
  const price = product.priceMin.amount === product.priceMax.amount ? money(product.priceMin) : `From ${money(product.priceMin)}`;
  return `<article class="product-card" tabindex="0" data-key="${escape(productKey(product))}">
    <figure>${image ? `<img loading="lazy" src="${escape(image)}" alt="${escape(product.title)}" />` : '<span class="image-fallback">M</span>'}<span class="stock-label ${escape(product.stockStatus)}">${STOCK_LABEL[product.stockStatus]}</span></figure>
    <div class="product-info"><p class="product-brand">${escape(cleanBrand(product.brandName))}</p><h3>${escape(product.title)}</h3>
    <div class="product-price"><span>${price}</span>${discounted ? `<del>${money(discounted.compareAtPrice)}</del>` : ''}</div>
    <p class="available-sizes">${sizes.length ? `Sizes ${sizes.slice(0, 6).map(escape).join(' · ')}` : 'View availability'}</p></div></article>`;
}

function openDetail(key) {
  const product = state.products.find((item) => productKey(item) === key);
  if (!product) return;
  const variants = product.variants.map((variant) => `<div class="variant-row"><span>${escape(variant.size ?? variant.title)}</span><span>${variant.available ? 'Available' : 'Sold out'}</span><strong>${money(variant.price)}</strong></div>`).join('');
  dom.drawerBody.innerHTML = `<div class="detail-layout"><div class="detail-gallery">${product.images.slice(0, 4).map((image) => `<img src="${escape(image.url)}" alt="${escape(image.alt ?? product.title)}" />`).join('')}</div>
    <div class="detail-copy"><p class="eyebrow">${escape(cleanBrand(product.brandName))}</p><h2 id="drawer-title">${escape(product.title)}</h2><p class="detail-price">${money(product.priceMin)}</p>
    ${product.description ? `<p class="description">${escape(product.description.slice(0, 600))}</p>` : ''}<div class="variant-list">${variants}</div>
    <a class="shop-link" href="${escape(product.url)}" target="_blank" rel="noreferrer noopener">View on ${escape(cleanBrand(product.brandName))} ↗</a><p class="detail-note">Purchases are completed on the label’s website.</p></div></div>`;
  dom.drawer.hidden = false;
  document.body.classList.add('drawer-open');
}

function closeDetail() { dom.drawer.hidden = true; document.body.classList.remove('drawer-open'); }
function clearFilters() { dom.search.value = ''; dom.brand.value = 'all'; dom.category.value = 'all'; dom.size.value = 'all'; dom.sort.value = 'newest'; dom.inStock.checked = false; render(); }
function productKey(product) { return `${product.brandKey}:${product.externalId}`; }
function cleanBrand(name) { return name.replace(/ PK$/, ''); }
function unique(values) { return [...new Set(values)]; }
function sizeSort(left, right) {
  const order = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'ONE SIZE', 'UNSTITCHED'];
  const leftIndex = order.indexOf(left); const rightIndex = order.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
  return left.localeCompare(right, undefined, { numeric: true });
}
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`); }

for (const control of [dom.search, dom.brand, dom.category, dom.size, dom.sort, dom.inStock]) control.addEventListener('input', render);
dom.clear.addEventListener('click', clearFilters);
el('drawer-close').addEventListener('click', closeDetail);
dom.drawer.addEventListener('click', (event) => { if (event.target === dom.drawer) closeDetail(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDetail(); });
document.querySelector('[data-new-link]').addEventListener('click', () => { dom.sort.value = 'newest'; render(); });
await loadCatalogue();
