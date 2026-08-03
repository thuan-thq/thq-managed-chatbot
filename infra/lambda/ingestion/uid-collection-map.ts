/**
 * UidCollectionMap helpers for webhook normalisation.
 *
 * Builds and queries a map from Strapi content-type UIDs to REST API
 * collection names, used by the webhook handler to route incoming events
 * to the correct collection pipeline without hard-coded mappings.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { StrapiCollectionConfig } from "./config-types";

/**
 * Builds a map from `strapiUid` → `name` for every collection in the config.
 *
 * The map contains exactly one entry per collection — no extras, no omissions.
 * Requirement 5.1, 5.3.
 *
 * @param collections - The `StrapiCollectionConfig` array from `ClientConfig.strapi.collections`
 * @returns A `Map<strapiUid, name>` covering every configured collection
 */
export function buildUidCollectionMap(
  collections: StrapiCollectionConfig[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const collection of collections) {
    map.set(collection.strapiUid, collection.name);
  }
  return map;
}

/**
 * Looks up a Strapi content-type UID in the given `UidCollectionMap`.
 *
 * Behaviour:
 * - If `uid` does not start with `api::`, logs a structured WARN entry and
 *   returns `undefined` (Requirement 5.5).
 * - If `uid` starts with `api::` but is not found in the map, logs a
 *   structured WARN entry and returns `undefined` (Requirement 5.4).
 * - Otherwise returns the mapped collection `name`.
 *
 * @param map  - The `UidCollectionMap` built by `buildUidCollectionMap`
 * @param uid  - The raw UID value from the incoming Strapi webhook payload
 * @returns The collection `name`, or `undefined` when the UID is unrecognised
 */
export function lookupCollection(
  map: Map<string, string>,
  uid: string,
): string | undefined {
  if (!uid.startsWith("api::")) {
    console.log(
      JSON.stringify({
        level: "WARN",
        message: "Skipping non-api:: Strapi uid - collection unknown",
        uid,
      }),
    );
    return undefined;
  }

  const name = map.get(uid);
  if (name === undefined) {
    console.log(
      JSON.stringify({
        level: "WARN",
        message: "Unrecognised Strapi uid - collection unknown",
        uid,
      }),
    );
    return undefined;
  }

  return name;
}
