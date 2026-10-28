/**
 * LAX — Linked Agent eXchange
 * Jobs client tests, one block per acceptance item A1 to A7 of the job spec.
 * Run: npx tsx jobs.test.ts
 * Live read test runs only when LAX_LIVE=1.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createJobsClient, LaxJobsError } from './src/index.js';

const BASE = 'https://lax.kognai.ai/registry';
const DID = 'did:pkh:eip155:8453:0xb6e8a315ca639bca70bed7ff8c391b0cebdc0c58';
const PAYOUT = '0xB6E8A315CA639bcA70BeD7ff8c391b0cEbdC0c58';

type Call = { url: string; init: RequestInit & { body?: string } };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function recordingFetch(script: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return script(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('A1 listJobs, getJob and submit send the documented requests and return parsed answers', async () => {
  const { calls, fetchImpl } = recordingFetch((call) => {
    if (call.url === `${BASE}/jobs?track=seat&limit=2`) {
      return jsonResponse(200, { jobs: [{ id: 'j1', title: 'tracker seat' }], count: 1 });
    }
    if (call.url === `${BASE}/jobs/j%2F1`) {
      return jsonResponse(200, { job: { id: 'j/1', title: 'one job' } });
    }
    if (call.url === `${BASE}/jobs/j1/submissions`) {
      return jsonResponse(201, {
        submission: { id: 's1', job_id: 'j1', status: 'received', created_at: '2026-10-28T00:00:00Z' },
      });
    }
    throw new Error(`unexpected url ${call.url}`);
  });
  const client = createJobsClient({ fetch: fetchImpl, sleep: async () => {} });

  const list = await client.listJobs({ track: 'seat', limit: 2 });
  assert.equal(list.count, 1);
  assert.equal(list.jobs[0]?.id, 'j1');
  assert.equal(calls[0]?.init.method, 'GET');

  const job = await client.getJob('j/1');
  assert.equal(job.id, 'j/1');
  assert.match(calls[1]?.url ?? '', /\/jobs\/j%2F1$/);

  const submitted = await client.submit('j1', {
    builder: 'gamethao92',
    contact: 'https://github.com/gamethao92',
    repo_or_patch_url: 'https://github.com/gamethao92/lax',
    payout_address: PAYOUT,
    agent_did: DID,
    notes: 'jobs client approach',
  });
  assert.equal(submitted.job_id, 'j1');
  const post = calls[2];
  assert.equal(post?.init.method, 'POST');
  assert.equal((post?.init.headers as Record<string, string>)['content-type'], 'application/json');
  const body = JSON.parse(post?.init.body ?? '{}') as Record<string, unknown>;
  assert.equal(body.agent_did, DID);
  assert.equal(body.payout_address, PAYOUT);
  assert.equal(body.repo_or_patch_url, 'https://github.com/gamethao92/lax');
  assert.equal(body.notes, 'jobs client approach');
});

test('A2 400, 404 and 409 throw LaxJobsError after a single request', async () => {
  for (const [status, code] of [[400, 'bad_request'], [404, 'not_found'], [409, 'conflict']] as const) {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(status, { error: `registry says ${status}` }));
    const client = createJobsClient({ fetch: fetchImpl, sleep: async () => {} });
    await assert.rejects(
      () => client.getJob('missing'),
      (error: unknown) => {
        assert.ok(error instanceof LaxJobsError);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        assert.equal(error.message, `registry says ${status}`);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  }
});

test('A3 a 429 honours Retry-After and later succeeds; a lasting 429 ends rate_limited', async () => {
  {
    const { calls, fetchImpl } = recordingFetch((call, index) => {
      if (index === 0) return jsonResponse(429, { error: 'slow down' }, { 'retry-after': '1' });
      return jsonResponse(200, { jobs: [], count: 0 });
    });
    const sleeps: number[] = [];
    const client = createJobsClient({ fetch: fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
    const result = await client.listJobs();
    assert.equal(result.count, 0);
    assert.deepEqual(sleeps, [1000]);
    assert.equal(calls.length, 2);
  }
  {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(429, { error: 'still slow' }));
    const sleeps: number[] = [];
    const client = createJobsClient({ fetch: fetchImpl, retries: 2, sleep: async (ms) => { sleeps.push(ms); } });
    await assert.rejects(
      () => client.listJobs(),
      (error: unknown) => error instanceof LaxJobsError && error.code === 'rate_limited' && error.status === 429,
    );
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [500, 1000]);
  }
});

test('A4 5xx and network errors retry on reads only; submit is not retried on 5xx', async () => {
  {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(503, { error: 'maintenance' }));
    const client = createJobsClient({ fetch: fetchImpl, sleep: async () => {} });
    await assert.rejects(
      () => client.listJobs(),
      (error: unknown) => error instanceof LaxJobsError && error.code === 'server' && error.status === 503,
    );
    assert.equal(calls.length, 3);
  }
  {
    const { calls, fetchImpl } = recordingFetch(() => {
      throw new Error('socket closed');
    });
    const client = createJobsClient({ fetch: fetchImpl, sleep: async () => {} });
    await assert.rejects(
      () => client.getJob('j1'),
      (error: unknown) => error instanceof LaxJobsError && error.code === 'network' && error.status === 0,
    );
    assert.equal(calls.length, 3);
  }
  {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(500, { error: 'boom' }));
    const client = createJobsClient({ fetch: fetchImpl, sleep: async () => {} });
    await assert.rejects(
      () => client.submit('j1', {
        builder: 'gamethao92',
        contact: 'https://github.com/gamethao92',
        repo_or_patch_url: 'https://github.com/gamethao92/lax',
        payout_address: PAYOUT,
        agent_did: DID,
      }),
      (error: unknown) => error instanceof LaxJobsError && error.code === 'server',
    );
    assert.equal(calls.length, 1);
  }
});

test('A5 submit refuses a missing DID, a bad payout address and a non-https link before any request', async () => {
  const invalidInputs = [
    { agent_did: '' },
    { agent_did: 'pkh:not-a-did' },
    { payout_address: '0x1234' },
    { payout_address: `0x${'g'.repeat(40)}` },
    { repo_or_patch_url: 'http://example.com/repo' },
    { repo_or_patch_url: 'not a url' },
  ];
  for (const patch of invalidInputs) {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(201, { submission: {} }));
    const client = createJobsClient({ fetch: fetchImpl, sleep: async () => {} });
    await assert.rejects(
      () => client.submit('j1', {
        builder: 'gamethao92',
        contact: 'https://github.com/gamethao92',
        repo_or_patch_url: 'https://github.com/gamethao92/lax',
        payout_address: PAYOUT,
        agent_did: DID,
        ...patch,
      }),
      (error: unknown) => error instanceof LaxJobsError && error.code === 'invalid_input' && error.status === 0,
    );
    assert.equal(calls.length, 0);
  }
});

test('A6 the client stays silent and needs no runtime dependency', async () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  const deps = pkg.dependencies as Record<string, unknown> | undefined;
  assert.ok(deps === undefined || Object.keys(deps).length === 0, 'no runtime dependencies');
  const { fetchImpl } = recordingFetch(() => jsonResponse(200, { jobs: [], count: 0 }));
  const logged: unknown[][] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => { logged.push(args); };
  console.warn = (...args: unknown[]) => { logged.push(args); };
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const client = createJobsClient({ fetch: fetchImpl, sleep: async () => {} });
    await client.listJobs();
    await client.getJob;
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  assert.equal(logged.length, 0);
});

test('A7 live read of GET /jobs (LAX_LIVE=1)', { skip: process.env.LAX_LIVE !== '1' }, async () => {
  const client = createJobsClient();
  const result = await client.listJobs({ limit: 5 });
  assert.ok(Array.isArray(result.jobs));
  assert.ok(result.count >= result.jobs.length);
});
