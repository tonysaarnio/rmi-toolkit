// One-off: set CurrencyIsoCode = 'USD' on all accounts in the org.
List<Account> accs = [SELECT Id, CurrencyIsoCode FROM Account];
List<Account> toUpdate = new List<Account>();
for (Account a : accs) {
  if (a.CurrencyIsoCode != 'USD') {
    a.CurrencyIsoCode = 'USD';
    toUpdate.add(a);
  }
}
if (!toUpdate.isEmpty()) update toUpdate;
System.debug('ACCOUNTS_TOTAL|' + accs.size());
System.debug('ACCOUNTS_UPDATED|' + toUpdate.size());
