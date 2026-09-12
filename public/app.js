const el = (id) => document.getElementById(id);
const state = { products: [], brands: [], fx: null, auth: null, authConfig: null, authMode: 'login' };
const dom = {
  search: el('search'), brand: el('brand'), category: el('category'), size: el('size'),
  sort: el('sort'), inStock: el('in-stock'), clear: el('clear'), count: el('result-count'),
  updated: el('updated'), status: el('status'), grid: el('grid'), heroReel: el('hero-reel'),
  sizeReference: el('size-reference'), drawer: el('drawer'), drawerBody: el('drawer-body'),
  account: el('account-button'), authModal: el('auth-modal'), authForm: el('auth-form'),
  authEmail: el('auth-email'), authPassword: el('auth-password'), authSubmit: el('auth-submit'),
  googleAuth: el('google-auth'), authMode: el('auth-mode'), authClose: el('auth-close'), authMessage: el('auth-message'),
};

const STOCK_LABEL = { in_stock: 'In stock', partially_in_stock: 'Limited availability', out_of_stock: 'Sold out', unknown: 'Check availability' };
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

async function authRequest(path, options = {}) {
  const response = await fetch(`${state.authConfig.supabaseUrl}/auth/v1${path}`, {
    ...options,
    headers: { apikey: state.authConfig.supabaseAnonKey, 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error_description ?? body.msg ?? body.message ?? 'Authentication failed.');
  return body;
}

async function loadAuth() {
  const config = await getJson('/api/auth-config');
  if (!config.supabaseUrl || !config.supabaseAnonKey) return;
  state.authConfig = config;
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (hash.get('access_token')) {
    state.auth = {
      access_token: hash.get('access_token'),
      refresh_token: hash.get('refresh_token'),
    };
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    localStorage.setItem('malabis.auth', JSON.stringify(state.auth));
  }

  const stored = localStorage.getItem('malabis.auth');
  if (stored) {
    try {
      state.auth = JSON.parse(stored);
      if (state.auth.access_token) {
        state.auth.user = await authRequest('/user', { headers: { Authorization: `Bearer ${state.auth.access_token}` } });
        localStorage.setItem('malabis.auth', JSON.stringify(state.auth));
      }
    } catch { localStorage.removeItem('malabis.auth'); }
  }
  renderAccount();
}

function renderAccount() {
  if (!state.auth?.user) { dom.account.textContent = 'Sign in'; return; }
  dom.account.textContent = `Hi, ${state.auth.user.user_metadata?.full_name ?? state.auth.user.email?.split('@')[0] ?? 'there'}`;
}

function openAuth() {
  if (state.auth?.user) {
    state.auth = null;
    localStorage.removeItem('malabis.auth');
    renderAccount();
    return;
  }
  dom.authModal.hidden = false;
}

function closeAuth() { dom.authModal.hidden = true; }

function setAuthMode(mode) {
  state.authMode = mode;
  const register = mode === 'register';
  dom.authSubmit.textContent = register ? 'Create account' : 'Sign in';
  dom.authMode.textContent = register ? 'Already registered? Sign in' : 'Need an account? Register';
  dom.authMessage.textContent = register ? 'Create an account to keep your cart and checkout details together.' : 'Sign in to save your finds and continue to checkout later.';
  dom.authPassword.autocomplete = register ? 'new-password' : 'current-password';
}

async function submitAuth(event) {
  event.preventDefault();
  dom.authSubmit.disabled = true;
  dom.authMessage.textContent = 'Working…';
  try {
    const path = state.authMode === 'register' ? '/signup' : '/token?grant_type=password';
    const result = await authRequest(path, { method: 'POST', body: JSON.stringify({ email: dom.authEmail.value.trim(), password: dom.authPassword.value }) });
    if (!result.access_token) { dom.authMessage.textContent = 'Check your email to confirm your account, then sign in.'; return; }
    state.auth = { access_token: result.access_token, refresh_token: result.refresh_token, user: result.user };
    localStorage.setItem('malabis.auth', JSON.stringify(state.auth));
    renderAccount();
    closeAuth();
  } catch (error) { dom.authMessage.textContent = error.message; }
  finally { dom.authSubmit.disabled = false; }
}

function signInWithGoogle() {
  const params = new URLSearchParams({ provider: 'google', redirect_to: location.origin + '/' });
  location.href = `${state.authConfig.supabaseUrl}/auth/v1/authorize?${params}`;
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
  updateDependentFilters();
  const latest = Math.max(...state.products.map((product) => Date.parse(product.scrapedAt)));
  const catalogDate = Number.isFinite(latest)
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(latest)
    : 'recently';
  const rate = state.fx
    ? ` · USD rate ${state.fx.source === 'live' ? 'live' : 'estimated'} at PKR ${state.fx.pkrPerUsd.toFixed(2)}`
    : '';
  dom.updated.textContent = `Catalogue updated ${catalogDate}${rate}`;
}

function updateDependentFilters() {
  if (dom.brand.value === 'all') {
    dom.category.innerHTML = '<option value="all">Choose brand first</option>';
    dom.category.disabled = true;
    dom.size.innerHTML = '<option value="all">Choose brand first</option>';
    dom.size.disabled = true;
    dom.sizeReference.hidden = true;
    return;
  }

  const brandProducts = dom.brand.value === 'all'
    ? state.products
    : state.products.filter((product) => product.brandKey === dom.brand.value);
  const categories = unique(brandProducts.map((product) => product.productType).filter(Boolean)).sort();
  replaceOptions(dom.category, 'All categories', categories);

  const categoryRequired = dom.brand.value !== 'all' && categories.length > 1 && dom.category.value === 'all';
  const categoryProducts = dom.category.value === 'all'
    ? brandProducts
    : brandProducts.filter((product) => product.productType === dom.category.value);
  const sizes = unique(categoryProducts.flatMap((product) => product.variants.map((variant) => variant.size).filter(isUsefulSize))).sort(sizeSort);
  if (categoryRequired) {
    dom.size.innerHTML = '<option value="all">Choose category first</option>';
    dom.size.disabled = true;
  } else {
    replaceOptions(dom.size, 'All sizes', sizes);
  }
  renderSizeReference(categoryProducts, categoryRequired);
}

function replaceOptions(select, allLabel, values) {
  const selected = select.value;
  select.innerHTML = `<option value="all">${allLabel}</option>` + values.map((value) => `<option value="${escape(value)}">${escape(value)}</option>`).join('');
  select.value = values.includes(selected) ? selected : 'all';
  select.disabled = values.length === 0;
}

function renderSizeReference(products, categoryRequired) {
  if (dom.brand.value === 'all') {
    dom.sizeReference.hidden = true;
    return;
  }

  const brand = state.brands.find((item) => item.key === dom.brand.value);
  const referenceProduct = products.find((product) => product.variants.some((variant) => variant.size && variant.size !== 'Default')) ?? products[0];
  const sizes = unique(products.flatMap((product) => product.variants.map((variant) => variant.size).filter(isUsefulSize))).sort(sizeSort);
  if (!brand || !referenceProduct) {
    dom.sizeReference.hidden = true;
    return;
  }

  dom.sizeReference.innerHTML = `
    <div><span>Official size reference</span><strong>${escape(cleanBrand(brand.name))}</strong></div>
    <p>${categoryRequired ? 'Choose a category to see its relevant size system.' : sizes.length ? `Sizes currently listed: ${sizes.map(escape).join(' · ')}` : 'This category does not use clothing sizes.'}</p>
    <a href="${escape(referenceProduct.url)}" target="_blank" rel="noreferrer noopener">Open official sizing on ${escape(cleanBrand(brand.name))} ↗</a>`;
  dom.sizeReference.hidden = false;
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

  const scope = dom.brand.value === 'all' ? 'across all brands' : `from ${cleanBrand(state.brands.find((brand) => brand.key === dom.brand.value)?.name ?? 'this brand')}`;
    dom.count.textContent = `${products.length} available ${products.length === 1 ? 'piece' : 'pieces'} ${scope}`;
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
  const availability = availabilitySummary(product);
  const price = product.priceMin.amount === product.priceMax.amount ? money(product.priceMin) : `From ${money(product.priceMin)}`;
  return `<article class="product-card" tabindex="0" data-key="${escape(productKey(product))}">
    <figure>${image ? `<img loading="lazy" src="${escape(image)}" alt="${escape(product.title)}" />` : '<span class="image-fallback">M</span>'}<span class="stock-label ${escape(product.stockStatus)}">${STOCK_LABEL[product.stockStatus]}</span></figure>
    <div class="product-info"><p class="product-brand">${escape(cleanBrand(product.brandName))}</p><h3>${escape(product.title)}</h3>
    <div class="product-price"><span>${price}</span>${discounted ? `<del>${money(discounted.compareAtPrice)}</del>` : ''}</div>
    <p class="available-sizes">${availability || (sizes.length ? `Available: ${sizes.slice(0, 6).map(escape).join(' · ')}` : 'View availability')}</p></div></article>`;
}

function availabilitySummary(product) {
  if (product.stockStatus !== 'partially_in_stock') return '';
  const available = product.variants.filter((variant) => variant.available).map((variant) => variant.size ?? variant.title);
  const unavailable = product.variants.filter((variant) => !variant.available).map((variant) => variant.size ?? variant.title);
  const parts = [];
  if (available.length) parts.push(`Available: ${available.slice(0, 3).map(escape).join(' · ')}`);
  if (unavailable.length) parts.push(`Sold out: ${unavailable.slice(0, 2).map(escape).join(' · ')}`);
  return parts.join(' · ');
}

function openDetail(key) {
  const product = state.products.find((item) => productKey(item) === key);
  if (!product) return;
  const variants = product.variants.map((variant) => `<div class="variant-row"><span>${escape(variant.size ?? variant.title)}</span><span>${variant.available ? 'Available' : 'Sold out'}</span><strong>${money(variant.price)}</strong></div>`).join('');
  dom.drawerBody.innerHTML = `<div class="detail-layout"><div class="detail-gallery">${product.images.slice(0, 4).map((image) => `<img src="${escape(image.url)}" alt="${escape(image.alt ?? product.title)}" />`).join('')}</div>
    <div class="detail-copy"><p class="eyebrow">${escape(cleanBrand(product.brandName))}</p><h2 id="drawer-title">${escape(product.title)}</h2><p class="detail-price">${money(product.priceMin)}</p>
    ${product.description ? `<p class="description">${escape(product.description.slice(0, 600))}</p>` : ''}<div class="variant-list">${variants}</div>
    <div class="detail-actions"><a class="shop-link" href="${escape(product.url)}" target="_blank" rel="noreferrer noopener">View on ${escape(cleanBrand(product.brandName))} ↗</a><a class="size-link" href="${escape(product.url)}" target="_blank" rel="noreferrer noopener">Open official product sizing ↗</a></div><p class="detail-note">Purchases and official sizing details are provided on the brand’s product page.</p></div></div>`;
  dom.drawer.hidden = false;
  document.body.classList.add('drawer-open');
}

function closeDetail() { dom.drawer.hidden = true; document.body.classList.remove('drawer-open'); }
function clearFilters() { dom.search.value = ''; dom.brand.value = 'all'; dom.category.value = 'all'; dom.size.value = 'all'; dom.sort.value = 'newest'; dom.inStock.checked = false; updateDependentFilters(); render(); }
function productKey(product) { return `${product.brandKey}:${product.externalId}`; }
function cleanBrand(name) { return name.replace(/ PK$/, ''); }
function unique(values) { return [...new Set(values)]; }
function isUsefulSize(size) {
  return Boolean(size) && size !== 'Default' && !/(?:\bML\b|METERS?|\bPIECE\b)/i.test(size);
}
function sizeSort(left, right) {
  const order = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'ONE SIZE', 'UNSTITCHED'];
  const leftIndex = order.indexOf(left); const rightIndex = order.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
  return left.localeCompare(right, undefined, { numeric: true });
}
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`); }

dom.brand.addEventListener('change', () => { dom.category.value = 'all'; dom.size.value = 'all'; updateDependentFilters(); render(); });
dom.category.addEventListener('change', () => { dom.size.value = 'all'; updateDependentFilters(); render(); });
for (const control of [dom.search, dom.size, dom.sort, dom.inStock]) control.addEventListener('input', render);
dom.clear.addEventListener('click', clearFilters);
dom.account.addEventListener('click', openAuth);
dom.authClose.addEventListener('click', closeAuth);
dom.authModal.addEventListener('click', (event) => { if (event.target === dom.authModal) closeAuth(); });
dom.authForm.addEventListener('submit', submitAuth);
dom.authMode.addEventListener('click', () => setAuthMode(state.authMode === 'login' ? 'register' : 'login'));
dom.googleAuth.addEventListener('click', signInWithGoogle);
el('drawer-close').addEventListener('click', closeDetail);
dom.drawer.addEventListener('click', (event) => { if (event.target === dom.drawer) closeDetail(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDetail(); });
document.querySelector('[data-new-link]').addEventListener('click', () => { dom.sort.value = 'newest'; render(); });
await loadAuth();
await loadCatalogue();
