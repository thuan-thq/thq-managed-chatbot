/**
 * Types for the markdown converter module.
 *
 * Defines Strapi content structures used by the block and type converters.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 */

// ─── Strapi Media Types ──────────────────────────────────────────────────────

/** Strapi image media attributes. */
export interface StrapiImage {
  url?: string;
  alternativeText?: string;
  caption?: string;
  name?: string;
  width?: number;
  height?: number;
}

/** Strapi file/document attachment attributes. */
export interface StrapiFile {
  url?: string;
  name?: string;
  size?: number;
  mime?: string;
  ext?: string;
}

// ─── Content Block ───────────────────────────────────────────────────────────

/** A Strapi dynamic zone component with __component discriminator. */
export interface ContentBlock {
  __component: string;
  text?: string;
  title?: string;
  summary?: string;
  subTitle?: string;
  items?: ContentBlock[];
  textBlock?: string | ContentBlock[];
  left?: ContentBlock;
  right?: ContentBlock;
  leftColumnTitle?: string;
  leftColumnBody?: string;
  rightColumnTitle?: string;
  rightColumnBody?: string;
  links?: Array<{ text?: string; url?: string; target_blank?: boolean }>;
  files?: { data?: Array<{ attributes?: StrapiFile }> };
  photos?: { data?: Array<{ attributes?: StrapiImage }> };
  cards?: Array<{
    title?: string;
    link?: string;
    icon?: { data?: { attributes?: StrapiImage } };
    color?: string;
  }>;
  table?: string;
  [key: string]: unknown;
}
