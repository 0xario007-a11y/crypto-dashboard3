/**
 * fetch-notion.mjs
 *
 * Reads the "Projects" Notion database and writes the result to projects.json
 * at the repository root. Run by .github/workflows/sync-notion.yml on a
 * schedule and on manual dispatch. Requires Node 18+ (uses global fetch).
 *
 * Required environment variables (set as GitHub Actions secrets):
 *   NOTION_TOKEN        - Notion internal integration token
 *   NOTION_DATABASE_ID  - ID of the Notion database (32-char id from the URL)
 *
 * Exit codes:
 *   0 - success, projects.json written (or confirmed unchanged)
 *   1 - configuration or validation error (e.g. duplicate slugs) — the
 *       workflow run will show as failed so the problem is visible.
 */

import { writeFile, readFile } from "node:fs/promises";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = "2022-06-28";
const OUTPUT_PATH = new URL("./projects.json", import.meta.url);

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

if (!NOTION_TOKEN) fail("Missing required environment variable NOTION_TOKEN.");
if (!NOTION_DATABASE_ID) fail("Missing required environment variable NOTION_DATABASE_ID.");

/** Extracts plain text from a Notion "title" property. */
function getTitle(prop) {
  if (!prop || prop.type !== "title") return "";
  return prop.title.map((t) => t.plain_text).join("").trim();
}

/** Extracts plain text from a Notion "rich_text" property. */
function getText(prop) {
  if (!prop || prop.type !== "rich_text") return "";
  return prop.rich_text.map((t) => t.plain_text).join("").trim();
}

/** Extracts a value from a Notion "url" property. */
function getUrl(prop) {
  if (!prop || prop.type !== "url") return "";
  return prop.url ? prop.url.trim() : "";
}

/** Extracts a boolean from a Notion "checkbox" property. */
function getCheckbox(prop) {
  if (!prop || prop.type !== "checkbox") return false;
  return Boolean(prop.checkbox);
}

/** Extracts a number from a Notion "number" property. */
function getNumber(prop) {
  if (!prop || prop.type !== "number") return null;
  return typeof prop.number === "number" ? prop.number : null;
}

/**
 * Extracts a category-like value. Supports either a "select" property or a
 * plain "rich_text" property, since either is a reasonable way to model
 * "Category" in Notion and the sync should not be brittle about it.
 */
function getCategory(prop) {
  if (!prop) return "";
  if (prop.type === "select") return prop.select ? prop.select.name : "";
  if (prop.type === "rich_text") return getText(prop);
  return "";
}

async function queryDatabase() {
  const results = [];
  let cursor = undefined;

  do {
    const response = await fetch(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cursor ? { start_cursor: cursor } : {}),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      fail(
        `Notion API request failed (${response.status} ${response.statusText}). ${body}`
      );
    }

    const data = await response.json();
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return results;
}

function mapPage(page) {
  const props = page.properties;

  const name = getTitle(props["Project Name"]);
  const slug = getText(props["Slug"]).toLowerCase();
  const coingeckoId = getText(props["CoinGecko ID"]).toLowerCase();
  const active = getCheckbox(props["Active"]);
  const sortOrder = getNumber(props["Sort Order"]);

  return {
    name,
    slug,
    coingeckoId,
    active,
    sortOrder,
    description: getText(props["Description"]),
    category: getCategory(props["Category"]),
    website: getUrl(props["Website"]),
    whitepaper: getUrl(props["Whitepaper"]),
    github: getUrl(props["GitHub"]),
    docs: getUrl(props["Documentation"]),
    twitter: getUrl(props["Twitter/X"]),
    notionPageId: page.id,
  };
}

function validate(projects) {
  const errors = [];
  const slugCounts = new Map();

  for (const p of projects) {
    if (!p.name) errors.push(`Row ${p.notionPageId}: missing "Project Name".`);
    if (!p.slug) errors.push(`Row ${p.notionPageId}: missing "Slug".`);
    if (!p.coingeckoId) errors.push(`Row ${p.notionPageId}: missing "CoinGecko ID".`);
    if (p.slug && /\s/.test(p.slug)) {
      errors.push(`Row ${p.notionPageId}: "Slug" ("${p.slug}") must not contain spaces.`);
    }
    if (p.slug) slugCounts.set(p.slug, (slugCounts.get(p.slug) || 0) + 1);
  }

  for (const [slug, count] of slugCounts) {
    if (count > 1) errors.push(`Duplicate Slug "${slug}" used by ${count} rows. Slugs must be unique.`);
  }

  if (errors.length) {
    fail(`Validation failed:\n - ${errors.join("\n - ")}`);
  }
}

async function main() {
  console.log(`Querying Notion database ${NOTION_DATABASE_ID}...`);
  const pages = await queryDatabase();
  console.log(`Fetched ${pages.length} row(s).`);

  const projects = pages.map(mapPage);
  validate(projects);

  projects.sort((a, b) => {
    const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.name.localeCompare(b.name);
  });

  const output = {
    updatedAt: new Date().toISOString(),
    projects,
  };

  // Avoid a no-op commit (and a noisy Action history) when nothing changed
  // besides the timestamp.
  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
  } catch {
    // No existing file, or it's not valid JSON yet — that's fine, we'll write fresh.
  }

  const unchanged =
    previous && JSON.stringify(previous.projects) === JSON.stringify(output.projects);

  if (unchanged) {
    console.log("No project data changes since last sync. Skipping write.");
    return;
  }

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`✅ Wrote projects.json with ${projects.length} project(s).`);
}

main().catch((err) => fail(err.stack || String(err)));
