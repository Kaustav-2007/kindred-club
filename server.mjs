import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocatePrizes, drawNumbers, validateScore } from './lib.mjs';
import { billingConfig, createBilling } from './billing.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const config = billingConfig();
// Keep legacy demo records separate; they must never become paid memberships.
const data = process.env.DATA_DIR || path.join(root, 'data-live');
mkdirSync(data, { recursive: true });
const db = new DatabaseSync(path.join(data, 'kindred.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(readFileSync(path.join(root, 'schema.sql'), 'utf8'));
const query = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const now = () => new Date().toISOString();
const billing = createBilling({ db, config });
const active = u => !!u && billing.membership(u.id).active;
const publicUser = u => u && ({ id: u.id, name: u.name, email: u.email, role: u.role, charity_id: u.charity_id, percentage: u.percentage, ...billing.membership(u.id) });
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function hashPassword(password) { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(password, salt, 64).toString('hex'); }
function checkPassword(password, hash) { const [salt, digest] = hash.split(':'); return timingSafeEqual(Buffer.from(digest, 'hex'), scryptSync(password, salt, 64)); }
function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
function charity(id) { const c = one('SELECT * FROM charities WHERE id=? AND active=1', Number(id)); if (!c) fail('Choose an available charity.'); return c; }
function text(value, min = 1, max = 300) { if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(`Enter between ${min} and ${max} characters.`); return value.trim(); }

// Bootstrap is owner-configured, never a public registration privilege.
if (process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD) {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 16) throw new Error('Bootstrap administrator requires a valid email and a password of at least 16 characters.');
  if (!one("SELECT id FROM users WHERE role='admin'")) {
    if (one('SELECT id FROM users WHERE email=?', email)) throw new Error('Bootstrap email already belongs to a member. Choose another email.');
    run('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)', 'Club Administrator', email, hashPassword(password), 'admin');
  }
}

function drawContext() {
  const subscribers = query("SELECT * FROM users WHERE role='user'").filter(active);
  const entrants = subscribers.map(u => ({ id: u.id, name: u.name, scores: query('SELECT score FROM scores WHERE user_id=? ORDER BY date DESC LIMIT 5', u.id).map(s => s.score) })).filter(u => u.scores.length === 5);
  const pool = subscribers.reduce((n, u) => n + (billing.membership(u.id).plan === 'yearly' ? config.yearly * .2 / 12 : config.monthly * .2), 0);
  const rollover = one('SELECT rollover_out FROM draws ORDER BY month DESC LIMIT 1')?.rollover_out || 0;
  const result = { entrants, pool: Math.round(pool), rollover };
  return { ...result, fingerprint: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}
function state(u) {
  const draws = query('SELECT * FROM draws ORDER BY month DESC').map(d => ({ ...d, numbers: JSON.parse(d.numbers), entrants: JSON.parse(d.entrants).length }));
  const stats = one('SELECT COUNT(*) as members FROM users WHERE role=\'user\'');
  const totals = one('SELECT COALESCE(SUM(charity_amount),0) as giving FROM payments');
  const result = { user: publicUser(u), charities: query('SELECT * FROM charities WHERE active=1'), draws, stats: { ...stats, ...totals, pool: drawContext().pool, rollover: drawContext().rollover }, billing: billing.available() };
  if (u) {
    result.scores = query('SELECT * FROM scores WHERE user_id=? ORDER BY date DESC', u.id);
    result.winners = query('SELECT w.id,w.draw_id,w.matches,w.amount,w.review,w.status,w.proof IS NOT NULL AS has_proof,d.month FROM winners w JOIN draws d ON d.id=w.draw_id WHERE w.user_id=? ORDER BY w.id DESC', u.id);
    result.payments = query('SELECT p.*,c.name as charity FROM payments p LEFT JOIN charities c ON c.id=p.charity_id WHERE user_id=? ORDER BY p.id DESC', u.id);
    result.participation = draws.filter(d => JSON.parse(one('SELECT entrants FROM draws WHERE id=?', d.id).entrants).some(e => e.id === u.id)).length;
  }
  if (u?.role === 'admin') {
    result.users = query('SELECT * FROM users').map(publicUser);
    result.allScores = query('SELECT * FROM scores ORDER BY date DESC');
    result.allWinners = query('SELECT w.id,w.draw_id,w.user_id,w.matches,w.amount,w.review,w.status,w.proof IS NOT NULL AS has_proof,u.name,d.month FROM winners w JOIN users u ON u.id=w.user_id JOIN draws d ON d.id=w.draw_id ORDER BY w.id DESC');
    result.allCharities = query('SELECT * FROM charities');
    result.report = query('SELECT c.name,COALESCE(SUM(p.charity_amount),0) as amount FROM charities c LEFT JOIN payments p ON p.charity_id=c.id GROUP BY c.id');
  }
  return result;
}

const attempts = new Map();
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
  const url = new URL(req.url, 'http://localhost');
  const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  try {
    if (req.headers.host !== new URL(config.origin).host && req.headers.host !== `127.0.0.1:${process.env.PORT || 4173}`) fail('Unrecognised host.', 403);
    if (!url.pathname.startsWith('/api/')) {
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      const file = files[url.pathname]; if (!file) return send(404, { error: 'Page not found.' });
      res.writeHead(200, { 'Content-Type': file[1] }); return res.end(readFileSync(path.join(root, 'public', file[0])));
    }
    if (!['GET', 'POST'].includes(req.method)) fail('Method not allowed.', 405);
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== config.origin) fail('Request origin is not allowed.', 403);
    let body = {}; let rawBody = Buffer.alloc(0); if (req.method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/json')) fail('JSON required.', 415);
      const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 3e6) fail('Upload must be smaller than 2 MB.', 413); chunks.push(chunk); }
      rawBody = Buffer.concat(chunks);
      if (url.pathname === '/api/stripe/webhook') {
        try { await billing.webhook(rawBody, req.headers['stripe-signature']); }
        catch (e) { if (e.status) throw e; console.error('Stripe webhook processing failed:', e.type || e.name); return send(500, { error: 'Webhook processing failed; retry required.' }); }
        return send(200, { received: true });
      }
      try { body = JSON.parse(rawBody.toString('utf8') || '{}'); } catch { fail('Invalid request.'); }
    }
    const token = req.headers.cookie?.match(/(?:^|; )kindred=([a-f0-9]+)/)?.[1];
    const u = token ? one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', token, Date.now()) : null;
    const route = url.pathname;
    if (req.method === 'GET' && route === '/api/state') return send(200, state(u));
    if (req.method === 'POST' && ['/api/login', '/api/signup'].includes(route)) {
      const key = req.socket.remoteAddress;
      let attempt = attempts.get(key); if (!attempt || attempt.until < Date.now()) { attempt = { count: 0, until: Date.now() + 600000 }; attempts.set(key, attempt); }
      if (++attempt.count > 30) fail('Too many attempts. Try again in 10 minutes.', 429);
      const email = text(body.email, 5, 200).toLowerCase(); const password = text(body.password, 10, 200);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email address.');
      let user = one('SELECT * FROM users WHERE email=?', email);
      if (route === '/api/signup') {
        if (user) fail('An account already exists with that email.');
        charity(body.charity_id);
        const id = run('INSERT INTO users(name,email,password,charity_id) VALUES(?,?,?,?)', text(body.name, 2, 80), email, hashPassword(password), Number(body.charity_id)).lastInsertRowid;
        run('INSERT INTO billing_preferences(user_id,charity_id,percentage,effective) VALUES(?,?,10,?)', id, Number(body.charity_id), Math.floor(Date.now()/1000));
        user = one('SELECT * FROM users WHERE id=?', id);
      } else if (!user || !checkPassword(password, user.password)) fail('Email or password is incorrect.', 401);
      const session = randomBytes(32).toString('hex');
      run('DELETE FROM sessions WHERE expires<?', Date.now());
      run('INSERT INTO sessions VALUES(?,?,?)', session, user.id, Date.now() + 864e5);
      res.setHeader('Set-Cookie', `kindred=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${config.origin.startsWith('https:') ? '; Secure' : ''}`);
      return send(200, { ok: true });
    }
    if (!u) fail('Please sign in to continue.', 401);
    if (req.method === 'GET' && route === '/api/proof') {
      const w = one('SELECT * FROM winners WHERE id=?', Number(url.searchParams.get('id')));
      if (!w || (u.role !== 'admin' && w.user_id !== u.id)) fail('Proof not found.', 404);
      if (!w.proof) fail('No proof uploaded.', 404);
      return send(200, { proof: w.proof });
    }
    if (req.method !== 'POST') fail('Not found.', 404);
    if (route === '/api/logout') { run('DELETE FROM sessions WHERE token=?', token); res.setHeader('Set-Cookie', 'kindred=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); }
    else if (route === '/api/profile') {
      charity(body.charity_id); const p = Number(body.percentage); if (!Number.isInteger(p) || p < 10 || p > 80) fail('Charity contribution must be 10–80%.');
      transaction(() => {
        run('UPDATE users SET name=?,charity_id=?,percentage=? WHERE id=?', text(body.name, 2, 80), Number(body.charity_id), p, u.id);
        run('INSERT INTO billing_preferences(user_id,charity_id,percentage,effective) VALUES(?,?,?,?)', u.id, Number(body.charity_id), p, Math.floor(Date.now()/1000));
      });
    }
    else if (route === '/api/subscribe') return send(200, await billing.checkout(u, { kind: 'subscription', plan: body.plan }));
    else if (route === '/api/cancel' || route === '/api/billing/portal') return send(200, await billing.portal(u));
    else if (route === '/api/donate') return send(200, await billing.checkout(u, { kind: 'donation', amount: Number(body.amount), charity_id: body.charity_id }));
    else if (route === '/api/score' || route === '/api/score/delete') {
      const target = u.role === 'admin' && body.user_id ? Number(body.user_id) : u.id;
      if (u.role !== 'admin' && !active(u)) fail('An active membership is needed to manage scores.', 403);
      if (!one('SELECT id FROM users WHERE id=?', target)) fail('Member not found.', 404);
      if (route.endsWith('/delete')) run('DELETE FROM scores WHERE id=? AND user_id=?', Number(body.id), target);
      else {
        const score = Number(body.score); validateScore(score, body.date);
        const duplicate = one('SELECT id FROM scores WHERE user_id=? AND date=?', target, body.date);
        if (duplicate && duplicate.id !== Number(body.id)) fail('A round already exists on that date. Edit the existing round.');
        transaction(() => {
          if (body.id) { if (!one('SELECT id FROM scores WHERE id=? AND user_id=?', Number(body.id), target)) fail('Round not found.', 404); run('UPDATE scores SET score=?,date=? WHERE id=? AND user_id=?', score, body.date, Number(body.id), target); }
          else run('INSERT INTO scores(user_id,score,date) VALUES(?,?,?)', target, score, body.date);
          run('DELETE FROM scores WHERE user_id=? AND id NOT IN (SELECT id FROM scores WHERE user_id=? ORDER BY date DESC LIMIT 5)', target, target);
        });
      }
    }
    else if (route === '/api/proof') {
      const w = one('SELECT * FROM winners WHERE id=? AND user_id=?', Number(body.id), u.id);
      if (!w || w.status === 'paid' || w.review === 'approved') fail('This prize cannot accept a new proof.');
      if (typeof body.proof !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(body.proof)) fail('Upload a PNG or JPEG image.');
      const bytes = Buffer.from(body.proof.split(',')[1], 'base64');
      if (bytes.length > 2e6 || !(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')))) fail('Invalid image or image larger than 2 MB.');
      run('UPDATE winners SET proof=?,review=\'pending review\' WHERE id=?', body.proof, w.id);
    }
    else if (route.startsWith('/api/admin/')) {
      if (u.role !== 'admin') fail('Administrator access required.', 403);
      if (route === '/api/admin/user') {
        const member = one('SELECT * FROM users WHERE id=?', Number(body.id)); if (!member || member.role === 'admin') fail('Choose a member account.');
        if (body.status) fail('Membership access is controlled by verified Stripe payments.');
        run('UPDATE users SET name=? WHERE id=?', text(body.name, 2, 80), member.id);
      }
      else if (route === '/api/admin/charity') {
        const args = [text(body.name, 2, 100), text(body.category, 2, 60), text(body.description, 10, 1500), text(body.event || 'Events to be announced', 1, 200), body.active === false ? 0 : 1];
        if (body.id) run('UPDATE charities SET name=?,category=?,description=?,event=?,active=? WHERE id=?', ...args, Number(body.id));
        else run('INSERT INTO charities(name,category,description,event,active) VALUES(?,?,?,?,?)', ...args);
      }
      else if (route === '/api/admin/simulate') {
        if (!['random', 'weighted'].includes(body.mode)) fail('Choose a draw method.');
        const month = now().slice(0, 7); if (one('SELECT id FROM draws WHERE month=?', month)) fail('This month’s draw is already published.');
        const ctx = drawContext(); if (!ctx.entrants.length) fail('At least one active member needs five scores.');
        const numbers = drawNumbers(body.mode, ctx.entrants.flatMap(e => e.scores)); const id = randomBytes(16).toString('hex');
        run('DELETE FROM simulations WHERE created<?', Date.now() - 3600000);
        run('INSERT INTO simulations VALUES(?,?,?,?,?,?)', id, month, body.mode, JSON.stringify(numbers), ctx.fingerprint, Date.now());
        return send(200, { id, numbers, month, pool: ctx.pool, ...allocatePrizes(ctx.pool, ctx.rollover, ctx.entrants, numbers) });
      }
      else if (route === '/api/admin/publish') {
        transaction(() => {
          const sim = one('SELECT * FROM simulations WHERE id=?', String(body.id));
          if (!sim || sim.created < Date.now() - 3600000 || sim.month !== now().slice(0, 7)) fail('Run a fresh simulation first.');
          if (one('SELECT id FROM draws WHERE month=?', sim.month)) fail('This month’s draw is already published.');
          const ctx = drawContext(); if (ctx.fingerprint !== sim.fingerprint) fail('Scores or membership changed. Run a new simulation.');
          const result = allocatePrizes(ctx.pool, ctx.rollover, ctx.entrants, JSON.parse(sim.numbers));
          const id = run('INSERT INTO draws(month,mode,numbers,pool,rollover_in,rollover_out,entrants,created) VALUES(?,?,?,?,?,?,?,?)', sim.month, sim.mode, sim.numbers, ctx.pool, ctx.rollover, result.rollover, JSON.stringify(ctx.entrants), now()).lastInsertRowid;
          for (const winner of result.winners) run('INSERT INTO winners(draw_id,user_id,matches,amount) VALUES(?,?,?,?,?)', id, winner.id, winner.matches, winner.amount);
          run('DELETE FROM simulations');
        });
      }
      else if (route === '/api/admin/winner') {
        const w = one('SELECT * FROM winners WHERE id=?', Number(body.id)); if (!w) fail('Winner not found.');
        if (w.status === 'paid') fail('This prize is already paid.');
        if (body.action === 'paid') { if (w.review !== 'approved') fail('Approve proof before recording a payout.'); run('UPDATE winners SET status=\'paid\' WHERE id=?', w.id); }
        else { if (!w.proof || !['approved', 'rejected'].includes(body.action)) fail('A proof upload is required.'); run('UPDATE winners SET review=? WHERE id=?', body.action, w.id); }
      } else fail('Not found.', 404);
    } else fail('Not found.', 404);
    send(200, { ok: true });
  } catch (e) { if (!e.status && !/Enter|Choose|date|score/.test(e.message)) console.error(e); send(e.status || 400, { error: e.status || /Enter|Choose|date|score/.test(e.message) ? e.message : 'Could not complete that request. Check your entries and try again.' }); }
});
server.listen(Number(process.env.PORT || 4173), process.env.HOST || '127.0.0.1', () => console.log(`Kindred Club is ready at http://127.0.0.1:${process.env.PORT || 4173}`));
