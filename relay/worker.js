// PROTOTYPE — Pawgents relay, a Cloudflare Worker (or any fetch-handler runtime).
// Receives errors from three sources, normalises them, drops noise, and asks GitHub to run the
// fixer workflow in the right site repo.
//
//   POST /wp       from pawgents-watch.php (WordPress), header X-Pawgents-Signature: hex HMAC-SHA256(body)
//   POST /sentry   Sentry or GlitchTip issue-alert webhook, header Sentry-Hook-Signature (HMAC-SHA256)
//   POST /js       browser error beacon (no signature; rate-limited and only for known site origins)
//
// Env: PAWGENTS_SECRET, SENTRY_CLIENT_SECRET, GITHUB_TOKEN (fine-grained: actions+contents write on
// listed repos only), SITE_REPOS = JSON {"clientsite.sg":"webpuppies/clientsite"}, DEDUPE (KV namespace).
//
// Sentry payload nesting differs between alert types (`data.event` vs `data.issue`); confirm against a
// real delivery before trusting the field paths below.

const MAX = 4000;
const SECRET_PATTERNS = [/(sk-[a-z0-9-]{20,})/gi, /(ghp_[a-z0-9]{30,})/gi, /(AKIA[0-9A-Z]{16})/g, /(password|passwd|pwd|secret|token|api[_-]?key)=([^&\s"']+)/gi, /[\w.+-]+@[\w-]+\.[\w.]+/g];

const scrub = s => SECRET_PATTERNS.reduce((t, re) => t.replace(re, '[redacted]'), String(s ?? '')).slice(0, MAX);

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function sha1(s) {
  const h = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

// Every source becomes this one shape, which is what the fixer workflow reads.
async function normalise(source, b) {
  if (source === 'wp') {
    return { source, site: b.site, kind: 'php-fatal', title: b.message?.split('\n')[0], message: b.message, file: b.file, line: b.line, url: b.url, wp: b.wp, php: b.php, plugins: b.plugins };
  }
  if (source === 'sentry') {
    const ev = b.data?.event || b.data?.issue || {};
    const frames = ev.exception?.values?.[0]?.stacktrace?.frames || [];
    return { source, site: new URL(ev.request?.url || ev.url || 'https://unknown').host.replace(/^www\./, ''), kind: ev.platform || 'error', title: ev.title, message: ev.message || ev.title, stack: frames.slice(-12).map(f => `${f.filename}:${f.lineno} ${f.function || ''}`).join('\n'), url: ev.request?.url, issueUrl: ev.web_url, release: ev.release };
  }
  // From embed/pawgents.js. Breadcrumbs are the visitor's last steps, which the fixer uses to reproduce.
  const crumbs = Array.isArray(b.breadcrumbs) ? b.breadcrumbs.slice(-12).map(c => `${c.t} ${c.type} ${c.text}`).join('\n') : '';
  return { source: 'js', site: b.site, kind: b.kind || 'js-error', title: b.message, message: b.message, stack: b.stack, file: b.source, url: b.url, release: b.release, breadcrumbs: crumbs, userAgent: b.ua };
}

async function handle(req, env) {
  const path = new URL(req.url).pathname;
  const source = { '/wp': 'wp', '/sentry': 'sentry', '/js': 'js' }[path];
  if (req.method !== 'POST' || !source) return new Response('not found', { status: 404 });
  const body = await req.text();
  if (body.length > 64000) return new Response('too large', { status: 413 });

  if (source === 'wp' && !timingSafeEqual(req.headers.get('x-pawgents-signature') || '', await hmacHex(env.PAWGENTS_SECRET, body))) return new Response('bad signature', { status: 401 });
  if (source === 'sentry' && !timingSafeEqual(req.headers.get('sentry-hook-signature') || '', await hmacHex(env.SENTRY_CLIENT_SECRET, body))) return new Response('bad signature', { status: 401 });

  const repos = JSON.parse(env.SITE_REPOS || '{}');
  const raw = await normalise(source, JSON.parse(body));
  const repo = repos[raw.site];
  if (!repo) return new Response('unknown site', { status: 202 });
  if (source === 'js') {
    const host = (() => { try { return new URL(req.headers.get('origin')).host; } catch { return ''; } })();
    if (host !== raw.site && !host.endsWith(`.${raw.site}`)) return new Response('origin mismatch', { status: 403 });
  }

  const err = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? scrub(v) : v]));
  err.fingerprint = await sha1(`${err.site}|${err.kind}|${err.title}|${err.file || ''}:${err.line || ''}`);

  // Noise control: one fix attempt per fingerprint per 24 h; count repeats so the PR can say how often it happened.
  const seen = JSON.parse((await env.DEDUPE?.get(err.fingerprint)) || 'null');
  const count = (seen?.count || 0) + 1;
  await env.DEDUPE?.put(err.fingerprint, JSON.stringify({ count, firstSeen: seen?.firstSeen || new Date().toISOString() }), { expirationTtl: 86400 });
  if (seen) return new Response(`deduped (${count})`, { status: 202 });
  err.firstSeen = new Date().toISOString();

  const gh = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'pawgents-relay', 'content-type': 'application/json' },
    // GitHub allows at most 10 top-level keys in client_payload, so the report is nested.
    body: JSON.stringify({ event_type: 'pawgents-error', client_payload: { fingerprint: err.fingerprint, site: err.site, error: err } }),
  });
  // A failed dispatch must not block the next attempt for 24 h.
  if (!gh.ok) await env.DEDUPE?.delete(err.fingerprint);
  return new Response(gh.ok ? `dispatched ${err.fingerprint} to ${repo}` : `github ${gh.status}`, { status: gh.ok ? 202 : 502 });
}

export default {
  async fetch(req, env) {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const res = await handle(req, env);
    return new Response(res.body, { status: res.status, headers: cors });
  },
};
