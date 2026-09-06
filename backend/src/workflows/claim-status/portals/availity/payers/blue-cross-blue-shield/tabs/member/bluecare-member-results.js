"use strict";

const logger = require("../../../../utils/logger");
const { getClaimStatusFrame } = require("../../../../pages/navigation.page");
const { PROVIDERS } = require("../../../../pages/claim-status-member.page");
const { normalizeDateText, waitForSearchResultsToSettle } = require("../../../../pages/results.page");
const { normalizeStatus } = require("../../../../services/status-normalizer");
const { renderFailedSummary } = require("../../../../services/summary-renderer");
const { processParsedSearchResults } = require("../../../../workflows/shared-claim-workflow");
const { searchBluecareMemberWithProvider } = require("./bluecare-member-search");

async function getBluecareMemberResultRows(page) {
  const frame = await getClaimStatusFrame(page);
  const rows = frame.locator("tbody tr");
  const count = await rows.count();
  const results = [];

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const cells = await row.locator("td").evaluateAll((nodes) => {
      return nodes.map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim());
    }).catch(() => []);

    if (cells.length < 6) {
      continue;
    }

    const statusText = await row.locator(".badge").first().innerText({ timeout: 1000 }).catch(() => cells[0] || "");
    const parsed = {
      index,
      row,
      cells,
      serviceDate: normalizeDateText(cells[1]),
      billedAmount: cells[5] || "",
      claimNumber: cells[2] || "",
      finalizedDate: "",
      finalizedDateValue: null,
      status: normalizeStatus(statusText || cells[0] || "")
    };

    logger.info(
      `Parsed Bluecare Member result row ${index + 1}: service_date="${parsed.serviceDate}", billed="${parsed.billedAmount}", claim="${parsed.claimNumber}", status="${parsed.status.display}"`
    );
    results.push(parsed);
  }

  return results;
}

async function runBluecareMemberProviderSearch(page, row, providerOrder = PROVIDERS, options = {}) {
  let lastProviderFailure = "";

  for (const provider of providerOrder) {
    await searchBluecareMemberWithProvider(page, provider, row.data, {
      projectId: options.projectId,
      providerMode: options.providerMode,
    });

    logger.info(`Waiting up to 5 seconds for ${provider} Bluecare Member search results to settle`);
    const resultSummary = await waitForSearchResultsToSettle(page, 5000);
    logger.info(
      `Bluecare Member provider ${provider} search result summary: heading="${resultSummary.headingText || "not found"}", total=${resultSummary.total ?? "unknown"}, rows=${resultSummary.resultRowCount ?? "unknown"}, no_results_message=${resultSummary.noResultsMessageVisible}, alert="${resultSummary.portalAlertMessage || ""}"`
    );

    const resultRows = await getBluecareMemberResultRows(page);

    if (resultSummary.hasPortalAlert && resultRows.length === 0) {
      logger.warn(`Bluecare Member provider ${provider} returned portal alert without claim rows: ${resultSummary.portalAlertMessage}`);
      lastProviderFailure = `Provider ${provider}: ${resultSummary.portalAlertMessage}`;
      continue;
    }

    if (resultSummary.hasPortalAlert) {
      logger.info(`Bluecare Member provider ${provider} returned an informational alert with result rows. Continuing to parse rows. Alert="${resultSummary.portalAlertMessage}"`);
    }

    if (resultRows.length === 0) {
      logger.warn(`Bluecare Member provider ${provider} returned no claim rows. Trying next provider if available.`);
      lastProviderFailure = `Provider ${provider}: no claim rows returned.`;
      continue;
    }

    return processParsedSearchResults(page, row, provider, resultSummary, "Member", resultRows, "not_found");
  }

  return {
    status: "not_found",
    summaries: [renderFailedSummary(lastProviderFailure || "Claim not found in Bluecare Member tab for matching Service Date and Charges.")],
    matchCount: 0,
    provider: providerOrder.join(", "),
    sourceTab: "Member",
    notes: lastProviderFailure
      ? `Searched Bluecare Member providers: ${providerOrder.join(", ")}. Last provider failure: ${lastProviderFailure}`
      : `Searched Bluecare Member providers: ${providerOrder.join(", ")}. No matching Service Date + Charges found.`
  };
}

module.exports = {
  getBluecareMemberResultRows,
  runBluecareMemberProviderSearch
};
