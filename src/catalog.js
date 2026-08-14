import { query } from './org.js';

/**
 * Resolve the org's Standard Price Book Id at runtime.
 * The Id is org-specific, so it must not be hardcoded. Cached after first lookup.
 */
let _standardPricebookId = null;
export function getStandardPricebookId() {
  if (_standardPricebookId) return _standardPricebookId;
  const rows = query(`SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1`);
  if (!rows.length) {
    throw new Error('No standard Price Book found in the target org.');
  }
  _standardPricebookId = rows[0].Id;
  return _standardPricebookId;
}

/**
 * Resolve the org's corporate currency ISO code (multi-currency orgs only).
 * Returns the ISO code, or null for single-currency orgs. Cached.
 */
let _corporateCurrency; // undefined = unresolved, null = single-currency
export function getCorporateCurrency() {
  if (_corporateCurrency !== undefined) return _corporateCurrency;
  try {
    const rows = query(`SELECT IsoCode FROM CurrencyType WHERE IsCorporate = true AND IsActive = true LIMIT 1`);
    _corporateCurrency = rows.length ? rows[0].IsoCode : null;
  } catch (_) {
    _corporateCurrency = null; // single-currency org: CurrencyType not queryable
  }
  return _corporateCurrency;
}

/**
 * Fetch all ProductCatalog records from the org.
 * Returns [ { Id, Name } ]
 */
export function fetchCatalogs() {
  return query(`SELECT Id, Name FROM ProductCatalog ORDER BY Name`);
}

/**
 * Given a catalog Id, return all active products with their pricebook entries.
 * Returns [ { productId, productName, pricebookEntryId, unitPrice, psmoId } ]
 */
export function fetchProductPool(catalogId) {
  // Join through ProductCategoryProduct → ProductCategory → ProductCatalog
  const records = query(`
    SELECT
      pcp.ProductId,
      pcp.Product.Name,
      pcp.Product.IsActive
    FROM ProductCategoryProduct pcp
    WHERE pcp.ProductCategory.CatalogId = '${catalogId}'
      AND pcp.Product.IsActive = true
  `.trim().replace(/\s+/g, ' '));

  if (!records.length) return [];

  // Deduplicate product IDs (each product appears in main + subcategory)
  const seen = new Set();
  for (const r of records) seen.add(r.ProductId);

  // Batch the ID list into a SOQL IN clause
  const idList = [...seen].map(id => `'${id}'`).join(',');

  // Fetch PricebookEntry for each product (Standard Pricebook).
  // In multi-currency orgs, pin to the corporate currency so every line
  // matches the Quote currency (avoids FIELD_INTEGRITY currency mismatch).
  const STANDARD_PRICEBOOK_ID = getStandardPricebookId();
  const corpCurrency = getCorporateCurrency();
  const currencyFilter = corpCurrency ? ` AND CurrencyIsoCode = '${corpCurrency}'` : '';
  const pbeRecords = query(
    `SELECT Id, Product2Id, UnitPrice FROM PricebookEntry WHERE Product2Id IN (${idList}) AND Pricebook2Id = '${STANDARD_PRICEBOOK_ID}' AND IsActive = true${currencyFilter}`
  );

  // Fetch default ProductSellingModelOption for each product, including the
  // ProductSellingModel Id + term details. The selling model must be set on
  // each QuoteLineItem and drives the billing frequency / term the pricing
  // procedure requires (derived from a real quote's line items).
  const psmoRecords = query(
    `SELECT Id, Product2Id, ProductSellingModelId, ProductSellingModel.SellingModelType, ProductSellingModel.PricingTerm, ProductSellingModel.PricingTermUnit FROM ProductSellingModelOption WHERE Product2Id IN (${idList}) AND IsDefault = true`
  );

  const pbeByProduct = {};
  for (const p of pbeRecords) pbeByProduct[p.Product2Id] = p;

  const psmoByProduct = {};
  for (const p of psmoRecords) psmoByProduct[p.Product2Id] = p;

  const pool = [];
  for (const r of records) {
    if (seen.has(r.ProductId)) {
      const pbe = pbeByProduct[r.ProductId];
      const psmo = psmoByProduct[r.ProductId];
      if (pbe && psmo) {
        pool.push({
          productId: r.ProductId,
          productName: r.Product?.Name ?? r.ProductId,
          pricebookEntryId: pbe.Id,
          unitPrice: pbe.UnitPrice,
          psmoId: psmo.Id,
          sellingModelId: psmo.ProductSellingModelId ?? null,
          sellingModelType: psmo.ProductSellingModel?.SellingModelType ?? null,
          pricingTerm: psmo.ProductSellingModel?.PricingTerm ?? 1,
          pricingTermUnit: psmo.ProductSellingModel?.PricingTermUnit ?? null,
        });
        seen.delete(r.ProductId); // prevent duplicate pool entries
      }
    }
  }

  return pool;
}

/**
 * Merge product pools from multiple catalogs, deduplicating by productId.
 */
export function mergeProductPools(pools) {
  const seen = new Set();
  const merged = [];
  for (const pool of pools) {
    for (const p of pool) {
      if (!seen.has(p.productId)) {
        seen.add(p.productId);
        merged.push(p);
      }
    }
  }
  return merged;
}

/**
 * Pick N random distinct items from an array.
 */
export function pickRandom(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

/**
 * Enrich a list of product IDs with Standard-Pricebook PricebookEntry and
 * default ProductSellingModelOption data. Returns a map keyed by productId.
 * Products lacking an active PBE (in the corporate currency) or a default
 * PSMO are omitted — PST cannot price them.
 */
export function enrichProducts(productIds) {
  const ids = [...new Set(productIds)];
  if (!ids.length) return {};
  const idList = ids.map(id => `'${id}'`).join(',');
  const STANDARD_PRICEBOOK_ID = getStandardPricebookId();
  const corpCurrency = getCorporateCurrency();
  const currencyFilter = corpCurrency ? ` AND CurrencyIsoCode = '${corpCurrency}'` : '';

  const pbeRecords = query(
    `SELECT Id, Product2Id, UnitPrice FROM PricebookEntry WHERE Product2Id IN (${idList}) AND Pricebook2Id = '${STANDARD_PRICEBOOK_ID}' AND IsActive = true${currencyFilter}`
  );
  const psmoRecords = query(
    `SELECT Id, Product2Id, ProductSellingModelId, ProductSellingModel.SellingModelType, ProductSellingModel.PricingTerm, ProductSellingModel.PricingTermUnit FROM ProductSellingModelOption WHERE Product2Id IN (${idList}) AND IsDefault = true`
  );

  const pbeByProduct = {};
  for (const p of pbeRecords) pbeByProduct[p.Product2Id] = p;
  const psmoByProduct = {};
  for (const p of psmoRecords) psmoByProduct[p.Product2Id] = p;

  const out = {};
  for (const id of ids) {
    const pbe = pbeByProduct[id];
    const psmo = psmoByProduct[id];
    if (!pbe || !psmo) continue;
    out[id] = {
      productId: id,
      pricebookEntryId: pbe.Id,
      unitPrice: pbe.UnitPrice,
      psmoId: psmo.Id,
      sellingModelId: psmo.ProductSellingModelId ?? null,
      sellingModelType: psmo.ProductSellingModel?.SellingModelType ?? null,
      pricingTerm: psmo.ProductSellingModel?.PricingTerm ?? 1,
      pricingTermUnit: psmo.ProductSellingModel?.PricingTermUnit ?? null,
    };
  }
  return out;
}

/**
 * Return the set of Product2 Ids that are PROVEN to sell + convert + activate as
 * STANDALONE lines — i.e. products already present as top-level (non-bundle-child)
 * items on activated Orders. A product's billing treatment can reject an explicit
 * BillingFrequency in a standalone context (it may only be valid as a bundle
 * component), so flat "standalone from the bundle" orders must be limited to this
 * proven set to stay convertible. Returns a Set<string> of product Ids.
 */
export function fetchProvenStandaloneProductIds() {
  const ids = new Set();
  try {
    const rows = query(
      `SELECT Product2Id FROM OrderItem WHERE ParentOrderItemId = null AND Order.Status = 'Activated' AND Product2Id != null`
    );
    for (const r of rows) ids.add(r.Product2Id);
  } catch (_) { /* ignore */ }
  return ids;
}

/**
 * Fetch a configurable bundle and its allowed child components, modeled on a
 * real quote (e.g. "QuantumBit Complete Solution"). The bundle's allowed
 * children come from ProductRelatedComponent; each is enriched with pricing.
 *
 * Returns { bundle, components } where:
 *   bundle     = enriched pool item + { productName, isBundle:true }
 *   components = [ enriched item + { productName, group, isDefault,
 *                 quantityEditable, defaultQuantity } ]
 * Components (and the bundle) that cannot be priced are dropped/rejected.
 */
export function fetchBundlePool(bundleName) {
  const safeName = bundleName.replace(/'/g, "\\'");
  const prod = query(
    `SELECT Id, Name, Type FROM Product2 WHERE Name = '${safeName}' AND IsActive = true LIMIT 1`
  );
  if (!prod.length) throw new Error(`Bundle product not found: ${bundleName}`);
  const bundleId = prod[0].Id;

  const prc = query(
    `SELECT Id, ChildProductId, ChildProduct.Name, ChildProduct.Type, ChildProduct.ConfigureDuringSale, ProductComponentGroup.Name, ProductRelationshipTypeId, MinQuantity, MaxQuantity, Quantity, IsDefaultComponent, IsQuantityEditable FROM ProductRelatedComponent WHERE ParentProductId = '${bundleId}'`
  );

  const childIds = prc.map(r => r.ChildProductId);
  const enriched = enrichProducts([bundleId, ...childIds]);

  const bundle = enriched[bundleId];
  if (!bundle) {
    throw new Error(`Bundle "${bundleName}" has no priceable PricebookEntry/PSMO in the corporate currency.`);
  }
  bundle.productName = prod[0].Name;
  bundle.isBundle = true;

  const components = [];
  const seenChild = new Set();
  for (const r of prc) {
    const e = enriched[r.ChildProductId];
    if (!e) continue;                       // not priceable — skip
    if (seenChild.has(r.ChildProductId)) continue; // dedupe repeats
    seenChild.add(r.ChildProductId);
    const childType = r.ChildProduct?.Type ?? null;
    components.push({
      ...e,
      productName: r.ChildProduct?.Name ?? r.ChildProductId,
      group: r.ProductComponentGroup?.Name ?? 'Ungrouped',
      isDefault: !!r.IsDefaultComponent,
      quantityEditable: !!r.IsQuantityEditable,
      defaultQuantity: r.Quantity ?? null,
      prcId: r.Id,                                   // ProductRelatedComponent Id
      relationshipTypeId: r.ProductRelationshipTypeId ?? null,
      // A component can itself be a bundle/configurable product (nested bundle);
      // such products can't be sold as a flat standalone line (they need
      // configuration), so flag them to keep them out of the flat pool.
      isConfigurable: childType === 'Bundle' || r.ChildProduct?.ConfigureDuringSale === 'Allowed',
    });
  }
  return { bundle, components };
}
