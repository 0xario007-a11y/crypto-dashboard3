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
 * Validation model:
 *   Bad individual rows (missing required fields, invalid CoinGecko ID,
 *   duplicate slug after normalization) are EXCLUDED from projects.json and
 *   logged clearly — they do not stop the sync. This keeps one bad Notion row
 *   from taking the whole dashboard offline.
 *
 *   Infrastructure failures (can't reach Notion, can't reach CoinGecko to
 *   validate IDs) DO fail the run (exit 1), because in that case we cannot
 *   safely guarantee projects.json only contains valid projects — better to
 *   leave the previous, known-good projects.json in place and retry on the
 *   next scheduled run.
 *
 * Exit codes:
 *   0 - success, projects.json written (or confirmed unchanged)
 *   1 - infra/config error — the workflow run will show as failed
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

function warn(message) {
  console.warn(`⚠️  ${message}`);
}

if (!NOTION_TOKEN) fail("Missing required environment variable NOTION_TOKEN.");
if (!NOTION_DATABASE_ID) fail("Missing required environment variable NOTION_DATABASE_ID.");

// ---------------------------------------------------------------------------
// Notion property extraction
// ---------------------------------------------------------------------------

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

/** Extracts the option name from a Notion "select" property. */
function getSelect(prop) {
  if (!prop || prop.type !== "select") return "";
  return prop.select ? prop.select.name : "";
}

/**
 * Normalizes the "Chart Source" select value to the lowercase key the
 * front end switches on. Unrecognized or empty values default to
 * "coingecko" so old rows (added before this field existed) keep working
 * with zero changes.
 */
function normalizeChartSource(raw) {
  const key = (raw || "").trim().toLowerCase();
  const known = ["coingecko", "geckoterminal", "dexscreener", "exchange"];
  return known.includes(key) ? key : "coingecko";
}

/**
 * Normalizes a raw Slug value: trim surrounding whitespace, lowercase, and
 * replace internal whitespace with hyphens, so "  My Project " and
 * "my-project" and "My  Project" all converge on "my-project".
 */
function normalizeSlug(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
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

  return {
    name: getTitle(props["Project Name"]),
    slugRaw: getText(props["Slug"]),
    coingeckoId: getText(props["CoinGecko ID"]).trim().toLowerCase(),
    active: getCheckbox(props["Active"]),
    sortOrder: getNumber(props["Sort Order"]),
    description: getText(props["Description"]),
    category: getCategory(props["Category"]),
    website: getUrl(props["Website"]),
    whitepaper: getUrl(props["Whitepaper"]),
    github: getUrl(props["GitHub"]),
    docs: getUrl(props["Documentation"]),
    twitter: getUrl(props["Twitter/X"]),
    chartSource: normalizeChartSource(getSelect(props["Chart Source"])),
    network: getText(props["Network"]).trim(),
    contractAddress: getText(props["Contract Address"]).trim(),
    poolAddress: getText(props["Pool Address"]).trim(),
    tradingPair: getText(props["Trading Pair"]).trim(),
    exchange: getText(props["Exchange"]).trim(),
    notionPageId: page.id,
    notionUrl: page.url,
  };
}

// ---------------------------------------------------------------------------
// CoinGecko ID validation
// ---------------------------------------------------------------------------

/**
 * Fetches the full list of valid CoinGecko coin IDs in a single request, so
 * validating N projects costs 1 API call instead of N (avoids rate limiting
 * and keeps the sync fast). This is an infra dependency: if it fails, we
 * cannot safely tell a valid ID from a typo, so the whole run fails rather
 * than risking a bad ID slipping through.
 */
async function fetchValidCoinGeckoIds() {
  console.log("Fetching CoinGecko coin list for ID validation...");
  const response = await fetch("https://api.coingecko.com/api/v3/coins/list");

  if (!response.ok) {
    fail(
      `Could not fetch CoinGecko's coin list to validate IDs (${response.status} ${response.statusText}). Aborting sync — leaving projects.json unchanged.`
    );
  }

  const list = await response.json();
  const ids = new Set(list.map((c) => c.id));
  console.log(`Loaded ${ids.size} known CoinGecko IDs.`);
  return ids;
}

// ---------------------------------------------------------------------------
// Row-level validation — bad rows are excluded and logged, not fatal
// ---------------------------------------------------------------------------

function validateAndFilter(rawProjects, validCoinGeckoIds) {
  const kept = [];
  const seenSlugs = new Map(); // normalized slug -> row label, for duplicate detection
  const excluded = [];

  function exclude(row, reason) {
    const label = row.name || row.slugRaw || row.notionPageId;
    excluded.push({ label, reason, notionUrl: row.notionUrl });
  }

  for (const row of rawProjects) {
    const rowLabel = row.name || row.slugRaw || row.notionPageId;
    const missing = [];
    if (!row.name) missing.push("Project Name");
    if (!row.slugRaw) missing.push("Slug");
    if (!row.coingeckoId) missing.push("CoinGecko ID");

    if (missing.length) {
      exclude(row, `missing required field(s): ${missing.join(", ")}`);
      continue;
    }

    const slug = normalizeSlug(row.slugRaw);

    if (!slug) {
      exclude(row, `Slug "${row.slugRaw}" normalized to an empty string`);
      continue;
    }

    if (seenSlugs.has(slug)) {
      exclude(
        row,
        `duplicate Slug "${slug}" after normalization (already used by "${seenSlugs.get(slug)}")`
      );
      continue;
    }

    if (!validCoinGeckoIds.has(row.coingeckoId)) {
      exclude(row, `CoinGecko ID "${row.coingeckoId}" does not exist on CoinGecko`);
      continue;
    }

    // Chart Source config is validated softly: an incomplete alt-source
    // config doesn't exclude the project (price/stats still work via
    // CoinGecko ID) — it's logged so it's easy to spot, and the front end
    // falls back to CoinGecko for the chart itself at runtime.
    if (row.chartSource === "geckoterminal" && (!row.network || !row.poolAddress)) {
      warn(`"${rowLabel}" — Chart Source is GeckoTerminal but Network and/or Pool Address is empty; chart will fall back to CoinGecko.`);
    }
    if (row.chartSource === "dexscreener" && (!row.network || !row.poolAddress)) {
      warn(`"${rowLabel}" — Chart Source is DexScreener but Network and/or Pool Address is empty; chart will fall back to CoinGecko.`);
    }

    seenSlugs.set(slug, rowLabel);
    kept.push({
      name: row.name,
      slug,
      coingeckoId: row.coingeckoId,
      active: row.active,
      sortOrder: row.sortOrder,
      description: row.description,
      category: row.category,
      website: row.website,
      whitepaper: row.whitepaper,
      github: row.github,
      docs: row.docs,
      twitter: row.twitter,
      chartSource: row.chartSource,
      network: row.network,
      contractAddress: row.contractAddress,
      poolAddress: row.poolAddress,
      tradingPair: row.tradingPair,
      exchange: row.exchange,
    });
  }

  if (excluded.length) {
    console.warn(`\n${excluded.length} row(s) excluded from projects.json:`);
    for (const e of excluded) {
      warn(`"${e.label}" — ${e.reason}${e.notionUrl ? ` (${e.notionUrl})` : ""}`);
    }
    console.warn("");
  } else {
    console.log("All rows passed validation.");
  }

  return kept;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Querying Notion database ${NOTION_DATABASE_ID}...`);
  const pages = await queryDatabase();
  console.log(`Fetched ${pages.length} row(s) from Notion.`);

  const rawProjects = pages.map(mapPage);
  const validCoinGeckoIds = await fetchValidCoinGeckoIds();
  const projects = validateAndFilter(rawProjects, validCoinGeckoIds);

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
  console.log(`✅ Wrote projects.json with ${projects.length} valid project(s).`);
}

main().catch((err) => fail(err.stack || String(err)));
