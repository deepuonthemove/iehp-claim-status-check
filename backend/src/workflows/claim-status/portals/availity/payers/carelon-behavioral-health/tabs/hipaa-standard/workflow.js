"use strict";

const logger = require("../../../../utils/logger");
const { waitForSearchTabs } = require("../../../../pages/claim-status-hipaa.page");
const { renderFailedSummary } = require("../../../../services/summary-renderer");
const { runHipaaProviderSearch } = require("../../../../workflows/shared-claim-workflow");

async function processClaim(page, row, options = {}) {
  logger.info("Using Carelon Behavioral Health workflow: HIPAA Standard search only.");
  const { hipaaAvailable } = await waitForSearchTabs(page, 3000, { preferHipaa: true });
  if (!hipaaAvailable) {
    return {
      status: "failed",
      summaries: [renderFailedSummary("HIPAA Standard tab is not available for Carelon Behavioral Health.")],
      matchCount: 0,
      provider: "",
      sourceTab: "",
      notes: "Carelon Behavioral Health requires the HIPAA Standard tab."
    };
  }

  return runHipaaProviderSearch(page, row, options.providerOrder || [], {
    projectId: options.projectId,
    providerMode: options.providerMode,
    matchingPolicy: options.matchingPolicy
  });
}

module.exports = { name: "carelon-behavioral-health", processClaim };
