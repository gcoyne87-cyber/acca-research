// batch-runner.js — Message Batches support shared by the goingtrip and
// trainer-history engines.
//
//   submitBatch(requests, meta)  -> POST /v1/messages/batches; stores the job
//                                   at batch:job:{engine}:{batchId}
//   collectBatch(batchId, adapter) -> polls; when ended, streams the results
//                                   file and hands EVERY succeeded result to
//                                   adapter.finish(customId, text, usage,
//                                   stopReason) — the engine's own
//                                   validate-then-store function, the SAME one
//                                   its live loop calls. Validation failures
//                                   are retried live inside that function.
//
// The batch path therefore owns only transport and bookkeeping; what counts
// as valid, what gets stored and with which fields is decided in one place
// per engine (finishGoingTrip / finishTrainer in the runners).
//
// Collection is resumable: processed custom_ids are recorded in the job key,
// so a collect that runs out of time can be called again and carries on.

const https = require('https');
const E = require('../text-engine-submit-background.js').helpers;

// Batch API = 50% of the standard per-token rates.
const BATCH_PRICE = { input: 1.5, output: 7.5, cacheWrite: 1.875, cacheRead: 0.15 };
const EMPTY = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
function add(a, b) { return { input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead }; }
function usageFrom(msg) { const u = (msg && msg.usage) || {}; return { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 }; }
function costOf(u, price) { const p = price || BATCH_PRICE; return +((u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6).toFixed(4); }
function jobKey(engine, batchId) { return 'batch:job:' + engine + ':' + batchId; }

// Results file: a full URL on api.anthropic.com, fetched with the same auth
// headers as every other call. Returns the raw JSONL text.
function fetchResults(url) {
  return new Promise(function(resolve, reject) {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }, function(res) {
      let d = ''; res.on('data', function(c) { d += c; }); res.on('end', function() { if (res.statusCode !== 200) return reject(new Error('results fetch HTTP ' + res.statusCode + ' ' + d.slice(0, 200))); resolve(d); });
    });
    req.on('error', reject); req.setTimeout(300000, function() { req.destroy(); reject(new Error('results fetch timeout')); }); req.end();
  });
}

// submitBatch(requests, meta)
//   requests: [{ custom_id, params: { model, max_tokens, system, messages } }]
//   meta: { engine, dates, horses: {custom_id -> horse}, costCap, extra... }
// Returns { batchId, job } or throws on an API error.
async function submitBatch(requests, meta) {
  if (!requests.length) throw new Error('submitBatch: no requests');
  const resp = await E.anthropic('POST', '/v1/messages/batches', { requests: requests });
  if (resp.status !== 200 || !resp.json || !resp.json.id) throw new Error('batch submit HTTP ' + resp.status + ' ' + (resp.raw || '').slice(0, 300));
  const batchId = resp.json.id;
  const job = Object.assign({}, meta, { batchId: batchId, submittedAt: new Date().toISOString(), horseCount: requests.length, status: 'submitted', processing_status: resp.json.processing_status, request_counts: resp.json.request_counts || null, done: {}, counts: { stored: 0, retried: 0, failed: 0, errored: 0, skipped: 0 }, usage: EMPTY, costUSD: 0 });
  await E.redisSet(jobKey(meta.engine, batchId), job);
  return { batchId: batchId, job: job };
}

// collectBatch(batchId, adapter, opts)
//   adapter.engine            — job key namespace
//   adapter.finish(customId, text, usage, stopReason, job) -> result record
//       { stored, skipped, validateFailed, error, usage (live retry usage) }
//   opts.budgetMs             — stop and persist progress before this elapses
// Returns { status: 'in_progress' | 'partial' | 'complete', job }
async function collectBatch(batchId, adapter, opts) {
  const key = jobKey(adapter.engine, batchId);
  const job = await E.redisGet(key);
  if (!job) throw new Error('no job record at ' + key);
  const started = Date.now(); const budget = (opts && opts.budgetMs) || 700000;
  const status = await E.anthropic('GET', '/v1/messages/batches/' + batchId);
  if (status.status !== 200 || !status.json) throw new Error('batch status HTTP ' + status.status + ' ' + (status.raw || '').slice(0, 200));
  job.processing_status = status.json.processing_status; job.request_counts = status.json.request_counts || job.request_counts;
  if (status.json.processing_status !== 'ended') { job.status = 'in_progress'; job.lastPoll = new Date().toISOString(); await E.redisSet(key, job); return { status: 'in_progress', job: job }; }
  const jsonl = await fetchResults(status.json.results_url);
  const lines = jsonl.split('\n').filter(Boolean);
  const items = []; lines.forEach(function(l) { try { items.push(JSON.parse(l)); } catch (e) {} });
  job.done = job.done || {}; job.results = job.results || [];
  const pending = items.filter(function(it) { return it && it.custom_id && !job.done[it.custom_id]; });
  let timedOut = false;
  const CONC = (opts && opts.concurrency) || 8;
  async function one(it) {
    const id = it.custom_id;
    let rec;
    if (!it.result || it.result.type !== 'succeeded') {
      rec = { horse_id: id, stored: false, error: 'batch result ' + ((it.result && it.result.type) || 'missing') + ((it.result && it.result.error && it.result.error.message) ? ': ' + it.result.error.message : ''), usage: EMPTY };
      job.counts.errored++;
    } else {
      const msg = it.result.message; const text = (msg.content || []).map(function(c) { return c.text || ''; }).join('');
      const u = usageFrom(msg); job.usage = add(job.usage, u);
      try { rec = await adapter.finish(id, text, u, msg.stop_reason, job); } catch (e) { rec = { horse_id: id, stored: false, error: e.message, usage: EMPTY }; }
      if (rec.skipped) job.counts.skipped++; else if (rec.stored) { job.counts.stored++; if (rec.attempt > 1) job.counts.retried++; } else { job.counts.failed++; if (rec.attempt > 1) job.counts.retried++; }
      // finish() reports first+retry usage; the first reply's usage is the
      // batch result already counted above, so only the excess is the LIVE
      // retry, billed at standard rates and kept separately.
      if (rec.usage) { const extra = { input: Math.max(0, rec.usage.input - u.input), output: Math.max(0, rec.usage.output - u.output), cacheWrite: Math.max(0, rec.usage.cacheWrite - u.cacheWrite), cacheRead: Math.max(0, rec.usage.cacheRead - u.cacheRead) }; if (extra.input || extra.output) job.liveRetryUsage = add(job.liveRetryUsage || EMPTY, extra); }
    }
    job.done[id] = true; job.results.push(rec);
  }
  let i = 0;
  async function worker() { while (i < pending.length) { if (Date.now() - started > budget) { timedOut = true; return; } await one(pending[i++]); } }
  await Promise.all(Array.from({ length: CONC }, worker));
  job.costUSD = costOf(job.usage, BATCH_PRICE);
  job.liveRetryCostUSD = costOf(job.liveRetryUsage || EMPTY, { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 });
  job.totalCostUSD = +(job.costUSD + job.liveRetryCostUSD).toFixed(4);
  job.status = timedOut ? 'partial' : 'complete'; job.collectedAt = new Date().toISOString(); job.remaining = pending.length - Object.keys(job.done).filter(function(id) { return pending.some(function(p) { return p.custom_id === id; }); }).length;
  await E.redisSet(key, job);
  return { status: job.status, job: job };
}

module.exports = { submitBatch: submitBatch, collectBatch: collectBatch, BATCH_PRICE: BATCH_PRICE, costOf: costOf, jobKey: jobKey, usageFrom: usageFrom };
