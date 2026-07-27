/**
 * Content block converters - convertContentBlock router and all block converters.
 *
 * Routes individual Strapi dynamic zone components to the appropriate
 * converter based on the __component discriminator field. Supports all
 * block types from the Strapi populate config.
 */

import type { ContentBlock, StrapiImage } from "./types";
import {
  formatImage,
  formatLink,
  formatFile,
  parseHTMLTableToMarkdown,
  cleanMarkdownText,
} from "./helpers";

// ─── Main Router ─────────────────────────────────────────────────────────────

/**
 * Routes a content block to the appropriate converter based on __component field.
 * Returns empty string for null/undefined blocks.
 */
export function convertContentBlock(block: ContentBlock): string {
  if (!block || !block.__component) {
    return "";
  }

  switch (block.__component) {
    case "dynamic.text-block":
    case "dynamic.changeling-text-block":
      return convertTextBlock(block);

    case "dynamic.accordion":
      return convertAccordion(block);

    case "dynamic.50-50-text-n-image":
      return convert5050TextNImage(block);

    case "dynamic.double-text-block":
      return convertDoubleTextBlock(block);

    case "dynamic.text-and-image":
      return convertTextAndImage(block);

    case "dynamic.image-and-cta-block":
      return convertImageAndCta(block);

    case "dynamic.text-and-cta-block":
      return convertTextAndCta(block);

    case "dynamic.text-and-video":
      return convertTextAndVideo(block);

    case "dynamic.text-quote-block":
      return convertTextQuote(block);

    case "dynamic.testimonial":
      return convertTestimonial(block);

    case "dynamic.values-block":
      return convertValuesBlock(block);

    case "dynamic.about-me":
      return convertAboutMe(block);

    case "dynamic.wins-and-shoutouts":
      return convertWinsAndShoutouts(block);

    case "dynamic.gallery":
      return convertGallery(block);

    case "dynamic.advisors-listing":
      return convertAdvisorsListing(block);

    case "sidebar.link-block":
    case "dynamic.columns-link-block":
      return convertLinks(block);

    case "sidebar.document-block":
      return convertDocuments(block);

    case "dynamic.photos-block":
    case "dynamic.shuffled-photo":
      return convertPhotos(block);

    case "dynamic.table":
      return convertTable(block);

    case "intranet-blocks.link-cards":
      return convertLinkCards(block);

    case "intranet-blocks.video-block":
      return convertVideoBlock(block);

    case "intranet-blocks.events-carousel":
      return convertEventsCarousel(block);

    case "intranet-blocks.quote-of-the-week":
      return convertQuoteOfTheWeek(block);

    case "intranet-blocks.team-cards":
      return convertTeamCards(block);

    case "intranet-blocks.social-header":
      return convertSocialHeader(block);

    default:
      return convertUnknownBlock(block);
  }
}

// ─── Text Block ──────────────────────────────────────────────────────────────

function convertTextBlock(block: ContentBlock): string {
  const text = block.text || block.textBlock;

  if (!text) {
    return "";
  }

  if (typeof text === "string") {
    return cleanMarkdownText(text);
  }

  if (Array.isArray(text)) {
    return text
      .map((item) => convertContentBlock(item as ContentBlock))
      .filter((s) => s.length > 0)
      .join("\n\n");
  }

  return "";
}

// ─── Accordion ───────────────────────────────────────────────────────────────

function convertAccordion(block: ContentBlock): string {
  if (!block.items || !Array.isArray(block.items) || block.items.length === 0) {
    return "";
  }

  const sections: string[] = [];

  for (const item of block.items) {
    const parts: string[] = [];

    if (item.title) {
      parts.push(`### ${item.title}`);
    }

    if (item.summary) {
      parts.push(cleanMarkdownText(item.summary));
    } else if (item.text) {
      parts.push(cleanMarkdownText(item.text));
    }

    if (parts.length > 0) {
      sections.push(parts.join("\n\n"));
    }
  }

  return sections.join("\n\n");
}

// ─── 50-50 Text and Image ────────────────────────────────────────────────────

function convert5050TextNImage(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.left) {
    const leftParts = extractSectionContent(block.left);
    if (leftParts.length > 0) {
      parts.push(leftParts.join("\n\n"));
    }
  }

  if (block.right) {
    const rightParts = extractSectionContent(block.right);
    if (rightParts.length > 0) {
      parts.push(rightParts.join("\n\n"));
    }
  }

  return parts.join("\n\n");
}

/** Extracts text and image content from a left/right section sub-component. */
function extractSectionContent(section: ContentBlock): string[] {
  const parts: string[] = [];

  if (section.title) {
    parts.push(`**${section.title}**`);
  }

  if (section.text) {
    parts.push(cleanMarkdownText(section.text));
  }

  if (section.summary) {
    parts.push(cleanMarkdownText(section.summary));
  }

  // Handle image field (from populate: left.image / right.image)
  const image = extractImageData(section["image"]);
  if (image) {
    parts.push(formatImage(image));
  }

  // Also handle photos array if present
  if (section.photos?.data && Array.isArray(section.photos.data)) {
    for (const photo of section.photos.data) {
      const attrs = photo.attributes as StrapiImage | undefined;
      if (attrs) {
        parts.push(formatImage(attrs));
      }
    }
  }

  return parts;
}

// ─── Text and Image ──────────────────────────────────────────────────────────

function convertTextAndImage(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  if (block.text) {
    parts.push(cleanMarkdownText(block.text));
  }

  const image = extractImageData(block["image"]);
  if (image) {
    parts.push(formatImage(image));
  }

  return parts.join("\n\n");
}

// ─── Image and CTA Block ─────────────────────────────────────────────────────

function convertImageAndCta(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  if (block.text) {
    parts.push(cleanMarkdownText(block.text));
  }

  const heroImage = extractImageData(block["hero_image"]);
  if (heroImage) {
    parts.push(formatImage(heroImage));
  }

  // CTA link
  const ctaText = block["cta_text"] || block["ctaText"];
  const ctaUrl = block["cta_url"] || block["ctaUrl"] || block["cta_link"];
  if (
    typeof ctaText === "string" &&
    typeof ctaUrl === "string" &&
    ctaUrl.length > 0
  ) {
    parts.push(formatLink(ctaText, ctaUrl));
  }

  return parts.join("\n\n");
}

// ─── Text and CTA Block ──────────────────────────────────────────────────────

function convertTextAndCta(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  if (block.text) {
    parts.push(cleanMarkdownText(block.text));
  }

  if (block.summary) {
    parts.push(cleanMarkdownText(block.summary));
  }

  const ctaText = block["cta_text"] || block["ctaText"] || block["button_text"];
  const ctaUrl =
    block["cta_url"] ||
    block["ctaUrl"] ||
    block["button_link"] ||
    block["link"];
  if (
    typeof ctaText === "string" &&
    typeof ctaUrl === "string" &&
    ctaUrl.length > 0
  ) {
    parts.push(formatLink(ctaText, ctaUrl));
  }

  return parts.join("\n\n");
}

// ─── Text and Video ──────────────────────────────────────────────────────────

function convertTextAndVideo(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  if (block.text) {
    parts.push(cleanMarkdownText(block.text));
  }

  const videoUrl = block["video_url"] || block["videoUrl"];
  if (typeof videoUrl === "string" && videoUrl.length > 0) {
    parts.push(`Video: ${videoUrl}`);
  }

  return parts.join("\n\n");
}

// ─── Text Quote Block ────────────────────────────────────────────────────────

function convertTextQuote(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.text) {
    parts.push(cleanMarkdownText(block.text));
  }

  const quote = block["quote"];
  if (typeof quote === "string" && quote.length > 0) {
    parts.push(`> ${quote}`);
  }

  const author = block["author"];
  if (typeof author === "string" && author.length > 0) {
    parts.push(`- ${author}`);
  }

  return parts.join("\n\n");
}

// ─── Testimonial ─────────────────────────────────────────────────────────────

function convertTestimonial(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  const quotes = block["quotes"];
  if (Array.isArray(quotes)) {
    for (const quote of quotes) {
      if (quote && typeof quote === "object") {
        const q = quote as Record<string, unknown>;
        const text = q["text"] || q["quote"];
        const author = q["author"] || q["name"];
        if (typeof text === "string" && text.length > 0) {
          parts.push(`> ${text}`);
          if (typeof author === "string" && author.length > 0) {
            parts.push(`- ${author}`);
          }
        }
      }
    }
  }

  return parts.join("\n\n");
}

// ─── Values Block ────────────────────────────────────────────────────────────

function convertValuesBlock(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  const values = block["values"];
  if (Array.isArray(values)) {
    for (const value of values) {
      if (value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        const title = v["title"] || v["name"];
        const desc = v["description"] || v["text"];
        if (typeof title === "string") {
          parts.push(
            `- **${title}**${typeof desc === "string" ? `: ${desc}` : ""}`,
          );
        }
      }
    }
  }

  return parts.join("\n\n");
}

// ─── About Me ────────────────────────────────────────────────────────────────

function convertAboutMe(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  const aboutMe = block["aboutMe"];
  if (aboutMe && typeof aboutMe === "object") {
    const data = aboutMe as Record<string, unknown>;
    if (typeof data["text"] === "string") {
      parts.push(cleanMarkdownText(data["text"]));
    }
    if (typeof data["title"] === "string") {
      parts.push(`**${data["title"]}**`);
    }
    const image = extractImageData(data["image"]);
    if (image) {
      parts.push(formatImage(image));
    }
  }

  return parts.join("\n\n");
}

// ─── Wins and Shoutouts ──────────────────────────────────────────────────────

function convertWinsAndShoutouts(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  if (block.subTitle) {
    parts.push(block.subTitle);
  }

  if (block.text) {
    parts.push(cleanMarkdownText(block.text));
  }

  return parts.join("\n\n");
}

// ─── Gallery ─────────────────────────────────────────────────────────────────

function convertGallery(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  const items = block["items"] || block["media"];
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item && typeof item === "object") {
        const mediaData = item as Record<string, unknown>;
        // Try media.data.attributes (Strapi relation format)
        const media = mediaData["media"];
        const image = extractImageData(media) || extractImageData(mediaData);
        if (image) {
          parts.push(formatImage(image));
        }
      }
    }
  }

  return parts.join("\n\n");
}

// ─── Advisors Listing ────────────────────────────────────────────────────────

function convertAdvisorsListing(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  const advisors = block["advisors"];
  if (Array.isArray(advisors)) {
    for (const advisor of advisors) {
      if (advisor && typeof advisor === "object") {
        const a = advisor as Record<string, unknown>;
        const name = a["name"] || a["title"];
        const role = a["role"] || a["position"];
        if (typeof name === "string") {
          const line =
            typeof role === "string" ? `- ${name} - ${role}` : `- ${name}`;
          parts.push(line);
        }
      }
    }
  }

  return parts.join("\n");
}

// ─── Video Block ─────────────────────────────────────────────────────────────

function convertVideoBlock(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  if (block.text) {
    parts.push(cleanMarkdownText(block.text));
  }

  const video = block["video"];
  if (video && typeof video === "object") {
    const v = video as Record<string, unknown>;
    const url =
      v["url"] ||
      (v["data"] as Record<string, unknown> | undefined)?.["attributes"]?.[
        "url" as keyof object
      ];
    if (typeof url === "string") {
      parts.push(`Video: ${url}`);
    }
  }

  const videoUrl = block["video_url"] || block["videoUrl"];
  if (typeof videoUrl === "string" && videoUrl.length > 0) {
    parts.push(`Video: ${videoUrl}`);
  }

  return parts.join("\n\n");
}

// ─── Events Carousel ─────────────────────────────────────────────────────────

function convertEventsCarousel(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  if (block.text) {
    parts.push(cleanMarkdownText(block.text));
  }

  const link = block["link"];
  if (link && typeof link === "object") {
    const l = link as Record<string, unknown>;
    const text = l["text"] || l["label"] || "Link";
    const url = l["url"] || l["href"];
    if (typeof text === "string" && typeof url === "string") {
      parts.push(formatLink(text, url));
    }
  }

  return parts.join("\n\n");
}

// ─── Quote of the Week ───────────────────────────────────────────────────────

function convertQuoteOfTheWeek(block: ContentBlock): string {
  const parts: string[] = [];

  const quote = block["quote"] || block.text;
  if (typeof quote === "string" && quote.length > 0) {
    parts.push(`> ${quote}`);
  }

  const author = block["author"] || block["name"];
  if (typeof author === "string" && author.length > 0) {
    parts.push(`- ${author}`);
  }

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  return parts.join("\n\n");
}

// ─── Team Cards ──────────────────────────────────────────────────────────────

function convertTeamCards(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  const cards = block["cards"] || block["teams"];
  if (Array.isArray(cards)) {
    for (const card of cards) {
      if (card && typeof card === "object") {
        const c = card as Record<string, unknown>;
        const name = c["name"] || c["title"];
        const desc = c["description"] || c["summary"];
        if (typeof name === "string") {
          const line =
            typeof desc === "string" ? `- **${name}**: ${desc}` : `- ${name}`;
          parts.push(line);
        }
      }
    }
  }

  return parts.join("\n");
}

// ─── Social Header ───────────────────────────────────────────────────────────

function convertSocialHeader(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  if (block.text) {
    parts.push(cleanMarkdownText(block.text));
  }

  if (block.subTitle) {
    parts.push(block.subTitle);
  }

  return parts.join("\n\n");
}

// ─── Double Text Block ───────────────────────────────────────────────────────

function convertDoubleTextBlock(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.leftColumnTitle) {
    parts.push(`**${block.leftColumnTitle}**`);
  }
  if (block.leftColumnBody) {
    parts.push(cleanMarkdownText(block.leftColumnBody));
  }

  if (block.rightColumnTitle) {
    parts.push(`**${block.rightColumnTitle}**`);
  }
  if (block.rightColumnBody) {
    parts.push(cleanMarkdownText(block.rightColumnBody));
  }

  return parts.join("\n\n");
}

// ─── Links ───────────────────────────────────────────────────────────────────

function convertLinks(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  if (block.links && Array.isArray(block.links)) {
    const linkItems = block.links
      .filter((link) => link.url)
      .map((link) => {
        const text = link.text || link.url || "";
        const url = link.url || "";
        return `- ${formatLink(text, url, link.target_blank)}`;
      });

    if (linkItems.length > 0) {
      parts.push(linkItems.join("\n"));
    }
  }

  return parts.join("\n\n");
}

// ─── Documents ───────────────────────────────────────────────────────────────

function convertDocuments(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  if (block.files?.data && Array.isArray(block.files.data)) {
    const fileItems = block.files.data
      .filter((file) => file.attributes)
      .map((file) => `- ${formatFile(file.attributes!)}`);

    if (fileItems.length > 0) {
      parts.push(fileItems.join("\n"));
    }
  }

  return parts.join("\n\n");
}

// ─── Photos ──────────────────────────────────────────────────────────────────

function convertPhotos(block: ContentBlock): string {
  if (!block.photos?.data || !Array.isArray(block.photos.data)) {
    return "";
  }

  const images = block.photos.data
    .filter((photo) => photo.attributes)
    .map((photo) => formatImage(photo.attributes as StrapiImage));

  return images.join("\n\n");
}

// ─── Table ───────────────────────────────────────────────────────────────────

function convertTable(block: ContentBlock): string {
  if (!block.table || typeof block.table !== "string") {
    return "";
  }

  return parseHTMLTableToMarkdown(block.table);
}

// ─── Link Cards ──────────────────────────────────────────────────────────────

function convertLinkCards(block: ContentBlock): string {
  if (!block.cards || !Array.isArray(block.cards) || block.cards.length === 0) {
    return "";
  }

  const sections: string[] = [];

  for (const card of block.cards) {
    const parts: string[] = [];

    if (card.title) {
      parts.push(`### ${card.title}`);
    }

    if (card.link) {
      parts.push(formatLink(card.title || card.link, card.link));
    }

    if (card.icon?.data?.attributes) {
      parts.push(formatImage(card.icon.data.attributes));
    }

    if (parts.length > 0) {
      sections.push(parts.join("\n\n"));
    }
  }

  return sections.join("\n\n");
}

// ─── Unknown Block Fallback ──────────────────────────────────────────────────

function convertUnknownBlock(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`**${block.title}**`);
  }

  if (block.text) {
    parts.push(cleanMarkdownText(block.text));
  }

  if (block.summary) {
    parts.push(cleanMarkdownText(block.summary));
  }

  if (block.subTitle) {
    parts.push(block.subTitle);
  }

  if (parts.length === 0) {
    return "";
  }

  return parts.join("\n\n");
}

// ─── Image Extraction Helper ─────────────────────────────────────────────────

/**
 * Extracts StrapiImage data from various Strapi image field formats:
 * - Direct attributes: { url, alternativeText, ... }
 * - Nested relation: { data: { attributes: { url, ... } } }
 * - Array relation: { data: [{ attributes: { url, ... } }] }
 */
function extractImageData(field: unknown): StrapiImage | null {
  if (!field || typeof field !== "object") {
    return null;
  }

  const obj = field as Record<string, unknown>;

  // Direct image attributes
  if (typeof obj["url"] === "string") {
    return obj as unknown as StrapiImage;
  }

  // Nested: { data: { attributes: { url, ... } } }
  const data = obj["data"];
  if (data && typeof data === "object") {
    // Single relation
    const singleData = data as Record<string, unknown>;
    if (
      singleData["attributes"] &&
      typeof singleData["attributes"] === "object"
    ) {
      const attrs = singleData["attributes"] as Record<string, unknown>;
      if (typeof attrs["url"] === "string") {
        return attrs as unknown as StrapiImage;
      }
    }

    // Array relation: data is array
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0] as Record<string, unknown>;
      if (first["attributes"] && typeof first["attributes"] === "object") {
        const attrs = first["attributes"] as Record<string, unknown>;
        if (typeof attrs["url"] === "string") {
          return attrs as unknown as StrapiImage;
        }
      }
    }
  }

  return null;
}
