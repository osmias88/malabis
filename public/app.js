import { addToBag, initShop, refreshBag } from '/shop.js';

const el = (id) => document.getElementById(id);
const PAGE_SIZE = 48;

// The server filters, sorts and pages the catalogue; the page only asks for what it shows.
const state = {
  brands: [],
  home: null,
  listing: null,
  items: [],
  tab: 'all', // 'all' | 'women' | 'men' | 'girls' | 'boys'
  brand: 'all',
  section: 'all',
  size: 'all',
  sort: 'newest',
  query: '',
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

function listingParams(offset, limit) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (state.tab !== 'all') params.set('tab', state.tab);
  if (state.brand !== 'all') params.set('brand', state.brand);
  if (state.brand !== 'all' && state.section !== 'all') params.set('section', state.section);
  if (state.size !== 'all') params.set('size', state.size);
  if (state.sort !== 'newest') params.set('sort', state.sort);
  if (state.query.trim()) params.set('q', state.query.trim());
  return params;
}

const fetchListing = (offset, limit = PAGE_SIZE) => getJson(`/api/products?${listingParams(offset, limit)}`);

/** Prices and stock for bag lines, used by the bag. */
async function lookupProducts(keys) {
  if (!keys.length) return [];
  const { products } = await getJson(`/api/products/lookup?keys=${encodeURIComponent(keys.join(','))}`);
  return products;
}

function brandName(key) { return cleanBrand(state.brands.find((brand) => brand.key === key)?.name ?? key); }

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
  if (state.brand !== 'all' && state.section !== 'all') params.set('section', state.section);
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
  writeUrl(true);
  render();
  closeRail();
  if (scroll) window.scrollTo({ top: isHomeView() ? 0 : document.getElementById('listing').offsetTop - headerHeight(), behavior: 'smooth' });
}

function headerHeight() { return document.querySelector('.site-header')?.offsetHeight ?? 0; }
function isHomeView() { return state.tab === 'all' && state.brand === 'all' && !state.query.trim(); }

/* ---------- Rendering ---------- */

let renderCount = 0;

async function render() {
  const run = ++renderCount;
  renderTabs();
  const home = isHomeView();
  dom.home.hidden = !home;
  // The home page is the brand rows; the full grid is for tabs, brands and search.
  dom.listing.hidden = home;
  dom.grid.setAttribute('aria-busy', 'true');
  try {
    const [listing, homeData] = await Promise.all([
      fetchListing(0, home ? 0 : PAGE_SIZE),
      home && !state.home ? getJson('/api/home') : Promise.resolve(state.home),
    ]);
    if (run !== renderCount) return; // a newer render has started
    state.listing = listing;
    state.items = listing.items;
    state.home = homeData;
    renderBrandRail(listing.facets);
    if (home) renderHome();
    else renderListing();
    dom.status.hidden = true;
    dom.updated.textContent = `Last updated ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(listing.updatedAt))}.`;
  } catch (error) {
    if (run !== renderCount) return;
    dom.status.hidden = false;
    dom.status.textContent = 'The collection could not be loaded. Please try again shortly.';
    dom.status.classList.add('error');
    console.error(error);
  } finally {
    if (run === renderCount) dom.grid.setAttribute('aria-busy', 'false');
  }
}

function renderTabs() {
  for (const link of dom.tabs.querySelectorAll('[data-tab]')) {
    const current = link.dataset.tab === state.tab;
    link.classList.toggle('is-current', current);
    if (current) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
}

function renderBrandRail(facets) {
  const counts = facets.brands;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const brandItems = state.brands.filter((brand) => counts[brand.key]).map((brand) => {
    const active = state.brand === brand.key;
    const sections = active && facets.sections.length
      ? `<ul class="rail-sections">${facets.sections.map(([name, count]) => `
        <li><button type="button" class="rail-section ${state.section === name ? 'is-current' : ''}" data-section="${escape(name)}">
          <span>${escape(name)}</span><span class="rail-count">${count}</span></button></li>`).join('')}</ul>`
      : '';
    return `<div class="rail-brand ${active ? 'is-open' : ''}">
      <button type="button" class="rail-link ${active ? 'is-current' : ''}" data-brand="${escape(brand.key)}" aria-expanded="${active}">
        <span>${escape(cleanBrand(brand.name))}</span><span class="rail-count">${counts[brand.key]}</span>
      </button>${sections}</div>`;
  }).join('');

  dom.brandList.innerHTML = `
    <button type="button" class="rail-link ${state.brand === 'all' ? 'is-current' : ''}" data-brand="all">
      <span>All brands</span><span class="rail-count">${total}</span>
    </button>${brandItems}`;
}

function renderHome() {
  const brands = state.home?.brands ?? [];
  // Brand strip: each brand's newest piece as its cover; tapping one opens that brand.
  dom.brandStrip.innerHTML = brands.filter((brand) => brand.cover).map((brand) => `
    <button type="button" class="brand-card" data-brand="${escape(brand.key)}">
      <img src="${escape(brand.cover)}" alt="" loading="lazy" />
      <span class="brand-card-name">${escape(brand.name)}</span>
      <span class="brand-card-count">${brand.count} pieces</span>
    </button>`).join('');

  // One row per brand: its newest pieces and a link to the rest.
  dom.brandRows.innerHTML = brands.filter((brand) => brand.items.length).map((brand) => `
    <section class="home-block brand-row" id="row-${escape(brand.key)}" aria-label="${escape(brand.name)}">
      <div class="block-head">
        <h2>${escape(brand.name)}</h2>
        <button type="button" class="block-link" data-brand="${escape(brand.key)}">Shop all ${brand.count} →</button>
      </div>
      <div class="product-grid">${brand.items.map(productCard).join('')}</div>
    </section>`).join('');
}

function renderListing() {
  const { total, facets } = state.listing;
  const brandLabel = state.brand === 'all' ? 'All brands' : brandName(state.brand);
  dom.listingEyebrow.textContent = brandLabel;
  if (state.query.trim()) dom.listingTitle.textContent = `Results for “${state.query.trim()}”`;
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

  // Sections are a brand's own lines, so they only appear once a brand is picked.
  dom.sectionChips.hidden = state.brand === 'all' || facets.sections.length < 2;
  dom.sectionChips.innerHTML = `<button type="button" class="section-chip ${state.section === 'all' ? 'is-current' : ''}" data-section="all">All</button>`
    + facets.sections.map(([name, count]) => `<button type="button" class="section-chip ${state.section === name ? 'is-current' : ''}" data-section="${escape(name)}">${escape(name)} <span>${count}</span></button>`).join('');

  dom.size.innerHTML = '<option value="all">All sizes</option>' + facets.sizes.map((size) => `<option value="${escape(size)}">${escape(size)}</option>`).join('');
  dom.size.value = facets.sizes.includes(state.size) ? state.size : 'all';
  dom.sort.value = state.sort;

  dom.count.textContent = `${total.toLocaleString('en-US')} ${total === 1 ? 'piece' : 'pieces'}`;
  dom.grid.innerHTML = state.items.length
    ? state.items.map(productCard).join('')
    : '<div class="empty"><strong>Nothing here yet</strong><span>Try another brand, section or size.</span></div>';
  updateShowMore();
}

function updateShowMore() {
  const left = (state.listing?.total ?? 0) - state.items.length;
  dom.showMore.hidden = left <= 0;
  dom.showMore.disabled = false;
  dom.showMore.textContent = `Show more (${left.toLocaleString('en-US')} left)`;
}

async function showMore() {
  dom.showMore.disabled = true;
  dom.showMore.textContent = 'Loading…';
  const run = renderCount;
  try {
    const next = await fetchListing(state.items.length);
    if (run !== renderCount) return;
    state.items.push(...next.items);
    dom.grid.insertAdjacentHTML('beforeend', next.items.map(productCard).join(''));
    state.listing.total = next.total;
  } catch (error) {
    console.error(error);
  }
  updateShowMore();
}

function productCard(card) {
  const [first, second] = card.images;
  const badge = card.discount >= 0.05 ? `<span class="badge badge-sale">−${Math.round(card.discount * 100)}%</span>` : card.isNew ? '<span class="badge">New</span>' : '';
  const price = card.priceMin.amount === card.priceMax.amount ? money(card.priceMin) : `From ${money(card.priceMin)}`;
  return `<article class="product-card" tabindex="0" data-key="${escape(card.key)}">
    <figure class="${second ? 'has-alt' : ''}">
      ${first ? `<img loading="lazy" src="${escape(first)}" alt="${escape(card.title)}" />` : '<span class="image-fallback">M</span>'}
      ${second ? `<img class="alt-image" loading="lazy" src="${escape(second)}" alt="" />` : ''}
      ${badge}
    </figure>
    <div class="product-info">
      <p class="product-brand">${escape(card.brandName)}</p>
      <h3>${escape(card.title)}</h3>
      <p class="product-price"><span>${price}</span>${card.compareAt && card.discount >= 0.05 ? `<del>${money(card.compareAt)}</del>` : ''}</p>
      ${card.colours > 1 ? `<p class="product-colours">${card.colours} colours</p>` : ''}
    </div>
  </article>`;
}

/* ---------- Product detail ---------- */

const details = new Map();

async function openDetail(key) {
  let product = details.get(key);
  if (!product) {
    try {
      product = (await getJson(`/api/product?key=${encodeURIComponent(key)}`)).product;
      details.set(key, product);
    } catch (error) {
      console.error(error);
      return;
    }
  }

  const images = product.images.length ? product.images : [{ url: '', alt: product.title }];
  const brand = product.brandName;

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
        <p class="eyebrow">${escape(brand)} · ${escape(product.section)}</p>
        <h2 id="drawer-title">${escape(product.title)}</h2>
        <p class="detail-price">${money(product.priceMin)}</p>
        <div class="size-picker">
          <div id="colour-picker" hidden>
            <p class="variant-heading">Colour <span id="colour-choice"></span></p>
            <div class="size-options colour-options" id="colour-options" role="group" aria-label="Choose a colour"></div>
          </div>
          <p class="variant-heading">Size <span id="size-choice"></span></p>
          <div class="size-options" id="size-options" role="group" aria-label="Choose a size"></div>
          ${sizeGuide(product, brand)}
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

  // Some stores (e.g. Cambridge) put each label and its value on separate
  // lines ("Fit", "Traditional Fit", ...). Short alternating lines become pairs,
  // and repeated pairs are dropped.
  for (const section of sections) {
    const texts = section.items;
    const pairable = texts.length >= 4 && texts.length % 2 === 0
      && texts.every((item) => item.type === 'text' && item.text.length <= 40)
      && texts.filter((_, index) => index % 2 === 0).every((item) => item.text.split(/\s+/).length <= 3);
    if (!pairable) continue;
    const seen = new Set();
    section.items = [];
    for (let index = 0; index < texts.length; index += 2) {
      const key = texts[index].text;
      const val = texts[index + 1].text;
      const id = `${key.toLowerCase()}|${val.toLowerCase()}`;
      if (seen.has(id)) continue;
      seen.add(id);
      section.items.push({ type: 'keyval', key: titleCase(key), val });
    }
  }

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

// The brand's own size chart, shown under the sizes; a link to the brand when there is none.
function sizeGuide(product, brand) {
  const link = `<a class="size-guide" href="${escape(product.url)}" target="_blank" rel="noreferrer noopener">${escape(brand)} size guide ↗</a>`;
  const charts = (product.sizeCharts ?? []).filter((chart) => chart.rows?.length || chart.image);
  if (!charts.length) return link;
  const tables = charts.map((chart) => `
    <figure class="size-chart">
      ${chart.title && charts.length > 1 ? `<figcaption>${escape(titleCase(chart.title))}</figcaption>` : ''}
      ${chart.rows?.length ? `<div class="size-chart-scroll"><table>
        <thead><tr>${chart.rows[0].map((cell, index) => `<th scope="col" data-col="${index}">${escape(cell)}</th>`).join('')}</tr></thead>
        <tbody>${chart.rows.slice(1).map((row) => `<tr>${row.map((cell, index) => index === 0
          ? `<th scope="row">${escape(titleCase(cell))}</th>`
          : `<td data-col="${index}">${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>` : ''}
      ${chart.image ? `<img src="${escape(chart.image)}" alt="${escape(brand)} size chart" loading="lazy" />` : ''}
    </figure>`).join('');
  return `<details class="size-guide-panel">
      <summary>Size guide</summary>
      ${tables}
      <p class="size-chart-note">Garment measurements as published by ${escape(brand)}; allow a little tolerance. ${link}</p>
    </details>`;
}

// Highlights the chosen size's column, matching "2-3 YRS" to "2-3Y", "Medium" to "M", etc.
function highlightSizeColumn(size) {
  if (size === null) { dom.drawerBody.querySelectorAll('.size-chart .is-chosen').forEach((cell) => cell.classList.remove('is-chosen')); return; }
  const key = (value) => String(value).toUpperCase().replace(/YEARS?|YRS?/g, 'Y').replace(/[^A-Z0-9]/g, '')
    .replace(/^(EXTRA)?SMALL$/, 'S').replace(/^MEDIUM$/, 'M').replace(/^LARGE$/, 'L');
  for (const table of dom.drawerBody.querySelectorAll('.size-chart table')) {
    const header = [...table.querySelectorAll('thead th[data-col]')].find((cell) => cell.dataset.col !== '0' && key(cell.textContent) === key(size));
    for (const cell of table.querySelectorAll('[data-col]')) cell.classList.toggle('is-chosen', Boolean(header) && cell.dataset.col === header.dataset.col);
  }
}

// Products sold in several colours (e.g. "Black / L") get a colour choice
// first, then only that colour's sizes.
function initSizePicker(product) {
  const button = el('add-to-bag');
  const sizeBox = el('size-options');
  const colourBox = el('colour-options');
  const colours = [...new Set(product.variants.map((variant) => variant.color).filter(Boolean))];
  const byColour = colours.length > 1;
  const label = (variant) => variant.size ?? variant.title;
  let colour = null;
  let chosen = null;

  const reset = (text) => {
    chosen = null;
    el('size-choice').textContent = '';
    highlightSizeColumn(null);
    button.disabled = true;
    button.textContent = text;
  };

  const choose = (option) => {
    chosen = product.variants.find((variant) => variant.externalId === option.dataset.variant);
    sizeBox.querySelectorAll('.size-option').forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === option)));
    el('size-choice').textContent = `· ${label(chosen)}`;
    highlightSizeColumn(label(chosen));
    button.disabled = false;
    button.textContent = `Add to bag · ${money(chosen.price)}`;
  };

  const renderSizes = () => {
    const variants = byColour ? product.variants.filter((variant) => variant.color === colour) : product.variants;
    sizeBox.innerHTML = variants.map((variant) => `
      <button type="button" class="size-option" data-variant="${escape(variant.externalId)}" ${variant.available ? '' : 'disabled'}
        aria-pressed="false" aria-label="Size ${escape(label(variant))}${variant.available ? '' : ', sold out'}">${escape(label(variant))}</button>`).join('');
    const options = [...sizeBox.querySelectorAll('.size-option')];
    options.forEach((option) => option.addEventListener('click', () => choose(option)));
    const available = options.filter((option) => !option.disabled);
    reset(available.length ? 'Choose a size' : 'Sold out');
    if (available.length === 1) choose(available[0]);
  };

  if (byColour) {
    el('colour-picker').hidden = false;
    const inStock = (name) => product.variants.some((variant) => variant.color === name && variant.available);
    colourBox.innerHTML = colours.map((name) => `
      <button type="button" class="size-option" data-colour="${escape(name)}" ${inStock(name) ? '' : 'disabled'}
        aria-pressed="false" aria-label="${escape(name)}${inStock(name) ? '' : ', sold out'}">${escape(name)}</button>`).join('');
    const pick = (option) => {
      colour = option.dataset.colour;
      colourBox.querySelectorAll('.size-option').forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === option)));
      el('colour-choice').textContent = `· ${colour}`;
      renderSizes();
    };
    colourBox.querySelectorAll('.size-option').forEach((option) => option.addEventListener('click', () => pick(option)));
    const first = colourBox.querySelector('.size-option:not(:disabled)') ?? colourBox.querySelector('.size-option');
    if (first) pick(first);
  } else if (product.colourOptions?.length > 1) {
    // Stores that list each colour as its own piece: each colour opens that piece.
    el('colour-picker').hidden = false;
    el('colour-choice').textContent = product.colour ? `· ${product.colour}` : '';
    colourBox.innerHTML = product.colourOptions.map((option) => `
      <button type="button" class="size-option" data-colour-key="${escape(option.key)}" ${option.inStock ? '' : 'disabled'}
        aria-pressed="${option.key === product.key}" aria-label="${escape(option.colour)}${option.inStock ? '' : ', sold out'}">${escape(option.colour)}</button>`).join('');
    colourBox.querySelectorAll('[data-colour-key]').forEach((option) => option.addEventListener('click', () => {
      if (option.dataset.colourKey !== product.key) openDetail(option.dataset.colourKey);
    }));
    renderSizes();
  } else {
    renderSizes();
  }

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

function titleCase(value) {
  return value.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (match, lead, letter) => lead + letter.toUpperCase());
}


/* ---------- Helpers ---------- */

function cleanBrand(name) { return name.replace(/ PK$/, ''); }
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

dom.showMore.addEventListener('click', showMore);
dom.size.addEventListener('change', () => navigate({ size: dom.size.value }, { scroll: false }));
dom.sort.addEventListener('change', () => navigate({ sort: dom.sort.value }, { scroll: false }));

let searchTimer = null;
dom.search.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    state.query = dom.search.value;
    writeUrl(false);
    render();
  }, 250);
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
initShop({ lookupProducts, money, escape }).catch((error) => console.error(error));
try {
  state.brands = (await getJson('/api/brands')).brands;
} catch (error) {
  console.error(error);
}
await render();
refreshBag();
