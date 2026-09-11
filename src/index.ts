interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * AI Model Experiments MCP ("Model Lab") — run the same prompts across many
 * AI models simultaneously and compare outputs, latency, and cost.
 *
 * PREPAID ONLY: every run costs real provider money (OpenRouter inference,
 * billed at 1.5× provider cost from the caller's Pipeworx credit balance).
 * Callers top up via x402 USDC (POST /credits/topup on the gateway) — see
 * experiment_topup for exact instructions.
 *
 * Async by design: experiment_create returns immediately with an id; the
 * experiment-runner worker executes cells within ~1 minute (cron). Agents
 * poll experiment_status, then read experiment_results. An optional
 * Fable-written summary compares the models' outputs when the run completes.
 *
 * State lives in Supabase (lab_experiments / lab_cells, migration 053);
 * the gateway injects _supabaseUrl/_supabaseKey (injectSupabase) plus
 * _accountId/_creditBalance/_internal for the prepaid gate.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'AI Model Experiments');
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const MARKUP = 1.5;
const FLOOR_USD = 0.1; // minimum charge per experiment
const CAPS = { prompts: 20, models: 12, reps: 5, cells: 240, maxSpendUsd: 100 };
const CREDIT_USD = 0.0001; // 1 credit = $0.0001 (shared/src/overage.ts)

const tools: McpToolExport['tools'] = [
  {
    name: 'experiment_models',
    description:
      'List AI models available for experiments (about 300 across Anthropic, OpenAI, Google, Meta, Mistral, DeepSeek, Qwen and more), with context window and OUR per-token prices (provider cost × 1.5 — what experiments actually bill). Filter by name/vendor search, minimum context, or max price. Use the returned model ids in experiment_create. Example: experiment_models({ search: "claude", min_context: 100000 })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Substring match on model id or name, e.g. "claude", "gpt", "llama"' },
        min_context: { type: 'number', description: 'Minimum context window in tokens' },
        max_price_per_mtok: { type: 'number', description: 'Max billed OUTPUT price in USD per million tokens' },
        limit: { type: 'number', description: 'Max models to return (default 30)' },
      },
      required: [],
    },
  },
  {
    name: 'experiment_estimate',
    description:
      'Dry-run cost estimate for an experiment BEFORE creating it — cell count and estimated billed cost range (at our 1.5× pricing) for prompts × models × reps. Free to call, no side effects, does not need credit balance. Same spec shape as experiment_create. Example: experiment_estimate({ prompts: ["Summarize: ..."], models: ["anthropic/claude-sonnet-4.5", "openai/gpt-5"], reps: 2 })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompts: { type: 'array', items: { type: 'string' }, description: 'Prompts to test (max 20)' },
        models: { type: 'array', items: { type: 'string' }, description: 'Model ids from experiment_models (max 12)' },
        reps: { type: 'number', description: 'Repetitions per prompt×model, 1-5 (default 1)' },
        params: { type: 'object', description: 'Optional {system, temperature, max_tokens}' },
        summary: { type: 'boolean', description: 'Include the AI-written comparison summary stage (default true)' },
      },
      required: ['prompts', 'models'],
    },
  },
  {
    name: 'experiment_create',
    description:
      'Model Lab: run one prompt across many AI models at once and compare their outputs, cost, and latency side by side. Create and start an experiment: run each prompt against each model (× reps), collecting output, tokens, latency, and billed cost per cell. PREPAID: requires Pipeworx credit balance ≥ max_spend_usd (top up via experiment_topup); bills actual provider cost × 1.5 with a $0.10 minimum per experiment. ASYNC: returns experiment_id immediately — execution starts within ~1 minute; poll experiment_status until complete, then call experiment_results. Do NOT wait synchronously. Set summary:false to skip the AI-written model-comparison summary. Example: experiment_create({ name: "tone test", prompts: ["Rewrite formally: ..."], models: ["anthropic/claude-haiku-4.5", "openai/gpt-5-mini"], reps: 2, max_spend_usd: 2 })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Short experiment name' },
        prompts: { type: 'array', items: { type: 'string' }, description: 'Prompts to test (max 20)' },
        models: { type: 'array', items: { type: 'string' }, description: 'Model ids from experiment_models (max 12)' },
        reps: { type: 'number', description: 'Repetitions per prompt×model for variance, 1-5 (default 1)' },
        params: { type: 'object', description: 'Optional {system, temperature, max_tokens (default 512)}' },
        summary: { type: 'boolean', description: 'AI-written comparison of the models\' outputs when the run completes (default true)' },
        max_spend_usd: { type: 'number', description: 'REQUIRED hard spend cap in USD for this experiment (max 100). Execution stops when reached.' },
      },
      required: ['prompts', 'models', 'max_spend_usd'],
    },
  },
  {
    name: 'experiment_status',
    description:
      'Progress of an experiment: cell counts by state (pending/running/ok/error/skipped), spend so far vs cap, and whether it is complete. Poll this after experiment_create (every few seconds). Example: experiment_status({ experiment_id: "..." })',
    inputSchema: {
      type: 'object' as const,
      properties: { experiment_id: { type: 'string', description: 'From experiment_create' } },
      required: ['experiment_id'],
    },
  },
  {
    name: 'experiment_results',
    description:
      'Results of an experiment: per-model aggregates (mean latency, tokens, total billed cost, error rate), per-cell outputs, and the AI-written summary comparing how the models differed (if enabled). Use include_outputs:false for aggregates only. Example: experiment_results({ experiment_id: "..." })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        experiment_id: { type: 'string', description: 'From experiment_create' },
        include_outputs: { type: 'boolean', description: 'Include full model outputs per cell (default true)' },
      },
      required: ['experiment_id'],
    },
  },
  {
    name: 'experiment_list',
    description: 'List your experiments, newest first, with status and spend. Example: experiment_list({ limit: 10 })',
    inputSchema: {
      type: 'object' as const,
      properties: { limit: { type: 'number', description: 'Max experiments (default 20)' } },
      required: [],
    },
  },
  {
    name: 'experiment_cancel',
    description:
      'Cancel a running experiment: pending cells are skipped (not billed); in-flight cells finish and bill. Example: experiment_cancel({ experiment_id: "..." })',
    inputSchema: {
      type: 'object' as const,
      properties: { experiment_id: { type: 'string', description: 'From experiment_create' } },
      required: ['experiment_id'],
    },
  },
  {
    name: 'experiment_topup',
    description:
      'How to add prepaid credits for experiments (and your current balance). Payment is x402 — USDC on Base, paid in-band by any wallet-equipped agent: POST https://gateway.pipeworx.io/credits/topup?amount_usd=10 responds HTTP 402 with payment requirements; retry with PAYMENT-SIGNATURE to settle and the credits land instantly. Example: experiment_topup({})',
    inputSchema: {
      type: 'object' as const,
      properties: { amount_usd: { type: 'number', description: 'Intended top-up amount in USD (1-500) — echoed into the instructions' } },
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------

interface Ctx {
  url: string;
  key: string;
  accountId: string;
  balanceCredits: number; // -1 = unknown (Redis fail-open)
  internal: boolean;
}

async function pg(ctx: Ctx, path: string, init?: RequestInit & { prefer?: string }): Promise<Response> {
  const res = await pwFetch(`${ctx.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ctx.key,
      Authorization: `Bearer ${ctx.key}`,
      'Content-Type': 'application/json',
      ...(init?.prefer ? { Prefer: init.prefer } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Model Lab storage error (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Model catalog (OpenRouter public /models, keyless) with 1.5× pricing.

interface ORModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string; request?: string };
}

let MODEL_CACHE: { at: number; models: ORModel[] } | null = null;

async function fetchModels(): Promise<ORModel[]> {
  if (MODEL_CACHE && Date.now() - MODEL_CACHE.at < 3_600_000) return MODEL_CACHE.models;
  const res = await pwFetch(OPENROUTER_MODELS_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Model catalog unavailable (OpenRouter HTTP ${res.status}) — retry shortly.`);
  const data = (await res.json()) as { data?: ORModel[] };
  MODEL_CACHE = { at: Date.now(), models: data.data ?? [] };
  return MODEL_CACHE.models;
}

function billedPerMtok(perTok: string | undefined): number {
  return Math.round((Number(perTok ?? 0) || 0) * 1_000_000 * MARKUP * 100) / 100;
}

async function listModels(args: Record<string, unknown>) {
  const models = await fetchModels();
  const q = String(args.search ?? '').toLowerCase();
  const minCtx = Number(args.min_context) || 0;
  const maxPrice = args.max_price_per_mtok != null ? Number(args.max_price_per_mtok) : Infinity;
  const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
  const out = models
    .filter(
      (m) =>
        (!q || m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q)) &&
        (m.context_length ?? 0) >= minCtx &&
        billedPerMtok(m.pricing?.completion) <= maxPrice,
    )
    .slice(0, limit)
    .map((m) => ({
      id: m.id,
      name: m.name,
      context: m.context_length,
      billed_input_per_mtok_usd: billedPerMtok(m.pricing?.prompt),
      billed_output_per_mtok_usd: billedPerMtok(m.pricing?.completion),
    }));
  return {
    count: out.length,
    pricing_note: 'Prices are what experiments bill: provider cost × 1.5, USD per million tokens. $0.10 minimum per experiment.',
    models: out,
  };
}

// ---------------------------------------------------------------------------
// Spec validation + estimation (shared by estimate and create).

interface Spec {
  prompts: string[];
  models: string[];
  reps: number;
  params: { system?: string; temperature?: number; max_tokens?: number };
  summary: boolean;
}

function parseSpec(args: Record<string, unknown>): Spec {
  const prompts = (Array.isArray(args.prompts) ? args.prompts : []).map(String).filter((p) => p.trim());
  const models = (Array.isArray(args.models) ? args.models : []).map(String).filter(Boolean);
  const reps = Math.min(Math.max(Math.round(Number(args.reps) || 1), 1), CAPS.reps);
  if (prompts.length === 0) throw new Error('At least one non-empty prompt is required.');
  if (models.length === 0) throw new Error('At least one model id is required — pick from experiment_models.');
  if (prompts.length > CAPS.prompts) throw new Error(`Too many prompts (${prompts.length} > ${CAPS.prompts}).`);
  if (models.length > CAPS.models) throw new Error(`Too many models (${models.length} > ${CAPS.models}).`);
  const cells = prompts.length * models.length * reps;
  if (cells > CAPS.cells) {
    throw new Error(`${cells} cells exceeds the ${CAPS.cells}-cell cap — reduce prompts, models, or reps.`);
  }
  const p = (args.params ?? {}) as Record<string, unknown>;
  return {
    prompts,
    models,
    reps,
    params: {
      system: p.system != null ? String(p.system) : undefined,
      temperature: p.temperature != null ? Number(p.temperature) : undefined,
      max_tokens: Math.min(Math.max(Number(p.max_tokens) || 512, 16), 8192),
    },
    summary: args.summary !== false,
  };
}

async function estimateSpec(spec: Spec) {
  const models = await fetchModels();
  const byId = new Map(models.map((m) => [m.id, m]));
  const unknown = spec.models.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown model id(s): ${unknown.join(', ')}. Use ids exactly as returned by experiment_models.`);
  }
  const cells = spec.prompts.length * spec.models.length * spec.reps;
  const estInTok = spec.prompts.reduce((s, p) => s + Math.ceil((p.length + (spec.params.system?.length ?? 0)) / 4), 0) / spec.prompts.length;
  let estUsd = 0;
  for (const id of spec.models) {
    const m = byId.get(id)!;
    const inCost = (Number(m.pricing?.prompt ?? 0) || 0) * estInTok;
    const outCost = (Number(m.pricing?.completion ?? 0) || 0) * (spec.params.max_tokens ?? 512);
    estUsd += (inCost + outCost) * spec.prompts.length * spec.reps;
  }
  estUsd *= MARKUP;
  // 4-decimal precision: cheap-model runs cost fractions of a cent and a
  // rounded "$0" estimate reads as free when it isn't.
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  return {
    cells,
    estimated_billed_usd: r4(estUsd),
    // Output length is the wild card — models rarely use the full max_tokens.
    estimated_range_usd: [r4(estUsd * 0.25), r4(estUsd)],
    minimum_charge_usd: FLOOR_USD,
    note: 'Upper bound assumes every response hits max_tokens; typical spend lands well below it. Actual billing is measured provider cost × 1.5.',
  };
}

// ---------------------------------------------------------------------------

async function createExperiment(ctx: Ctx, args: Record<string, unknown>) {
  const spec = parseSpec(args);
  const maxSpendUsd = Number(args.max_spend_usd);
  if (!Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0) {
    throw new Error('max_spend_usd is required — a hard USD spend cap for this experiment (e.g. 2).');
  }
  if (maxSpendUsd > CAPS.maxSpendUsd) throw new Error(`max_spend_usd exceeds the $${CAPS.maxSpendUsd} per-experiment cap.`);
  if (maxSpendUsd < FLOOR_USD) throw new Error(`max_spend_usd must be at least the $${FLOOR_USD} minimum charge.`);

  const est = await estimateSpec(spec);

  // Prepaid gate: balance must cover the cap. -1 = Redis unknown (fail-open
  // for internal only; paying callers must have a readable balance).
  const needCredits = Math.ceil(maxSpendUsd / CREDIT_USD);
  if (!ctx.internal) {
    if (ctx.balanceCredits < 0) {
      throw new Error('Credit balance is temporarily unreadable — retry in a few seconds.');
    }
    if (ctx.balanceCredits < needCredits) {
      const haveUsd = (ctx.balanceCredits * CREDIT_USD).toFixed(2);
      throw new Error(
        `Insufficient prepaid balance: experiments require balance ≥ max_spend_usd. You have $${haveUsd}, this experiment caps at $${maxSpendUsd.toFixed(2)}. Top up via x402: POST https://gateway.pipeworx.io/credits/topup?amount_usd=${Math.ceil(maxSpendUsd)} (see experiment_topup for the flow).`,
      );
    }
  }

  const insert = await pg(ctx, 'lab_experiments', {
    method: 'POST',
    prefer: 'return=representation',
    body: JSON.stringify({
      account_id: ctx.accountId,
      name: args.name != null ? String(args.name).slice(0, 120) : null,
      spec,
      max_spend_cents: Math.round(maxSpendUsd * 100),
      is_internal: ctx.internal,
    }),
  });
  const [exp] = (await insert.json()) as Array<{ id: string }>;

  const cells: Array<Record<string, unknown>> = [];
  for (let pi = 0; pi < spec.prompts.length; pi++) {
    for (const model of spec.models) {
      for (let rep = 0; rep < spec.reps; rep++) {
        cells.push({ experiment_id: exp.id, prompt_idx: pi, model, rep, kind: 'run' });
      }
    }
  }
  // ≤240 rows — safely inside PostgREST statement-timeout bounds in one insert.
  await pg(ctx, 'lab_cells', { method: 'POST', body: JSON.stringify(cells) });

  return {
    experiment_id: exp.id,
    status: 'running',
    cells: cells.length,
    estimate: est,
    max_spend_usd: maxSpendUsd,
    next: 'Execution starts within ~1 minute. Poll experiment_status({experiment_id}) until status is complete, then call experiment_results. Do not block waiting.',
  };
}

async function getExperiment(ctx: Ctx, id: string) {
  const res = await pg(ctx, `lab_experiments?id=eq.${encodeURIComponent(id)}&select=*`);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  const exp = rows[0];
  if (!exp) throw new Error(`No experiment ${id}.`);
  if (!ctx.internal && exp.account_id !== ctx.accountId) throw new Error(`No experiment ${id} on your account.`);
  return exp;
}

async function statusTool(ctx: Ctx, args: Record<string, unknown>) {
  const id = String(args.experiment_id ?? '');
  const exp = await getExperiment(ctx, id);
  const res = await pg(ctx, `lab_cells?experiment_id=eq.${encodeURIComponent(id)}&select=status,kind`);
  const cells = (await res.json()) as Array<{ status: string; kind: string }>;
  const by: Record<string, number> = {};
  for (const c of cells) by[c.status] = (by[c.status] ?? 0) + 1;
  const done = (by.ok ?? 0) + (by.error ?? 0) + (by.skipped ?? 0);
  return {
    experiment_id: id,
    status: exp.status,
    cells_total: cells.length,
    cells_by_state: by,
    progress: cells.length > 0 ? Math.round((done / cells.length) * 100) / 100 : 0,
    spent_usd: Math.round(Number(exp.spent_cents ?? 0)) / 100,
    max_spend_usd: Number(exp.max_spend_cents) / 100,
    summary_pending: exp.status === 'running' && (exp.spec as Spec | null)?.summary !== false,
    complete: exp.status !== 'running',
  };
}

async function resultsTool(ctx: Ctx, args: Record<string, unknown>) {
  const id = String(args.experiment_id ?? '');
  const includeOutputs = args.include_outputs !== false;
  const exp = await getExperiment(ctx, id);
  const spec = exp.spec as Spec;
  const res = await pg(
    ctx,
    `lab_cells?experiment_id=eq.${encodeURIComponent(id)}&kind=eq.run&select=prompt_idx,model,rep,status,output,error,tokens_in,tokens_out,latency_ms,billed_cents&order=prompt_idx,model,rep`,
  );
  const cells = (await res.json()) as Array<Record<string, unknown>>;

  const agg = new Map<string, { n: number; ok: number; latency: number; tokensOut: number; billed: number }>();
  for (const c of cells) {
    const a = agg.get(String(c.model)) ?? { n: 0, ok: 0, latency: 0, tokensOut: 0, billed: 0 };
    a.n++;
    if (c.status === 'ok') {
      a.ok++;
      a.latency += Number(c.latency_ms ?? 0);
      a.tokensOut += Number(c.tokens_out ?? 0);
    }
    a.billed += Number(c.billed_cents ?? 0);
    agg.set(String(c.model), a);
  }

  return {
    experiment_id: id,
    name: exp.name,
    status: exp.status,
    spent_usd: Math.round(Number(exp.spent_cents ?? 0)) / 100,
    summary: exp.summary ?? (exp.status === 'running' ? '(pending — run still in progress)' : undefined),
    summary_model: exp.summary_model ?? undefined,
    per_model: [...agg.entries()].map(([model, a]) => ({
      model,
      cells: a.n,
      ok: a.ok,
      error_rate: a.n > 0 ? Math.round(((a.n - a.ok) / a.n) * 100) / 100 : 0,
      mean_latency_ms: a.ok > 0 ? Math.round(a.latency / a.ok) : null,
      mean_output_tokens: a.ok > 0 ? Math.round(a.tokensOut / a.ok) : null,
      billed_usd: Math.round(a.billed) / 100,
    })),
    prompts: spec.prompts,
    cells: includeOutputs
      ? cells.map((c) => ({
          prompt_idx: c.prompt_idx,
          model: c.model,
          rep: c.rep,
          status: c.status,
          output: c.output,
          error: c.error ?? undefined,
          tokens_in: c.tokens_in,
          tokens_out: c.tokens_out,
          latency_ms: c.latency_ms,
          billed_usd: c.billed_cents != null ? Math.round(Number(c.billed_cents)) / 100 : null,
        }))
      : undefined,
  };
}

async function listTool(ctx: Ctx, args: Record<string, unknown>) {
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  const res = await pg(
    ctx,
    `lab_experiments?account_id=eq.${encodeURIComponent(ctx.accountId)}&select=id,name,status,spent_cents,max_spend_cents,created_at,completed_at&order=created_at.desc&limit=${limit}`,
  );
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return {
    count: rows.length,
    experiments: rows.map((r) => ({
      experiment_id: r.id,
      name: r.name,
      status: r.status,
      spent_usd: Math.round(Number(r.spent_cents ?? 0)) / 100,
      max_spend_usd: Number(r.max_spend_cents) / 100,
      created_at: r.created_at,
      completed_at: r.completed_at,
    })),
  };
}

async function cancelTool(ctx: Ctx, args: Record<string, unknown>) {
  const id = String(args.experiment_id ?? '');
  await getExperiment(ctx, id);
  await pg(ctx, `lab_cells?experiment_id=eq.${encodeURIComponent(id)}&status=eq.pending`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'skipped' }),
  });
  await pg(ctx, `lab_experiments?id=eq.${encodeURIComponent(id)}&status=eq.running`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'cancelled', completed_at: new Date().toISOString() }),
  });
  return {
    experiment_id: id,
    status: 'cancelled',
    note: 'Pending cells skipped (not billed). Cells already in flight finish and bill. Results so far remain readable via experiment_results.',
  };
}

function topupTool(ctx: Ctx, args: Record<string, unknown>) {
  const amount = Math.min(Math.max(Number(args.amount_usd) || 10, 1), 500);
  return {
    balance_usd: ctx.balanceCredits >= 0 ? Math.round(ctx.balanceCredits * CREDIT_USD * 100) / 100 : null,
    how_to_topup: {
      protocol: 'x402 (USDC on Base, in-band HTTP 402 payment)',
      step1: `POST https://gateway.pipeworx.io/credits/topup?amount_usd=${amount} — the response is HTTP 402 with a PAYMENT-REQUIRED header (base64 payment requirements).`,
      step2: 'Sign the USDC transfer with your wallet and retry the same request with a PAYMENT-SIGNATURE header.',
      step3: 'On settlement the credits land on your account instantly (1 credit = $0.0001) and the response confirms your new balance.',
      note: 'Send your usual Authorization bearer token so credits attach to your Pipeworx account; without one they attach to your paying wallet address.',
    },
    pricing: 'Experiments bill actual provider cost × 1.5, $0.10 minimum per experiment. Balance must cover max_spend_usd at create time.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  if (!url || !key) throw new Error('ai-model-experiments is not configured on this deployment — an operator must enable its data credentials. This is a setup problem, not your arguments.');
  const ctx: Ctx = {
    url,
    key,
    accountId: String(args._accountId ?? '').trim() || 'anonymous',
    balanceCredits: typeof args._creditBalance === 'number' ? args._creditBalance : -1,
    internal: args._internal === true,
  };

  switch (name) {
    case 'experiment_models':
      return listModels(args);
    case 'experiment_estimate':
      return estimateSpec(parseSpec(args));
    case 'experiment_create':
      return createExperiment(ctx, args);
    case 'experiment_status':
      return statusTool(ctx, args);
    case 'experiment_results':
      return resultsTool(ctx, args);
    case 'experiment_list':
      return listTool(ctx, args);
    case 'experiment_cancel':
      return cancelTool(ctx, args);
    case 'experiment_topup':
      return topupTool(ctx, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
