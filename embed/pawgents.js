/*!
 * Pawgents embed — PROTOTYPE by Webpuppies. Throwaway code.
 *
 *   <script src="https://cyril-wp.github.io/pawgents-prototype/embed/pawgents.js"
 *           data-relay="https://pawgents-relay.example.workers.dev/js"></script>
 *
 * Put it as high in <head> as possible so it sees errors from the start. It catches what goes
 * wrong for real visitors (script errors, failed promises, failed requests, broken images and
 * scripts), removes secrets, groups repeats, and sends one report per problem to the Pawgents
 * relay, which asks the fixer agent for a tested draft pull request.
 *
 * Options (attributes on the script tag):
 *   data-relay="https://…/js"   where reports go. Without it nothing leaves the page (demo mode).
 *   data-site="client.sg"       site id the relay maps to a repo. Default: this page's host.
 *   data-release="2026.11.21"   deploy version, so the fixer looks at the right code.
 *   data-friendly="true"        show visitors a calm "we have been told" note when something breaks.
 *   data-panel="always"         show the owner panel to everyone (demos). Otherwise add ?pawgents.
 */
(function () {
  'use strict';
  if (window.Pawgents) return;

  var script = document.currentScript || {};
  var ds = script.dataset || {};
  var relay = ds.relay || '';
  var site = ds.site || location.host;
  var release = ds.release || '';
  var MAX_REPORTS = 10;
  var SECRET = [/\b(sk-[a-z0-9-]{20,})/gi, /\b(gh[po]_[a-z0-9]{30,})/gi, /\b(AKIA[0-9A-Z]{16})/g, /\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}/gi, /(password|passwd|pwd|secret|token|api[_-]?key|session)=([^&\s"']+)/gi, /[\w.+-]+@[\w-]+\.[\w.]+/g, /\b(?:\d[ -]?){13,19}\b/g];

  var events = [], byFp = {}, crumbs = [], listeners = [], sent = 0, friendlyShown = false;

  function scrub(s) {
    var n = 0, t = String(s == null ? '' : s);
    SECRET.forEach(function (re) { t = t.replace(re, function () { n++; return '[redacted]'; }); });
    return { text: t.slice(0, 2000), n: n };
  }
  function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return ('00000000' + h.toString(16)).slice(-8); }
  function pagePath(u) { try { var x = new URL(u, location.href); return x.origin + x.pathname; } catch (e) { return String(u).split('?')[0]; } }
  function crumb(type, text) { crumbs.push({ t: new Date().toISOString().slice(11, 19), type: type, text: scrub(text).text.slice(0, 120) }); if (crumbs.length > 12) crumbs.shift(); }

  function capture(kind, message, stack, source) {
    var m = scrub(message), st = scrub(stack);
    // Numbers and ids vary between occurrences of the same bug, so they are left out of the fingerprint.
    var fp = hash(site + '|' + kind + '|' + m.text.replace(/\d+/g, '#') + '|' + (source || '').replace(/:\d+:\d+$/, ''));
    var ev = byFp[fp];
    if (ev) { ev.count++; ev.lastSeen = new Date().toISOString(); emit(); return ev; }
    ev = byFp[fp] = {
      fingerprint: fp, kind: kind, site: site, release: release,
      message: m.text, stack: st.text, source: source || '', url: pagePath(location.href),
      firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), count: 1,
      breadcrumbs: crumbs.slice(), ua: navigator.userAgent, viewport: innerWidth + 'x' + innerHeight,
      redacted: m.n + st.n, delivery: relay ? 'sending' : 'demo mode: not sent',
    };
    events.push(ev);
    send(ev);
    friendly(kind);
    emit();
    return ev;
  }

  function send(ev) {
    if (!relay || sent >= MAX_REPORTS) { if (relay) ev.delivery = 'not sent: page limit reached'; return; }
    sent++;
    var body = JSON.stringify({ site: ev.site, kind: ev.kind, message: ev.message, stack: ev.stack, source: ev.source, url: ev.url, release: ev.release, breadcrumbs: ev.breadcrumbs, ua: ev.ua, fingerprint: ev.fingerprint });
    // text/plain keeps this a "simple" request: no CORS preflight, works with keepalive during page unload.
    origFetch(relay, { method: 'POST', body: body, keepalive: true, mode: 'cors', credentials: 'omit', headers: { 'content-type': 'text/plain' } })
      .then(function (r) { return r.text().then(function (t) { ev.delivery = 'relay ' + r.status + (t ? ': ' + t.slice(0, 80) : ''); }); })
      .catch(function () { ev.delivery = 'relay unreachable'; try { navigator.sendBeacon(relay, body); ev.delivery += ', retried by beacon'; } catch (e) { /* give up */ } })
      .then(emit);
  }

  function friendly(kind) {
    if (ds.friendly !== 'true' || friendlyShown || kind === 'resource') return;
    friendlyShown = true;
    var n = document.createElement('div');
    n.setAttribute('role', 'status');
    n.textContent = 'Sorry, that did not work. We have been told automatically and are fixing it.';
    n.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483645;max-width:min(92vw,440px);background:#151A26;color:#fff;font:500 14px/1.45 system-ui,sans-serif;padding:12px 16px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.25)';
    (document.body || document.documentElement).appendChild(n);
    setTimeout(function () { n.remove(); }, 6000);
  }

  // ---------------- capture ----------------
  addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName) {
      var u = t.src || t.href || '';
      if (u && u.indexOf(script.src) !== 0) capture('resource', 'Failed to load ' + t.tagName.toLowerCase() + ': ' + pagePath(u), '', pagePath(u));
      return;
    }
    var src = e.filename ? pagePath(e.filename) + ':' + e.lineno + ':' + e.colno : '';
    capture('js-error', e.message || 'Script error', e.error && e.error.stack, src);
  }, true);

  addEventListener('unhandledrejection', function (e) {
    var r = e.reason || {};
    capture('promise', 'Unhandled promise rejection: ' + (r.message || String(r)), r.stack, '');
  });

  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : input && input.url;
      var method = (init && init.method) || (input && input.method) || 'GET';
      if (relay && url && String(url).indexOf(relay) === 0) return origFetch(input, init);
      crumb('fetch', method + ' ' + pagePath(url));
      return origFetch(input, init).then(function (res) {
        var same = new URL(url, location.href).origin === location.origin;
        if (res.status >= 500 || (same && res.status >= 400)) capture('http', method + ' ' + pagePath(url) + ' answered ' + res.status, '', pagePath(url));
        return res;
      }, function (err) {
        capture('http', method + ' ' + pagePath(url) + ' failed: ' + (err && err.message), err && err.stack, pagePath(url));
        throw err;
      });
    };
  }

  addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('a,button,input,[role=button],[onclick]') : null;
    if (!el || el.closest('[data-pawgents]')) return;
    crumb('click', el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' "' + (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 40) + '"');
  }, true);
  ['pushState', 'replaceState'].forEach(function (k) {
    var o = history[k];
    history[k] = function () { var r = o.apply(this, arguments); crumb('navigate', pagePath(location.href)); return r; };
  });
  addEventListener('popstate', function () { crumb('navigate', pagePath(location.href)); });
  crumb('load', pagePath(location.href));

  function emit() { listeners.forEach(function (f) { try { f(events); } catch (e) { /* ignore */ } }); }

  window.Pawgents = {
    events: function () { return events.slice(); },
    capture: function (err) { return capture('manual', err && err.message || String(err), err && err.stack, ''); },
    onChange: function (f) { listeners.push(f); },
    relay: relay,
  };

  // ---------------- owner panel (only with ?pawgents or data-panel="always") ----------------
  var wantPanel = ds.panel === 'always' || /[?&#]pawgents\b/.test(location.search + location.hash);
  if (!wantPanel) return;

  var KIND = { 'js-error': 'Script error', promise: 'Failed promise', http: 'Failed request', resource: 'Broken file', manual: 'Reported' };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var host = document.createElement('div');
  host.setAttribute('data-pawgents', '');
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' +
    ':host{all:initial}*{box-sizing:border-box}' +
    '.w{--bg:#fff;--sunk:#F6F0EC;--ink:#1E1712;--muted:#6B5D53;--line:#E6DAD2;--brand:#B4440E;--onbrand:#fff;--good:#1D7349;--bad:#B42318;--badbg:#FDE7E4;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink)}' +
    '@media (prefers-color-scheme:dark){.w{--bg:#1B1612;--sunk:#251E19;--ink:#F1E9E3;--muted:#B3A398;--line:#3A2F27;--brand:#FF9B66;--onbrand:#1B1612;--good:#63C796;--bad:#FF8A7A;--badbg:#3A1512}}' +
    '.fab{position:fixed;bottom:max(20px,env(safe-area-inset-bottom));left:max(20px,env(safe-area-inset-left));z-index:2147483646;display:flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:10px 16px 10px 12px;background:var(--brand);color:var(--onbrand);font:600 14px system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(60,20,0,.28)}' +
    '.fab svg{width:20px;height:20px}.fab b{font-variant-numeric:tabular-nums}' +
    '.panel{position:fixed;bottom:max(80px,calc(env(safe-area-inset-bottom) + 80px));left:max(16px,env(safe-area-inset-left));z-index:2147483647;width:min(460px,calc(100vw - 32px));max-height:min(660px,calc(100vh - 110px));overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:16px;box-shadow:0 18px 50px rgba(30,10,0,.3)}' +
    '.head{position:sticky;top:0;background:var(--bg);padding:16px 16px 10px;border-bottom:1px solid var(--line);display:grid;gap:4px}' +
    '.head h2{margin:0;font-size:17px;color:var(--brand)}' +
    '.mono{font:12px ui-monospace,Menlo,monospace;color:var(--muted);overflow-wrap:anywhere}' +
    '.empty{padding:20px 16px;color:var(--muted)}' +
    '.list{list-style:none;margin:0;padding:12px 16px;display:grid;gap:10px}' +
    '.ev{border:1px solid var(--line);border-radius:12px;padding:10px 12px;display:grid;gap:6px}' +
    '.top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
    '.pill{font:700 10px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.05em;border-radius:999px;padding:2px 8px;background:var(--badbg);color:var(--bad)}' +
    '.count{font:600 12px ui-monospace,Menlo,monospace;color:var(--muted)}' +
    '.msg{font-weight:600;overflow-wrap:anywhere}' +
    'details{font-size:13px}summary{cursor:pointer;color:var(--muted)}' +
    'pre{margin:6px 0 0;background:var(--sunk);border-radius:8px;padding:8px 10px;overflow-x:auto;font:11.5px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word}' +
    '.ok{color:var(--good)}.no{color:var(--muted)}' +
    '.bar{display:flex;gap:8px;flex-wrap:wrap;padding:0 16px 16px}' +
    'button.b{font:600 13px system-ui,sans-serif;border-radius:8px;padding:7px 12px;border:1px solid var(--brand);background:none;color:var(--brand);cursor:pointer}' +
    '.foot{padding:0 16px 16px;color:var(--muted);font-size:11.5px}' +
    'button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}' +
    '</style><div class="w">' +
    '<button class="fab" type="button" aria-expanded="false" aria-controls="pg-panel"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><ellipse cx="6" cy="9" rx="2.1" ry="2.7"/><ellipse cx="10" cy="5.6" rx="2.1" ry="2.8"/><ellipse cx="14.2" cy="5.6" rx="2.1" ry="2.8"/><ellipse cx="18.2" cy="9" rx="2.1" ry="2.7"/><path d="M12 11c-3.3 0-6.2 3.6-6.2 6.4 0 1.8 1.4 2.6 3 2.6 1.3 0 2-.6 3.2-.6s1.9.6 3.2.6c1.6 0 3-.8 3-2.6C18.2 14.6 15.3 11 12 11z"/></svg><span>Pawgents <b class="n">0</b></span></button>' +
    '<div class="panel" id="pg-panel" role="dialog" aria-label="Pawgents: problems caught on this page" hidden>' +
    '<div class="head"><h2>Pawgents</h2><div class="mono site"></div><div class="mono dest"></div></div>' +
    '<div class="body"></div>' +
    '<div class="bar"><button class="b copy" type="button">Copy reports for the fixer</button></div>' +
    '<div class="foot">Prototype by Webpuppies. Only you see this panel. Secrets, emails and card numbers are removed before anything is sent. One report per problem; repeats are counted.</div>' +
    '</div></div>';

  var $ = function (s) { return root.querySelector(s); };
  $('.site').textContent = 'site ' + site + (release ? ' · release ' + release : '');
  $('.dest').innerHTML = relay ? '<span class="ok">Sending to relay</span> ' + esc(relay) : '<span class="no">No relay set. Demo mode: nothing leaves this page.</span>';

  function render() {
    $('.n').textContent = events.length;
    if (!events.length) { $('.body').innerHTML = '<p class="empty">Nothing has gone wrong on this page yet.</p>'; return; }
    $('.body').innerHTML = '<ul class="list">' + events.slice().reverse().map(function (e) {
      var sentJson = { site: e.site, kind: e.kind, message: e.message, source: e.source, url: e.url, fingerprint: e.fingerprint, breadcrumbs: e.breadcrumbs.length + ' steps' };
      return '<li class="ev"><div class="top"><span class="pill">' + (KIND[e.kind] || e.kind) + '</span><span class="count">×' + e.count + ' · ' + e.fingerprint + '</span></div>' +
        '<div class="msg">' + esc(e.message) + '</div>' +
        (e.source ? '<div class="mono">' + esc(e.source) + '</div>' : '') +
        '<div class="mono">' + esc(e.delivery) + (e.redacted ? ' · ' + e.redacted + ' secret' + (e.redacted > 1 ? 's' : '') + ' removed' : '') + '</div>' +
        '<details><summary>Steps before it broke (' + e.breadcrumbs.length + ')</summary><pre>' + esc(e.breadcrumbs.map(function (c) { return c.t + '  ' + c.type.padEnd(8) + ' ' + c.text; }).join('\n') || 'none') + '</pre></details>' +
        '<details><summary>What the relay receives</summary><pre>' + esc(JSON.stringify(sentJson, null, 2)) + '</pre></details></li>';
    }).join('') + '</ul>';
  }
  window.Pawgents.onChange(render);

  $('.fab').addEventListener('click', function () {
    var p = $('.panel'), open = p.hidden;
    p.hidden = !open; $('.fab').setAttribute('aria-expanded', String(open)); render();
  });
  $('.copy').addEventListener('click', function () {
    navigator.clipboard.writeText(JSON.stringify(events, null, 2)).then(function () { $('.copy').textContent = 'Copied'; }, function () { $('.copy').textContent = 'Copy blocked by browser'; });
  });

  function mount() { document.body.appendChild(host); render(); if (/[?&#]pawgents\b/.test(location.search + location.hash)) $('.fab').click(); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
