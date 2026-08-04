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

// ─── ElementsHeaderComponent helper ─────────────────────────────────────────

/**
 * Joins an array of ElementsHeaderComponent items (each with a Heading or text
 * property) into a single plain-text heading string.
 */
function extractHeaderTitle(
  headings: Array<{ Heading?: string; text?: string }> | undefined,
): string {
  if (!headings || !Array.isArray(headings) || headings.length === 0) {
    return "";
  }
  return headings
    .map((h) => h.Heading ?? h.text ?? "")
    .filter((s) => s.length > 0)
    .join(" ");
}

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
      return convertTextBlock(block);

    case "dynamic.changeling-text-block":
      return convertChangelingTextBlock(block);

    case "dynamic.accordion":
      return convertAccordion(block);

    case "dynamic.50-50-text-n-image":
      return convert5050TextNImage(block);

    case "dynamic.double-text-block":
      return convertDoubleTextBlock(block);

    case "dynamic.text-and-image":
      return convertTextAndImage(block);

    case "dynamic.image-and-cta-block":
      return convertImageAndCtaBlock(block);

    case "dynamic.text-and-cta-block":
      return convertTextAndCtaBlock(block);

    case "dynamic.text-and-video":
      return convertTextAndVideo(block);

    case "dynamic.text-quote-block":
      return convertTextQuoteBlock(block);

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

    case "dynamic.about-us-values-block":
      return convertAboutUsValuesBlock(block);

    case "dynamic.statements-block":
      return convertStatementsBlock(block);

    case "dynamic.text-scroll":
      return convertTextScroll(block);

    case "dynamic.homepage-text-block":
      return convertHomepageTextBlock(block);

    case "dynamic.specialty-block":
      return convertSpecialtyBlock(block);

    case "sidebar.link-block":
    case "dynamic.columns-link-block":
      return convertLinks(block);

    case "sidebar.document-block":
      return convertDocuments(block);

    case "dynamic.photos-block":
    case "dynamic.shuffled-photo": // no meaningful text — photo grid
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

    // ── No-content blocks — dynamically fetched or purely visual ────────────
    case "dynamic.case-study-listing": // fetched separately, indexed on their own
    case "dynamic.people-listing": // fetched separately, indexed on their own
    case "dynamic.news-listing": // fetched separately, indexed on their own
    case "dynamic.clients-logo": // logo images only
    case "dynamic.advisory-panel": // advisor pages are indexed directly
    case "dynamic.vector-masked-video": // masked video, no text
    case "dynamic.multicultural-map": // interactive map widget
    case "dynamic.askvic-chatbot-microsite": // chatbot embed
    case "dynamic.e-newsletter-form": // form embed
    case "dynamic.the-blob": // decorative animation
    case "decoration.arrow": // visual spacer
    case "decoration.space": // visual spacer
      return "";

    default:
      return convertUnknownBlock(block);
  }
}

// ─── Text Block ──────────────────────────────────────────────────────────────

function convertTextBlock(block: ContentBlock): string {
  if (!block.text) {
    return "";
  }
  return cleanMarkdownText(block.text);
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
    parts.push(`## ${block.title}`);
  }

  if (block.text) {
    parts.push(cleanMarkdownText(block.text));
  }

  // orientation and image fields are visual metadata — skip

  return parts.join("\n\n");
}

// ─── Image and CTA Block ─────────────────────────────────────────────────────

function convertImageAndCtaBlock(block: ContentBlock): string {
  const parts: string[] = [];

  const headingText = extractHeaderTitle(
    block["title"] as Array<{ Heading?: string; text?: string }> | undefined,
  );
  if (headingText.length > 0) {
    parts.push(`## ${headingText}`);
  }

  if (block.summary) {
    parts.push(cleanMarkdownText(block.summary));
  }

  // image and layout are visual metadata — skip

  const button = block["button"] as { text?: string; url?: string } | undefined;
  if (button?.text && button?.url) {
    parts.push(`CTA: ${button.text} → ${button.url}`);
  }

  return parts.join("\n\n");
}

// ─── Text and CTA Block ──────────────────────────────────────────────────────

function convertTextAndCtaBlock(block: ContentBlock): string {
  const parts: string[] = [];

  const headingText = extractHeaderTitle(
    block["title"] as Array<{ Heading?: string; text?: string }> | undefined,
  );
  if (headingText.length > 0) {
    parts.push(`## ${headingText}`);
  }

  if (block.text) {
    parts.push(cleanMarkdownText(block.text));
  }

  // has_black_background and hero_image are visual metadata — skip

  const cta = block["cta"] as { text?: string; url?: string } | undefined;
  if (cta?.text && cta?.url) {
    parts.push(`CTA: ${cta.text} → ${cta.url}`);
  }

  return parts.join("\n\n");
}

// ─── Text and Video ──────────────────────────────────────────────────────────

function convertTextAndVideo(block: ContentBlock): string {
  const parts: string[] = [];

  if (block.title) {
    parts.push(`## ${block.title}`);
  }

  const items = block.items;
  if (Array.isArray(items) && items.length > 0) {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const itemParts: string[] = [];

      if (item.title) {
        itemParts.push(`### ${item.title}`);
      }

      if (item.text) {
        itemParts.push(cleanMarkdownText(item.text));
      }

      // video field is a JSON string like { "url": "...", "title": "..." }
      const videoRaw = (item as Record<string, unknown>)["video"];
      if (typeof videoRaw === "string" && videoRaw.length > 0) {
        try {
          const parsed = JSON.parse(videoRaw) as Record<string, unknown>;
          const videoTitle = parsed["title"];
          if (typeof videoTitle === "string" && videoTitle.length > 0) {
            itemParts.push(`Video: ${videoTitle}`);
          }
        } catch {
          // not valid JSON — skip
        }
      }

      if (itemParts.length > 0) {
        parts.push(itemParts.join("\n\n"));
      }
    }
  }

  return parts.join("\n\n");
}

// ─── Text Quote Block ────────────────────────────────────────────────────────

function convertTextQuoteBlock(block: ContentBlock): string {
  const parts: string[] = [];

  // statement is a pull-quote — render as blockquote
  const statement = block["statement"] as string | undefined;
  if (typeof statement === "string" && statement.length > 0) {
    parts.push(`> ${cleanMarkdownText(statement)}`);
  }

  if (block.title) {
    parts.push(`## ${block.title}`);
  }

  if (block.text) {
    parts.push(cleanMarkdownText(block.text));
  }

  // theme is visual metadata — skip

  return parts.join("\n\n");
}

// ─── Testimonial ─────────────────────────────────────────────────────────────

function convertTestimonial(block: ContentBlock): string {
  const parts: string[] = [];

  const headingText = extractHeaderTitle(
    block["title"] as Array<{ Heading?: string; text?: string }> | undefined,
  );
  if (headingText.length > 0) {
    parts.push(`## ${headingText}`);
  }

  const quotes = block["quotes"] as
    | Array<{ quote?: string; clientName?: string; clientTitle?: string }>
    | undefined;

  if (Array.isArray(quotes)) {
    for (const item of quotes) {
      if (!item || typeof item !== "object") continue;

      const quoteLines: string[] = [];

      if (typeof item.quote === "string" && item.quote.length > 0) {
        quoteLines.push(`> ${item.quote}`);
      }

      const attribution: string[] = [];
      if (typeof item.clientName === "string" && item.clientName.length > 0) {
        attribution.push(item.clientName);
      }
      if (typeof item.clientTitle === "string" && item.clientTitle.length > 0) {
        attribution.push(item.clientTitle);
      }
      if (attribution.length > 0) {
        quoteLines.push(`— ${attribution.join(", ")}`);
      }

      if (quoteLines.length > 0) {
        parts.push(quoteLines.join("\n"));
      }
    }
  }

  return parts.join("\n\n");
}

// ─── Values Block ────────────────────────────────────────────────────────────

function convertValuesBlock(block: ContentBlock): string {
  const parts: string[] = [];

  const headingText = extractHeaderTitle(
    block["title"] as Array<{ Heading?: string; text?: string }> | undefined,
  );
  if (headingText.length > 0) {
    parts.push(`## ${headingText}`);
  }

  const values = block["values"] as
    | Array<{ title?: string; text?: string; description?: string }>
    | undefined;

  if (Array.isArray(values)) {
    for (const value of values) {
      if (!value || typeof value !== "object") continue;

      const valueParts: string[] = [];

      if (typeof value.title === "string" && value.title.length > 0) {
        valueParts.push(`### ${value.title}`);
      }

      const body = value.text ?? value.description;
      if (typeof body === "string" && body.length > 0) {
        valueParts.push(cleanMarkdownText(body));
      }

      if (valueParts.length > 0) {
        parts.push(valueParts.join("\n\n"));
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
    parts.push(`## ${block.title}`);
  }

  if (block.summary) {
    parts.push(cleanMarkdownText(block.summary));
  }

  // background is visual metadata — skip

  const items = block["items"] as
    | Array<{ title?: string; caption?: string; alt?: string }>
    | undefined;

  if (!Array.isArray(items)) {
    return parts.join("\n\n");
  }

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    // Images carry no useful text — extract caption/alt only
    const caption = item.caption ?? item.alt;
    if (item.title) {
      parts.push(item.title);
    } else if (caption) {
      parts.push(caption);
    }
  }

  return parts.join("\n\n");
}

// ─── Advisors Listing ────────────────────────────────────────────────────────

function convertAdvisorsListing(block: ContentBlock): string {
  const parts: string[] = [];

  const advisors = block["advisors"] as
    | Array<{ fullname?: string; role?: string; bio?: string }>
    | undefined;

  if (!Array.isArray(advisors) || advisors.length === 0) {
    return "";
  }

  for (const advisor of advisors) {
    if (!advisor || typeof advisor !== "object") continue;

    const lines: string[] = [];

    const nameRole: string[] = [];
    if (typeof advisor.fullname === "string" && advisor.fullname.length > 0) {
      nameRole.push(`**${advisor.fullname}**`);
    }
    if (typeof advisor.role === "string" && advisor.role.length > 0) {
      nameRole.push(advisor.role);
    }

    if (nameRole.length > 0) {
      lines.push(nameRole.join(" — "));
    }

    if (typeof advisor.bio === "string" && advisor.bio.length > 0) {
      lines.push(advisor.bio);
    }

    if (lines.length > 0) {
      parts.push(lines.join("\n"));
    }
  }

  return parts.join("\n\n");
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
  // Guard: all 4 fields must be non-empty strings
  if (
    typeof block.leftColumnTitle !== "string" ||
    block.leftColumnTitle.trim().length === 0 ||
    typeof block.leftColumnBody !== "string" ||
    block.leftColumnBody.trim().length === 0 ||
    typeof block.rightColumnTitle !== "string" ||
    block.rightColumnTitle.trim().length === 0 ||
    typeof block.rightColumnBody !== "string" ||
    block.rightColumnBody.trim().length === 0
  ) {
    return "";
  }

  const parts: string[] = [
    `## ${block.leftColumnTitle}`,
    cleanMarkdownText(block.leftColumnBody),
    `## ${block.rightColumnTitle}`,
    cleanMarkdownText(block.rightColumnBody),
  ];

  return parts.join("\n\n");
}

// ─── About Us Values Block ───────────────────────────────────────────────────

function convertAboutUsValuesBlock(block: ContentBlock): string {
  const parts: string[] = [];

  const textBlock = block["textBlock"] as
    | Array<{ text?: string; subtext?: string }>
    | undefined;

  if (Array.isArray(textBlock)) {
    for (const item of textBlock) {
      if (!item || typeof item !== "object") continue;

      const lines: string[] = [];
      if (typeof item.text === "string" && item.text.length > 0) {
        lines.push(item.text);
      }
      if (typeof item.subtext === "string" && item.subtext.length > 0) {
        lines.push(item.subtext);
      }
      if (lines.length > 0) {
        parts.push(lines.join("\n"));
      }
    }
  }

  const linksBlock = block["linksBlock"] as
    | { desc?: string; title?: string; url?: string }
    | undefined;

  if (linksBlock && typeof linksBlock === "object") {
    const linkParts: string[] = [];
    if (typeof linksBlock.desc === "string" && linksBlock.desc.length > 0) {
      linkParts.push(linksBlock.desc);
    }
    if (
      typeof linksBlock.title === "string" &&
      linksBlock.title.length > 0 &&
      typeof linksBlock.url === "string" &&
      linksBlock.url.length > 0
    ) {
      linkParts.push(`CTA: ${linksBlock.title} → ${linksBlock.url}`);
    }
    if (linkParts.length > 0) {
      parts.push(linkParts.join("\n"));
    }
  }

  return parts.join("\n\n");
}

// ─── Statements Block ────────────────────────────────────────────────────────

function convertStatementsBlock(block: ContentBlock): string {
  const statements = block["statements"] as
    | Array<{
        heading?: string;
        heading1?: string;
        font?: string;
        font1?: string;
        description?: string;
      }>
    | undefined;

  if (!Array.isArray(statements) || statements.length === 0) {
    return "";
  }

  const sections: string[] = [];

  for (const statement of statements) {
    if (!statement || typeof statement !== "object") continue;

    const parts: string[] = [];

    // heading and heading1 are two font-styled parts of a composite heading
    const headingParts: string[] = [];
    if (typeof statement.heading === "string" && statement.heading.length > 0) {
      headingParts.push(statement.heading);
    }
    if (
      typeof statement.heading1 === "string" &&
      statement.heading1.length > 0
    ) {
      headingParts.push(statement.heading1);
    }
    if (headingParts.length > 0) {
      parts.push(`## ${headingParts.join(" ")}`);
    }

    if (
      typeof statement.description === "string" &&
      statement.description.length > 0
    ) {
      parts.push(statement.description);
    }

    // font and font1 are visual styling — skip

    if (parts.length > 0) {
      sections.push(parts.join("\n\n"));
    }
  }

  return sections.join("\n\n");
}

// ─── Changeling Text Block ───────────────────────────────────────────────────

function convertChangelingTextBlock(block: ContentBlock): string {
  const textBlock = block["textBlock"] as
    | Array<{ text?: string; theme?: string; type?: string; align?: string }>
    | undefined;

  if (!Array.isArray(textBlock) || textBlock.length === 0) {
    return "";
  }

  const sections: string[] = [];

  for (const item of textBlock) {
    if (!item || typeof item !== "object") continue;

    // theme, type, align are visual metadata — skip
    if (typeof item.text === "string" && item.text.length > 0) {
      sections.push(cleanMarkdownText(item.text));
    }
  }

  return sections.join("\n\n");
}

// ─── Text Scroll ─────────────────────────────────────────────────────────────

function convertTextScroll(block: ContentBlock): string {
  // Scroll-driven visual block — all items are readable text that highlight
  // one at a time. Extract all text and join with newlines.
  const title = block["title"] as
    | Array<{ id?: number; text?: string }>
    | undefined;

  if (!Array.isArray(title) || title.length === 0) {
    return "";
  }

  return title
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .filter((s) => s.length > 0)
    .join("\n");
}

// ─── Homepage Text Block ─────────────────────────────────────────────────────

function convertHomepageTextBlock(block: ContentBlock): string {
  const parts: string[] = [];

  const textWithFont = block["textWithFont"] as
    | Array<{ text?: string; font?: string }>
    | undefined;

  // textWithFont items form a large heading — join their text values
  if (Array.isArray(textWithFont) && textWithFont.length > 0) {
    const heading = textWithFont
      .map((item) => (typeof item.text === "string" ? item.text : ""))
      .filter((s) => s.length > 0)
      .join(" ");
    if (heading.length > 0) {
      parts.push(heading);
    }
  }

  const linkDesc = block["linkDesc"] as string | undefined;
  if (typeof linkDesc === "string" && linkDesc.length > 0) {
    parts.push(linkDesc);
  }

  const linksBlock = block["linksBlock"] as
    | { text?: string; url?: string }
    | undefined;

  if (
    linksBlock &&
    typeof linksBlock.text === "string" &&
    linksBlock.text.length > 0 &&
    typeof linksBlock.url === "string" &&
    linksBlock.url.length > 0
  ) {
    parts.push(`CTA: ${linksBlock.text} → ${linksBlock.url}`);
  }

  return parts.join("\n\n");
}

// ─── Specialty Block ─────────────────────────────────────────────────────────

function convertSpecialtyBlock(block: ContentBlock): string {
  // Lives outside the DynamicZone — uses specialtyBlock[] array shape
  const specialtyBlock = block["specialtyBlock"] as
    | Array<{
        title?: string;
        description?: string;
        textStabilGrotesk?: string;
        textFautive?: string;
        linksTitle?: string;
        url?: string;
        ctaTitle?: string;
        ctaUrl?: string;
        certifications?: {
          data: Array<{ attributes?: { slug?: string } }>;
        };
      }>
    | undefined;

  if (!Array.isArray(specialtyBlock) || specialtyBlock.length === 0) {
    return "";
  }

  const sections: string[] = [];

  for (const item of specialtyBlock) {
    if (!item || typeof item !== "object") continue;

    const parts: string[] = [];

    if (typeof item.title === "string" && item.title.length > 0) {
      parts.push(`### ${item.title}`);
    }

    if (typeof item.description === "string" && item.description.length > 0) {
      parts.push(item.description);
    }

    // textStabilGrotesk and textFautive are two font-styled portions of a
    // rich description — both carry meaningful text content
    const richParts: string[] = [];
    if (
      typeof item.textStabilGrotesk === "string" &&
      item.textStabilGrotesk.length > 0
    ) {
      richParts.push(item.textStabilGrotesk);
    }
    if (typeof item.textFautive === "string" && item.textFautive.length > 0) {
      richParts.push(item.textFautive);
    }
    if (richParts.length > 0) {
      parts.push(richParts.join(" "));
    }

    if (
      typeof item.linksTitle === "string" &&
      item.linksTitle.length > 0 &&
      typeof item.url === "string" &&
      item.url.length > 0
    ) {
      parts.push(`CTA: ${item.linksTitle} → ${item.url}`);
    }

    if (
      typeof item.ctaTitle === "string" &&
      item.ctaTitle.length > 0 &&
      typeof item.ctaUrl === "string" &&
      item.ctaUrl.length > 0
    ) {
      parts.push(`Secondary CTA: ${item.ctaTitle} → ${item.ctaUrl}`);
    }

    // Certifications are referenced by slug (images) — include as metadata labels
    const certs = item.certifications?.data;
    if (Array.isArray(certs) && certs.length > 0) {
      const slugs = certs
        .map((c) => c.attributes?.slug)
        .filter((s): s is string => typeof s === "string" && s.length > 0);
      if (slugs.length > 0) {
        parts.push(`Certifications: ${slugs.join(", ")}`);
      }
    }

    if (parts.length > 0) {
      sections.push(parts.join("\n"));
    }
  }

  return sections.join("\n\n");
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
