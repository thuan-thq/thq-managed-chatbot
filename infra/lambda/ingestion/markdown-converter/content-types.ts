/**
 * Content type converters - convertPage, convertTeam, convertPerson.
 *
 * Each function produces page-level markdown for its respective Strapi
 * collection (intranet-pages, intranet-teams, intranet-people).
 * Mirrors the old export service (lib/export/converters/content-types.ts)
 * to produce identical markdown output for Bedrock KB.
 *
 * URL path structure per collection:
 * - Pages: {baseUrl}/{slug} (or {baseUrl}/initiatives/{slug} for initiatives)
 * - Teams: {baseUrl}/team/{slug}
 * - People: {baseUrl}/people/{slug}
 */

import type { ContentBlock } from "./types";
import {
  formatMetadata,
  extractTitle,
  cleanMarkdownText,
  formatImage,
} from "./helpers";
import { convertContentBlock } from "./content-blocks";

// ─── Page Converter ──────────────────────────────────────────────────────────

/**
 * Converts intranet-pages entries to markdown.
 * Based on: (pages)/[slug]/page.tsx and initiatives/[slug]/page.tsx
 */
export function convertPage(
  data: Record<string, unknown>,
  baseUrl?: string,
): string {
  let md = "";

  // Title - use head_title array if available (matches frontend)
  const headTitle = data["head_title"];
  if (Array.isArray(headTitle) && headTitle.length > 0) {
    md += `# ${headTitle.join(" ")}\n\n`;
  } else {
    md += `# ${extractTitle(data)}\n\n`;
  }

  // Build source URL
  const slug = data["slug"];
  const isInitiative = data["is_initiative"];
  let sourceUrl: string | undefined;
  if (typeof slug === "string" && slug.length > 0 && baseUrl) {
    sourceUrl = isInitiative
      ? `${baseUrl}/initiatives/${slug}`
      : `${baseUrl}/${slug}`;
  }

  // Metadata
  md += formatMetadata(data, "page", sourceUrl);

  // Summary
  const summary = data["summary"];
  if (typeof summary === "string" && summary.length > 0) {
    md += `## Summary\n\n${cleanMarkdownText(summary)}\n\n`;
  }

  // Main Content Blocks
  const contentBlocks = data["content_blocks"];
  if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
    md += `## Content\n\n`;
    for (const block of contentBlocks) {
      const blockMd = convertContentBlock(block as ContentBlock);
      if (blockMd) md += blockMd + "\n";
    }
  }

  // Sidebar Blocks
  const sidebarBlocks = data["sidebar_blocks"];
  if (Array.isArray(sidebarBlocks) && sidebarBlocks.length > 0) {
    md += `## Sidebar\n\n`;
    for (const block of sidebarBlocks) {
      const blockMd = convertContentBlock(block as ContentBlock);
      if (blockMd) md += blockMd + "\n";
    }
  }

  return md;
}

// ─── Team Converter ──────────────────────────────────────────────────────────

/**
 * Converts intranet-teams entries to markdown.
 * Based on: team/[slug]/page.tsx
 */
export function convertTeam(
  data: Record<string, unknown>,
  baseUrl?: string,
): string {
  let md = "";

  // Title
  md += `# ${extractTitle(data)}\n\n`;

  // Build source URL
  const slug = data["slug"];
  const sourceUrl =
    typeof slug === "string" && slug.length > 0 && baseUrl
      ? `${baseUrl}/team/${slug}`
      : undefined;

  // Metadata
  md += formatMetadata(data, "team", sourceUrl);

  // Banner Graphic
  const bannerGraphic = data["banner_graphic"] as
    | Record<string, unknown>
    | undefined;
  if (bannerGraphic?.data) {
    const bannerAttrs = (bannerGraphic["data"] as Record<string, unknown>)?.[
      "attributes"
    ];
    if (bannerAttrs && typeof bannerAttrs === "object") {
      md += `## Banner\n\n${formatImage(bannerAttrs as Record<string, unknown>)}\n\n`;
    }
  }

  // Team Picture
  const teamPicture = data["team_picture"] as
    | Record<string, unknown>
    | undefined;
  if (teamPicture?.data) {
    const picAttrs = (teamPicture["data"] as Record<string, unknown>)?.[
      "attributes"
    ];
    if (picAttrs && typeof picAttrs === "object") {
      md += `## Team Photo\n\n${formatImage(picAttrs as Record<string, unknown>)}\n\n`;
    }
  }

  // Icon
  const icon = data["icon"] as Record<string, unknown> | undefined;
  if (icon?.data) {
    const iconAttrs = (icon["data"] as Record<string, unknown>)?.["attributes"];
    if (iconAttrs && typeof iconAttrs === "object") {
      md += `## Icon\n\n${formatImage(iconAttrs as Record<string, unknown>)}\n\n`;
    }
  }

  // Summary
  const summary = data["summary"];
  if (typeof summary === "string" && summary.length > 0) {
    md += `## About\n\n${cleanMarkdownText(summary)}\n\n`;
  }

  // Team Members (from intranet_people relation)
  const intranetPeople = data["intranet_people"] as
    | Record<string, unknown>
    | undefined;
  const peopleData = intranetPeople?.data;
  if (Array.isArray(peopleData) && peopleData.length > 0) {
    md += `## Team Members\n\n`;
    for (const person of peopleData) {
      const attrs = (person as Record<string, unknown>)?.attributes as
        | Record<string, unknown>
        | undefined;
      if (attrs) {
        const name =
          attrs["display_name"] || attrs["name"] || attrs["displayName"];
        const personSlug = attrs["slug"];
        if (typeof name === "string" && typeof personSlug === "string") {
          md += `- [${name}](/people/${personSlug})`;
          const jobTitle = attrs["job_title"] || attrs["jobTitle"];
          if (typeof jobTitle === "string") md += ` - ${jobTitle}`;
          md += "\n";
        } else if (typeof name === "string") {
          md += `- ${name}`;
          const jobTitle = attrs["job_title"] || attrs["jobTitle"];
          if (typeof jobTitle === "string") md += ` - ${jobTitle}`;
          md += "\n";
        }
      }
    }
    md += "\n";
  }

  // Content Blocks
  const contentBlocks = data["content_blocks"];
  if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
    md += `## Additional Content\n\n`;
    for (const block of contentBlocks) {
      const blockMd = convertContentBlock(block as ContentBlock);
      if (blockMd) md += blockMd + "\n";
    }
  }

  return md;
}

// ─── Person Converter ────────────────────────────────────────────────────────

/**
 * Converts intranet-people entries to markdown.
 * Based on: people/[slug]/page.tsx
 */
export function convertPerson(
  data: Record<string, unknown>,
  baseUrl?: string,
): string {
  let md = "";

  // Name (matches frontend: display_name || name)
  const name =
    (data["display_name"] as string) ||
    (data["displayName"] as string) ||
    (data["name"] as string) ||
    "Person";
  md += `# ${name}\n\n`;

  // Build source URL
  const slug = data["slug"];
  const sourceUrl =
    typeof slug === "string" && slug.length > 0 && baseUrl
      ? `${baseUrl}/people/${slug}`
      : undefined;

  // Metadata
  md += formatMetadata(data, "person", sourceUrl);

  // Headshot
  const headshot = data["headshot"] as Record<string, unknown> | undefined;
  if (headshot?.data) {
    const headshotAttrs = (headshot["data"] as Record<string, unknown>)?.[
      "attributes"
    ];
    if (headshotAttrs && typeof headshotAttrs === "object") {
      md += `## Photo\n\n${formatImage(headshotAttrs as Record<string, unknown>)}\n\n`;
    }
  }

  // Pronunciation
  const phonetic = data["pronunciation_phonetic"];
  if (typeof phonetic === "string" && phonetic.length > 0) {
    md += `**Pronunciation:** ${phonetic}\n\n`;
  }
  const voiceClip = data["pronunciation_voice_clip"] as
    | Record<string, unknown>
    | undefined;
  if (voiceClip?.data) {
    const clipAttrs = (voiceClip["data"] as Record<string, unknown>)?.[
      "attributes"
    ] as Record<string, unknown> | undefined;
    if (clipAttrs?.url) {
      md += `🔊 [Listen to pronunciation](${clipAttrs["url"]})\n\n`;
    }
  }

  // Nickname
  const nickname = data["nickname"];
  if (typeof nickname === "string" && nickname.length > 0) {
    md += `**Nickname:** ${nickname}\n\n`;
  }

  // Job Title
  const jobTitle = data["job_title"] || data["jobTitle"];
  if (typeof jobTitle === "string" && jobTitle.length > 0) {
    md += `**Role:** ${jobTitle}\n\n`;
  }

  // Team (from intranet_team relation)
  const intranetTeam = data["intranet_team"] as
    | Record<string, unknown>
    | undefined;
  if (intranetTeam?.data) {
    const teamAttrs = (intranetTeam["data"] as Record<string, unknown>)?.[
      "attributes"
    ] as Record<string, unknown> | undefined;
    if (teamAttrs) {
      const teamName = teamAttrs["title"] || teamAttrs["name"];
      const teamSlug = teamAttrs["slug"];
      if (typeof teamName === "string" && typeof teamSlug === "string") {
        md += `**Team:** [${teamName}](/team/${teamSlug})\n\n`;
      } else if (typeof teamName === "string") {
        md += `**Team:** ${teamName}\n\n`;
      }
    }
  } else {
    // Fallback: check simple team object
    const team = data["team"];
    if (team && typeof team === "object") {
      const teamData = team as Record<string, unknown>;
      const teamName = teamData["name"] || teamData["title"];
      if (typeof teamName === "string") {
        md += `**Team:** ${teamName}\n\n`;
      }
    } else if (typeof team === "string" && team.length > 0) {
      md += `**Team:** ${team}\n\n`;
    }
  }

  // Bio
  const bio = data["bio"] || data["biography"];
  if (typeof bio === "string" && bio.length > 0) {
    md += `## Biography\n\n${cleanMarkdownText(bio)}\n\n`;
  }

  // Contact Info
  const contactInfo: string[] = [];
  const email = data["email"];
  if (typeof email === "string" && email.length > 0) {
    contactInfo.push(`**Email:** ${email}`);
  }
  const phone = data["phone"];
  if (typeof phone === "string" && phone.length > 0) {
    contactInfo.push(`**Phone:** ${phone}`);
  }
  const location = data["location"];
  if (typeof location === "string" && location.length > 0) {
    contactInfo.push(`**Location:** ${location}`);
  }

  if (contactInfo.length > 0) {
    md += `## Contact\n\n${contactInfo.join("\n")}\n\n`;
  }

  // Content Blocks
  const contentBlocks = data["content_blocks"];
  if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
    md += `## Additional Information\n\n`;
    for (const block of contentBlocks) {
      const blockMd = convertContentBlock(block as ContentBlock);
      if (blockMd) md += blockMd + "\n";
    }
  }

  return md;
}
