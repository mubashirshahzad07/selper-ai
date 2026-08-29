// lib/wikipedia.mjs
// Definitions come from Wikipedia (MediaWiki REST API), kept visibly distinct
// from Gemini so AI boundaries stay transparent (PRD 4, "Transparent AI boundaries").

import fetch from "node-fetch";

const SEARCH_URL = "https://en.wikipedia.org/w/rest.php/v1/search/page";
const SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary";

export async function fetchWikipediaDefinition(searchTitle) {
  // 1. Search for the best matching page title.
  const searchRes = await fetch(
    `${SEARCH_URL}?q=${encodeURIComponent(searchTitle)}&limit=1`,
    { headers: { "User-Agent": "StudyHelper/1.0 (hackathon project)" } }
  );
  if (!searchRes.ok) throw new Error(`Wikipedia search failed: ${searchRes.status}`);
  const searchData = await searchRes.json();
  const best = searchData?.pages?.[0];
  if (!best) return null;

  // 2. Fetch the summary for that page.
  const summaryRes = await fetch(`${SUMMARY_URL}/${encodeURIComponent(best.key)}`, {
    headers: { "User-Agent": "StudyHelper/1.0 (hackathon project)" },
  });
  if (!summaryRes.ok) throw new Error(`Wikipedia summary failed: ${summaryRes.status}`);
  const summary = await summaryRes.json();

  return {
    title: summary.title,
    extract: summary.extract,
    url: summary.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${best.key}`,
  };
}
