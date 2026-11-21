// PROTOTYPE smoke run: node pawgents/relay/smoke.mjs — exercises the relay with a fake GitHub and fake KV.
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker from './worker.js';

const kv = new Map();
const env = { PAWGENTS_SECRET: 's3cret', SENTRY_CLIENT_SECRET: 'x', SITE_REPOS: JSON.stringify({ 'clientsite.sg': 'webpuppies/clientsite' }), GITHUB_TOKEN: 'fake', DEDUPE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) } };
const sent = [];
globalThis.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); };

const post = (path, body, headers = {}) => worker.fetch(new Request(`https://relay.test${path}`, { method: 'POST', body, headers }), env);
const wp = readFileSync(new URL('../fixtures/wp-fatal.json', import.meta.url), 'utf8');
const sig = createHmac('sha256', 's3cret').update(wp).digest('hex');

const show = async (label, res) => console.log(label.padEnd(22), res.status, await res.text());
await show('wp, bad signature', await post('/wp', wp, { 'x-pawgents-signature': 'nope' }));
await show('wp, signed', await post('/wp', wp, { 'x-pawgents-signature': sig }));
await show('wp, same error again', await post('/wp', wp, { 'x-pawgents-signature': sig }));
await show('js, wrong origin', await post('/js', readFileSync(new URL('../fixtures/js-error.json', import.meta.url), 'utf8'), { origin: 'https://evil.example' }));
await show('js, right origin', await post('/js', readFileSync(new URL('../fixtures/js-error.json', import.meta.url), 'utf8'), { origin: 'https://clientsite.sg' }));
console.log('\ndispatches sent to GitHub:', sent.length);
for (const s of sent) console.log(' ', s.url, s.body.event_type, s.body.client_payload.fingerprint, '|', s.body.client_payload.title);
