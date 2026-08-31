// RMI Toolkit — Reference: Invoice an Activated Order
// Replace ORDER_ID with an ACTIVATED order's Id.
// The generate.js CLI runs this sequence automatically after each activation
// when the org type declares `invoicing: true`.
//
// Activation is the billing trigger: it fires the Order-to-Billing-Schedule
// flow, which runs asynchronously after commit. So the BillingSchedule rows
// this script reads appear seconds AFTER activation — if the query below comes
// back empty, wait and re-run rather than concluding billing is broken.
//
// Anonymous Apex cannot sleep, so this script does one pass. The CLI polls
// (see src/invoices.js); here, re-run until each stage reports what you expect.

final String ORDER_ID = '801Hu00000XXXXXXXXX'; // replace
final String API_VERSION = 'v68.0';            // invoicing resources need v62.0+

// ─── Stage 1: the billing schedules activation produced ──────────────────────
List<BillingSchedule> schedules = [
    SELECT Id, Status, TotalAmount
    FROM BillingSchedule
    WHERE ReferenceEntityId = :ORDER_ID
];
System.debug('Billing schedules found: ' + schedules.size());
for (BillingSchedule bs : schedules) {
    System.debug('  ' + bs.Id + ' — ' + bs.Status + ' — ' + bs.TotalAmount);
}

List<String> readyIds = new List<String>();
for (BillingSchedule bs : schedules) {
    if (bs.Status == 'ReadyForInvoicing' || bs.Status == 'CompletelyBilled') {
        readyIds.add(bs.Id);
    }
}
if (readyIds.isEmpty()) {
    System.debug('No schedules ready to invoice yet. Wait and re-run.');
    return;
}

// ─── Stage 2: generate a Draft invoice from them ─────────────────────────────
// invoiceDate/targetDate are set to the Order's EffectiveDate rather than today
// so the invoice sits on the same timeline as the order it came from.
Order ord = [SELECT EffectiveDate FROM Order WHERE Id = :ORDER_ID LIMIT 1];
String invoiceDate = String.valueOf(ord.EffectiveDate);

Map<String,Object> payload = new Map<String,Object>{
    'billingScheduleIds' => readyIds,
    'action'             => 'Draft',
    'invoiceDate'        => invoiceDate,
    'targetDate'         => invoiceDate,
    'correlationId'      => 'RMI-manual-' + ORDER_ID.right(6)
};

HttpRequest req = new HttpRequest();
req.setEndpoint(URL.getOrgDomainUrl().toExternalForm()
    + '/services/data/' + API_VERSION + '/commerce/invoicing/invoices/collection/actions/generate');
req.setMethod('POST');
req.setHeader('Content-Type', 'application/json');
req.setHeader('Authorization', 'Bearer ' + UserInfo.getSessionId());
req.setTimeout(120000);
req.setBody(JSON.serialize(payload));
HttpResponse res = new Http().send(req);
System.debug('generate → HTTP ' + res.getStatusCode() + ': ' + res.getBody());

// `generate` is async and returns only {requestIdentifier, success, errors} —
// no statusURL, no AsyncOperationTracker. The invoice row appears ~10-15s later.

// ─── Stage 3: find the invoice, then post it ─────────────────────────────────
// Correlate ONLY via InvoiceLine.BillingScheduleId. Invoice.ReferenceEntityId is
// null as-generated and CorrelationIdentifier is not persisted, so neither one
// can find the row. Query across ALL submitted schedules: they all land on a
// single invoice, but a TotalAmount = 0 slot yields no InvoiceLine, so any one
// schedule is an unsafe anchor.
List<InvoiceLine> lines = [
    SELECT InvoiceId, Invoice.Status, Invoice.InvoiceNumber
    FROM InvoiceLine
    WHERE BillingScheduleId IN :readyIds
];
if (lines.isEmpty()) {
    System.debug('Invoice not generated yet (~10-15s lag). Re-run to pick it up and post it.');
    return;
}

String invoiceId = lines[0].InvoiceId;
System.debug('Invoice ' + invoiceId + ' — ' + lines[0].Invoice.Status);

if (lines[0].Invoice.Status == 'Draft' || lines[0].Invoice.Status == 'Split Draft') {
    HttpRequest postReq = new HttpRequest();
    postReq.setEndpoint(URL.getOrgDomainUrl().toExternalForm()
        + '/services/data/' + API_VERSION + '/commerce/invoicing/invoices/collection/actions/post');
    postReq.setMethod('POST');
    postReq.setHeader('Content-Type', 'application/json');
    postReq.setHeader('Authorization', 'Bearer ' + UserInfo.getSessionId());
    postReq.setTimeout(120000);
    postReq.setBody(JSON.serialize(new Map<String,Object>{
        'invoiceIds'    => new List<String>{ invoiceId },
        'correlationId' => 'RMI-manual-' + ORDER_ID.right(6)
    }));
    HttpResponse postRes = new Http().send(postReq);
    System.debug('post → HTTP ' + postRes.getStatusCode() + ': ' + postRes.getBody());
    // InvoiceNumber is null while Draft; it is assigned at post time. Re-run to
    // read it back, and to set ReferenceEntityId — writable only once Posted.
} else {
    System.debug('Invoice already ' + lines[0].Invoice.Status
        + ' (' + lines[0].Invoice.InvoiceNumber + '); nothing to post.');
}
