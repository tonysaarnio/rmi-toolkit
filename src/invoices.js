import { runApex, extractDebugLines, query, isTransientTransportError } from './org.js';

// Invoicing resources were introduced at v62.0 (billingScheduleIds) — this is a
// floor, not a preference. Pinned to the version the target orgs run.
const API_VERSION = process.env.RMI_API_VERSION || 'v68.0';

const POLL_INTERVAL_MS = 5000;
const BILLING_SCHEDULE_TIMEOUT_MS = 180000;
const INVOICE_TIMEOUT_MS = 180000;

// A billing schedule count has to hold still for this many consecutive polls
// before we invoice. Activation writes one schedule per billable slot and they
// land progressively, so the first non-empty read is not the whole set.
const STABLE_POLLS = 2;

// Documented platform cap on one `generate` call. Past this, Salesforce's answer
// is the Invoice Scheduler, which selects by filter criteria instead of by id —
// the wrong shape for invoicing one specific order, hence a hard error here
// rather than silently invoicing the first 200.
const MAX_SCHEDULES_PER_GENERATE = 200;

// Terminal-state picklists. 'Split *' variants appear when an invoice is split
// across legal entities; they are the same outcomes under a different label.
const BILLING_SCHEDULE_READY = new Set(['ReadyForInvoicing', 'CompletelyBilled']);
const INVOICE_FAIL = new Set(['Error', 'Split Error']);
const INVOICE_DRAFT_OK = new Set(['Draft', 'Split Draft']);
const INVOICE_POSTED_OK = new Set(['Posted', 'Split Posted']);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Wait for the BillingSchedule rows that activation generates for this order.
 *
 * Activation is the billing trigger: setting Order.Status = 'Activated' fires
 * the Order-to-Billing-Schedule flow, which runs asynchronously after commit —
 * so schedules appear seconds later, never read-after-write. Only the schedules
 * it produces can be invoiced.
 *
 * Correlation is BillingSchedule.ReferenceEntityId = orderId. 'Error' is
 * terminal; we wait for the ready count to stabilize rather than returning on
 * the first row, so a multi-line or bundle order isn't invoiced piecemeal.
 *
 * Returns `{ Id, NextBillingDate }` rows — the caller needs the date to decide
 * which schedules are billable (see `billableAsOf`).
 */
async function waitForBillingSchedules(orderId, timeoutMs = BILLING_SCHEDULE_TIMEOUT_MS) {
  const soql = `SELECT Id, Status, NextBillingDate FROM BillingSchedule WHERE ReferenceEntityId = '${orderId}'`;
  const deadline = Date.now() + timeoutMs;
  let lastCount = -1;
  let stable = 0;

  while (Date.now() < deadline) {
    const rows = query(soql);
    const errored = rows.filter(r => r.Status === 'Error').map(r => r.Id);
    if (errored.length) {
      throw new Error(`BillingSchedule in Error: ${errored.join(', ')}`);
    }
    const ready = rows.filter(r => BILLING_SCHEDULE_READY.has(r.Status));
    if (ready.length > 0 && ready.length === lastCount) {
      if (++stable >= STABLE_POLLS) return ready;
    } else {
      stable = 1;
    }
    lastCount = ready.length;
    await sleep(POLL_INTERVAL_MS);
  }

  const hint = lastCount <= 0
    ? ' — no billing schedules were generated at all, which usually means the org\'s billing engine is not configured (billing policies/treatments, or the Order-to-Billing-Schedule flow is inactive)'
    : '';
  throw new Error(
    `no stable set of ready BillingSchedules for order ${orderId} within ${Math.round(timeoutMs / 1000)}s${hint}`
  );
}

/**
 * Keep only the schedules that are actually billable by `targetDate`.
 *
 * `generate` applies a filter on its own and rejects the ENTIRE call —
 * INVALID_API_INPUT, "don't meet the filter criteria for invoice creation" — if
 * even one submitted schedule falls outside it. One order legitimately mixes
 * dates: a bundle's one-time lines bill on the order date while its subscription
 * lines bill from their own start, so passing every schedule blindly fails the
 * whole order over a line that simply isn't due yet.
 */
function billableAsOf(schedules, targetDate) {
  return schedules.filter(s => !s.NextBillingDate || String(s.NextBillingDate).slice(0, 10) <= targetDate);
}

/**
 * Generate a Draft invoice from the given billing schedules.
 * Apex-hosted REST callout, same transport as the Quote→Order conversion step.
 */
function buildGenerateInvoiceApex(scheduleIds, invoiceDate, targetDate, marker) {
  const idList = scheduleIds.map(id => `"${id}"`).join(',');
  return `
try {
  String endpoint = URL.getOrgDomainUrl().toExternalForm()
    + '/services/data/${API_VERSION}/commerce/invoicing/invoices/collection/actions/generate';
  HttpRequest req = new HttpRequest();
  req.setEndpoint(endpoint);
  req.setMethod('POST');
  req.setHeader('Content-Type', 'application/json');
  req.setHeader('Authorization', 'Bearer ' + UserInfo.getSessionId());
  req.setTimeout(120000);
  req.setBody('{"billingScheduleIds":[${idList}],"action":"Draft","invoiceDate":"${invoiceDate}","targetDate":"${targetDate}","correlationId":"${marker}"}');
  HttpResponse res = new Http().send(req);
  if (res.getStatusCode() >= 200 && res.getStatusCode() < 300) {
    Map<String,Object> body = (Map<String,Object>) JSON.deserializeUntyped(res.getBody());
    if (body.get('success') == true) {
      System.debug('INVOICE_GEN_SUCCESS|' + String.valueOf(body.get('requestIdentifier')));
    } else {
      System.debug('INVOICE_GEN_FAILED|' + String.valueOf(body.get('errors')));
    }
  } else {
    System.debug('INVOICE_GEN_FAILED|HTTP ' + res.getStatusCode() + ': ' + res.getBody());
  }
} catch (Exception e) {
  System.debug('INVOICE_GEN_FAILED|' + e.getTypeName() + ': ' + e.getMessage());
}
`;
}

/** Post a Draft invoice. Assigns the InvoiceNumber, which is null until now. */
function buildPostInvoiceApex(invoiceId, marker) {
  return `
try {
  String endpoint = URL.getOrgDomainUrl().toExternalForm()
    + '/services/data/${API_VERSION}/commerce/invoicing/invoices/collection/actions/post';
  HttpRequest req = new HttpRequest();
  req.setEndpoint(endpoint);
  req.setMethod('POST');
  req.setHeader('Content-Type', 'application/json');
  req.setHeader('Authorization', 'Bearer ' + UserInfo.getSessionId());
  req.setTimeout(120000);
  req.setBody('{"invoiceIds":["${invoiceId}"],"correlationId":"${marker}"}');
  HttpResponse res = new Http().send(req);
  if (res.getStatusCode() >= 200 && res.getStatusCode() < 300) {
    Map<String,Object> body = (Map<String,Object>) JSON.deserializeUntyped(res.getBody());
    if (body.get('success') == true) {
      System.debug('INVOICE_POST_SUCCESS|${invoiceId}');
    } else {
      System.debug('INVOICE_POST_FAILED|' + String.valueOf(body.get('errors')));
    }
  } else {
    System.debug('INVOICE_POST_FAILED|HTTP ' + res.getStatusCode() + ': ' + res.getBody());
  }
} catch (Exception e) {
  System.debug('INVOICE_POST_FAILED|' + e.getTypeName() + ': ' + e.getMessage());
}
`;
}

/**
 * Stamp the run marker and the originating order onto a posted invoice.
 *
 * Description is the tag that makes generated invoices findable for cleanup.
 * ReferenceEntityId is the natural Invoice→Order link, and it is writable only
 * once the invoice is Posted — a Draft rejects it — which is why this runs last.
 * Cosmetic: correlation already works via InvoiceLine.BillingScheduleId.
 */
function buildTagInvoiceApex(invoiceId, orderId, marker) {
  return `
try {
  update new Invoice(Id = '${invoiceId}', Description = '${marker}', ReferenceEntityId = '${orderId}');
  System.debug('INVOICE_TAG_SUCCESS|${invoiceId}');
} catch (Exception e) {
  System.debug('INVOICE_TAG_FAILED|' + e.getMessage());
}
`;
}

/**
 * Expand the platform's own shorthand in a billing error.
 *
 * A rejected generate says to "check the billing schedule's RTEL log", which
 * names nothing you can search for: RTEL is RevenueTransactionErrorLog.
 */
function withErrorLogHint(message) {
  if (!/RTEL/i.test(message)) return message;
  return `${message} [RTEL = RevenueTransactionErrorLog — see README → Invoicing for how to read it]`;
}

function runMarked(apex, successPrefix, failurePrefix, apexOpts = {}) {
  const lines = extractDebugLines(runApex(apex, apexOpts));
  let value = null;
  let error = '';
  for (const line of lines) {
    if (line.startsWith(`${successPrefix}|`)) value = line.split('|').slice(1).join('|');
    else if (line.startsWith(`${failurePrefix}|`)) error = line.split('|').slice(1).join('|');
  }
  return { value, error };
}

/**
 * Find the invoice generated from these billing schedules.
 *
 * The only reliable correlation is InvoiceLine.BillingScheduleId — the ids we
 * submitted. Invoice.ReferenceEntityId is null as-generated and
 * CorrelationIdentifier is not persisted, so neither can find the row. Query
 * across every submitted schedule: all of them land on one invoice, but a slot
 * with TotalAmount = 0 produces no InvoiceLine, so no single schedule is a safe
 * anchor.
 */
async function waitForInvoice(scheduleIds, timeoutMs = INVOICE_TIMEOUT_MS) {
  const inList = scheduleIds.map(id => `'${id}'`).join(', ');
  const soql = `SELECT InvoiceId, Invoice.Status, Invoice.InvoiceNumber FROM InvoiceLine WHERE BillingScheduleId IN (${inList})`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = query(soql).filter(r => r.InvoiceId);
    if (rows.length) {
      const status = rows[0].Invoice?.Status;
      if (INVOICE_FAIL.has(status)) {
        throw new Error(`generated invoice ${rows[0].InvoiceId} is in ${status}`);
      }
      if (INVOICE_DRAFT_OK.has(status) || INVOICE_POSTED_OK.has(status)) {
        return rows[0].InvoiceId;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `no invoice appeared for ${scheduleIds.length} billing schedule(s) within ${Math.round(timeoutMs / 1000)}s`
  );
}

/** Wait for a posted invoice and return its InvoiceNumber. */
async function waitForPosted(invoiceId, timeoutMs = INVOICE_TIMEOUT_MS) {
  const soql = `SELECT Status, InvoiceNumber FROM Invoice WHERE Id = '${invoiceId}'`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = query(soql);
    const status = rows[0]?.Status;
    if (INVOICE_POSTED_OK.has(status)) return rows[0].InvoiceNumber;
    if (INVOICE_FAIL.has(status)) throw new Error(`invoice ${invoiceId} is in ${status} after post`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`invoice ${invoiceId} did not post within ${Math.round(timeoutMs / 1000)}s`);
}

/**
 * Step 5 — invoice an activated order: wait for its billing schedules, generate
 * a Draft invoice from the billable ones, post it, then tag it.
 *
 * The two dates do different jobs. `targetDate` is today: it decides which
 * billing periods are due, and the billing engine dates schedules from the
 * subscription's own start rather than from the order's back-dated
 * EffectiveDate, so an earlier target leaves the subscription lines not-yet-due
 * and fails the call. `invoiceDate` is the order's own date, which back-dates
 * the invoice onto the same timeline as Order.EffectiveDate — verified accepted:
 * an order dated 2025-10-08 posted as InvoiceDate 2025-10-08.
 *
 * Throws on failure; the caller decides what that means for the order.
 */
export async function invoiceOrder(orderId, invoiceDate, onProgress = () => {}) {
  const marker = `RMI-${invoiceDate}-${orderId.slice(-6)}`;
  const targetDate = today();

  const schedules = await waitForBillingSchedules(orderId);
  const billable = billableAsOf(schedules, targetDate);
  onProgress(`    → ${schedules.length} billing schedule(s) ready, ${billable.length} billable as of ${targetDate}`);
  if (!billable.length) {
    throw new Error(
      `none of the ${schedules.length} billing schedule(s) are due by ${targetDate} — nothing to invoice yet`
    );
  }
  if (billable.length > MAX_SCHEDULES_PER_GENERATE) {
    throw new Error(
      `${billable.length} billable billing schedules exceeds the ${MAX_SCHEDULES_PER_GENERATE}-schedule limit of a single invoice generation — this order is too large to invoice in one call`
    );
  }
  const scheduleIds = billable.map(s => s.Id);

  // `generate` carries no idempotency key — correlationId is not persisted — so
  // it must be called exactly once per order. Each order is invoiced inline
  // right after it activates and is never retried, which is what keeps it once.
  const gen = runMarked(
    buildGenerateInvoiceApex(scheduleIds, invoiceDate, targetDate, marker),
    'INVOICE_GEN_SUCCESS',
    'INVOICE_GEN_FAILED'
  );
  if (gen.value === null) {
    throw new Error(withErrorLogHint(gen.error || 'invoice generation returned no result'));
  }

  const invoiceId = await waitForInvoice(scheduleIds);
  onProgress(`    → Invoice ${invoiceId} drafted`);

  // The post targets an invoice that already exists, so a lost response is
  // settled by reading its status below rather than by posting a second time.
  let responseLost = false;
  let posted = { value: null, error: '' };
  try {
    posted = runMarked(
      buildPostInvoiceApex(invoiceId, marker),
      'INVOICE_POST_SUCCESS',
      'INVOICE_POST_FAILED'
    );
  } catch (err) {
    if (!isTransientTransportError(err.message)) throw err;
    responseLost = true;
  }
  if (!responseLost && posted.value === null) {
    throw new Error(posted.error || 'invoice post returned no result');
  }

  const invoiceNumber = await waitForPosted(invoiceId);

  // Tagging is bookkeeping for cleanup, not part of the deliverable — a failure
  // here leaves a perfectly good posted invoice, so it warns instead of throwing.
  const tagged = runMarked(
    buildTagInvoiceApex(invoiceId, orderId, marker),
    'INVOICE_TAG_SUCCESS',
    'INVOICE_TAG_FAILED',
    { retries: 2 }
  );
  if (tagged.value === null) {
    onProgress(`    ⚠ Invoice ${invoiceId} posted but could not be tagged: ${tagged.error}`);
  }

  return { invoiceId, invoiceNumber };
}
