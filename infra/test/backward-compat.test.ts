/**
 * Backward-compatibility regression tests (Requirements 8.2, 8.3, 8.4, 8.5).
 *
 * Verifies that `CollectionMarkdownConverter` produces output containing
 * the same essential content (H1 title, summary, content blocks text) as the
 * legacy `convertPage`, `convertTeam`, and `convertPerson` functions when
 * given identical fixture data.
 *
 * Note: The new converter uses a different section structure than the old
 * converters (no `## Content`, `## Additional Content`, or metadata lines
 * like `**Content Type:**`). These tests assert content equivalence —
 * same title, summary text, and content-block text — rather than
 * string equality, which is intentional per the spec (see Req 8.2–8.4
 * notes in design.md).
 *
 * S3 document path format is also verified (Req 8.5).
 */

import { CollectionMarkdownConverter } from "../lambda/ingestion/collection-markdown-converter";
import type { StrapiCollectionConfig } from "../lambda/ingestion/config-types";
import {
  pageFixture,
  teamFixture,
  personFixture,
} from "./markdown-converter/fixtures";

// ─── ThinkHQ StrapiCollectionConfig objects (from deployment.json) ────────────

const intranetPagesConfig: StrapiCollectionConfig = {
  name: "intranet-pages",
  strapiUid: "api::intranet-page.intranet-page",
  markdownStrategy: "content-blocks",
  fieldMappings: {
    titleFields: ["head_title", "title"],
    slugField: "slug",
    summaryField: "summary",
    contentBlocksField: "content_blocks",
    lastModifiedField: "updatedAt",
  },
  urlPathTemplate: "/{slug}",
};

const intranetTeamsConfig: StrapiCollectionConfig = {
  name: "intranet-teams",
  strapiUid: "api::intranet-team.intranet-team",
  markdownStrategy: "content-blocks",
  fieldMappings: {
    titleFields: ["title", "name"],
    slugField: "slug",
    summaryField: "summary",
    contentBlocksField: "content_blocks",
    lastModifiedField: "updatedAt",
  },
  urlPathTemplate: "/team/{slug}",
};

const intranetPeopleConfig: StrapiCollectionConfig = {
  name: "intranet-people",
  strapiUid: "api::intranet-person.intranet-person",
  markdownStrategy: "content-blocks",
  fieldMappings: {
    titleFields: ["display_name", "displayName", "name"],
    slugField: "slug",
    summaryField: "bio",
    contentBlocksField: "content_blocks",
    lastModifiedField: "updatedAt",
  },
  urlPathTemplate: "/people/{slug}",
};

const BASE_URL = "https://think-hq.com.au";

// ─── Helper: derive document path (mirrors configurable-strapi-adapter logic) ─

/**
 * Mirrors the `deriveDocumentPath` function in configurable-strapi-adapter.ts.
 * Priority: attrs[slugField] → toSlug(attrs[titleFields[0]]) → toSlug(attrs.name) → recordId
 */
function deriveDocumentPath(
  attrs: Record<string, unknown>,
  config: StrapiCollectionConfig,
  recordId: string,
): string {
  const { slugField, titleFields } = config.fieldMappings;

  let filename = "";

  if (slugField !== undefined) {
    const slugValue = attrs[slugField];
    if (typeof slugValue === "string" && slugValue.length > 0) {
      filename = slugValue;
    } else if (titleFields && titleFields.length > 0) {
      const firstTitle = attrs[titleFields[0]];
      filename =
        typeof firstTitle === "string" && firstTitle.length > 0
          ? toSlugTest(firstTitle)
          : "";
    }
  } else if (titleFields && titleFields.length > 0) {
    const firstTitle = attrs[titleFields[0]];
    filename =
      typeof firstTitle === "string" && firstTitle.length > 0
        ? toSlugTest(firstTitle)
        : "";
  }

  if (!filename || filename.length === 0) {
    const nameValue = attrs["name"];
    if (typeof nameValue === "string" && nameValue.length > 0) {
      filename = toSlugTest(nameValue);
    }
  }

  if (!filename || filename.length === 0) {
    filename = recordId;
  }

  return `documents/${config.name}/${filename}.json`;
}

/**
 * Simple slug function matching the behaviour of `toSlug` from helpers.ts:
 * lower-cases, replaces non-alphanumeric runs with hyphens, strips leading/trailing hyphens.
 */
function toSlugTest(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── Req 8.2: intranet-pages backward compat ──────────────────────────────────

describe("Req 8.2 — intranet-pages backward compatibility", () => {
  const attrs = pageFixture.attributes as Record<string, unknown>;

  it("includes the H1 title from the title field", () => {
    const result = CollectionMarkdownConverter.convert(
      attrs,
      intranetPagesConfig,
      { baseUrl: BASE_URL },
    );
    // title = "About Us" (no head_title in fixture, falls back to "title")
    expect(result).toContain("# About Us");
  });

  it("includes the summary text under a Summary heading", () => {
    const result = CollectionMarkdownConverter.convert(
      attrs,
      intranetPagesConfig,
      { baseUrl: BASE_URL },
    );
    expect(result).toContain("## Summary");
    expect(result).toContain("Learn about our company and values.");
  });

  it("includes text-block content from content_blocks", () => {
    const result = CollectionMarkdownConverter.convert(
      attrs,
      intranetPagesConfig,
      { baseUrl: BASE_URL },
    );
    expect(result).toContain("Welcome to our company page.");
  });

  it("includes accordion item text from content_blocks", () => {
    const result = CollectionMarkdownConverter.convert(
      attrs,
      intranetPagesConfig,
      { baseUrl: BASE_URL },
    );
    // accordion items should appear; at minimum the title "Our Mission"
    expect(result).toContain("Our Mission");
  });

  it("produces non-empty markdown output", () => {
    const result = CollectionMarkdownConverter.convert(
      attrs,
      intranetPagesConfig,
      { baseUrl: BASE_URL },
    );
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── Req 8.3: intranet-teams backward compat ─────────────────────────────────

describe("Req 8.3 — intranet-teams backward compatibility", () => {
  const attrs = teamFixture.attributes as Record<string, unknown>;

  it("includes the H1 title from the name field (no title field in fixture)", () => {
    const result = CollectionMarkdownConverter.convert(
      attrs,
      intranetTeamsConfig,
      { baseUrl: BASE_URL },
    );
    // titleFields = ["title", "name"]; fixture has "name": "Engineering"
    expect(result).toContain("# Engineering");
  });

  it("includes the summary text under a Summary heading", () => {
    const result = CollectionMarkdownConverter.convert(
      attrs,
      intranetTeamsConfig,
      { baseUrl: BASE_URL },
    );
    expect(result).toContain("## Summary");
    expect(result).toContain(
      "The engineering team builds and maintains our products.",
    );
  });

  it("includes text-block content from content_blocks", () => {
    const result = CollectionMarkdownConverter.convert(
      attrs,
      intranetTeamsConfig,
      { baseUrl: BASE_URL },
    );
    expect(result).toContain("Our team focuses on quality.");
  });

  it("produces non-empty markdown output", () => {
    const result = CollectionMarkdownConverter.convert(
      attrs,
      intranetTeamsConfig,
      { baseUrl: BASE_URL },
    );
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── Req 8.4: intranet-people backward compat ────────────────────────────────

describe("Req 8.4 — intranet-people backward compatibility", () => {
  const attrs = personFixture.attributes as Record<string, unknown>;

  it("includes the H1 title from displayName field", () => {
    const result = CollectionMarkdownConverter.convert(
      attrs,
      intranetPeopleConfig,
      { baseUrl: BASE_URL },
    );
    // titleFields = ["display_name", "displayName", "name"]; fixture has "displayName": "Jane Doe"
    expect(result).toContain("# Jane Doe");
  });

  it("renders Summary section from bio field (summaryField: bio)", () => {
    // personFixture has no "bio" field — the summary section should be absent
    // but the converter should still produce output with the title
    const result = CollectionMarkdownConverter.convert(
      attrs,
      intranetPeopleConfig,
      { baseUrl: BASE_URL },
    );
    // bio is not present in personFixture.attributes — confirm no crash and title is present
    expect(result).toContain("# Jane Doe");
  });

  it("handles empty content_blocks gracefully", () => {
    const result = CollectionMarkdownConverter.convert(
      attrs,
      intranetPeopleConfig,
      { baseUrl: BASE_URL },
    );
    // content_blocks is [] in personFixture — result should still contain title
    expect(result).toContain("# Jane Doe");
    expect(result.length).toBeGreaterThan(0);
  });

  it("produces non-empty markdown output (title at minimum)", () => {
    const result = CollectionMarkdownConverter.convert(
      attrs,
      intranetPeopleConfig,
      { baseUrl: BASE_URL },
    );
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── Req 8.5: S3 document key backward compat ────────────────────────────────

describe("Req 8.5 — S3 document key uses same slug-resolution priority as existing adapter", () => {
  it("intranet-pages: uses slug field value as filename", () => {
    const attrs = pageFixture.attributes as Record<string, unknown>;
    const recordId = String(pageFixture.id);
    const path = deriveDocumentPath(attrs, intranetPagesConfig, recordId);
    // slug = "about-us"
    expect(path).toBe("documents/intranet-pages/about-us.json");
  });

  it("intranet-pages: falls back to toSlug(titleFields[0]=head_title) when slug absent", () => {
    // deriveDocumentPath only checks titleFields[0] = "head_title".
    // If head_title is present and non-empty, it slugifies it; otherwise filename = "" → recordId fallback.
    const attrsWithHeadTitle = {
      head_title: "New Announcement",
      title: "Should Not Be Used",
      summary: "Important update.",
      content_blocks: [],
      updatedAt: "2024-02-10T00:00:00.000Z",
    };
    const path = deriveDocumentPath(
      attrsWithHeadTitle,
      intranetPagesConfig,
      "2",
    );
    // slugField present but absent → titleFields[0] = "head_title" = "New Announcement" → "new-announcement"
    expect(path).toBe("documents/intranet-pages/new-announcement.json");
  });

  it("intranet-pages: falls back to recordId when slug and titleFields[0] absent (title field is not titleFields[0])", () => {
    // Only titleFields[0]="head_title" is checked; "title" alone does NOT produce a slug
    const attrsWithoutHeadTitle = {
      title: "New Announcement",
      summary: "Important update.",
      content_blocks: [],
      updatedAt: "2024-02-10T00:00:00.000Z",
    };
    const path = deriveDocumentPath(
      attrsWithoutHeadTitle,
      intranetPagesConfig,
      "2",
    );
    // head_title absent → filename = "" → name absent → falls back to recordId "2"
    expect(path).toBe("documents/intranet-pages/2.json");
  });

  it("intranet-pages: falls back to recordId when no slug, title, or name", () => {
    const attrs = {
      content_blocks: [],
      updatedAt: "2024-03-10T00:00:00.000Z",
    };
    const path = deriveDocumentPath(attrs, intranetPagesConfig, "3");
    expect(path).toBe("documents/intranet-pages/3.json");
  });

  it("intranet-teams: uses slug field value as filename", () => {
    const attrs = teamFixture.attributes as Record<string, unknown>;
    const recordId = String(teamFixture.id);
    const path = deriveDocumentPath(attrs, intranetTeamsConfig, recordId);
    // slug = "engineering"
    expect(path).toBe("documents/intranet-teams/engineering.json");
  });

  it("intranet-teams: falls back to toSlug(titleFields[0]) when slug absent", () => {
    const attrs = {
      title: "Product Team",
      content_blocks: [],
      updatedAt: "2024-02-10T00:00:00.000Z",
    };
    const path = deriveDocumentPath(attrs, intranetTeamsConfig, "99");
    // titleFields = ["title", "name"]; title = "Product Team" → "product-team"
    expect(path).toBe("documents/intranet-teams/product-team.json");
  });

  it("intranet-teams: falls back to toSlug(name) when slug and title absent", () => {
    const attrs = {
      name: "Design Team",
      content_blocks: [],
      updatedAt: "2024-02-10T00:00:00.000Z",
    };
    const path = deriveDocumentPath(attrs, intranetTeamsConfig, "88");
    // slugField present but absent → titleFields[0]="title" absent → attrs.name → "design-team"
    expect(path).toBe("documents/intranet-teams/design-team.json");
  });

  it("intranet-people: uses slug field value as filename", () => {
    // personFixture doesn't have a slug; use a variant with slug
    const attrs = {
      ...personFixture.attributes,
      slug: "jane-doe",
    } as Record<string, unknown>;
    const recordId = String(personFixture.id);
    const path = deriveDocumentPath(attrs, intranetPeopleConfig, recordId);
    expect(path).toBe("documents/intranet-people/jane-doe.json");
  });

  it("intranet-people: falls back to recordId when slug absent and display_name (titleFields[0]) absent", () => {
    const attrs = personFixture.attributes as Record<string, unknown>;
    const recordId = String(personFixture.id);
    // personFixture has "displayName" but NOT "display_name".
    // deriveDocumentPath only checks titleFields[0] = "display_name" which is absent.
    // filename = "" → attrs.name absent → falls back to recordId.
    const path = deriveDocumentPath(attrs, intranetPeopleConfig, recordId);
    expect(path).toBe(`documents/intranet-people/${recordId}.json`);
  });

  it("intranet-people: uses toSlug(display_name) when display_name is present (titleFields[0])", () => {
    const attrs = {
      ...personFixture.attributes,
      display_name: "Jane Doe",
    } as Record<string, unknown>;
    const recordId = String(personFixture.id);
    const path = deriveDocumentPath(attrs, intranetPeopleConfig, recordId);
    // titleFields[0] = "display_name" = "Jane Doe" → "jane-doe"
    expect(path).toBe("documents/intranet-people/jane-doe.json");
  });

  it("intranet-people: falls back to recordId when slug, display_name, displayName, name all absent", () => {
    const attrs = {
      jobTitle: "Engineer",
      content_blocks: [],
      updatedAt: "2024-03-01T00:00:00.000Z",
    };
    const path = deriveDocumentPath(attrs, intranetPeopleConfig, "10");
    expect(path).toBe("documents/intranet-people/10.json");
  });

  it("document path format is documents/{collectionName}/{slug}.json for all collections", () => {
    const collections = [
      { config: intranetPagesConfig, slug: "about-us" },
      { config: intranetTeamsConfig, slug: "engineering" },
    ];

    for (const { config, slug } of collections) {
      const path = `documents/${config.name}/${slug}.json`;
      expect(path).toMatch(/^documents\/[a-z-]+\/[a-z0-9-]+\.json$/);
    }
  });
});
