"use strict";

const logger = require("../../../../utils/logger");
const { waitForSearchTabs } = require("../../../../pages/claim-status-hipaa.page");
const { renderFailedSummary } = require("../../../../services/summary-renderer");
const { runHipaaProviderSearch } = require("../../../../workflows/shared-claim-workflow");

const SCAN_HEALTH_PROVIDER_ORDER = ["DAO, THUAN DUC", "TRINITY PAIN MANAGEMENT"];

async function processClaim(page, row, options = {}) {
  logger.info("Using Scan Health workflow: HIPAA Standard search only.");
  const { hipaaAvailable } = await waitForSearchTabs(page, 3000, { preferHipaa: true });
  logger.info(`Scan Health workflow tabs detected: hipaa_standard=${hipaaAvailable}`);

  if (!hipaaAvailable) {
    return {
      status: "failed",
      summaries: [renderFailedSummary("HIPAA Standard tab is not available for Scan Health payer workflow.")],
      matchCount: 0,
      provider: "",
      sourceTab: "",
      notes: "Scan Health workflow requires HIPAA Standard tab, but it was not visible."
    };
  }

  const providerOrder = Array.isArray(options.providerOrder) && options.providerOrder.length
    ? options.providerOrder
    : SCAN_HEALTH_PROVIDER_ORDER;
  return runHipaaProviderSearch(page, row, providerOrder, { projectId: options.projectId, providerMode: options.providerMode, matchingPolicy: options.matchingPolicy });
}

module.exports = {
  name: "scan-health",
  processClaim
};
