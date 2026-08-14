// RMI Toolkit — Reference: Single Order via PlaceSalesTransaction
// Replace the placeholder IDs below with real values before running.
// The generate.js CLI builds this dynamically for each order.
//
// ACCOUNT_ID       — Id of the Account to associate the order with
// PRICEBOOK_ID     — Standard Price Book (org-specific; query it:
//                    SELECT Id FROM Pricebook2 WHERE IsStandard = true)
// EFFECTIVE_DATE   — YYYY-MM-DD (randomized Jan 2025–today by the toolkit)
// Product/PBE IDs  — queried from the selected catalog pool

final String ACCOUNT_ID     = '001Hu00000XXXXXXXXX';  // replace
final String PRICEBOOK_ID   = '01sHu00000XXXXXXXXX';  // replace
final String EFFECTIVE_DATE = '2025-06-15';

// Line item data — add/remove as needed (3–10 lines in toolkit)
final String PROD1_ID  = '01tHu00000XXXXXXXXX'; // replace
final String PBE1_ID   = '01uHu00000XXXXXXXXX'; // replace
final Decimal PRICE1   = 1.25;
final Decimal QTY1     = 500.0;
final Decimal DISC1    = 0.15; // 15% discount applied to TotalLineAmount

final String PROD2_ID  = '01tHu00000YYYYYYYYY'; // replace
final String PBE2_ID   = '01uHu00000YYYYYYYYY'; // replace
final Decimal PRICE2   = 3.80;
final Decimal QTY2     = 1000.0;
final Decimal DISC2    = 0.00;

RevSalesTrxn.PricingPreferenceEnum pricingPref =
    RevSalesTrxn.PricingPreferenceEnum.SYSTEM;
RevSalesTrxn.ConfigurationExecutionEnum configExec =
    RevSalesTrxn.ConfigurationExecutionEnum.SYSTEM;

// Order (header)
RevSalesTrxn.RecordResource orderRecord =
    new RevSalesTrxn.RecordResource(Order.getSobjectType(), 'POST');
Map<String,Object> orderFields = new Map<String,Object>();
orderFields.put('AccountId',    ACCOUNT_ID);
orderFields.put('Pricebook2Id', PRICEBOOK_ID);
orderFields.put('EffectiveDate', Date.valueOf(EFFECTIVE_DATE));
orderFields.put('Status', 'Draft');
orderRecord.fieldValues = orderFields;

// Line item 1
RevSalesTrxn.RecordResource item1 =
    new RevSalesTrxn.RecordResource(OrderItem.getSobjectType(), 'POST');
Map<String,Object> item1Fields = new Map<String,Object>();
item1Fields.put('Product2Id',       PROD1_ID);
item1Fields.put('PricebookEntryId', PBE1_ID);
item1Fields.put('Quantity',         QTY1);
item1Fields.put('UnitPrice',  PRICE1);
item1Fields.put('ListPrice',  PRICE1);
item1Fields.put('Discount',   DISC1 * 100); // Discount field is 0–100 percent
item1Fields.put('OrderId',    '@{refOrder.id}');
item1.fieldValues = item1Fields;

// Line item 2
RevSalesTrxn.RecordResource item2 =
    new RevSalesTrxn.RecordResource(OrderItem.getSobjectType(), 'POST');
Map<String,Object> item2Fields = new Map<String,Object>();
item2Fields.put('Product2Id',       PROD2_ID);
item2Fields.put('PricebookEntryId', PBE2_ID);
item2Fields.put('Quantity',         QTY2);
item2Fields.put('UnitPrice',  PRICE2);
item2Fields.put('ListPrice',  PRICE2);
item2Fields.put('Discount',   DISC2 * 100); // Discount field is 0–100 percent
item2Fields.put('OrderId',    '@{refOrder.id}');
item2.fieldValues = item2Fields;

List<RevSalesTrxn.RecordWithReferenceRequest> records =
    new List<RevSalesTrxn.RecordWithReferenceRequest>();
records.add(new RevSalesTrxn.RecordWithReferenceRequest('refOrder', orderRecord));
records.add(new RevSalesTrxn.RecordWithReferenceRequest('refItem1', item1));
records.add(new RevSalesTrxn.RecordWithReferenceRequest('refItem2', item2));

RevSalesTrxn.GraphRequest graph =
    new RevSalesTrxn.GraphRequest('rmi_ref_order', records);

RevSalesTrxn.PlaceSalesTransactionResponse resp =
    RevSalesTrxn.PlaceSalesTransactionExecutor.execute(
        graph, pricingPref, configExec,
        new RevSalesTrxn.ConfigurationOptionsInput(),
        null, null, null, null
    );

if (resp != null && resp.graphs != null && !resp.graphs.isEmpty()) {
    RevSalesTrxn.GraphResponse gr = resp.graphs[0];
    if (gr.isSuccessful) {
        for (RevSalesTrxn.RecordWithReferenceResult r : gr.graphResponse.values()) {
            System.debug('PST_RESULT|' + r.referenceId + '|' + r.result);
        }
    } else {
        System.debug('PST_ERRORS|' + gr.errors);
    }
} else {
    System.debug('PST_NULL_RESPONSE');
}
