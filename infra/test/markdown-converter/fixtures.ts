/**
 * Strapi API response fixtures for integration tests.
 *
 * Provides realistic fixture data matching Strapi v4 API response format
 * for intranet-pages, intranet-teams, and intranet-people collections
 * with content_blocks dynamic zones.
 */

export const pageFixture = {
  id: 1,
  attributes: {
    title: "About Us",
    slug: "about-us",
    summary: "Learn about our company and values.",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-15T00:00:00.000Z",
    publishedAt: "2024-01-05T00:00:00.000Z",
    content_blocks: [
      {
        __component: "dynamic.text-block",
        text: "Welcome to our company page.",
      },
      {
        __component: "dynamic.accordion",
        items: [
          {
            __component: "",
            title: "Our Mission",
            summary: "To innovate and lead.",
          },
        ],
      },
    ],
  },
};

export const teamFixture = {
  id: 5,
  attributes: {
    name: "Engineering",
    slug: "engineering",
    summary: "The engineering team builds and maintains our products.",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-02-01T00:00:00.000Z",
    members: [
      { displayName: "Alice Smith", jobTitle: "Senior Engineer" },
      { displayName: "Bob Jones", jobTitle: "Tech Lead" },
    ],
    content_blocks: [
      {
        __component: "dynamic.text-block",
        text: "Our team focuses on quality.",
      },
    ],
  },
};

export const personFixture = {
  id: 10,
  attributes: {
    displayName: "Jane Doe",
    firstName: "Jane",
    lastName: "Doe",
    jobTitle: "Product Manager",
    team: { name: "Product" },
    biography: "Jane has 10 years of experience.",
    email: "jane@example.com",
    phone: "+61 400 000 000",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-03-01T00:00:00.000Z",
    content_blocks: [],
  },
};

/** Page fixture without a slug (for title-based path derivation). */
export const pageFixtureNoSlug = {
  id: 2,
  attributes: {
    title: "New Announcement",
    summary: "Important update for all staff.",
    createdAt: "2024-02-01T00:00:00.000Z",
    updatedAt: "2024-02-10T00:00:00.000Z",
    publishedAt: "2024-02-05T00:00:00.000Z",
    content_blocks: [
      {
        __component: "dynamic.text-block",
        text: "This is an important announcement.",
      },
    ],
  },
};

/** Page fixture with neither slug nor title (for recordId fallback path derivation). */
export const pageFixtureNoSlugNoTitle = {
  id: 3,
  attributes: {
    createdAt: "2024-03-01T00:00:00.000Z",
    updatedAt: "2024-03-10T00:00:00.000Z",
    content_blocks: [
      { __component: "dynamic.text-block", text: "Minimal content." },
    ],
  },
};

/** Wraps a fixture entry in a Strapi v4 single-entry API response. */
export function wrapSingleResponse(entry: {
  id: number | string;
  attributes: Record<string, unknown>;
}) {
  return { data: entry };
}

/** Wraps fixture entries in a Strapi v4 list API response. */
export function wrapListResponse(
  entries: Array<{ id: number | string; attributes: Record<string, unknown> }>,
  pagination: {
    page: number;
    pageSize: number;
    pageCount: number;
    total: number;
  },
) {
  return {
    data: entries,
    meta: { pagination },
  };
}
