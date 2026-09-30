import { addToBag, initShop, refreshBag } from '/shop.js';

const el = (id) => document.getElementById(id);
const PAGE_SIZE = 48;
const NEW_DAYS = 14;

const state = {
  products: [],
  brands: [],
  fx: null,
  tab: 'all', // 'all' | 'women' | 'men' | 'girls' | 'boys'
  brand: 'all',
  section: 'all',
  size: 'all',
  sort: 'newest',
  query: '',
  shown: PAGE_SIZE,
};

const dom = {
  search: el('search'), size: el('size'), sort: el('sort'), count: el('result-count'),
  updated: el('updated'), status: el('status'), grid: el('grid'), showMore: el('show-more'),
  home: el('home'), listing: el('listing'), brandStrip: el('brand-strip'), brandRows: el('brand-rows'), listingEyebrow: el('listing-eyebrow'), listingTitle: el('listing-title'),
  activeChips: el('active-chips'), sectionChips: el('section-chips'), tabs: el('audience-tabs'),
  rail: el('brand-rail'), brandList: el('brand-list'), railOpen: el('rail-open'), railClose: el('rail-close'), railScrim: el('rail-scrim'),
  drawer: el('drawer'), drawerBody: el('drawer-body'),
};

const TABS = {
  all: { label: 'New In', title: 'Newest arrivals' },
  women: { label: 'Women', title: 'Women' },
  men: { label: 'Men', title: 'Men' },
  girls: { label: 'Girls', title: 'Girls' },
  boys: { label: 'Boys', title: 'Boys' },
};

const BRAND_ROW_SIZE = 4;

// Whole dollars, rounded up so a price is never shown lower than it is.
const money = (value) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: value.currency, minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format(Math.ceil(value.amount / 100));

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

/* ---------- Data ---------- */

async function loadCatalogue() {
  try {
    const [{ brands }, result] = await Promise.all([getJson('/api/brands'), getJson('/api/catalog?limit=2000')]);
    state.brands = brands;
    state.products = result.products;
    state.fx = result.fx;
    const latest = Math.max(...state.products.map((product) => Date.parse(product.scrapedAt)));
    if (Number.isFinite(latest)) {
      dom.updated.textContent = `Last updated ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(latest)}.`;
    }
    dom.status.hidden = true;
    dom.grid.setAttribute('aria-busy', 'false');
    render();
  } catch (error) {
    dom.grid.setAttribute('aria-busy', 'false');
    dom.status.textContent = 'The collection could not be loaded. Please try again shortly.';
    dom.status.classList.add('error');
    console.error(error);
  }
}

function listedTime(product) { return Date.parse(product.listedAt ?? product.scrapedAt) || 0; }
function isNew(product) { return Date.now() - listedTime(product) < NEW_DAYS * 86400000; }
function brandName(key) { return cleanBrand(state.brands.find((brand) => brand.key === key)?.name ?? key); }

/* ---------- Classification ---------- */

function audienceOf(product) {
  const text = [product.title, product.productType, product.url, ...(product.tags || [])].filter(Boolean).join(' ').toLowerCase();
  if (/\bboy\b|\bboys\b|cambridge junior/.test(text)) return 'boys';
  if (/\bgirl\b|\bgirls\b|daughter/.test(text)) return 'girls';
  if (/\bkids?\b|\bjunior\b|\btoddler\b|chota fusion|\bws\d+[- ]kids\b/.test(text)) {
    // Cambridge's junior range is boys-only and Ethnic's is girls-only.
    if (product.brandKey === 'cambridge-pk') return 'boys';
    if (product.brandKey === 'ethnic-pk') return 'girls';
    return 'kids';
  }
  if (product.brandKey === 'cambridge-pk') return 'men';
  if (/\bmen\b|\bmens\b|\bmale\b|\bgents\b|kameez shalwar|jubba|waistcoat|\bpajama\b|mashriq|for him/.test(text)) return 'men';
  // Some stores (e.g. Sapphire) only name the audience in the description:
  // "Shop SAPPHIRE online for mens KURTA ...".
  const forWhom = (product.description || '').toLowerCase().match(/\bfor (mens?|gents|boys?|girls?|kids)\b/);
  if (forWhom) {
    if (/^boys?$/.test(forWhom[1])) return 'boys';
    if (/^girls?$/.test(forWhom[1])) return 'girls';
    if (forWhom[1] === 'kids') return 'kids';
    return 'men';
  }
  return 'women';
}

// Kids pieces that don't say boys or girls appear under both.
function inTab(product, tab) {
  if (tab === 'all') return true;
  const audience = audienceOf(product);
  return audience === tab || (audience === 'kids' && (tab === 'girls' || tab === 'boys'));
}

const GARMENTS = [
  ['Shalwar Kameez', /shalwar|salwar|kameez|pajama suit|pyjama suit|waistcoat suit|kurta pajama/],
  ['Kurtas & Suits', /kurta|kurti|\d ?piece|\bsuit\b|lawn|pret|anarkali|kaftan/],
  ['Co-ord Sets', /co-?ord|\bsets?\b|jumpsuit/],
  ['Dresses', /dress|frock|maxi|gown/],
  ['Polos & Tees', /polo|t-?shirt|\btees?\b|athleisure/],
  ['Blazers & Jackets', /blazer|jacket|coat\b|waistcoat/],
  ['Knitwear', /sweater|cardigan|hoodie|sweatshirt|knit/],
  ['Shirts & Tops', /shirt|\btops?\b|blouse|tunic/],
  ['Bottoms', /trouser|pant|jeans|denim|skirt|shorts|culotte|palazzo|bottom|chino|jogger/],
];

function garmentOf(product) {
  const text = [product.title, product.productType, product.handle].filter(Boolean).join(' ').toLowerCase().replace(/[-_]+/g, ' ');
  for (const [label, pattern] of GARMENTS) if (pattern.test(text)) return label;
  return 'More';
}

// Brands whose own product types are their collection lines (Lawn, Pret, Fusion…).
const BRAND_LINES = new Set(['afrozeh-pk', 'ethnic-pk']);

function sectionOf(product) {
  if (state.brand !== 'all' && BRAND_LINES.has(product.brandKey) && product.productType) return titleCase(product.productType);
  return garmentOf(product);
}

/* ---------- Filtering ---------- */

function scopedProducts({ ignoreSection = false, ignoreSize = false } = {}) {
  const term = state.query.trim().toLowerCase();
  return state.products.filter((product) => {
    if (!inTab(product, state.tab)) return false;
    if (state.brand !== 'all' && product.brandKey !== state.brand) return false;
    if (!ignoreSection && state.brand !== 'all' && state.section !== 'all' && sectionOf(product) !== state.section) return false;
    if (!ignoreSize && state.size !== 'all' && !product.variants.some((variant) => variant.available && variant.size === state.size)) return false;
    if (term) {
      const haystack = [product.title, product.brandName, product.productType, garmentOf(product), ...product.tags].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

function sortProducts(products) {
  const sorted = [...products];
  if (state.sort === 'price-asc') return sorted.sort((a, b) => a.priceMin.amount - b.priceMin.amount);
  if (state.sort === 'price-desc') return sorted.sort((a, b) => b.priceMin.amount - a.priceMin.amount);
  return sorted.sort((a, b) => listedTime(b) - listedTime(a));
}

function countBy(products, keyOf) {
  const counts = new Map();
  for (const product of products) counts.set(keyOf(product), (counts.get(keyOf(product)) ?? 0) + 1);
  return counts;
}

/* ---------- URL state ---------- */

function readUrl() {
  const params = new URLSearchParams(location.search);
  state.tab = TABS[params.get('tab')] ? params.get('tab') : 'all';
  state.brand = params.get('brand') ?? 'all';
  state.section = params.get('section') ?? 'all';
  state.size = params.get('size') ?? 'all';
  state.sort = params.get('sort') === 'price-asc' || params.get('sort') === 'price-desc' ? params.get('sort') : 'newest';
  state.query = params.get('q') ?? '';
  dom.search.value = state.query;
}

function writeUrl(push) {
  const params = new URLSearchParams();
  if (state.tab !== 'all') params.set('tab', state.tab);
  if (state.brand !== 'all') params.set('brand', state.brand);
  if (state.section !== 'all') params.set('section', state.section);
  if (state.size !== 'all') params.set('size', state.size);
  if (state.sort !== 'newest') params.set('sort', state.sort);
  if (state.query.trim()) params.set('q', state.query.trim());
  const url = `${location.pathname}${params.size ? `?${params}` : ''}`;
  if (push) history.pushState(null, '', url); else history.replaceState(null, '', url);
}

function navigate(changes, { scroll = true } = {}) {
  Object.assign(state, changes);
  if ('tab' in changes || 'brand' in changes) {
    if (!('section' in changes)) state.section = 'all';
    if (!('size' in changes)) state.size = 'all';
  }
  state.shown = PAGE_SIZE;
  writeUrl(true);
  render();
  closeRail();
  if (scroll) window.scrollTo({ top: isHomeView() ? 0 : document.getElementById('listing').offsetTop - headerHeight(), behavior: 'smooth' });
}

function headerHeight() { return document.querySelector('.site-header')?.offsetHeight ?? 0; }
function isHomeView() { return state.tab === 'all' && state.brand === 'all' && !state.query.trim(); }

/* ---------- Rendering ---------- */

function render() {
  if (!state.products.length) return;
  renderTabs();
  renderBrandRail();
  const home = isHomeView();
  dom.home.hidden = !home;
  // The home page is the brand rows; the full grid is for tabs, brands and search.
  dom.listing.hidden = home;
  if (home) renderHome();
  renderListing();
}

function renderTabs() {
  for (const link of dom.tabs.querySelectorAll('[data-tab]')) {
    const current = link.dataset.tab === state.tab;
    link.classList.toggle('is-current', current);
    if (current) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
}

function renderBrandRail() {
  const tabProducts = state.products.filter((product) => inTab(product, state.tab));
  const brandCounts = countBy(tabProducts, (product) => product.brandKey);
  const brands = state.brands.filter((brand) => brandCounts.get(brand.key));

  const brandItems = brands.map((brand) => {
    const active = state.brand === brand.key;
    let sections = '';
    if (active) {
      const sectionCounts = countBy(tabProducts.filter((product) => product.brandKey === brand.key), sectionOf);
      sections = `<ul class="rail-sections">${[...sectionCounts].sort((a, b) => b[1] - a[1]).map(([name, count]) => `
        <li><button type="button" class="rail-section ${state.section === name ? 'is-current' : ''}" data-section="${escape(name)}">
          <span>${escape(name)}</span><span class="rail-count">${count}</span></button></li>`).join('')}</ul>`;
    }
    return `<div class="rail-brand ${active ? 'is-open' : ''}">
      <button type="button" class="rail-link ${active ? 'is-current' : ''}" data-brand="${escape(brand.key)}" aria-expanded="${active}">
        <span>${escape(cleanBrand(brand.name))}</span><span class="rail-count">${brandCounts.get(brand.key)}</span>
      </button>${sections}</div>`;
  }).join('');

  dom.brandList.innerHTML = `
    <button type="button" class="rail-link ${state.brand === 'all' ? 'is-current' : ''}" data-brand="all">
      <span>All brands</span><span class="rail-count">${tabProducts.length}</span>
    </button>${brandItems}`;
}

function renderHome() {
  const byNewest = sortProducts(state.products.filter((product) => product.images.length));

  // Brand strip: each brand's newest piece as its cover; tapping one
  // scrolls to that brand's row below.
  dom.brandStrip.innerHTML = state.brands.map((brand) => {
    const items = byNewest.filter((product) => product.brandKey === brand.key);
    if (!items.length) return '';
    return `<button type="button" class="brand-card" data-jump="${escape(brand.key)}">
      <img src="${escape(items[0].images[0].url)}" alt="" loading="lazy" />
      <span class="brand-card-name">${escape(cleanBrand(brand.name))}</span>
      <span class="brand-card-count">${items.length} pieces</span>
    </button>`;
  }).join('');

  // One row per brand: its newest pieces and a link to the rest.
  dom.brandRows.innerHTML = state.brands.map((brand) => {
    const items = byNewest.filter((product) => product.brandKey === brand.key);
    if (!items.length) return '';
    const name = cleanBrand(brand.name);
    return `<section class="home-block brand-row" id="row-${escape(brand.key)}" aria-label="${escape(name)}">
      <div class="block-head">
        <h2>${escape(name)}</h2>
        <button type="button" class="block-link" data-brand="${escape(brand.key)}">Shop all ${items.length} →</button>
      </div>
      <div class="product-grid">${items.slice(0, BRAND_ROW_SIZE).map(productCard).join('')}</div>
    </section>`;
  }).join('');

}

function renderListing() {
  const home = isHomeView();
  const brandLabel = state.brand === 'all' ? 'All brands' : brandName(state.brand);
  dom.listingEyebrow.textContent = home ? 'Across every brand' : brandLabel;
  if (state.query.trim()) dom.listingTitle.textContent = `Results for “${state.query.trim()}”`;
  else if (home) dom.listingTitle.textContent = 'Everything, newest first';
  else if (state.brand !== 'all' && state.section !== 'all') dom.listingTitle.textContent = `${state.tab === 'all' ? '' : `${TABS[state.tab].label} · `}${state.section}`;
  else if (state.brand !== 'all') dom.listingTitle.textContent = state.tab === 'all' ? `New from ${brandLabel}` : `${TABS[state.tab].label} at ${brandLabel}`;
  else dom.listingTitle.textContent = TABS[state.tab].title;

  // Active filter chips, each removable.
  const chips = [];
  if (state.tab !== 'all') chips.push({ label: TABS[state.tab].label, clear: { tab: 'all' } });
  if (state.brand !== 'all') chips.push({ label: brandLabel, clear: { brand: 'all' } });
  if (state.brand !== 'all' && state.section !== 'all') chips.push({ label: state.section, clear: { section: 'all' } });
  if (state.size !== 'all') chips.push({ label: `Size ${state.size}`, clear: { size: 'all' } });
  if (state.query.trim()) chips.push({ label: `“${state.query.trim()}”`, clear: { query: '' } });
  dom.activeChips.innerHTML = chips.map((chip, index) => `<button type="button" class="active-chip" data-chip="${index}" aria-label="Remove ${escape(chip.label)}">${escape(chip.label)} <span aria-hidden="true">×</span></button>`).join('')
    + (chips.length > 1 ? '<button type="button" class="clear-all" data-chip="all">Clear all</button>' : '');
  dom.activeChips.onclick = (event) => {
    const button = event.target.closest('[data-chip]');
    if (!button) return;
    if (button.dataset.chip === 'all') { dom.search.value = ''; navigate({ tab: 'all', brand: 'all', section: 'all', size: 'all', query: '' }); return; }
    const { clear } = chips[Number(button.dataset.chip)];
    if ('query' in clear) dom.search.value = '';
    navigate(clear, { scroll: false });
  };

  // Section chips: the brand's own lines, or garment types across brands.
  const sectionCounts = countBy(scopedProducts({ ignoreSection: true }), sectionOf);
  const sections = [...sectionCounts].sort((a, b) => b[1] - a[1]);
  // Sections are a brand's own lines, so they only appear once a brand is picked.
  dom.sectionChips.hidden = home || state.brand === 'all' || sections.length < 2;
  dom.sectionChips.innerHTML = `<button type="button" class="section-chip ${state.section === 'all' ? 'is-current' : ''}" data-section="all">All</button>`
    + sections.map(([name, count]) => `<button type="button" class="section-chip ${state.section === name ? 'is-current' : ''}" data-section="${escape(name)}">${escape(name)} <span>${count}</span></button>`).join('');

  const sizes = unique(scopedProducts({ ignoreSize: true }).flatMap((product) => product.variants.filter((variant) => variant.available).map((variant) => variant.size)).filter(isUsefulSize)).sort(sizeSort);
  dom.size.innerHTML = '<option value="all">All sizes</option>' + sizes.map((size) => `<option value="${escape(size)}">${escape(size)}</option>`).join('');
  dom.size.value = sizes.includes(state.size) ? state.size : 'all';
  dom.sort.value = state.sort;

  const products = sortProducts(scopedProducts());
  dom.count.textContent = `${products.length} ${products.length === 1 ? 'piece' : 'pieces'}`;
  dom.grid.innerHTML = products.length
    ? products.slice(0, state.shown).map(productCard).join('')
    : '<div class="empty"><strong>Nothing here yet</strong><span>Try another brand, section or size.</span></div>';
  dom.showMore.hidden = products.length <= state.shown;
  dom.showMore.textContent = `Show more (${products.length - Math.min(state.shown, products.length)} left)`;
}

function productCard(product) {
  const [first, second] = product.images;
  const discount = discountOf(product);
  const badge = discount >= 0.05 ? `<span class="badge badge-sale">−${Math.round(discount * 100)}%</span>` : isNew(product) ? '<span class="badge">New</span>' : '';
  const compare = product.variants.find((variant) => variant.compareAtPrice)?.compareAtPrice;
  const price = product.priceMin.amount === product.priceMax.amount ? money(product.priceMin) : `From ${money(product.priceMin)}`;
  return `<article class="product-card" tabindex="0" data-key="${escape(productKey(product))}">
    <figure class="${second ? 'has-alt' : ''}">
      ${first ? `<img loading="lazy" src="${escape(first.url)}" alt="${escape(displayTitle(product))}" />` : '<span class="image-fallback">M</span>'}
      ${second ? `<img class="alt-image" loading="lazy" src="${escape(second.url)}" alt="" />` : ''}
      ${badge}
    </figure>
    <div class="product-info">
      <p class="product-brand">${escape(cleanBrand(product.brandName))}</p>
      <h3>${escape(displayTitle(product))}</h3>
      <p class="product-price"><span>${price}</span>${compare && discount >= 0.05 ? `<del>${money(compare)}</del>` : ''}</p>
    </div>
  </article>`;
}

// Prices include the brand's delivery charge within Pakistan (added by the server).
function deliveryNote(product) {
  if (!product.deliveryFee) return '';
  const text = product.deliveryFee.amount > 0
    ? `Includes ${money(product.deliveryFee)} delivery within Pakistan`
    : 'Includes free delivery within Pakistan';
  return `<p class="detail-delivery">${text}</p>`;
}

function discountOf(product) {
  return product.variants.reduce((best, variant) => {
    if (!variant.compareAtPrice?.amount || !variant.price.amount) return best;
    return Math.max(best, 1 - variant.price.amount / variant.compareAtPrice.amount);
  }, 0);
}

// Store titles are often SKU codes in capitals ("DRESS (E2264/301/422)").
function displayTitle(product) {
  let title = product.title.replace(/\s*\((?=[^)]*\d)[A-Z0-9/ -]+\)\s*$/i, '').replace(/\s+/g, ' ').trim();
  if (title === title.toUpperCase()) title = titleCase(title);
  if (product.brandKey === 'ethnic-pk' && product.productType && title.split(' ').length <= 2) title = `${titleCase(product.productType)} ${title}`;
  return title || product.title;
}

function titleCase(value) {
  return value.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (match, lead, letter) => lead + letter.toUpperCase());
}

/* ---------- Product detail ---------- */

function formatProductDescription(raw) {
  if (!raw) return '';
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return '';

  const sections = [];
  let currentHeader = '';
  let currentItems = [];
  const headerRegex = /^(product details|details|care instructions|care|size & fit|specifications|fabric details|description|disclaimer|composition|material|fit & styling|fabric & care):?$/i;

  for (const line of lines) {
    if (headerRegex.test(line)) {
      if (currentItems.length || currentHeader) { sections.push({ header: currentHeader, items: currentItems }); currentItems = []; }
      currentHeader = line.replace(/:$/, '').trim();
    } else if (/^[-•*]\s*/.test(line)) {
      currentItems.push({ type: 'bullet', text: line.replace(/^[-•*]\s*/, '') });
    } else if (line.includes(':') && line.indexOf(':') < 28 && !line.startsWith('http')) {
      const idx = line.indexOf(':');
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (val) currentItems.push({ type: 'keyval', key, val });
      else {
        if (currentItems.length || currentHeader) { sections.push({ header: currentHeader, items: currentItems }); currentItems = []; }
        currentHeader = key;
      }
    } else {
      currentItems.push({ type: 'text', text: line });
    }
  }
  if (currentItems.length || currentHeader) sections.push({ header: currentHeader, items: currentItems });

  let html = '<div class="product-description-formatted">';
  for (const section of sections) {
    html += '<div class="desc-block">';
    if (section.header) html += `<h4 class="desc-heading">${escape(section.header)}</h4>`;
    const bullets = [];
    const flush = () => {
      if (bullets.length) html += `<ul class="desc-bullet-list">${bullets.map((bullet) => `<li>${escape(bullet)}</li>`).join('')}</ul>`;
      bullets.length = 0;
    };
    for (const item of section.items) {
      if (item.type === 'bullet') { bullets.push(item.text); continue; }
      flush();
      if (item.type === 'keyval') html += `<div class="desc-keyval"><span class="desc-key">${escape(item.key)}</span><span class="desc-val">${escape(item.val)}</span></div>`;
      else html += `<p class="desc-paragraph">${escape(item.text)}</p>`;
    }
    flush();
    html += '</div>';
  }
  return `${html}</div>`;
}

let activeDetailSlider = null;

function openDetail(key) {
  const product = state.products.find((item) => productKey(item) === key);
  if (!product) return;

  const images = product.images.length ? product.images : [{ url: '', alt: product.title }];
  const sizes = product.variants.map((variant) => `
    <button type="button" class="size-option" data-variant="${escape(variant.externalId)}" ${variant.available ? '' : 'disabled'}
      aria-pressed="false" aria-label="Size ${escape(variant.size ?? variant.title)}${variant.available ? '' : ', sold out'}">${escape(variant.size ?? variant.title)}</button>`).join('');
  const brand = cleanBrand(product.brandName);

  dom.drawerBody.innerHTML = `
    <div class="detail-layout">
      <div class="detail-gallery-container">
        <div class="detail-slider" id="detail-slider" tabindex="0" role="region" aria-label="Product images">
          <div class="detail-slides-track">
            ${images.map((image, idx) => `
              <div class="detail-slide ${idx === 0 ? 'is-active' : ''}" data-index="${idx}">
                ${image.url ? `<img src="${escape(image.url)}" alt="${escape(image.alt ?? product.title)}" loading="${idx === 0 ? 'eager' : 'lazy'}" />` : '<span class="image-fallback">M</span>'}
              </div>`).join('')}
          </div>
          ${images.length > 1 ? `
            <button class="slider-arrow slider-prev" id="slider-prev-btn" type="button" aria-label="Previous image">‹</button>
            <button class="slider-arrow slider-next" id="slider-next-btn" type="button" aria-label="Next image">›</button>
            <div class="slider-counter"><span id="slider-current-num">1</span> / ${images.length}</div>` : ''}
        </div>
        ${images.length > 1 ? `
          <div class="detail-thumbnails" id="detail-thumbnails">
            ${images.map((image, idx) => `
              <button class="detail-thumb ${idx === 0 ? 'is-active' : ''}" type="button" data-index="${idx}" aria-label="View photo ${idx + 1}">
                <img src="${escape(image.url)}" alt="" loading="lazy" />
              </button>`).join('')}
          </div>` : ''}
      </div>

      <div class="detail-copy">
        <p class="eyebrow">${escape(brand)} · ${escape(sectionOf(product))}</p>
        <h2 id="drawer-title">${escape(displayTitle(product))}</h2>
        <p class="detail-price">${money(product.priceMin)}</p>
        ${deliveryNote(product)}
        <div class="size-picker">
          <p class="variant-heading">Size <span id="size-choice"></span></p>
          <div class="size-options" role="group" aria-label="Choose a size">${sizes}</div>
          <a class="size-guide" href="${escape(product.url)}" target="_blank" rel="noreferrer noopener">${escape(brand)} size guide ↗</a>
        </div>
        <div class="detail-actions">
          <button type="button" class="shop-link" id="add-to-bag" disabled>Choose a size</button>
          <button type="button" class="size-link" data-more-brand="${escape(product.brandKey)}">More from ${escape(brand)}</button>
        </div>
        ${formatProductDescription(product.description)}
      </div>
    </div>`;

  dom.drawer.hidden = false;
  document.body.classList.add('drawer-open');
  initSizePicker(product);
  dom.drawerBody.querySelector('[data-more-brand]').addEventListener('click', (event) => {
    closeDetail();
    navigate({ brand: event.currentTarget.dataset.moreBrand, tab: state.tab });
  });
  initDetailSlider(images.length);
}

function initSizePicker(product) {
  const button = el('add-to-bag');
  const options = [...dom.drawerBody.querySelectorAll('.size-option')];
  let chosen = null;
  const choose = (option) => {
    chosen = product.variants.find((variant) => variant.externalId === option.dataset.variant);
    options.forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === option)));
    el('size-choice').textContent = `· ${chosen.size ?? chosen.title}`;
    button.disabled = false;
    button.textContent = `Add to bag · ${money(chosen.price)}`;
  };
  options.forEach((option) => option.addEventListener('click', () => choose(option)));
  const available = options.filter((option) => !option.disabled);
  if (available.length === 1) choose(available[0]);
  if (!available.length) button.textContent = 'Sold out';
  button.addEventListener('click', () => {
    if (!chosen) return;
    addToBag(product, chosen);
    button.textContent = 'Added to bag ✓';
    window.setTimeout(() => { if (chosen) button.textContent = `Add to bag · ${money(chosen.price)}`; }, 1800);
  });
}

function initDetailSlider(totalImages) {
  if (totalImages <= 1) { activeDetailSlider = null; return; }

  const sliderEl = document.getElementById('detail-slider');
  const currentNum = document.getElementById('slider-current-num');
  const slides = [...sliderEl.querySelectorAll('.detail-slide')];
  const thumbs = [...(document.getElementById('detail-thumbnails')?.querySelectorAll('.detail-thumb') ?? [])];
  let currentIndex = 0;

  function showSlide(index) {
    currentIndex = (index + totalImages) % totalImages;
    slides.forEach((slide, i) => slide.classList.toggle('is-active', i === currentIndex));
    thumbs.forEach((thumb, i) => thumb.classList.toggle('is-active', i === currentIndex));
    if (currentNum) currentNum.textContent = String(currentIndex + 1);
    thumbs[currentIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  activeDetailSlider = { prev: () => showSlide(currentIndex - 1), next: () => showSlide(currentIndex + 1) };
  document.getElementById('slider-prev-btn')?.addEventListener('click', (e) => { e.stopPropagation(); activeDetailSlider.prev(); });
  document.getElementById('slider-next-btn')?.addEventListener('click', (e) => { e.stopPropagation(); activeDetailSlider.next(); });
  thumbs.forEach((thumb) => thumb.addEventListener('click', () => showSlide(Number(thumb.dataset.index))));

  let startX = 0;
  let startY = 0;
  sliderEl.addEventListener('touchstart', (e) => { startX = e.changedTouches[0].screenX; startY = e.changedTouches[0].screenY; }, { passive: true });
  sliderEl.addEventListener('touchend', (e) => {
    const diffX = e.changedTouches[0].screenX - startX;
    const diffY = e.changedTouches[0].screenY - startY;
    if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 35) {
      if (diffX < 0) activeDetailSlider.next(); else activeDetailSlider.prev();
    }
  }, { passive: true });
}

function closeDetail() {
  dom.drawer.hidden = true;
  document.body.classList.remove('drawer-open');
  activeDetailSlider = null;
}

/* ---------- Brand rail (drawer on phones) ---------- */

function openRail() {
  dom.rail.classList.add('is-open');
  dom.railScrim.hidden = false;
  dom.railOpen.setAttribute('aria-expanded', 'true');
  document.body.classList.add('drawer-open');
}

function closeRail() {
  if (!dom.rail.classList.contains('is-open')) return;
  dom.rail.classList.remove('is-open');
  dom.railScrim.hidden = true;
  dom.railOpen.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('drawer-open');
}

/* ---------- Helpers ---------- */

function productKey(product) { return `${product.brandKey}:${product.externalId}`; }
function cleanBrand(name) { return name.replace(/ PK$/, ''); }
function unique(values) { return [...new Set(values)]; }
function isUsefulSize(size) { return Boolean(size) && size !== 'Default' && !/(?:\bML\b|METERS?|\bPIECE\b)/i.test(size); }
function sizeSort(left, right) {
  const order = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'FREE'];
  const leftIndex = order.indexOf(left); const rightIndex = order.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
  return left.localeCompare(right, undefined, { numeric: true });
}
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`); }

/* ---------- Events ---------- */

dom.tabs.addEventListener('click', (event) => {
  const link = event.target.closest('[data-tab]');
  if (!link) return;
  event.preventDefault();
  navigate({ tab: link.dataset.tab });
});

dom.brandList.addEventListener('click', (event) => {
  const section = event.target.closest('[data-section]');
  if (section) { navigate({ section: section.dataset.section === state.section ? 'all' : section.dataset.section }); return; }
  const brand = event.target.closest('[data-brand]');
  if (brand) navigate({ brand: brand.dataset.brand });
});

dom.sectionChips.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-section]');
  if (chip) navigate({ section: chip.dataset.section }, { scroll: false });
});

dom.home.addEventListener('click', (event) => {
  const tile = event.target.closest('[data-key]');
  if (tile) { openDetail(tile.dataset.key); return; }
  const jump = event.target.closest('[data-jump]');
  if (jump) {
    const row = document.getElementById(`row-${jump.dataset.jump}`);
    if (row) window.scrollTo({ top: row.getBoundingClientRect().top + window.scrollY - headerHeight() - 12, behavior: 'smooth' });
    return;
  }
  const brand = event.target.closest('[data-brand]');
  if (brand) { navigate({ brand: brand.dataset.brand }); return; }
});

dom.grid.addEventListener('click', (event) => {
  const card = event.target.closest('.product-card');
  if (card) openDetail(card.dataset.key);
});
for (const container of [dom.grid, dom.brandRows]) {
  container.addEventListener('keydown', (event) => {
    const card = event.target.closest('.product-card');
    if (card && event.key === 'Enter') openDetail(card.dataset.key);
  });
}

dom.showMore.addEventListener('click', () => { state.shown += PAGE_SIZE; renderListing(); });
dom.size.addEventListener('change', () => navigate({ size: dom.size.value }, { scroll: false }));
dom.sort.addEventListener('change', () => navigate({ sort: dom.sort.value }, { scroll: false }));

let searchTimer = null;
dom.search.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    state.query = dom.search.value;
    state.shown = PAGE_SIZE;
    writeUrl(false);
    render();
  }, 180);
});

dom.railOpen.addEventListener('click', openRail);
dom.railClose.addEventListener('click', closeRail);
dom.railScrim.addEventListener('click', closeRail);
window.addEventListener('popstate', () => { readUrl(); render(); });

el('drawer-close').addEventListener('click', closeDetail);
dom.drawer.addEventListener('click', (event) => { if (event.target === dom.drawer) closeDetail(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closeDetail(); closeRail(); }
  else if (!dom.drawer.hidden && activeDetailSlider) {
    if (event.key === 'ArrowLeft') activeDetailSlider.prev();
    else if (event.key === 'ArrowRight') activeDetailSlider.next();
  }
});

readUrl();
initShop({ getProducts: () => state.products, money, escape, displayTitle, cleanBrand, productKey }).catch((error) => console.error(error));
await loadCatalogue();
refreshBag();
