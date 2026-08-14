// Delete toolkit-created (RMI-%) Quotes that never became Orders.
// Keeps any RMI quote referenced by an Order; never touches non-RMI quotes.
Set<Id> keep = new Set<Id>();
for (Order o : [SELECT QuoteId FROM Order WHERE QuoteId != null]) keep.add(o.QuoteId);
List<Quote> toDelete = [SELECT Id FROM Quote WHERE Name LIKE 'RMI-%' AND Id NOT IN :keep];
System.debug('ORPHAN_RMI_QUOTES|' + toDelete.size());
if (!toDelete.isEmpty()) delete toDelete;
System.debug('DELETED_QUOTES|' + toDelete.size());
