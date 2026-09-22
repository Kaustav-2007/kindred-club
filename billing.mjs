import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';

export function billingConfig(env = process.env) {
  const config = {
    secretKey: env.STRIPE_SECRET_KEY || '', webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    origin: (env.APP_URL || 'http://127.0.0.1:4173').replace(/\/$/, ''),
    currency: 'usd', monthly: 1900, yearly: 19000,
    monthlyPrice: env.STRIPE_MONTHLY_PRICE_ID || '', yearlyPrice: env.STRIPE_YEARLY_PRICE_ID || '',
    portalConfiguration: env.STRIPE_PORTAL_CONFIGURATION_ID || ''
  };
  const origin = new URL(config.origin);
  if (origin.origin !== config.origin || origin.username || origin.password) throw new Error('APP_URL must be a plain origin with no path or credentials.');
  if (config.secretKey && !/^sk_(live|test)_/.test(config.secretKey)) throw new Error('Invalid Stripe secret key format.');
  if (config.secretKey.startsWith('sk_live_') && origin.protocol !== 'https:') throw new Error('Live payments require an HTTPS APP_URL.');
  return config;
}

export function createBilling({ db, config = billingConfig(), stripe = config.secretKey ? new Stripe(config.secretKey, { maxNetworkRetries: 2, timeout: 15000 }) : null }) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  run('INSERT OR IGNORE INTO billing_settings VALUES(?,?)', 'installation', randomUUID());
  const installation = one('SELECT value FROM billing_settings WHERE key=?', 'installation').value;
  let queue = Promise.resolve();
  const serialize = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  const idOf = o => typeof o === 'string' ? o : o?.id;
  const live = config.secretKey.startsWith('sk_live_');
  const isConfigured = () => !!(stripe && config.webhookSecret && config.monthlyPrice && config.yearlyPrice);
  const requireSetup = () => { if (!isConfigured()) fail('Checkout is not connected yet. The owner needs to configure Stripe before payments can be accepted.', 503); };
  function available() { return { configured: isConfigured(), live: isConfigured() && live, currency: config.currency, monthly: config.monthly, yearly: config.yearly }; }
  function membership(userId) {
    const sub = one("SELECT * FROM billing_subscriptions WHERE user_id=? ORDER BY COALESCE(paid_until,'') DESC LIMIT 1", userId);
    const eligible = all("SELECT * FROM billing_subscriptions WHERE user_id=? AND status='active' AND paid_until>? ORDER BY paid_until DESC", userId, new Date().toISOString())[0];
    return { active: !!eligible, plan: (eligible || sub)?.plan || null, expires: (eligible || sub)?.paid_until || null, cancelled: (eligible || sub)?.cancel_at_period_end || 0, status: (eligible || sub)?.status || 'inactive' };
  }
  async function customer(user) {
    const existing = one('SELECT customer_id FROM billing_customers WHERE user_id=?', user.id);
    if (existing) return existing.customer_id;
    const c = await stripe.customers.create({ email: user.email, name: user.name, metadata: { kindred_user_id: String(user.id), kindred_installation: installation } }, { idempotencyKey: `kindred-customer-${installation}-${user.id}` });
    run('INSERT OR IGNORE INTO billing_customers VALUES(?,?)', user.id, c.id);
    return one('SELECT customer_id FROM billing_customers WHERE user_id=?', user.id).customer_id;
  }
  async function validatePrice(plan) {
    if (!['monthly', 'yearly'].includes(plan)) fail('Choose a membership plan.');
    const price = await stripe.prices.retrieve(config[plan + 'Price']);
    if (!price.active || price.livemode !== live || price.currency !== config.currency || price.unit_amount !== config[plan] || price.type !== 'recurring' || price.recurring?.interval !== (plan === 'monthly' ? 'month' : 'year') || price.recurring?.interval_count !== 1 || price.recurring?.usage_type !== 'licensed') fail('The Stripe price does not match this membership. Please contact the club owner.', 503);
    return price.id;
  }
  function validUrl(url, host) { if (!url || new URL(url).protocol !== 'https:' || new URL(url).hostname !== host) fail('Stripe did not return a valid checkout link.', 502); return url; }
  async function checkout(user, { kind, plan, amount, charity_id }) {
    return serialize(async () => {
      requireSetup();
      if (user.role === 'admin') fail('Please use a member account for purchases.');
      const selected = kind === 'subscription' ? user.charity_id : Number(charity_id);
      if (!one('SELECT id FROM charities WHERE id=? AND active=1', selected || -1)) fail('Choose an available charity before checking out.');
      let priceId = null;
      if (kind === 'subscription') {
        if (one("SELECT subscription_id FROM billing_subscriptions WHERE user_id=? AND status NOT IN ('canceled','incomplete_expired')", user.id)) fail('A subscription already exists. Use Manage billing to update it.');
        priceId = await validatePrice(plan); amount = config[plan];
      } else if (kind !== 'donation' || !Number.isInteger(amount) || amount < 100 || amount > 1000000) fail('Enter a donation between $1 and $10,000.');
      let order = one("SELECT * FROM billing_orders WHERE user_id=? AND kind=? AND status IN ('creating','open') ORDER BY created DESC LIMIT 1", user.id, kind);
      if (order?.session_id) {
        const session = await stripe.checkout.sessions.retrieve(order.session_id);
        if (session.status === 'complete') fail('Your payment is being confirmed. Please return to your account shortly.');
        if (session.status === 'open') {
          if (order.plan === (plan || null) && order.amount === amount && order.charity_id === selected && order.percentage === (kind === 'subscription' ? user.percentage : 100)) return { url: validUrl(session.url, 'checkout.stripe.com') };
          await stripe.checkout.sessions.expire(session.id);
        }
        run("UPDATE billing_orders SET status='expired' WHERE id=?", order.id); order = null;
      }
      // Ambiguous network failures keep the original request for safe idempotent retries.
      if (order && (order.plan !== (plan || null) || order.amount !== amount || order.charity_id !== selected)) fail('A checkout is still being created. Retry the original selection.');
      if (order && order.created < Date.now() - 23 * 3600000) fail('A checkout needs reconciliation by the owner before another payment can be started.', 409);
      if (!order) {
        const id = randomUUID();
        run('INSERT INTO billing_orders(id,user_id,kind,plan,charity_id,percentage,amount,currency,price_id,created) VALUES(?,?,?,?,?,?,?,?,?,?)', id, user.id, kind, plan || null, selected, kind === 'subscription' ? user.percentage : 100, amount, config.currency, priceId, Date.now());
        order = one('SELECT * FROM billing_orders WHERE id=?', id);
      }
      const customerId = await customer(user);
      const metadata = { kindred_order_id: order.id, kindred_installation: installation };
      const session = await stripe.checkout.sessions.create({
        mode: kind === 'subscription' ? 'subscription' : 'payment', customer: customerId, adaptive_pricing: { enabled: false },
        client_reference_id: order.id, metadata, payment_method_types: ['card'],
        line_items: [{ quantity: 1, ...(kind === 'subscription' ? { price: order.price_id } : { price_data: { currency: config.currency, unit_amount: order.amount, product_data: { name: 'Contribution to ' + one('SELECT name FROM charities WHERE id=?', selected).name } } }) }],
        ...(kind === 'subscription' ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
        success_url: `${config.origin}/?checkout=success#dashboard`, cancel_url: `${config.origin}/?checkout=cancelled#plans`
      }, { idempotencyKey: `kindred-checkout-${order.id}` });
      run("UPDATE billing_orders SET session_id=?,status='open' WHERE id=?", session.id, order.id);
      return { url: validUrl(session.url, 'checkout.stripe.com') };
    });
  }
  async function portal(user) {
    requireSetup();
    const c = one('SELECT customer_id FROM billing_customers WHERE user_id=?', user.id);
    if (!c) fail('No billing account exists yet. Choose a membership first.');
    if (!config.portalConfiguration) fail('The club owner needs to configure the Stripe billing portal.', 503);
    const session = await stripe.billingPortal.sessions.create({ customer: c.customer_id, configuration: config.portalConfiguration, return_url: `${config.origin}/#dashboard` });
    return { url: validUrl(session.url, 'billing.stripe.com') };
  }
  function managedOrder(object) {
    if (object.metadata?.kindred_installation !== installation) return null;
    return one('SELECT * FROM billing_orders WHERE id=?', object.metadata.kindred_order_id || '');
  }
  async function syncSubscription(subscriptionId) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const order = managedOrder(sub); if (!order || order.kind !== 'subscription') return null;
    const c = one('SELECT customer_id FROM billing_customers WHERE user_id=?', order.user_id);
    if (!c || c.customer_id !== idOf(sub.customer) || sub.livemode !== live) fail('Subscription ownership mismatch.');
    const item = sub.items?.data?.[0];
    const supported = sub.items?.data?.length === 1 && item.quantity === 1 && idOf(item.price) === order.price_id;
    const status = supported ? sub.status : 'unsupported_price';
    run(`INSERT INTO billing_subscriptions(subscription_id,user_id,customer_id,status,price_id,plan,cancel_at_period_end) VALUES(?,?,?,?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET status=excluded.status,cancel_at_period_end=excluded.cancel_at_period_end`, sub.id, order.user_id, c.customer_id, status, order.price_id, order.plan, sub.cancel_at_period_end ? 1 : 0);
    return { sub, order, item };
  }
  function recordPayment(reference, order, amount, charityId, percentage, created, subscriptionId = null) {
    if (one('SELECT reference FROM billing_receipts WHERE reference=?', reference)) return;
    const result = run('INSERT INTO payments(user_id,charity_id,kind,amount,charity_amount,created) VALUES(?,?,?,?,?,?)', order.user_id, charityId, order.kind, amount, Math.round(amount * percentage / 100), new Date(created * 1000).toISOString());
    run('INSERT INTO billing_receipts VALUES(?,?,?,?)', reference, result.lastInsertRowid, subscriptionId, config.currency);
  }
  async function paidInvoice(invoiceId) {
    const invoice = await stripe.invoices.retrieve(invoiceId);
    const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription || invoice.subscription);
    if (!subscriptionId) return;
    const managed = await syncSubscription(subscriptionId); if (!managed) return;
    const { order } = managed;
    if (invoice.status !== 'paid' || invoice.amount_paid <= 0) return;
    if (invoice.livemode !== live || invoice.currency !== config.currency || idOf(invoice.customer) !== idOf(managed.sub.customer)) fail('Invoice ownership or currency mismatch.');
    const lines = invoice.lines?.data || [];
    const line = lines.find(l => idOf(l.pricing?.price_details?.price || l.price) === order.price_id);
    if (lines.length !== 1 || !line || line.quantity !== 1 || !line.period?.end || invoice.amount_paid !== order.amount) fail('Invoice requires manual reconciliation; access has not been granted.');
    const preference = one('SELECT * FROM billing_preferences WHERE user_id=? AND effective<=? ORDER BY effective DESC,id DESC LIMIT 1', order.user_id, invoice.created);
    tx(() => {
      recordPayment(invoice.id, order, invoice.amount_paid, preference?.charity_id || order.charity_id, preference?.percentage || order.percentage, invoice.created, subscriptionId);
      const end = new Date(line.period.end * 1000).toISOString();
      run('UPDATE billing_subscriptions SET paid_until=MAX(COALESCE(paid_until,\'\'),?) WHERE subscription_id=?', end, subscriptionId);
      run("UPDATE billing_orders SET status='complete' WHERE id=?", order.id);
    });
  }
  async function processEvent(event) {
    if (event.livemode !== live) fail('Webhook mode mismatch.');
    if (one('SELECT id FROM billing_events WHERE id=?', event.id)) return;
    const object = event.data.object;
    if (event.type === 'invoice.paid') await paidInvoice(object.id);
    else if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed'].includes(event.type)) {
      const id = event.type.startsWith('invoice.') ? idOf(object.parent?.subscription_details?.subscription || object.subscription) : object.id;
      if (id) await syncSubscription(id);
    } else if (['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired'].includes(event.type)) {
      const session = await stripe.checkout.sessions.retrieve(object.id);
      const order = managedOrder(session);
      if (order) {
        const c = one('SELECT customer_id FROM billing_customers WHERE user_id=?', order.user_id);
        if (!c || idOf(session.customer) !== c.customer_id || (order.session_id && order.session_id !== session.id) || session.livemode !== live) fail('Checkout ownership mismatch.');
        if (session.status === 'expired') run("UPDATE billing_orders SET status='expired' WHERE id=? AND status<>'complete'", order.id);
        else if (session.mode === 'subscription' && order.kind === 'subscription' && session.subscription) {
          await syncSubscription(idOf(session.subscription));
          // The invoice event is authoritative; a browser redirect never grants access.
          if (session.invoice) await paidInvoice(idOf(session.invoice));
        } else if (session.mode === 'payment' && order.kind === 'donation' && session.payment_status === 'paid') {
          if (session.currency !== order.currency || session.amount_total !== order.amount) fail('Donation amount mismatch.');
          tx(() => { recordPayment(session.id, order, session.amount_total, order.charity_id, 100, session.created); run("UPDATE billing_orders SET status='complete' WHERE id=?", order.id); });
        }
      }
    }
    run('INSERT OR IGNORE INTO billing_events VALUES(?,?,?)', event.id, event.type, new Date().toISOString());
  }
  async function webhook(raw, signature) {
    requireSetup(); let event;
    try { event = stripe.webhooks.constructEvent(raw, signature, config.webhookSecret, 300); }
    catch { fail('Invalid webhook signature.', 400); }
    // No successful acknowledgment until processing is durable. Stripe retries failures.
    return serialize(() => processEvent(event));
  }
  return { available, membership, checkout, portal, webhook, processEvent, syncSubscription };
}
