/**
 * Unit tests for markdown-converter content-types module.
 * Task 8.5 - updated to match old export service format
 */

import {
  convertPage,
  convertTeam,
  convertPerson,
} from "../../lambda/ingestion/markdown-converter/content-types";

describe("convertPage", () => {
  it("produces expected markdown sections from full fixture", () => {
    const data = {
      title: "About Us",
      slug: "about-us",
      id: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-02-01T00:00:00.000Z",
      publishedAt: "2024-01-05T00:00:00.000Z",
      summary: "This page describes our company.",
      content_blocks: [
        {
          __component: "dynamic.text-block",
          text: "Welcome to the about page.",
        },
      ],
    };

    const result = convertPage(
      data,
      "https://staging.intranet.think-hq.com.au",
    );

    // H1 title
    expect(result).toContain("# About Us");

    // Metadata
    expect(result).toContain("**Content Type:** page");
    expect(result).toContain("**Slug:** about-us");
    expect(result).toContain(
      "**View online:** https://staging.intranet.think-hq.com.au/about-us",
    );

    // Summary
    expect(result).toContain("## Summary");
    expect(result).toContain("This page describes our company.");

    // Content blocks rendered
    expect(result).toContain("## Content");
    expect(result).toContain("Welcome to the about page.");
  });
});

describe("convertTeam", () => {
  it("produces expected markdown sections from fixture", () => {
    const data = {
      name: "Engineering",
      slug: "engineering",
      id: 5,
      summary: "The engineering team builds great products.",
      intranet_people: {
        data: [
          {
            attributes: {
              display_name: "Alice Smith",
              slug: "alice-smith",
              job_title: "Senior Engineer",
            },
          },
          {
            attributes: {
              display_name: "Bob Jones",
              slug: "bob-jones",
              job_title: "Tech Lead",
            },
          },
        ],
      },
      content_blocks: [
        {
          __component: "dynamic.text-block",
          text: "Our team focuses on innovation.",
        },
      ],
    };

    const result = convertTeam(
      data,
      "https://staging.intranet.think-hq.com.au",
    );

    // H1 team name
    expect(result).toContain("# Engineering");

    // Metadata
    expect(result).toContain("**Content Type:** team");
    expect(result).toContain(
      "**View online:** https://staging.intranet.think-hq.com.au/team/engineering",
    );

    // Summary
    expect(result).toContain("## About");
    expect(result).toContain("The engineering team builds great products.");

    // Team members (from intranet_people relation)
    expect(result).toContain("## Team Members");
    expect(result).toContain(
      "[Alice Smith](/people/alice-smith) - Senior Engineer",
    );
    expect(result).toContain("[Bob Jones](/people/bob-jones) - Tech Lead");

    // Content blocks
    expect(result).toContain("## Additional Content");
    expect(result).toContain("Our team focuses on innovation.");
  });
});

describe("convertPerson", () => {
  it("produces expected markdown sections from fixture", () => {
    const data = {
      display_name: "Jane Doe",
      slug: "jane-doe",
      job_title: "Product Manager",
      intranet_team: {
        data: {
          attributes: {
            name: "Product",
            slug: "product",
          },
        },
      },
      bio: "Jane has 10 years of experience in product management.",
      email: "jane.doe@example.com",
      phone: "+61 400 000 000",
      location: "Melbourne",
      content_blocks: [
        {
          __component: "dynamic.text-block",
          text: "Currently leading the new platform initiative.",
        },
      ],
    };

    const result = convertPerson(
      data,
      "https://staging.intranet.think-hq.com.au",
    );

    // H1 display name
    expect(result).toContain("# Jane Doe");

    // Source URL
    expect(result).toContain(
      "**View online:** https://staging.intranet.think-hq.com.au/people/jane-doe",
    );

    // Job title
    expect(result).toContain("**Role:** Product Manager");

    // Team (from intranet_team relation with link)
    expect(result).toContain("**Team:** [Product](/team/product)");

    // Biography
    expect(result).toContain("## Biography");
    expect(result).toContain(
      "Jane has 10 years of experience in product management.",
    );

    // Contact
    expect(result).toContain("## Contact");
    expect(result).toContain("**Email:** jane.doe@example.com");
    expect(result).toContain("**Phone:** +61 400 000 000");
    expect(result).toContain("**Location:** Melbourne");

    // Content blocks
    expect(result).toContain("## Additional Information");
    expect(result).toContain("Currently leading the new platform initiative.");
  });
});
