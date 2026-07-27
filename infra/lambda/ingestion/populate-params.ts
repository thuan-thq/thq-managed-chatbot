/**
 * Builds URLSearchParams for Strapi populate query parameters from a PopulateConfig.
 *
 * Algorithm:
 * - If populate is undefined/null: return empty params (Req 2.4)
 * - If populate.wildcard === true: set populate=* and return (Req 2.1, 2.3)
 * - If populate.fields is non-empty: append each { key, value } pair (Req 2.2)
 * - Otherwise: return empty params (Req 2.4)
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4
 */

import type { PopulateConfig } from "./config-types";

/**
 * Pure function that converts a `PopulateConfig` into `URLSearchParams`
 * suitable for appending to a Strapi REST API request URL.
 *
 * @param populate - The populate configuration from a `StrapiCollectionConfig`,
 *   or `undefined` when the collection has no populate block.
 * @returns A `URLSearchParams` instance containing zero or more query parameters.
 */
export function buildPopulateParams(
  populate: PopulateConfig | undefined,
): URLSearchParams {
  const params = new URLSearchParams();

  if (populate == null) {
    return params;
  }

  if (populate.wildcard === true) {
    params.set("populate", "*");
    return params; // wildcard wins; ignore fields
  }

  if (populate.fields != null && populate.fields.length > 0) {
    for (const { key, value } of populate.fields) {
      params.append(key, value);
    }
  }

  return params;
}
