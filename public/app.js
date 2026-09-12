const el = (id) => document.getElementById(id);
const state = {
  products: [],
  brands: [],
  fx: null,
  auth: null,
  authConfig: null,
  authMode: 'login',
  department: 'all', // 'all' (homepage category tiles) | 'women' | 'men' | 'kids'
  subCategory: 'all', // 'all' | specific subcategory name
  heroTimer: null,
  heroSlideTimer: null,
};

const dom = {
  search: el('search'), brand: el('brand'), category: el('category'), size: el('size'),
  sort: el('sort'), inStock: el('in-stock'), clear: el('clear'), count: el('result-count'),
  updated: el('updated'), status: el('status'), grid: el('grid'), heroReel: el('hero-reel'),
  sizeReference: el('size-reference'), drawer: el('drawer'), drawerBody: el('drawer-body'),
  account: el('account-button'), authModal: el('auth-modal'), authForm: el('auth-form'),
  authEmail: el('auth-email'), authPassword: el('auth-password'), authSubmit: el('auth-submit'),
  googleAuth: el('google-auth'), authMode: el('auth-mode'), authClose: el('auth-close'), authMessage: el('auth-message'),
  audienceTabs: el('audience-tabs'),
  categoryTiles: el('category-tiles'),
  breadcrumbs: el('breadcrumbs'),
  backToHome: el('back-to-home'),
  breadcrumbDept: el('breadcrumb-dept'),
  breadcrumbSub: el('breadcrumb-sub'),
  breadcrumbSubSep: el('breadcrumb-sub-separator'),
  subcategoryBar: el('subcategory-bar'),
  subcategoryPills: el('subcategory-pills'),
  filterSection: el('filter-section'),
  resultsHeader: el('results-header'),
  catalogueEyebrow: el('catalogue-eyebrow'),
  catalogueTitle: el('catalogue-title'),
};

const STOCK_LABEL = { in_stock: 'In stock', partially_in_stock: 'Limited availability', out_of_stock: 'Sold out', unknown: 'Check availability' };
const money = (value) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: value.currency,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(value.amount / 100);

const DEPARTMENTS = {
  women: {
    label: 'Women',
    eyebrow: "Women's Collection",
    title: 'Women’s Pakistani Fashion',
    subcategories: [
      { id: 'all', label: 'All Women' },
      { id: 'Eastern wear', label: 'Eastern Wear (Kurtas & Suits)' },
      { id: 'Festive & Formal', label: 'Festive & Luxury Pret' },
      { id: 'Western', label: 'Western & Co-ords' },
      { id: 'Footwear', label: 'Footwear' },
      { id: 'Accessories', label: 'Accessories & Dupattas' },
      { id: 'Home & Living', label: 'Home & Living' },
    ],
  },
  men: {
    label: 'Men',
    eyebrow: "Men's Collection",
    title: 'Men’s Traditional & Modern Wear',
    subcategories: [
      { id: 'all', label: 'All Men' },
      { id: 'Eastern wear', label: 'Eastern (Shalwar Kameez & Kurtas)' },
      { id: 'Western', label: 'Western (Polos, Shirts & Blazers)' },
      { id: 'Accessories', label: 'Accessories' },
    ],
  },
  kids: {
    label: 'Kids & Juniors',
    eyebrow: "Kids' Collection",
    title: 'Kids & Juniors Collection',
    subcategories: [
      { id: 'all', label: 'All Kids' },
      { id: 'girls', label: 'Girls' },
      { id: 'boys', label: 'Boys' },
    ],
  },
};

const FEATURED_TILES = [
  {
    id: 'women-eastern',
    dept: 'women',
    sub: 'Eastern wear',
    title: "Women's Eastern Wear",
    subtitle: 'Kurtas, Shalwar Kameez & Stitched Suits',
    match: (p) => productAudience(p) === 'women' && customerCategory(p) === 'Eastern wear',
  },
  {
    id: 'women-festive',
    dept: 'women',
    sub: 'Festive & Formal',
    title: 'Festive & Luxury Pret',
    subtitle: 'Chiffon, Luxury Pret & Embroidered Formals',
    match: (p) => productAudience(p) === 'women' && customerCategory(p) === 'Festive & Formal',
  },
  {
    id: 'men-eastern',
    dept: 'men',
    sub: 'Eastern wear',
    title: "Men's Shalwar Kameez",
    subtitle: 'Traditional Suits, Kurtas & Waistcoats',
    match: (p) => productAudience(p) === 'men' && customerCategory(p) === 'Eastern wear',
  },
  {
    id: 'men-western',
    dept: 'men',
    sub: 'Western',
    title: "Men's Western & Blazers",
    subtitle: 'Polos, Shirts, Blazers & Smart Casuals',
    match: (p) => productAudience(p) === 'men' && customerCategory(p) === 'Western',
  },
  {
    id: 'women-western',
    dept: 'women',
    sub: 'Western',
    title: 'Western & Co-ords',
    subtitle: 'Modern Tops, Trousers & Co-ord Sets',
    match: (p) => productAudience(p) === 'women' && customerCategory(p) === 'Western',
  },
  {
    id: 'kids-all',
    dept: 'kids',
    sub: 'all',
    title: 'Kids & Juniors',
    subtitle: 'Festive & Casual Styles for Boys & Girls',
    match: (p) => isKidsProduct(p),
  },
  {
    id: 'footwear-accessories',
    dept: 'women',
    sub: 'Footwear',
    title: 'Footwear & Accessories',
    subtitle: 'Handcrafted Khussas, Flats, Bags & Dupattas',
    match: (p) => customerCategory(p) === 'Footwear' || customerCategory(p) === 'Accessories',
  },
  {
    id: 'home-living',
    dept: 'women',
    sub: 'Home & Living',
    title: 'Home & Living',
    subtitle: 'Artisanal Decor, Cushions & Table Accents',
    match: (p) => customerCategory(p) === 'Home & Living',
  },
];

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
    const { brands } = await getJson('/api/brands');
    state.brands = brands;
    const heroResult = await getJson('/api/catalog?limit=5');
    state.products = heroResult.products;
    state.fx = heroResult.fx;
    renderHeroReel();

    const result = await getJson('/api/catalog?limit=2000');
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
  const featured = [...state.products]
    .filter((product) => product.images[0]?.url)
    .sort((left, right) => recommendationScore(right) - recommendationScore(left));

  dom.heroReel.innerHTML = featured.map((product, index) => `
    <figure class="hero-scene" style="--scene:${index}">
      <img ${index < 4 ? `src="${escape(product.images[0].url)}"` : `data-src="${escape(product.images[0].url)}"`} alt="" />
      <figcaption><span>${escape(cleanBrand(product.brandName))}</span><a href="${escape(product.url)}" target="_blank" rel="noreferrer noopener"><strong>${escape(product.title)}</strong><em>View piece ↗</em></a></figcaption>
    </figure>`).join('');
  dom.heroReel.style.setProperty('--scene-count', featured.length || 1);
  const scenes = [...dom.heroReel.querySelectorAll('.hero-scene')];
  let currentScene = 0;
  scenes[0]?.classList.add('is-active');
  if (state.heroSlideTimer) window.clearInterval(state.heroSlideTimer);
  state.heroSlideTimer = window.setInterval(() => {
    if (scenes.length < 2) return;
    const current = scenes[currentScene];
    const nextIndex = (currentScene + 1) % scenes.length;
    const next = scenes[nextIndex];
    current.classList.remove('is-active');
    current.classList.add('is-prev');
    next.classList.remove('is-prev', 'is-active');
    next.style.transform = 'translateX(100%)';
    void next.offsetWidth;
    next.style.transform = '';
    next.classList.add('is-active');
    currentScene = nextIndex;
  }, 5000);
  if (state.heroTimer) window.clearInterval(state.heroTimer);
  let next = 4;
  state.heroTimer = window.setInterval(() => {
    for (let index = 0; index < 2; index += 1) {
      const image = dom.heroReel.querySelector(`.hero-scene:nth-child(${next + 1}) img`);
      if (!image) break;
      if (image.dataset.src) {
        image.src = image.dataset.src;
        delete image.dataset.src;
      }
      next += 1;
    }
    if (next >= featured.length) window.clearInterval(state.heroTimer);
  }, 5000);
}

function hydrateFilters() {
  dom.brand.innerHTML = '<option value="all">All brands</option>' + state.brands.map((brand) => `<option value="${escape(brand.key)}">${escape(cleanBrand(brand.name))}</option>`).join('');
  updateDependentFilters();
  const latest = Math.max(...state.products.map((product) => Date.parse(product.scrapedAt)));
  const catalogDate = Number.isFinite(latest)
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(latest)
    : 'recently';
  dom.updated.textContent = `Catalogue updated ${catalogDate}`;
}

function updateDependentFilters() {
  const departmentProducts = getDepartmentFilteredProducts();
  const brandProducts = dom.brand.value === 'all'
    ? departmentProducts
    : departmentProducts.filter((product) => product.brandKey === dom.brand.value);
  const categories = unique(brandProducts.map((product) => customerCategory(product)).filter(Boolean)).sort();
  replaceOptions(dom.category, 'All categories', categories);

  const categoryProducts = dom.category.value === 'all'
    ? brandProducts
    : brandProducts.filter((product) => customerCategory(product) === dom.category.value);
  const sizes = unique(categoryProducts.flatMap((product) => product.variants.map((variant) => variant.size).filter(isUsefulSize))).sort(sizeSort);
  replaceOptions(dom.size, 'All sizes', sizes);
  renderSizeReference(categoryProducts);
}

function getDepartmentFilteredProducts() {
  return state.products.filter((product) => {
    if (state.department === 'women') return productAudience(product) === 'women';
    if (state.department === 'men') return productAudience(product) === 'men';
    if (state.department === 'kids') return isKidsProduct(product);
    return true;
  });
}

function replaceOptions(select, allLabel, values) {
  const selected = select.value;
  select.innerHTML = `<option value="all">${allLabel}</option>` + values.map((value) => `<option value="${escape(value)}">${escape(value)}</option>`).join('');
  select.value = values.includes(selected) ? selected : 'all';
  select.disabled = values.length === 0;
}

function renderSizeReference(products) {
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
    <p>${sizes.length ? `Sizes currently listed: ${sizes.map(escape).join(' · ')}` : 'This category does not use clothing sizes.'}</p>
    <a href="${escape(referenceProduct.url)}" target="_blank" rel="noreferrer noopener">Open official sizing on ${escape(cleanBrand(brand.name))} ↗</a>`;
  dom.sizeReference.hidden = false;
}

function render() {
  const term = dom.search.value.trim().toLowerCase();
  const isHomepageView = state.department === 'all' && state.subCategory === 'all' && !term && dom.brand.value === 'all' && dom.category.value === 'all' && dom.size.value === 'all' && !dom.inStock.checked;

  updateAudienceTabs();
  updateNavLinks();

  if (isHomepageView) {
    dom.catalogueEyebrow.textContent = 'Explore the Collections';
    dom.catalogueTitle.textContent = 'Shop by Category';
    dom.breadcrumbs.hidden = true;
    dom.subcategoryBar.hidden = true;
    dom.filterSection.hidden = true;
    dom.sizeReference.hidden = true;
    dom.resultsHeader.hidden = true;
    dom.grid.hidden = true;
    renderCategoryTiles();
    dom.categoryTiles.hidden = false;
    return;
  }

  // Browsing Mode: Vertical Grid Layout
  dom.categoryTiles.hidden = true;
  dom.breadcrumbs.hidden = false;
  dom.filterSection.hidden = false;
  dom.resultsHeader.hidden = false;
  dom.grid.hidden = false;

  renderBreadcrumbs();
  renderSubcategoryPills();

  let products = state.products.filter((product) => {
    // Department filtering
    if (state.department === 'women' && productAudience(product) !== 'women') return false;
    if (state.department === 'men' && productAudience(product) !== 'men') return false;
    if (state.department === 'kids' && !isKidsProduct(product)) return false;

    // Subcategory pill filtering
    if (state.subCategory !== 'all') {
      if (state.department === 'kids') {
        const aud = productAudience(product);
        if (state.subCategory === 'girls' && aud !== 'girls') return false;
        if (state.subCategory === 'boys' && aud !== 'boys') return false;
      } else {
        if (customerCategory(product) !== state.subCategory) return false;
      }
    }

    // Dropdown filters
    if (dom.brand.value !== 'all' && product.brandKey !== dom.brand.value) return false;
    if (dom.category.value !== 'all' && customerCategory(product) !== dom.category.value) return false;
    if (dom.size.value !== 'all' && !product.variants.some((variant) => variant.size === dom.size.value)) return false;
    if (dom.inStock.checked && !product.variants.some((variant) => variant.available)) return false;

    // Text search
    if (!term) return true;
    return [product.title, product.brandName, product.productType, product.vendor, ...product.tags].filter(Boolean).join(' ').toLowerCase().includes(term);
  });

  if (dom.sort.value === 'recommended') products = [...products].sort((a, b) => recommendationScore(b) - recommendationScore(a));
  if (dom.sort.value === 'price-asc') products = [...products].sort((a, b) => a.priceMin.amount - b.priceMin.amount);
  if (dom.sort.value === 'price-desc') products = [...products].sort((a, b) => b.priceMin.amount - a.priceMin.amount);
  if (dom.sort.value === 'title') products = [...products].sort((a, b) => a.title.localeCompare(b.title));
  if (dom.sort.value === 'newest') products = [...products].sort((a, b) => b.scrapedAt.localeCompare(a.scrapedAt));

  const deptInfo = DEPARTMENTS[state.department];
  if (deptInfo) {
    dom.catalogueEyebrow.textContent = deptInfo.eyebrow;
    const activeSub = deptInfo.subcategories.find((s) => s.id === state.subCategory);
    dom.catalogueTitle.textContent = activeSub && activeSub.id !== 'all' ? `${deptInfo.label} — ${activeSub.label}` : deptInfo.title;
  } else {
    dom.catalogueEyebrow.textContent = 'Browsing Collection';
    dom.catalogueTitle.textContent = state.subCategory !== 'all' ? state.subCategory : 'All Products';
  }

  const scope = dom.brand.value === 'all' ? 'across all brands' : `from ${cleanBrand(state.brands.find((brand) => brand.key === dom.brand.value)?.name ?? 'this brand')}`;
  dom.count.textContent = `${products.length} available ${products.length === 1 ? 'piece' : 'pieces'} ${scope}`;
  dom.grid.innerHTML = productGrid(products);

  for (const card of dom.grid.querySelectorAll('.product-card')) {
    card.addEventListener('click', () => openDetail(card.dataset.key));
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter') openDetail(card.dataset.key); });
  }
}

function renderCategoryTiles() {
  const cardsHtml = FEATURED_TILES.map((tile) => {
    const matching = state.products.filter(tile.match);
    if (!matching.length) return '';
    const topItem = [...matching].sort((a, b) => recommendationScore(b) - recommendationScore(a))[0];
    const image = topItem?.images[0]?.url;

    return `
      <article class="category-tile" tabindex="0" data-dept="${escape(tile.dept)}" data-sub="${escape(tile.sub)}">
        <figure class="category-tile-figure">
          ${image ? `<img loading="lazy" src="${escape(image)}" alt="${escape(tile.title)}" />` : '<span class="image-fallback">M</span>'}
          <div class="category-tile-overlay">
            <span class="category-tile-count">${matching.length} Pieces</span>
            <h3 class="category-tile-title">${escape(tile.title)}</h3>
            <p class="category-tile-subtitle">${escape(tile.subtitle)}</p>
            <span class="category-tile-cta">Shop Collection ↗</span>
          </div>
        </figure>
      </article>`;
  }).filter(Boolean).join('');

  dom.categoryTiles.innerHTML = cardsHtml;

  for (const card of dom.categoryTiles.querySelectorAll('.category-tile')) {
    const selectTile = () => {
      state.department = card.dataset.dept;
      state.subCategory = card.dataset.sub;
      dom.brand.value = 'all';
      dom.category.value = 'all';
      dom.size.value = 'all';
      dom.sort.value = 'recommended';
      updateDependentFilters();
      render();
      document.getElementById('catalogue').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    card.addEventListener('click', selectTile);
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter') selectTile(); });
  }
}

function renderBreadcrumbs() {
  const deptInfo = DEPARTMENTS[state.department];
  if (deptInfo) {
    dom.breadcrumbDept.textContent = deptInfo.label;
    dom.breadcrumbDept.hidden = false;
  } else {
    dom.breadcrumbDept.textContent = 'All Products';
    dom.breadcrumbDept.hidden = false;
  }

  if (state.subCategory !== 'all') {
    const subLabel = deptInfo?.subcategories.find((s) => s.id === state.subCategory)?.label ?? state.subCategory;
    dom.breadcrumbSub.textContent = subLabel;
    dom.breadcrumbSub.hidden = false;
    dom.breadcrumbSubSep.hidden = false;
  } else {
    dom.breadcrumbSub.hidden = true;
    dom.breadcrumbSubSep.hidden = true;
  }
}

function renderSubcategoryPills() {
  const deptInfo = DEPARTMENTS[state.department];
  if (!deptInfo) {
    dom.subcategoryBar.hidden = true;
    return;
  }

  dom.subcategoryBar.hidden = false;
  const pillsHtml = deptInfo.subcategories.map((sub) => {
    let count = 0;
    if (sub.id === 'all') {
      count = state.products.filter((p) => {
        if (state.department === 'women') return productAudience(p) === 'women';
        if (state.department === 'men') return productAudience(p) === 'men';
        if (state.department === 'kids') return isKidsProduct(p);
        return true;
      }).length;
    } else if (state.department === 'kids') {
      count = state.products.filter((p) => isKidsProduct(p) && productAudience(p) === sub.id).length;
    } else {
      count = state.products.filter((p) => {
        if (state.department === 'women' && productAudience(p) !== 'women') return false;
        if (state.department === 'men' && productAudience(p) !== 'men') return false;
        return customerCategory(p) === sub.id;
      }).length;
    }

    const isActive = state.subCategory === sub.id;
    return `<button class="subcategory-pill ${isActive ? 'is-active' : ''}" type="button" data-sub="${escape(sub.id)}" aria-selected="${isActive}">
      <span>${escape(sub.label)}</span>
      <span class="pill-count">${count}</span>
    </button>`;
  }).join('');

  dom.subcategoryPills.innerHTML = pillsHtml;

  for (const pill of dom.subcategoryPills.querySelectorAll('.subcategory-pill')) {
    pill.addEventListener('click', () => {
      state.subCategory = pill.dataset.sub;
      dom.category.value = 'all';
      dom.size.value = 'all';
      updateDependentFilters();
      render();
    });
  }
}

function productGrid(products) {
  return products.length
    ? products.map(productCard).join('')
    : '<div class="empty"><strong>No pieces found</strong><span>Try changing a filter or subcategory.</span></div>';
}

function isKidsProduct(product) {
  const aud = productAudience(product);
  return aud === 'kids' || aud === 'girls' || aud === 'boys' || customerCategory(product) === 'Kids';
}

function customerCategory(product) {
  const text = [product.productType, product.title, product.url, ...(product.tags || [])].filter(Boolean).join(' ').toLowerCase();
  if (/\bkids?\b|\bjunior\b|\btoddler\b|chota fusion|\bws\d+[- ]kids\b|\bboy\b|\bgirl\b|\bboys\b|\bgirls\b/.test(text)) return 'Kids';
  if (/footwear|shoe|shoes|pump|pumps|sandal|sandals|chappal|loafer|loafers|flats?|mules?|khussa|kolhapuri|sneaker|sneakers|heel|heels|slippers?/.test(text)) return 'Footwear';
  if (/cushion|table runner|dummy book|candle|diffuser|tray|coaster|vase|pottery|plate|bowl|platter|home decor|bedding|quilt|pillow|gift box|tissue box|\bobjects\b|\bhome\b|\bmugs?\b/.test(text)) return 'Home & Living';
  if (/accessor|bag|bags|clutch|tote|wallet|jewell|jewellery|earring|necklace|bracelet|ring|anklet|bangle|hair|belt|sunglasses|eyewear|mask|scarf|scarves|dupatta|shawl|stole/.test(text)) return 'Accessories';
  if (/festive|bridal|couture|formal|wedding|luxury pret|raw silk|chiffon|organza|zari|embroidered formal|the-night-before-forever|desert-rose|mastaani/.test(text)) return 'Festive & Formal';
  if (/polo|tee|t-shirt|blazer|jacket|hoodie|sweatshirt|jeans|denim|western|tank top|cardigan|overcoat|sweater/.test(text)) return 'Western';
  if (/lawn|pret|fusion|eastern|stitched|suit|ensemble|set|co-ord|coord|kameez|kurta|kurti|shalwar|salwar|trouser|pant|culottes|plazo|palazzo|pajama|tunic|kaftan|abaya|maxi|dress|shirt|top|bottom|ready-to-wear/.test(text)) return 'Eastern wear';
  return 'More to discover';
}

function productAudience(product) {
  const text = [product.title, product.productType, product.url, ...(product.tags || [])].filter(Boolean).join(' ').toLowerCase();
  if (/\bboy\b|\bboys\b|cambridge junior/.test(text)) return 'boys';
  if (/\bgirl\b|\bgirls\b|daughter/.test(text)) return 'girls';
  if (/\bkids?\b|\bjunior\b|\btoddler\b|chota fusion|\bws\d+[- ]kids\b/.test(text)) return 'kids';
  if (product.brandKey === 'cambridge-pk') return 'men';
  if (/\bmen\b|\bmens\b|\bmale\b|\bgents\b|kameez shalwar|jubba|waistcoat|\bpajama\b|mashriq|for him/.test(text)) return 'men';
  return 'women';
}

function slugify(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

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

function recommendationScore(product) {
  const ageDays = Math.max(0, (Date.now() - Date.parse(product.scrapedAt)) / 86400000);
  const newness = Math.max(0, 1 - ageDays / 30);
  const stock = product.stockStatus === 'in_stock' ? 1 : product.stockStatus === 'partially_in_stock' ? 0.65 : 0;
  const discount = product.variants.reduce((best, variant) => {
    if (!variant.compareAtPrice?.amount || !variant.price.amount) return best;
    return Math.max(best, 1 - variant.price.amount / variant.compareAtPrice.amount);
  }, 0);
  const imageQuality = product.images.length >= 4 ? 1 : product.images.length >= 2 ? 0.7 : product.images.length ? 0.4 : 0;
  const demandProxy = demandProxyScore(product);

  return newness * 0.25 + stock * 0.25 + Math.min(discount, 0.5) * 0.2 + imageQuality * 0.15 + demandProxy * 0.15;
}

function demandProxyScore(product) {
  const text = [product.title, product.productType, product.vendor, ...product.tags].filter(Boolean).join(' ').toLowerCase();
  const signals = ['new', 'festive', 'formal', 'lawn', 'kurta', 'suit', 'stitched', 'western', 'wedding', 'best seller', 'bestseller'];
  const matches = signals.filter((signal) => text.includes(signal)).length;
  return Math.min(1, matches / 3);
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
function clearFilters() {
  state.department = 'all';
  state.subCategory = 'all';
  dom.search.value = '';
  dom.brand.value = 'all';
  dom.category.value = 'all';
  dom.size.value = 'all';
  dom.sort.value = 'recommended';
  dom.inStock.checked = false;
  updateDependentFilters();
  render();
}
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

function updateAudienceTabs() {
  for (const tab of dom.audienceTabs.querySelectorAll('.audience-tab')) {
    const selected = tab.dataset.audience === state.department;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
}

function updateNavLinks() {
  for (const link of document.querySelectorAll('[data-nav-dept]')) {
    const selected = link.dataset.navDept === state.department;
    link.classList.toggle('current', selected);
  }
}

for (const tab of dom.audienceTabs.querySelectorAll('.audience-tab')) {
  tab.addEventListener('click', () => {
    state.department = tab.dataset.audience;
    state.subCategory = 'all';
    dom.brand.value = 'all';
    dom.category.value = 'all';
    dom.size.value = 'all';
    updateDependentFilters();
    render();
  });
}

for (const link of document.querySelectorAll('[data-nav-dept]')) {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    state.department = link.dataset.navDept;
    state.subCategory = 'all';
    dom.brand.value = 'all';
    dom.category.value = 'all';
    dom.size.value = 'all';
    updateDependentFilters();
    render();
    document.getElementById('catalogue').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

dom.backToHome.addEventListener('click', () => {
  state.department = 'all';
  state.subCategory = 'all';
  dom.brand.value = 'all';
  dom.category.value = 'all';
  dom.size.value = 'all';
  updateDependentFilters();
  render();
});

dom.breadcrumbDept.addEventListener('click', () => {
  state.subCategory = 'all';
  dom.category.value = 'all';
  dom.size.value = 'all';
  updateDependentFilters();
  render();
});

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

await loadAuth();
updateAudienceTabs();
await loadCatalogue();
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
updateAudienceTabs();
await loadCatalogue();
