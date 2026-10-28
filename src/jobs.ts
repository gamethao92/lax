/**
 * LAX — Linked Agent eXchange
 * Jobs client: list jobs, read one job and submit work to the registry.
 * TypeScript, fetch only, no runtime dependency.
 * @version 0.5.0
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A job published on the LAX registry. */
export interface LaxJob {
  id: string;
  title: string;
  track?: string | null;
  summary?: string | null;
  spec_md?: string | null;
  bounty_usdc?: number | string | null;
  currency?: string | null;
  chain?: string | null;
  skills?: string[] | null;
  deadline?: string | null;
  bid_closes?: string | null;
  status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  seat?: string | null;
  selection?: unknown;
  tests_url?: string | null;
  spec_url?: string | null;
  [key: string]: unknown;
}

/** Query parameters accepted by listJobs. */
export interface ListJobsParams {
  /** Only jobs on this track (seat, lax-agents, templates, ...). */
  track?: string;
  /** Page size, 1 to 100. */
  limit?: number;
  /** Offset into the list, zero or more. */
  offset?: number;
}

/** Answer of listJobs. */
export interface ListJobsResult {
  jobs: LaxJob[];
  count: number;
}

/** Input of submit; the registry requires all of these fields. */
export interface SubmitInput {
  builder: string;
  contact: string;
  repo_or_patch_url: string;
  payout_address: string;
  agent_did: string;
  notes?: string;
}

/** Answer of submit, taken out of the registry response. */
export interface SubmissionResult {
  id: string;
  job_id: string;
  status: string;
  created_at: string;
}

/** Options of createJobsClient. */
export interface JobsClientOptions {
  /** Registry base URL, default https://lax.kognai.ai/registry */
  baseUrl?: string;
  /** fetch implementation, default globalThis.fetch */
  fetch?: typeof fetch;
  /** Extra attempts after the first one, default 2 */
  retries?: number;
  /** sleep(ms) used between retries, default a timer */
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout in ms, default 15000; 0 disables it */
  timeoutMs?: number;
}

/** Error codes carried by LaxJobsError. */
export type LaxJobsErrorCode =
  | 'invalid_input'
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'invalid_response';

/** Jobs client returned by createJobsClient. */
export interface JobsClient {
  listJobs(params?: ListJobsParams): Promise<ListJobsResult>;
  getJob(id: string): Promise<LaxJob>;
  submit(jobId: string, input: SubmitInput): Promise<SubmissionResult>;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Error thrown by every jobs client call. */
export class LaxJobsError extends Error {
  /** HTTP status of the answer; 0 when there was no answer. */
  readonly status: number;
  /** Machine-readable reason. */
  readonly code: LaxJobsErrorCode;

  constructor(message: string, status: number, code: LaxJobsErrorCode) {
    super(message);
    this.name = 'LaxJobsError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://lax.kognai.ai/registry';
const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_S = 30;
const DID_PATTERN = /^did:[a-z0-9]+:.+/;
const PAYOUT_PATTERN = /^0x[0-9a-fA-F]{40}$/;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function invalidInput(message: string): never {
  throw new LaxJobsError(message, 0, 'invalid_input');
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function statusToCode(status: number): LaxJobsErrorCode {
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'bad_request';
}

function retryAfterMs(response: Response): number | null {
  const raw = typeof response.headers?.get === 'function'
    ? response.headers.get('retry-after')
    : null;
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_S) * 1000;
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt;
}

async function errorText(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`;
  let text = '';
  try {
    text = await response.text();
  } catch {
    return fallback;
  }
  if (!text) return fallback;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    if (typeof body.error === 'string' && body.error) return body.error;
    if (typeof body.message === 'string' && body.message) return body.message;
    return text.slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}

async function responseJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new LaxJobsError('could not read the response body', response.status, 'invalid_response');
  }
  if (!text) {
    throw new LaxJobsError('empty response body', response.status, 'invalid_response');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LaxJobsError('response body is not valid JSON', response.status, 'invalid_response');
  }
}

function asRecord(value: unknown, what: string, status: number): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LaxJobsError(`${what} is not a JSON object`, status, 'invalid_response');
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Create a jobs client for the LAX registry.
 *
 * Reads (listJobs, getJob) are retried on 429, 5xx and network errors; submit
 * is retried on 429 only. 400, 404 and 409 are never retried.
 */
export function createJobsClient(options: JobsClientOptions = {}): JobsClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl: typeof fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const retries = Math.max(0, Math.trunc(options.retries ?? DEFAULT_RETRIES));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call(url: string, init: RequestInit): Promise<Response> {
    if (!timeoutMs || timeoutMs <= 0) {
      return fetchImpl(url, init);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(
    path: string,
    init: RequestInit,
    retry5xx: boolean,
  ): Promise<{ response: Response; body: unknown }> {
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await call(baseUrl + path, init);
      } catch (error) {
        if (attempt < retries) {
          await sleep(backoffMs(attempt));
          attempt += 1;
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new LaxJobsError(`network error: ${reason}`, 0, 'network');
      }
      if (response.ok) {
        return { response, body: await responseJson(response) };
      }
      const status = response.status;
      if (status === 429 && attempt < retries) {
        const wait = retryAfterMs(response) ?? backoffMs(attempt);
        await sleep(wait);
        attempt += 1;
        continue;
      }
      if (status >= 500 && retry5xx && attempt < retries) {
        await sleep(backoffMs(attempt));
        attempt += 1;
        continue;
      }
      throw new LaxJobsError(await errorText(response), status, statusToCode(status));
    }
  }

  async function listJobs(params: ListJobsParams = {}): Promise<ListJobsResult> {
    const query = new URLSearchParams();
    if (params.track !== undefined) {
      if (typeof params.track !== 'string') invalidInput('track must be a string');
      query.set('track', params.track);
    }
    if (params.limit !== undefined) {
      if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100) {
        invalidInput('limit must be an integer from 1 to 100');
      }
      query.set('limit', String(params.limit));
    }
    if (params.offset !== undefined) {
      if (!Number.isInteger(params.offset) || params.offset < 0) {
        invalidInput('offset must be an integer zero or more');
      }
      query.set('offset', String(params.offset));
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const { response, body } = await request(
      `/jobs${suffix}`,
      { method: 'GET', headers: { accept: 'application/json' } },
      true,
    );
    const record = asRecord(body, 'jobs answer', response.status);
    if (!Array.isArray(record.jobs) || typeof record.count !== 'number') {
      throw new LaxJobsError('jobs answer misses jobs or count', response.status, 'invalid_response');
    }
    return { jobs: record.jobs as LaxJob[], count: record.count };
  }

  async function getJob(id: string): Promise<LaxJob> {
    if (typeof id !== 'string' || id.length === 0) invalidInput('job id is required');
    const { response, body } = await request(
      `/jobs/${encodeURIComponent(id)}`,
      { method: 'GET', headers: { accept: 'application/json' } },
      true,
    );
    const record = asRecord(body, 'job answer', response.status);
    if (typeof record.job !== 'object' || record.job === null) {
      throw new LaxJobsError('job answer misses job', response.status, 'invalid_response');
    }
    return record.job as LaxJob;
  }

  async function submit(jobId: string, input: SubmitInput): Promise<SubmissionResult> {
    if (typeof jobId !== 'string' || jobId.length === 0) invalidInput('job id is required');
    if (typeof input !== 'object' || input === null) invalidInput('submit input is required');
    if (typeof input.agent_did !== 'string' || !DID_PATTERN.test(input.agent_did)) {
      invalidInput('agent_did must be a DID of the form did:method:identifier');
    }
    if (typeof input.payout_address !== 'string' || !PAYOUT_PATTERN.test(input.payout_address)) {
      invalidInput('payout_address must be 0x followed by 40 hex characters');
    }
    if (typeof input.repo_or_patch_url !== 'string' || !isHttpsUrl(input.repo_or_patch_url)) {
      invalidInput('repo_or_patch_url must be an https URL');
    }
    if (input.notes !== undefined && typeof input.notes !== 'string') {
      invalidInput('notes must be a string');
    }
    const payload: Record<string, unknown> = {
      builder: input.builder,
      contact: input.contact,
      repo_or_patch_url: input.repo_or_patch_url,
      payout_address: input.payout_address,
      agent_did: input.agent_did,
    };
    if (input.notes !== undefined) payload.notes = input.notes;
    const { response, body } = await request(
      `/jobs/${encodeURIComponent(jobId)}/submissions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      },
      false,
    );
    const record = asRecord(body, 'submission answer', response.status);
    if (typeof record.submission !== 'object' || record.submission === null) {
      throw new LaxJobsError('submission answer misses submission', response.status, 'invalid_response');
    }
    return record.submission as SubmissionResult;
  }

  return { listJobs, getJob, submit };
}
