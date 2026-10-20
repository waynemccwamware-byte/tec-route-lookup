// TEC route lookup — FAA-sourced.
//
// This function runs on Netlify's servers, not in the visitor's browser, so it can
// fetch fly.faa.gov directly with no CORS restriction. It caches the parsed CSV in
// memory for CACHE_TTL_MS so repeated lookups don't re-download the whole national
// database on every request.
//
// The flat CSV download has no date fields at all. The FAA's live query page
// (nfdc_preferred_routes_database.jsp), however, states the current cycle's
// "Effective <date> until <date>" window in its page text — that's the actual
// published/effective date range for this data, so we scrape that alongside the
// CSV rather than substituting our own fetch timestamp for it.

const FAA_CSV_URL = "https://www.fly.faa.gov/rmt/data_file/prefroutes_db.csv";
const FAA_QUERY_PAGE_URL = "https://www.fly.faa.gov/rmt/nfdc_preferred_routes_database.jsp";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

let cache = { rows: null, fetchedAt: 0, effectiveFrom: null, effectiveUntil: null };

function normCode(v) {
  v = (v || "").trim().toUpperCase();
  if (v.length === 4 && v[0] === "K") v = v.slice(1);
  return v;
}

// Minimal CSV parser handling quoted fields with embedded commas/quotes.
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, "");
  const rowsOut = [];
  let field = "",
    row = [],
    inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\r") {
        // skip
      } else if (c === "\n") {
        row.push(field);
        rowsOut.push(row);
        row = [];
        field = "";
      } else {
        field += c;
      }
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rowsOut.push(row);
  }
  return rowsOut;
}

// Parses "Effective 11/27/2025 until 01/22/2026" out of the query page's HTML.
// Returns { from, until } as ISO date strings, or nulls if the page format changed
// and the pattern can't be found — callers must handle that gracefully rather than
// assuming it's always present.
async function fetchEffectiveDates() {
  try {
    const res = await fetch(FAA_QUERY_PAGE_URL);
    if (!res.ok) return { from: null, until: null };
    const html = await res.text();
    const m = html.match(/Effective\s+(\d{2}\/\d{2}\/\d{4})\s+until\s+(\d{2}\/\d{2}\/\d{4})/i);
    if (!m) return { from: null, until: null };
    const toISO = (mmddyyyy) => {
      const [mm, dd, yyyy] = mmddyyyy.split("/");
      return new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`).toISOString();
    };
    return { from: toISO(m[1]), until: toISO(m[2]) };
  } catch (e) {
    return { from: null, until: null };
  }
}

async function loadTecRows(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && cache.rows && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }

  const prevRows = cache.rows; // null on a cold container — no baseline to diff against
  const [csvRes, effective] = await Promise.all([fetch(FAA_CSV_URL), fetchEffectiveDates()]);
  if (!csvRes.ok) {
    throw new Error(`FAA source returned HTTP ${csvRes.status}`);
  }
  const text = await csvRes.text();
  const lines = parseCSV(text);
  if (lines.length < 2) throw new Error("FAA source returned an unexpectedly short file");

  const headers = lines[0];
  const rows = lines
    .slice(1)
    .filter((f) => f.length > 1 || (f.length === 1 && f[0] !== ""))
    .map((fields) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = fields[i] !== undefined ? fields[i] : "";
      });
      return obj;
    })
    .filter((r) => (r["Type"] || "").trim().toUpperCase() === "TEC");

  // Only meaningful when this is a forced refresh with a prior in-memory snapshot to
  // compare against. Netlify Functions are stateless between cold starts, so on a cold
  // start prevRows is null and diff comes back null — the caller shows a "no baseline
  // yet" message rather than a false "no changes" in that case.
  let diff = null;
  if (forceRefresh && prevRows) {
    const keyOf = (r) => [r["Orig"], r["Dest"], r["Direction"], r["Seq"]].join("|");
    const prevMap = new Map(prevRows.map((r) => [keyOf(r), JSON.stringify(r)]));
    const newMap = new Map(rows.map((r) => [keyOf(r), JSON.stringify(r)]));
    let added = 0,
      removed = 0,
      changed = 0;
    for (const [k, v] of newMap) {
      if (!prevMap.has(k)) added++;
      else if (prevMap.get(k) !== v) changed++;
    }
    for (const k of prevMap.keys()) {
      if (!newMap.has(k)) removed++;
    }
    diff = { added, removed, changed, total: added + removed + changed };
  }

  cache = {
    rows,
    fetchedAt: now,
    effectiveFrom: effective.from,
    effectiveUntil: effective.until,
    diff,
  };
  return cache;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  const params = event.queryStringParameters || {};
  const action = params.action || "routes";
  const forceRefresh = params.refresh === "1";

  try {
    const { rows, fetchedAt, effectiveFrom, effectiveUntil, diff } = await loadTecRows(forceRefresh);
    const dates = { fetchedAt, effectiveFrom, effectiveUntil, diff: forceRefresh ? diff : undefined };

    if (action === "origins") {
      const set = new Set(
        rows.map((r) => (r["Orig"] || "").trim().toUpperCase()).filter(Boolean)
      );
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ origins: Array.from(set).sort(), ...dates }),
      };
    }

    if (action === "destinations") {
      const origin = normCode(params.origin);
      if (!origin) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing origin" }) };
      }
      const set = new Set(
        rows
          .filter((r) => (r["Orig"] || "").trim().toUpperCase() === origin)
          .map((r) => (r["Dest"] || "").trim().toUpperCase())
          .filter(Boolean)
      );
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ destinations: Array.from(set).sort(), ...dates }),
      };
    }

    if (action === "routes") {
      const origin = normCode(params.origin);
      const dest = normCode(params.dest);
      if (!origin || !dest) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Missing origin or dest" }),
        };
      }
      const matches = rows
        .filter(
          (r) =>
            (r["Orig"] || "").trim().toUpperCase() === origin &&
            (r["Dest"] || "").trim().toUpperCase() === dest
        )
        .sort((a, b) => (parseInt(a["Seq"]) || 0) - (parseInt(b["Seq"]) || 0));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ routes: matches, ...dates }),
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: "Could not load FAA source data: " + err.message }),
    };
  }
};
