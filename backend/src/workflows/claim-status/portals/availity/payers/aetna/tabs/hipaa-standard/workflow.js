"use strict";

const logger = require("../../../../utils/logger");
const { waitForSearchTabs } = require("../../../../pages/claim-status-hipaa.page");
const { renderFailedSummary } = require("../../../../services/summary-renderer");
const { runHipaaProviderSearch } = require("../../../../workflows/shared-claim-workflow");

const AETNA_PROVIDER_ORDER = ["DAO, THUAN DUC", "TRINITY PAIN MANAGEMENT"];

async function processClaim(page, row, options = {}) {
  logger.info("Using Aetna workflow: HIPAA Standard search only.");
  const { hipaaAvailable } = await waitForSearchTabs(page, 3000, { preferHipaa: true });
  logger.info(`Aetna workflow tabs detected: hipaa_standard=${hipaaAvailable}`);

  if (!hipaaAvailable) {
    return {
      status: "failed",
      summaries: [renderFailedSummary("HIPAA Standard tab is not available for Aetna payer workflow.")],
      matchCount: 0,
      provider: "",
      sourceTab: "",
      notes: "Aetna workflow requires HIPAA Standard tab, but it was not visible."
    };
  }

  const providerOrder = Array.isArray(options.providerOrder) && options.providerOrder.length
    ? options.providerOrder
    : AETNA_PROVIDER_ORDER;
  return runHipaaProviderSearch(page, row, providerOrder, {
    projectId: options.projectId,
    providerMode: options.providerMode,
    matchingPolicy: options.matchingPolicy
  });
}

module.exports = {
  name: "aetna",
  processClaim
};
