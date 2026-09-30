// Customer accounts, the bag and checkout. The catalogue page (app.js) calls
// initShop() once and addToBag() from the product view.

const el = (id) => document.getElementById(id);
const SESSION_KEY = 'malabis.auth';
const GUEST_BAG_KEY = 'malabis.bag';
const MAX_QUANTITY = 10;

const STATUS_LABEL = {
  awaiting_payment: 'Awaiting payment',
  authorized: 'Payment authorised',
  placed_with_brand: 'Ordered from the brand',
  captured: 'Payment taken',
  received: 'At our Lahore studio',
  quality_checked: 'Checked and packed',
  shipped: 'Shipped to you',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const shop = {
  config: null,
  session: null,
  bag: [],
  profile: null,
  afterSignIn: null,
  helpers: null,
};

const dom = {
  account: el('account-button'), bagButton: el('bag-button'), bagCount: el('bag-count'),
  authModal: el('auth-modal'), authForm: el('auth-form'), authTitle: el('auth-title'), authMessage: el('auth-message'),
  authName: el('auth-name'), authNameField: el('auth-name-field'), authEmail: el('auth-email'), authEmailField: el('auth-email-field'),
  authPassword: el('auth-password'), authPasswordField: el('auth-password-field'), authSubmit: el('auth-submit'),
  authMode: el('auth-mode'), authForgot: el('auth-forgot'), googleAuth: el('google-auth'), authClose: el('auth-close'),
  bag: el('bag-panel'), bagBody: el('bag-body'), bagFooter: el('bag-footer'), bagTitle: el('bag-title'),
  accountPanel: el('account-panel'), accountBody: el('account-body'), toast: el('toast'),
};

/* ---------- Setup ---------- */

export async function initShop(helpers) {
  shop.helpers = helpers;
  shop.bag = readGuestBag();
  bindEvents();
  try {
    shop.config = await fetch('/api/auth-config').then((response) => response.json());
    const appConfig = await fetch('/api/config').then((response) => response.json());
    shop.config.checkoutEnabled = Boolean(appConfig.checkoutEnabled);
  } catch (error) {
    console.error(error);
    shop.config = { checkoutEnabled: false };
  }
  await restoreSession();
  renderHeader();
}

/** Called when the catalogue finishes loading, so bag lines can show live prices. */
export function refreshBag() {
  renderHeader();
  if (!dom.bag.hidden) renderBag();
}

/* ---------- Session ---------- */

function authUrl(path) { return `${shop.config.supabaseUrl}/auth/v1${path}`; }

async function authRequest(path, { method = 'GET', body, token } = {}) {
  if (!shop.config?.supabaseUrl) throw new Error('Accounts are not available right now.');
  const response = await fetch(authUrl(path), {
    method,
    headers: {
      apikey: shop.config.supabaseAnonKey,
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(friendlyAuthError(data));
  return data;
}

function friendlyAuthError(data) {
  const message = data.error_description ?? data.msg ?? data.message ?? 'Something went wrong. Please try again.';
  if (/invalid login credentials/i.test(message)) return 'That email and password don’t match an account.';
  if (/email not confirmed/i.test(message)) return 'Please confirm your email first. Check your inbox for the link.';
  if (/already registered/i.test(message)) return 'An account with this email already exists. Try signing in.';
  if (/password should be/i.test(message)) return 'Please use a password of at least 6 characters.';
  return message;
}

function saveSession(data) {
  shop.session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at ?? Math.floor(Date.now() / 1000) + Number(data.expires_in ?? 3600),
    user: data.user ?? shop.session?.user ?? null,
  };
  storageSet(SESSION_KEY, JSON.stringify(shop.session));
}

async function restoreSession() {
  // Links from Supabase emails (confirm, password reset) and Google sign-in land here.
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  let linkType = null;
  if (hash.get('access_token')) {
    saveSession({
      access_token: hash.get('access_token'),
      refresh_token: hash.get('refresh_token'),
      expires_in: hash.get('expires_in'),
      expires_at: Number(hash.get('expires_at')) || undefined,
    });
    linkType = hash.get('type');
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  } else if (hash.get('error_description')) {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    openAuth('login', hash.get('error_description'));
  } else {
    try { shop.session = JSON.parse(storageGet(SESSION_KEY) ?? 'null'); } catch { shop.session = null; }
  }
  if (!shop.session?.access_token) { shop.session = null; return; }

  try {
    const token = await accessToken();
    shop.session.user = await authRequest('/user', { token });
    storageSet(SESSION_KEY, JSON.stringify(shop.session));
    await onSignedIn();
    if (linkType === 'recovery') openAuth('reset');
    else if (linkType === 'signup') toast('Your email is confirmed. Welcome to Malabis!');
  } catch {
    clearSession();
  }
}

/** A valid access token, refreshed shortly before it expires. */
async function accessToken() {
  if (!shop.session) throw new Error('Please sign in.');
  if (shop.session.expires_at - 60 > Date.now() / 1000) return shop.session.access_token;
  const data = await authRequest('/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: shop.session.refresh_token } });
  saveSession(data);
  return shop.session.access_token;
}

function clearSession() {
  shop.session = null;
  shop.profile = null;
  storageRemove(SESSION_KEY);
  renderHeader();
}

async function signOut() {
  const token = shop.session?.access_token;
  clearSession();
  shop.bag = [];
  writeGuestBag();
  closePanel(dom.accountPanel);
  renderHeader();
  if (token) authRequest('/logout', { method: 'POST', token }).catch(() => {});
  toast('You’re signed out.');
}

function isSignedIn() { return Boolean(shop.session?.user); }

/* ---------- Server API ---------- */

async function api(path, { method = 'GET', body } = {}) {
  const token = await accessToken();
  const response = await fetch(`/api/account${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { clearSession(); openAuth('login', data.error); }
  if (!response.ok) {
    const error = new Error(data.error ?? 'Something went wrong. Please try again.');
    error.details = data.details;
    error.status = response.status;
    throw error;
  }
  return data;
}

async function onSignedIn() {
  // Merge a bag started as a guest into the account's saved bag.
  const guest = readGuestBag();
  const { items } = await api('/cart');
  shop.bag = mergeBags(items, guest);
  if (guest.length) {
    await saveBag();
    writeGuestBag([]);
  }
  api('/profile').then(({ profile }) => { shop.profile = profile; renderHeader(); }).catch(() => {});
  renderHeader();
}

/* ---------- Bag ---------- */

function readGuestBag() {
  try { return JSON.parse(storageGet(GUEST_BAG_KEY) ?? '[]').filter((line) => line.productKey && line.variantId); } catch { return []; }
}

function writeGuestBag(lines = shop.bag) { storageSet(GUEST_BAG_KEY, JSON.stringify(lines)); }

function mergeBags(...bags) {
  const merged = new Map();
  for (const line of bags.flat()) {
    const key = `${line.productKey}|${line.variantId}`;
    const existing = merged.get(key);
    merged.set(key, { ...line, quantity: Math.min(MAX_QUANTITY, (existing?.quantity ?? 0) + line.quantity) });
  }
  return [...merged.values()];
}

let saveTimer = null;
function saveBag() {
  renderHeader();
  if (!isSignedIn()) { writeGuestBag(); return Promise.resolve(); }
  window.clearTimeout(saveTimer);
  return new Promise((resolve) => {
    saveTimer = window.setTimeout(() => {
      api('/cart', { method: 'PUT', body: { items: shop.bag } })
        .catch((error) => toast(`Your bag couldn’t be saved: ${error.message}`))
        .finally(resolve);
    }, 400);
  });
}

export function addToBag(product, variant) {
  const { cleanBrand, displayTitle, productKey } = shop.helpers;
  const line = {
    productKey: productKey(product),
    variantId: variant.externalId,
    quantity: 1,
    snapshot: {
      title: displayTitle(product),
      brand: cleanBrand(product.brandName),
      size: variant.size ?? variant.title,
      image: product.images[0]?.url ?? null,
      price: variant.price.amount,
    },
  };
  shop.bag = mergeBags(shop.bag, [line]);
  saveBag();
  toast(`${line.snapshot.title} (${line.snapshot.size}) added to your bag.`, { label: 'View bag', action: openBag });
}

/** Each bag line with the live product and price, if the piece is still on sale. */
function resolveBag() {
  const products = shop.helpers.getProducts();
  return shop.bag.map((line) => {
    const product = products.find((candidate) => shop.helpers.productKey(candidate) === line.productKey);
    const variant = product?.variants.find((candidate) => candidate.externalId === line.variantId);
    const status = !products.length ? 'loading' : !product || !variant ? 'gone' : !variant.available ? 'soldout' : 'ok';
    const unit = variant ? wholeDollars(variant.price.amount) : null;
    return { line, product, variant, status, unit, total: unit === null ? null : unit * line.quantity };
  });
}

const wholeDollars = (cents) => Math.ceil(cents / 100) * 100;
const usd = (cents) => shop.helpers.money({ amount: cents, currency: 'USD' });

function bagCount() { return shop.bag.reduce((total, line) => total + line.quantity, 0); }

function renderHeader() {
  const count = bagCount();
  dom.bagCount.textContent = String(count);
  dom.bagCount.hidden = count === 0;
  dom.bagButton.setAttribute('aria-label', `Bag, ${count} ${count === 1 ? 'piece' : 'pieces'}`);
  dom.account.textContent = isSignedIn() ? 'Account' : 'Sign in';
}

function openBag() {
  renderBag();
  openPanel(dom.bag);
}

function renderBag() {
  const { escape } = shop.helpers;
  dom.bagTitle.textContent = 'Your bag';
  const lines = resolveBag();
  if (!lines.length) {
    dom.bagBody.innerHTML = '<div class="panel-empty"><strong>Your bag is empty</strong><span>Pick a size and tap “Add to bag” on any piece.</span></div>';
    dom.bagFooter.innerHTML = '';
    return;
  }
  dom.bagBody.innerHTML = `<ul class="bag-lines">${lines.map(({ line, status, unit, total }, index) => `
    <li class="bag-line ${status === 'ok' || status === 'loading' ? '' : 'is-unavailable'}">
      ${line.snapshot.image ? `<img src="${escape(line.snapshot.image)}" alt="" />` : '<span class="bag-thumb"></span>'}
      <div class="bag-line-info">
        <p class="product-brand">${escape(line.snapshot.brand ?? '')}</p>
        <p class="bag-line-title">${escape(line.snapshot.title ?? 'Piece')}</p>
        <p class="bag-line-meta">Size ${escape(line.snapshot.size ?? '')}${unit !== null ? ` · ${usd(unit)}` : ''}</p>
        ${status === 'gone' ? '<p class="bag-line-warning">No longer available</p>' : ''}
        ${status === 'soldout' ? '<p class="bag-line-warning">Sold out in this size</p>' : ''}
        <div class="bag-line-actions">
          <div class="qty" role="group" aria-label="Quantity">
            <button type="button" data-qty="-1" data-index="${index}" aria-label="One fewer">−</button>
            <span>${line.quantity}</span>
            <button type="button" data-qty="1" data-index="${index}" aria-label="One more" ${line.quantity >= MAX_QUANTITY ? 'disabled' : ''}>+</button>
          </div>
          <button type="button" class="text-link" data-remove="${index}">Remove</button>
        </div>
      </div>
      <strong class="bag-line-total">${total !== null ? usd(total) : ''}</strong>
    </li>`).join('')}</ul>`;

  const sellable = lines.filter((entry) => entry.status === 'ok');
  const subtotal = sellable.reduce((sum, entry) => sum + entry.total, 0);
  const blocked = lines.some((entry) => entry.status === 'gone' || entry.status === 'soldout');
  dom.bagFooter.innerHTML = `
    <div class="bag-subtotal"><span>Subtotal</span><strong>${usd(subtotal)}</strong></div>
    <p class="panel-note">Prices include delivery within Pakistan. International shipping and duties are added at checkout.</p>
    ${blocked ? '<p class="bag-line-warning">Remove unavailable pieces to continue.</p>' : ''}
    <button type="button" class="button-primary button-block" id="checkout-button" ${blocked || !sellable.length ? 'disabled' : ''}>Checkout</button>`;
}

function changeQuantity(index, delta) {
  const line = shop.bag[index];
  if (!line) return;
  line.quantity = Math.max(0, Math.min(MAX_QUANTITY, line.quantity + delta));
  if (!line.quantity) shop.bag.splice(index, 1);
  saveBag();
  renderBag();
}

/* ---------- Checkout ---------- */

function startCheckout() {
  if (!shop.config.checkoutEnabled) {
    toast(isSignedIn() ? 'Checkout opens soon. Your bag is saved to your account.' : 'Checkout opens soon. Sign in to keep your bag on any device.');
    return;
  }
  if (!isSignedIn()) {
    shop.afterSignIn = () => { openBag(); renderCheckout(); };
    openAuth('login', 'Sign in or create an account to check out. Your bag will be kept.');
    return;
  }
  renderCheckout();
}

async function renderCheckout() {
  const { escape } = shop.helpers;
  if (!shop.profile) {
    try { shop.profile = (await api('/profile')).profile; } catch { shop.profile = {}; }
  }
  const profile = shop.profile ?? {};
  const lines = resolveBag().filter((entry) => entry.status === 'ok');
  const subtotal = lines.reduce((sum, entry) => sum + entry.total, 0);
  const field = (name, label, value, attrs = '') => `<label class="form-field"><span>${label}</span><input name="${name}" value="${escape(value ?? '')}" ${attrs} /></label>`;

  dom.bagTitle.textContent = 'Checkout';
  dom.bagBody.innerHTML = `
    <form id="checkout-form" class="checkout-form" novalidate>
      <h3>Ship to</h3>
      ${field('name', 'Full name', profile.display_name, 'autocomplete="name" required')}
      ${field('line1', 'Address', profile.address_line1, 'autocomplete="address-line1" required')}
      ${field('line2', 'Apartment, suite (optional)', profile.address_line2, 'autocomplete="address-line2"')}
      <div class="form-row">
        ${field('city', 'City', profile.city, 'autocomplete="address-level2" required')}
        ${field('region', 'State', profile.region, 'autocomplete="address-level1" required maxlength="40"')}
      </div>
      <div class="form-row">
        ${field('postalCode', 'ZIP code', profile.postal_code, 'autocomplete="postal-code" inputmode="numeric" required')}
        ${field('phone', 'Phone (for the courier)', profile.phone, 'autocomplete="tel" inputmode="tel"')}
      </div>
      <label class="form-check"><input type="checkbox" name="save" checked /> Save this address to my account</label>
      <h3>Your order</h3>
      <ul class="checkout-lines">${lines.map(({ line, total }) => `
        <li><span>${escape(line.snapshot.title)} · ${escape(line.snapshot.size)} × ${line.quantity}</span><strong>${usd(total)}</strong></li>`).join('')}
      </ul>
      <p id="checkout-error" class="form-error" role="alert" hidden></p>
    </form>`;
  dom.bagFooter.innerHTML = `
    <div class="bag-subtotal"><span>Subtotal</span><strong>${usd(subtotal)}</strong></div>
    <p class="panel-note">International shipping and import duties will be confirmed before any payment is taken.</p>
    <button type="submit" form="checkout-form" class="button-primary button-block" id="place-order">Place order</button>
    <button type="button" class="text-link button-block" id="back-to-bag">Back to bag</button>`;
}

async function placeOrder(form) {
  const button = el('place-order');
  const errorBox = el('checkout-error');
  const data = Object.fromEntries(new FormData(form));
  const address = { name: data.name, line1: data.line1, line2: data.line2, city: data.city, region: data.region, postalCode: data.postalCode, phone: data.phone };
  const lines = resolveBag().filter((entry) => entry.status === 'ok');
  button.disabled = true;
  button.textContent = 'Placing order…';
  errorBox.hidden = true;
  try {
    if (data.save) {
      api('/profile', { method: 'PUT', body: {
        display_name: address.name, phone: address.phone, address_line1: address.line1, address_line2: address.line2,
        city: address.city, region: address.region, postal_code: address.postalCode,
      } }).then(({ profile }) => { shop.profile = profile; }).catch(() => {});
    }
    const { order } = await api('/orders', { method: 'POST', body: {
      items: lines.map(({ line }) => line),
      shippingAddress: address,
      expectedSubtotal: lines.reduce((sum, entry) => sum + entry.total, 0),
    } });
    shop.bag = [];
    renderHeader();
    renderConfirmation(order);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    button.disabled = false;
    button.textContent = 'Place order';
  }
}

function renderConfirmation(order) {
  dom.bagTitle.textContent = 'Thank you';
  dom.bagBody.innerHTML = `
    <div class="panel-empty">
      <strong>Order #${order.number} received</strong>
      <span>We’ve saved your order. We’ll email ${shop.helpers.escape(shop.session.user.email)} with each update, and you can follow it under Account → Orders.</span>
    </div>`;
  dom.bagFooter.innerHTML = '<button type="button" class="button-primary button-block" id="view-orders">View my orders</button>';
}

/* ---------- Account panel ---------- */

async function openAccount(tab = 'orders') {
  if (!isSignedIn()) { openAuth('login'); return; }
  openPanel(dom.accountPanel);
  renderAccount(tab);
}

async function renderAccount(tab) {
  const { escape } = shop.helpers;
  const user = shop.session.user;
  const name = shop.profile?.display_name ?? user.user_metadata?.full_name ?? '';
  dom.accountBody.innerHTML = `
    <p class="account-hello">${name ? `Hi, ${escape(name.split(' ')[0])}` : 'Your account'}<span>${escape(user.email)}</span></p>
    <div class="account-tabs" role="tablist">
      <button type="button" role="tab" data-account-tab="orders" aria-selected="${tab === 'orders'}" class="${tab === 'orders' ? 'is-current' : ''}">Orders</button>
      <button type="button" role="tab" data-account-tab="details" aria-selected="${tab === 'details'}" class="${tab === 'details' ? 'is-current' : ''}">My details</button>
    </div>
    <div id="account-tab-body" class="account-tab-body"><p class="panel-note">Loading…</p></div>
    <button type="button" class="text-link" id="sign-out">Sign out</button>`;
  const body = el('account-tab-body');
  try {
    if (tab === 'orders') body.innerHTML = renderOrders((await api('/orders')).orders);
    else body.innerHTML = renderDetails((await api('/profile')).profile);
  } catch (error) {
    body.innerHTML = `<p class="form-error">${escape(error.message)}</p>`;
  }
}

function renderOrders(orders) {
  const { escape } = shop.helpers;
  if (!orders.length) return '<div class="panel-empty"><strong>No orders yet</strong><span>When you place an order, you’ll be able to follow it here.</span></div>';
  const date = (value) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
  return orders.map((order) => `
    <article class="order-card">
      <header>
        <div><strong>Order #${order.number}</strong><span>${date(order.created_at)}</span></div>
        <span class="order-status status-${escape(order.status)}">${escape(STATUS_LABEL[order.status] ?? order.status)}</span>
      </header>
      <ul class="order-items">${order.order_items.map((item) => `
        <li>
          ${item.image_url ? `<img src="${escape(item.image_url)}" alt="" />` : ''}
          <div><p class="product-brand">${escape(item.brand_name ?? '')}</p><p>${escape(item.title)}</p><span>Size ${escape(item.size ?? '')} × ${item.quantity}</span></div>
          <strong>${usd(item.unit_price * item.quantity)}</strong>
        </li>`).join('')}
      </ul>
      <footer><span>Subtotal</span><strong>${usd(order.subtotal)}</strong></footer>
      <ol class="order-timeline">${order.order_events.map((event) => `
        <li><strong>${escape(STATUS_LABEL[event.status] ?? event.status)}</strong><span>${date(event.created_at)}${event.note ? ` · ${escape(event.note)}` : ''}</span></li>`).join('')}
      </ol>
    </article>`).join('');
}

function renderDetails(profile = {}) {
  const { escape } = shop.helpers;
  const field = (name, label, value, attrs = '') => `<label class="form-field"><span>${label}</span><input name="${name}" value="${escape(value ?? '')}" ${attrs} /></label>`;
  return `
    <form id="details-form" class="checkout-form">
      ${field('display_name', 'Full name', profile.display_name, 'autocomplete="name"')}
      ${field('phone', 'Phone', profile.phone, 'autocomplete="tel" inputmode="tel"')}
      <h3>Shipping address</h3>
      ${field('address_line1', 'Address', profile.address_line1, 'autocomplete="address-line1"')}
      ${field('address_line2', 'Apartment, suite', profile.address_line2, 'autocomplete="address-line2"')}
      <div class="form-row">
        ${field('city', 'City', profile.city, 'autocomplete="address-level2"')}
        ${field('region', 'State', profile.region, 'autocomplete="address-level1" maxlength="40"')}
      </div>
      ${field('postal_code', 'ZIP code', profile.postal_code, 'autocomplete="postal-code" inputmode="numeric"')}
      <p class="panel-note">We currently ship to the United States.</p>
      <button type="submit" class="button-primary">Save details</button>
      <p id="details-status" class="panel-note" role="status"></p>
    </form>`;
}

async function saveDetails(form) {
  const status = el('details-status');
  status.textContent = 'Saving…';
  try {
    shop.profile = (await api('/profile', { method: 'PUT', body: Object.fromEntries(new FormData(form)) })).profile;
    status.textContent = 'Saved.';
  } catch (error) {
    status.textContent = error.message;
  }
}

/* ---------- Sign-in dialog ---------- */

let authMode = 'login';

function openAuth(mode = 'login', message) {
  setAuthMode(mode, message);
  dom.authModal.hidden = false;
  (mode === 'reset' ? dom.authPassword : mode === 'register' ? dom.authName : dom.authEmail).focus();
}

function closeAuth() {
  dom.authModal.hidden = true;
  shop.afterSignIn = null;
}

function setAuthMode(mode, message) {
  authMode = mode;
  const copy = {
    login: ['Sign in', 'Sign in to see your orders and keep your bag on any device.', 'Sign in'],
    register: ['Create your account', 'Save your bag, check out faster and follow your orders.', 'Create account'],
    forgot: ['Reset your password', 'Enter your email and we’ll send you a link to set a new password.', 'Send reset link'],
    reset: ['Choose a new password', 'Enter a new password for your account.', 'Save new password'],
  }[mode];
  dom.authTitle.textContent = copy[0];
  dom.authMessage.textContent = message ?? copy[1];
  dom.authMessage.classList.toggle('is-error', false);
  dom.authSubmit.textContent = copy[2];
  dom.authNameField.hidden = mode !== 'register';
  dom.authEmailField.hidden = mode === 'reset';
  dom.authPasswordField.hidden = mode === 'forgot';
  dom.authPassword.required = mode !== 'forgot';
  dom.authEmail.required = mode !== 'reset';
  dom.authPassword.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  dom.authForgot.hidden = mode !== 'login';
  dom.googleAuth.hidden = mode === 'forgot' || mode === 'reset';
  dom.authMode.hidden = mode === 'reset';
  dom.authMode.textContent = mode === 'login' ? 'New to Malabis? Create an account' : 'Already have an account? Sign in';
}

function authError(message) {
  dom.authMessage.textContent = message;
  dom.authMessage.classList.add('is-error');
}

async function submitAuth(event) {
  event.preventDefault();
  const email = dom.authEmail.value.trim();
  const password = dom.authPassword.value;
  dom.authSubmit.disabled = true;
  try {
    if (authMode === 'forgot') {
      await authRequest(`/recover?redirect_to=${encodeURIComponent(location.origin + '/')}`, { method: 'POST', body: { email } });
      setAuthMode('login', 'If that email has an account, a reset link is on its way. Check your inbox.');
      return;
    }
    if (authMode === 'reset') {
      await authRequest('/user', { method: 'PUT', token: await accessToken(), body: { password } });
      dom.authPassword.value = '';
      closeAuth();
      toast('Your new password is saved.');
      return;
    }
    const data = authMode === 'register'
      ? await authRequest(`/signup?redirect_to=${encodeURIComponent(location.origin + '/')}`, {
        method: 'POST', body: { email, password, data: { full_name: dom.authName.value.trim() } },
      })
      : await authRequest('/token?grant_type=password', { method: 'POST', body: { email, password } });
    if (!data.access_token) {
      setAuthMode('login', `Almost done: we’ve emailed ${email} a link to confirm your account.`);
      return;
    }
    saveSession(data);
    dom.authPassword.value = '';
    const next = shop.afterSignIn;
    shop.afterSignIn = null;
    dom.authModal.hidden = true;
    await onSignedIn();
    toast(authMode === 'register' ? 'Your account is ready.' : 'You’re signed in.');
    next?.();
  } catch (error) {
    authError(error.message);
  } finally {
    dom.authSubmit.disabled = false;
  }
}

function signInWithGoogle() {
  const params = new URLSearchParams({ provider: 'google', redirect_to: location.origin + '/' });
  location.href = authUrl(`/authorize?${params}`);
}

/* ---------- Panels, toast, storage ---------- */

function openPanel(panel) {
  panel.hidden = false;
  document.body.classList.add('drawer-open');
  panel.querySelector('.side-panel-close')?.focus();
}

function closePanel(panel) {
  if (panel.hidden) return;
  panel.hidden = true;
  if (dom.bag.hidden && dom.accountPanel.hidden) document.body.classList.remove('drawer-open');
}

let toastTimer = null;
function toast(message, action) {
  dom.toast.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = message;
  dom.toast.append(text);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => { dom.toast.hidden = true; action.action(); });
    dom.toast.append(button);
  }
  dom.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { dom.toast.hidden = true; }, 5000);
}

function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }
function storageRemove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } }

/* ---------- Events ---------- */

function bindEvents() {
  dom.account.addEventListener('click', () => openAccount());
  dom.bagButton.addEventListener('click', openBag);
  dom.authClose.addEventListener('click', closeAuth);
  dom.authModal.addEventListener('click', (event) => { if (event.target === dom.authModal) closeAuth(); });
  dom.authForm.addEventListener('submit', submitAuth);
  dom.authMode.addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
  dom.authForgot.addEventListener('click', () => setAuthMode('forgot'));
  dom.googleAuth.addEventListener('click', signInWithGoogle);

  for (const panel of [dom.bag, dom.accountPanel]) {
    panel.addEventListener('click', (event) => {
      if (event.target === panel || event.target.closest('.side-panel-close')) closePanel(panel);
    });
  }

  dom.bag.addEventListener('click', (event) => {
    const qty = event.target.closest('[data-qty]');
    if (qty) { changeQuantity(Number(qty.dataset.index), Number(qty.dataset.qty)); return; }
    const remove = event.target.closest('[data-remove]');
    if (remove) { changeQuantity(Number(remove.dataset.remove), -MAX_QUANTITY); return; }
    if (event.target.closest('#checkout-button')) { startCheckout(); return; }
    if (event.target.closest('#back-to-bag')) { renderBag(); return; }
    if (event.target.closest('#view-orders')) { closePanel(dom.bag); openAccount('orders'); }
  });
  dom.bag.addEventListener('submit', (event) => {
    if (event.target.id !== 'checkout-form') return;
    event.preventDefault();
    placeOrder(event.target);
  });

  dom.accountPanel.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-account-tab]');
    if (tab) { renderAccount(tab.dataset.accountTab); return; }
    if (event.target.closest('#sign-out')) signOut();
  });
  dom.accountPanel.addEventListener('submit', (event) => {
    if (event.target.id !== 'details-form') return;
    event.preventDefault();
    saveDetails(event.target);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeAuth();
    closePanel(dom.bag);
    closePanel(dom.accountPanel);
  });
}
