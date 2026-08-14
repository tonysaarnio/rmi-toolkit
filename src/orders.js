import { runApex, extractDebugLines } from './org.js';
import { pickRandom, getStandardPricebookId, getCorporateCurrency, fetchProvenStandaloneProductIds } from './catalog.js';

const WARN_THRESHOLD = 200;

// Fallback line quantity range, used when the caller's org type doesn't declare
// one. Org types set their own (see src/orgTypes.js) — bulk parts and software
// seats sell in very different counts.
const DEFAULT_QUANTITY_RANGE = [100, 5000];

function randomOrderDate() {
  const start = new Date('2025-01-01').getTime();
  const end = Date.now();
  const ts = start + Math.random() * (end - start);
  return new Date(ts).toISOString().slice(0, 10);
}

// Add whole months to a YYYY-MM-DD string, returning YYYY-MM-DD (UTC-safe).
function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Add days to a YYYY-MM-DD string, returning YYYY-MM-DD (UTC-safe).
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Selling models that require subscription term/date/billing fields to price.
const TERM_SELLING_MODELS = new Set(['TermDefined', 'Evergreen']);

// Map a selling model's PricingTermUnit → QuoteLineItem.BillingFrequency value.
// BillingFrequency must match the term unit or the pricing procedure rejects it
// ("Add a Billing Treatment ... to change the Billing Frequency").
const FREQ_BY_TERM_UNIT = {
  Months: 'Monthly',
  Quarterly: 'Quarterly',
  'Semi-Annual': 'Semi-Annual',
  Annual: 'Annual',
};

// Whole months represented by one PricingTermUnit (to compute EndDate).
const MONTHS_PER_TERM_UNIT = {
  Months: 1,
  Quarterly: 3,
  'Semi-Annual': 6,
  Annual: 12,
};

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Poll until the Quote's tax calculation is complete (not TaxCalculationInProcess).
 * PST triggers async tax calculation; conversion fails if it hasn't finished.
 */
async function waitForQuoteReady(quoteId, maxWaitMs = 30000) {
  const { query } = await import('./org.js');
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const records = query(`SELECT Id, CalculationStatus FROM Quote WHERE Id = '${quoteId}'`);
    const status = records[0]?.CalculationStatus ?? '';
    if (status !== 'TaxCalculationInProcess') return;
    await new Promise(r => setTimeout(r, 2000));
  }
}

// Emit the subscription (term/date/billing) field puts for a line, keyed to
// itemFields<n>. TermDefined/Evergreen lines need term, dates, billing
// frequency (matching the model's term unit) and a proration boundary.
// OneTime lines get none of these. Derived from a real quote's line items.
function emitSubscriptionFields(n, item, quoteDate, opts = {}) {
  if (!TERM_SELLING_MODELS.has(item.sellingModelType)) return '';
  const term = item.pricingTerm || 1;
  const monthsPerUnit = MONTHS_PER_TERM_UNIT[item.pricingTermUnit] ?? 12;
  const billingFreq = FREQ_BY_TERM_UNIT[item.pricingTermUnit] ?? 'Annual';
  const start = quoteDate;
  const end = addDays(addMonths(start, term * monthsPerUnit), -1);
  // On a bundle root the configurator derives BillingFrequency from the selling
  // model; setting it explicitly triggers "Add a Billing Treatment ..." — so
  // omit it when omitBillingFrequency is set.
  const billingLine = opts.omitBillingFrequency
    ? ''
    : `itemFields${n}.put('BillingFrequency', '${billingFreq}');\n`;
  return `itemFields${n}.put('StartDate', '${start}');
itemFields${n}.put('EndDate', '${end}');
itemFields${n}.put('SubscriptionTerm', ${term});
${billingLine}itemFields${n}.put('PeriodBoundary', 'Anniversary');`;
}

// Emit one QuoteLineItem RecordResource snippet.
//   opts: { quantity, discountPct, parentRef, refName }
// We intentionally do NOT set ProductSellingModelId — the running user
// typically lacks FLS on it, and PST resolves the product's default selling
// model automatically (which drives the required term/billing).
function emitLineItem(n, item, quoteDate, opts = {}) {
  const qty = Math.floor(opts.quantity != null ? opts.quantity : randInt(...DEFAULT_QUANTITY_RANGE));
  const discountPct = opts.discountPct ?? 0;
  const refName = opts.refName || `refItem${n}`;
  const parentLine = opts.parentRef
    ? `itemFields${n}.put('ParentQuoteLineItemId', '@{${opts.parentRef}.id}');\n`
    : '';
  const subFields = emitSubscriptionFields(n, item, quoteDate, { omitBillingFrequency: opts.omitBillingFrequency });
  return `
RevSalesTrxn.RecordResource item${n} = new RevSalesTrxn.RecordResource(QuoteLineItem.getSobjectType(), 'POST');
Map<String,Object> itemFields${n} = new Map<String,Object>();
itemFields${n}.put('Product2Id', '${item.productId}');
itemFields${n}.put('PricebookEntryId', '${item.pricebookEntryId}');
itemFields${n}.put('Quantity', ${qty}.0);
itemFields${n}.put('UnitPrice', ${item.unitPrice});
itemFields${n}.put('Discount', ${discountPct});
itemFields${n}.put('QuoteId', '@{refQuote.id}');
${parentLine}${subFields}
item${n}.fieldValues = itemFields${n};
records.add(new RevSalesTrxn.RecordWithReferenceRequest('${refName}', item${n}));
`;
}

// Shared PST graph header: pricing/config prefs + the Quote record.
function pstHeader(quoteName, quoteDate) {
  const STANDARD_PRICEBOOK_ID = getStandardPricebookId();
  const corpCurrency = getCorporateCurrency();
  const currencyField = corpCurrency ? `quoteFields.put('CurrencyIsoCode', '${corpCurrency}');` : '';
  return `
RevSalesTrxn.PricingPreferenceEnum pricingPref = RevSalesTrxn.PricingPreferenceEnum.SYSTEM;
RevSalesTrxn.ConfigurationExecutionEnum configExec = RevSalesTrxn.ConfigurationExecutionEnum.SYSTEM;

RevSalesTrxn.RecordResource quoteRecord = new RevSalesTrxn.RecordResource(Quote.getSobjectType(), 'POST');
Map<String,Object> quoteFields = new Map<String,Object>();
quoteFields.put('Name', '${quoteName}');
quoteFields.put('Pricebook2Id', '${STANDARD_PRICEBOOK_ID}');
quoteFields.put('ExpirationDate', '${quoteDate}');
${currencyField}
quoteRecord.fieldValues = quoteFields;

List<RevSalesTrxn.RecordWithReferenceRequest> records = new List<RevSalesTrxn.RecordWithReferenceRequest>();
records.add(new RevSalesTrxn.RecordWithReferenceRequest('refQuote', quoteRecord));
`;
}

// Shared PST graph footer: execute + emit PST_SUCCESS / PST_FAILURE markers.
// opts.addDefaultConfiguration → expand bundle roots with their default
// components (the configurator owns ParentQuoteLineItemId; it cannot be set
// directly on a QuoteLineItem in the graph).
function pstFooter(opts = {}) {
  const addDefault = opts.addDefaultConfiguration ? 'true' : 'false';
  const execRules = opts.executeConfigurationRules ? 'true' : 'false';
  return `
RevSalesTrxn.GraphRequest graph = new RevSalesTrxn.GraphRequest('rmi_quote_${Date.now()}', records);

RevSalesTrxn.ConfigurationOptionsInput cInput = new RevSalesTrxn.ConfigurationOptionsInput();
cInput.addDefaultConfiguration = ${addDefault};
cInput.executeConfigurationRules = ${execRules};

try {
  RevSalesTrxn.PlaceSalesTransactionResponse resp =
    RevSalesTrxn.PlaceSalesTransactionExecutor.execute(
      graph, pricingPref, configExec,
      cInput,
      null
    );
  if (resp != null && resp.isSuccess) {
    System.debug('PST_SUCCESS|' + resp.salesTransactionId);
  } else {
    String errMsg = (resp != null && resp.errorResponse != null) ? String.valueOf(resp.errorResponse) : 'null response';
    System.debug('PST_FAILURE|' + errMsg);
  }
} catch (Exception e) {
  System.debug('PST_FAILURE|' + e.getTypeName() + ': ' + e.getMessage());
}
`;
}

/**
 * Pick a quantity per line, then scale the whole set down if the quote would
 * come out over maxTotal. A line's total is exactly
 * `unitPrice × quantity × (1 − discount)` — no term multiplier, verified
 * against priced OrderItems — so the projection here matches what PST returns
 * and the cap can be applied before the quote is ever created.
 */
function assignQuantities(lineItems, discounts, quantityRange, maxTotal) {
  const [minQty, maxQty] = quantityRange;
  const quantities = lineItems.map(() => randInt(minQty, maxQty));

  if (!maxTotal) return quantities;

  const lineTotal = (item, qty, i) =>
    (item.unitPrice || 0) * qty * (1 - (discounts[i] ?? 0) / 100);
  const projected = lineItems.reduce((sum, item, i) => sum + lineTotal(item, quantities[i], i), 0);
  if (projected <= maxTotal) return quantities;

  const factor = maxTotal / projected;
  return quantities.map(q => Math.max(1, Math.floor(q * factor)));
}

/**
 * Step 1 (flat) — PST: Create and price a Quote with standalone QuoteLineItems.
 * AccountId is not writable on Quote via PST — we link the account via a stub
 * Opportunity in Step 2.
 *   opts: { quantityRange, maxOrderTotal }
 */
function buildPSTApex(quoteDate, lineItems, discounts, opts = {}) {
  const quantityRange = opts.quantityRange ?? DEFAULT_QUANTITY_RANGE;
  const quantities = assignQuantities(lineItems, discounts, quantityRange, opts.maxOrderTotal);
  const quoteName = `RMI-${quoteDate}-${randInt(1000, 9999)}`;
  const lines = [pstHeader(quoteName, quoteDate)];
  lineItems.forEach((item, idx) => {
    lines.push(emitLineItem(idx + 1, item, quoteDate, {
      discountPct: discounts[idx] ?? 0,
      quantity: quantities[idx],
    }));
  });
  lines.push(pstFooter());
  return lines.join('\n');
}

/**
 * Step 1 (bundle) — PST: Create and price a Quote configured as a bundle.
 * We POST only the bundle root line (Type=Bundle, qty 1) and let PST's
 * configurator expand + validate it via addDefaultConfiguration=true. This is
 * the only path that produces a CONVERTIBLE bundle: the QuantumBit bundles have
 * CML constraint rules, so a hand-assembled component set is flagged
 * ValidationResult=Warning and createOrderFromQuote refuses it. The resulting
 * quote reproduces a real configured quote (e.g. "QuantumBit Complete
 * Solution", whose children ARE the bundle defaults). Per-order variety comes
 * from the bundle choice plus the flat "standalone from components" orders —
 * changing component quantities after PST leaves the quote priced stale and
 * blocks conversion, so it isn't attempted.
 */
function buildBundlePSTApex(quoteDate, bundle) {
  const quoteName = `RMI-${quoteDate}-${randInt(1000, 9999)}`;
  const lines = [pstHeader(quoteName, quoteDate)];
  lines.push(emitLineItem(0, bundle, quoteDate, {
    quantity: 1,
    discountPct: 0,
    refName: 'refBundle',
    omitBillingFrequency: true,
  }));
  lines.push(pstFooter({ addDefaultConfiguration: true, executeConfigurationRules: true }));
  return lines.join('\n');
}

/**
 * Step 2 — Link account to Quote via a stub Opportunity.
 * Also ensures a Bill-To Contact exists on the Account (required for Order activation).
 * Quote.AccountId is not directly writable; setting OpportunityId
 * on the Quote propagates the AccountId automatically.
 * Returns the Contact Id for use in Step 4.
 */
function buildLinkAccountApex(quoteId, accountId, quoteDate) {
  return `
try {
  // Ensure a Contact exists for this Account (required for Order activation)
  List<Contact> contacts = [SELECT Id FROM Contact WHERE AccountId = '${accountId}' LIMIT 1];
  Contact billToContact;
  if (contacts.isEmpty()) {
    billToContact = new Contact(
      FirstName = 'RMI',
      LastName = 'Contact',
      AccountId = '${accountId}'
    );
    insert billToContact;
  } else {
    billToContact = contacts[0];
  }

  Opportunity opp = new Opportunity(
    Name = 'RMI-${quoteDate}-${randInt(1000, 9999)}',
    AccountId = '${accountId}',
    StageName = 'Prospecting',
    CloseDate = Date.valueOf('${quoteDate}')
  );
  insert opp;
  Quote q = new Quote(Id = '${quoteId}', OpportunityId = opp.Id);
  update q;
  System.debug('LINK_SUCCESS|${quoteId}|' + opp.Id + '|' + billToContact.Id);
} catch (Exception e) {
  System.debug('LINK_FAILED|${quoteId}|' + e.getMessage());
}
`;
}

/**
 * Step 3 — Convert Quote to Order via the createOrderFromQuote
 * standard invocable action (REST call within Apex).
 */
function buildConvertApex(quoteId) {
  return `
try {
  String endpoint = URL.getOrgDomainUrl().toExternalForm()
    + '/services/data/v66.0/actions/standard/createOrderFromQuote';
  HttpRequest req = new HttpRequest();
  req.setEndpoint(endpoint);
  req.setMethod('POST');
  req.setHeader('Content-Type', 'application/json');
  req.setHeader('Authorization', 'Bearer ' + UserInfo.getSessionId());
  req.setBody('{"inputs":[{"quoteRecordId":"${quoteId}"}]}');
  HttpResponse res = new Http().send(req);
  if (res.getStatusCode() == 200) {
    List<Object> results = (List<Object>) JSON.deserializeUntyped(res.getBody());
    Map<String,Object> result = (Map<String,Object>) results[0];
    Boolean success = (Boolean) result.get('isSuccess');
    if (success) {
      Map<String,Object> outputs = (Map<String,Object>) result.get('outputValues');
      System.debug('CONVERT_SUCCESS|' + (String) outputs.get('orderId'));
    } else {
      System.debug('CONVERT_FAILED|${quoteId}|' + String.valueOf(result.get('errors')));
    }
  } else {
    System.debug('CONVERT_FAILED|${quoteId}|HTTP ' + res.getStatusCode() + ': ' + res.getBody());
  }
} catch (Exception e) {
  System.debug('CONVERT_FAILED|${quoteId}|' + e.getMessage());
}
`;
}

/**
 * Step 4 — Set BillToContactId, copy address from Account, then activate.
 * Orders converted from Quotes require a bill-to contact and billing address.
 */
function buildActivationApex(orderId, contactId, quoteDate) {
  return `
try {
  Order o = [SELECT Id, Status, AccountId,
               BillingStreet, BillingCity, BillingState, BillingCountry, BillingPostalCode,
               ShippingStreet, ShippingCity, ShippingState, ShippingCountry, ShippingPostalCode
             FROM Order WHERE Id = '${orderId}' LIMIT 1];
  o.EffectiveDate = Date.valueOf('${quoteDate}');
  if (o.AccountId != null && (o.BillingState == null || o.BillingState == ''
      || o.ShippingState == null || o.ShippingState == '')) {
    Account acc = [SELECT BillingStreet, BillingCity, BillingState, BillingCountry, BillingPostalCode,
                          ShippingStreet, ShippingCity, ShippingState, ShippingCountry, ShippingPostalCode
                   FROM Account WHERE Id = :o.AccountId LIMIT 1];
    if (o.BillingState == null || o.BillingState == '') {
      o.BillingStreet     = acc.BillingStreet;
      o.BillingCity       = acc.BillingCity;
      o.BillingState      = acc.BillingState;
      o.BillingCountry    = acc.BillingCountry;
      o.BillingPostalCode = acc.BillingPostalCode;
    }
    if (o.ShippingState == null || o.ShippingState == '') {
      // Fall back to billing address values if account shipping is also blank
      o.ShippingStreet     = acc.ShippingStreet != null ? acc.ShippingStreet : acc.BillingStreet;
      o.ShippingCity       = acc.ShippingCity != null ? acc.ShippingCity : acc.BillingCity;
      o.ShippingState      = acc.ShippingState != null ? acc.ShippingState : acc.BillingState;
      o.ShippingCountry    = acc.ShippingCountry != null ? acc.ShippingCountry : acc.BillingCountry;
      o.ShippingPostalCode = acc.ShippingPostalCode != null ? acc.ShippingPostalCode : acc.BillingPostalCode;
    }
  }
  o.BillToContactId = '${contactId}';
  o.Status = 'Activated';
  update o;
  System.debug('ACTIVATED|${orderId}');
} catch (Exception e) {
  System.debug('ACTIVATE_FAILED|${orderId}|' + e.getMessage());
}
`;
}

/**
 * Shared pipeline for one transaction: PST (Quote) → link Account →
 * createOrderFromQuote → Activate Order. Given the already-built PST apex,
 * runs the four steps, reporting progress and pushing to created/failed.
 */
async function processOrder(account, quoteDate, pstApex, onProgress, created, failed, postPstApexFn = null) {
  try {
    // Step 1 — Create priced Quote via PST
    const pstOutput = runApex(pstApex);
    const pstLines = extractDebugLines(pstOutput);

    let quoteId = null;
    let pstError = '';
    for (const line of pstLines) {
      if (line.startsWith('PST_SUCCESS|')) quoteId = line.split('|')[1];
      else if (line.startsWith('PST_FAILURE|')) pstError = line.split('|').slice(1).join('|');
    }
    if (!quoteId) {
      failed.push({ accountName: account.name, error: pstError || 'PST returned no Quote ID' });
      onProgress(`  ✗ PST failed: ${pstError}`);
      return;
    }
    onProgress(`  → Quote ${quoteId} created`);

    // Wait for PST tax calculation to complete before conversion
    await waitForQuoteReady(quoteId);

    // Step 1b — optional post-PST tweak (e.g. randomize bundle component qty)
    if (postPstApexFn) {
      const extraApex = postPstApexFn(quoteId);
      if (extraApex) {
        runApex(extraApex);
        await waitForQuoteReady(quoteId);
      }
    }

    // Step 2 — Link Account via stub Opportunity, ensure Bill-To Contact exists
    const linkOutput = runApex(buildLinkAccountApex(quoteId, account.id, quoteDate));
    const linkLines = extractDebugLines(linkOutput);
    let linkError = '';
    let contactId = null;
    for (const line of linkLines) {
      if (line.startsWith('LINK_SUCCESS|')) contactId = line.split('|')[3];
      else if (line.startsWith('LINK_FAILED|')) linkError = line.split('|').slice(2).join('|');
    }
    if (!contactId) {
      failed.push({ accountName: account.name, error: linkError || 'Account link failed' });
      onProgress(`  ✗ Account link failed: ${linkError}`);
      return;
    }

    // Step 3 — Convert Quote to Order
    const convertOutput = runApex(buildConvertApex(quoteId));
    const convertLines = extractDebugLines(convertOutput);
    let orderId = null;
    let convertError = '';
    for (const line of convertLines) {
      if (line.startsWith('CONVERT_SUCCESS|')) orderId = line.split('|')[1];
      else if (line.startsWith('CONVERT_FAILED|')) convertError = line.split('|').slice(2).join('|');
    }
    if (!orderId) {
      failed.push({ accountName: account.name, error: convertError || 'Conversion returned no Order ID' });
      onProgress(`  ✗ Conversion failed: ${convertError}`);
      return;
    }
    onProgress(`  → Order ${orderId} created from Quote`);

    // Step 4 — Activate the Order
    const activateOutput = runApex(buildActivationApex(orderId, contactId, quoteDate));
    const activateLines = extractDebugLines(activateOutput);
    let activateFailed = false;
    for (const line of activateLines) {
      if (line.startsWith('ACTIVATE_FAILED|')) {
        activateFailed = true;
        onProgress(`  ✗ Activation failed: ${line.split('|').slice(2).join('|')}`);
        failed.push({ accountName: account.name, error: `Activation: ${line.split('|').slice(2).join('|')}` });
      }
    }
    if (!activateFailed) {
      created.push(orderId);
      onProgress(`  ✓ Order ${orderId} activated (from Quote ${quoteId})`);
    }
  } catch (err) {
    failed.push({ accountName: account.name, error: err.message });
    onProgress(`  ✗ Exception: ${err.message}`);
  }
}

/**
 * Main order generation loop (flat, standalone line items).
 * Flow per transaction: PST (Quote) → link Account → createOrderFromQuote → Activate Order
 */
export async function generateOrders(accounts, productPool, ordersPerAccount, onProgress, opts = {}) {
  const { quantityRange = DEFAULT_QUANTITY_RANGE, maxOrderTotal = null } = opts;
  const totalOrders = accounts.length * ordersPerAccount;

  if (totalOrders > WARN_THRESHOLD) {
    onProgress(`⚠️  Warning: ${totalOrders} total orders. This will take a while. Proceeding...`);
  }

  const created = [];
  const failed = [];
  let orderNum = 0;

  for (const account of accounts) {
    for (let i = 0; i < ordersPerAccount; i++) {
      orderNum++;
      const lineItems = pickRandom(productPool, randInt(3, 10));
      const discounts = lineItems.map(() => randInt(0, 40));
      const quoteDate = randomOrderDate();

      onProgress(`[${orderNum}/${totalOrders}] "${account.name}" — ${lineItems.length} line items, date ${quoteDate}`);
      const pstApex = buildPSTApex(quoteDate, lineItems, discounts, { quantityRange, maxOrderTotal });
      await processOrder(account, quoteDate, pstApex, onProgress, created, failed);
    }
  }

  return { created, failed };
}

/**
 * Mixed generation loop, modeled on real quotes:
 *   - "bundle" orders  → a configurable bundle root + randomized allowed children
 *   - "flat"   orders  → standalone line items drawn FROM the bundles' components
 *
 * @param accounts        [{ id, name }]
 * @param bundles         [{ bundle, components }] from fetchBundlePool()
 * @param ordersPerAccount number
 * @param onProgress      msg => void
 * @param opts            { flatRatio = 0.35, quantityRange, maxOrderTotal }
 */
export async function generateMixedOrders(accounts, bundles, ordersPerAccount, onProgress, opts = {}) {
  const flatRatio = opts.flatRatio ?? 0.35;
  const quantityRange = opts.quantityRange ?? DEFAULT_QUANTITY_RANGE;
  const maxOrderTotal = opts.maxOrderTotal ?? null;
  const totalOrders = accounts.length * ordersPerAccount;

  if (totalOrders > WARN_THRESHOLD) {
    onProgress(`⚠️  Warning: ${totalOrders} total orders. This will take a while. Proceeding...`);
  }

  // Flat pool = bundle component products (dedup) that are PROVEN to convert as
  // standalone lines (present as top-level items on activated orders). Some
  // components can't be sold standalone (their billing treatment is
  // bundle-only), so restricting to the proven set keeps flat orders reliable.
  // If nothing is proven yet (fresh org), fall back to OneTime components, which
  // need no billing fields and never hit the billing-treatment wall.
  const proven = fetchProvenStandaloneProductIds();
  const flatSeen = new Set();
  const allComponents = [];
  for (const { components } of bundles) {
    for (const c of components) {
      if (!flatSeen.has(c.productId)) {
        flatSeen.add(c.productId);
        allComponents.push(c);
      }
    }
  }
  // Never put a nested bundle / configurable product on a flat line — it needs
  // configuration and would raise config warnings that block conversion.
  const flatEligible = allComponents.filter(c => !c.isConfigurable);
  let flatPool = flatEligible.filter(c => proven.has(c.productId));
  if (!flatPool.length) {
    flatPool = flatEligible.filter(c => c.sellingModelType === 'OneTime');
  }
  onProgress(`Flat pool: ${flatPool.length} proven standalone component product(s).`);

  const created = [];
  const failed = [];
  let orderNum = 0;

  for (const account of accounts) {
    for (let i = 0; i < ordersPerAccount; i++) {
      orderNum++;
      const quoteDate = randomOrderDate();
      const goFlat = flatPool.length > 0 && Math.random() < flatRatio;

      let pstApex;
      let label;
      let postPstApexFn = null;
      if (goFlat) {
        const lineItems = pickRandom(flatPool, randInt(3, Math.min(8, flatPool.length)));
        const discounts = lineItems.map(() => randInt(0, 40));
        pstApex = buildPSTApex(quoteDate, lineItems, discounts, { quantityRange, maxOrderTotal });
        label = `flat — ${lineItems.length} standalone line items`;
      } else {
        const { bundle } = bundles[randInt(0, bundles.length - 1)];
        pstApex = buildBundlePSTApex(quoteDate, bundle);
        label = `bundle "${bundle.productName}" (configurator default)`;
      }

      onProgress(`[${orderNum}/${totalOrders}] "${account.name}" — ${label}, date ${quoteDate}`);
      await processOrder(account, quoteDate, pstApex, onProgress, created, failed, postPstApexFn);
    }
  }

  return { created, failed };
}
