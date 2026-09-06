"use strict";

const logger = require("../../../../utils/logger");
const { waitForSearchTabs } = require("../../../../pages/claim-status-hipaa.page");
const { PROVIDERS } = require("../../../../pages/claim-status-member.page");
const { renderFailedSummary } = require("../../../../services/summary-renderer");
const { runHipaaProviderSearch } = require("../../../../workflows/shared-claim-workflow");

async function processClaim(page, row, options = {}) {
  logger.info("Using Wellpoint workflow: HIPAA Standard search only.");
  const { hipaaAvailable } = await waitForSearchTabs(page, 3000, { preferHipaa: true });
  logger.info(`Wellpoint workflow tabs detected: hipaa_standard=${hipaaAvailable}`);

  if (!hipaaAvailable) {
    return {
      status: "failed",
      summaries: [renderFailedSummary("HIPAA Standard tab is not available for Wellpoint payer workflow.")],
      matchCount: 0,
      provider: "",
      sourceTab: "",
      notes: "Wellpoint workflow requires HIPAA Standard tab, but it was not visible."
    };
  }

  const providerOrder = Array.isArray(options.providerOrder) && options.providerOrder.length
    ? options.providerOrder
    : PROVIDERS;
  return runHipaaProviderSearch(page, row, providerOrder, {
    projectId: options.projectId,
    providerMode: options.providerMode,
    matchingPolicy: options.matchingPolicy,
    useHipaaDeniedExtractorForDeniedStatus: true,
    hipaaExtractionOptions: {
      preferExpandedReasonRemarkCode: true
    }
  });
}

module.exports = {
  name: "wellpoint",
  processClaim
};
