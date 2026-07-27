/**
 * Tests for the deployment.example.json config artifact.
 *
 * Validates Requirements 9.1 and 9.3:
 * - 9.1: The example file contains all three strategy examples.
 * - 9.3: ConfigLoader.validate() returns no errors for the example config.
 */

import * as fs from "fs";
import * as path from "path";
import { ConfigLoader } from "../lambda/ingestion/config-loader";

const EXAMPLE_PATH = path.resolve(
  __dirname,
  "../config/deployment.example.json",
);

describe("deployment.example.json artifact", () => {
  let exampleJson: unknown;

  beforeAll(() => {
    const raw = fs.readFileSync(EXAMPLE_PATH, "utf-8");
    exampleJson = JSON.parse(raw);
  });

  /**
   * Req 9.1 — The example file must contain at least one collection entry for
   * each of the three markdown strategies: content-blocks, rich-text, flat-fields.
   */
  it("contains all three strategy examples (Req 9.1)", () => {
    const config = exampleJson as {
      strapi?: { collections?: Array<{ markdownStrategy?: string }> };
    };

    const collections = config?.strapi?.collections ?? [];
    expect(collections.length).toBeGreaterThanOrEqual(3);

    const strategies = collections.map((c) => c.markdownStrategy);
    expect(strategies).toContain("content-blocks");
    expect(strategies).toContain("rich-text");
    expect(strategies).toContain("flat-fields");
  });

  /**
   * Req 9.3 — ConfigLoader.validate() must return no errors for the example
   * config (with placeholder values already structurally valid).
   */
  it("passes ConfigLoader.validate() without errors (Req 9.3)", () => {
    const result = ConfigLoader.validate(exampleJson);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
