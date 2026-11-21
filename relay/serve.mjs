#!/usr/bin/env node
// PROTOTYPE — run the relay locally on http://localhost:8787 (same code as the Cloudflare Worker).
//
//   node relay/serve.mjs                       dry run: prints the GitHub dispatch it would send
//   GITHUB_TOKEN=$(gh auth token) \
//   PAWGENTS_REPO=owner/repo node relay/serve.mjs   really starts the fixer workflow in that repo
//
// Sites are mapped to the repo by host; the demo shop on localhost and on GitHub Pages both map to PAWGENTS_REPO.
import { createServer } from 'node:http';

import worker from './worker.js';

const PORT = Number(process.env.PORT || 8787);
const REPO = process.env.PAWGENTS_REPO || 'Cyril-WP/pawgents-prototype';
const kv = new Map();
const env = {
  PAWGENTS_SECRET: process.env.PAWGENTS_SECRET || 'local-dev-secret',
  SENTRY_CLIENT_SECRET: process.env.SENTRY_CLIENT_SECRET || 'local-dev-secret',
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  SITE_REPOS: process.env.SITE_REPOS || JSON.stringify({ 'localhost:8732': REPO, 'cyril-wp.github.io': REPO }),
  DEDUPE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) },
};

if (!env.GITHUB_TOKEN) {
  // Dry run: intercept only the GitHub call and print what would have been sent.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.github.com/')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    process.stdout.write(`\n[dry run] would POST ${url}\n${JSON.stringify(body, null, 2)}\n`);
    return new Response(null, { status: 204 });
  };
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const out = await worker.fetch(request, env);
  const text = await out.text();
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${req.method} ${req.url} ${out.status} ${text}\n`);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(text);
}).listen(PORT, () => {
  process.stdout.write(`Pawgents relay on http://localhost:${PORT} · ${env.GITHUB_TOKEN ? `dispatching to ${REPO}` : 'dry run (no GITHUB_TOKEN)'}\n`);
});
