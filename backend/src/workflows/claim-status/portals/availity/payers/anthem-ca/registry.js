"use strict";

const logger = require("../../utils/logger");
const { waitForSearchTabs } = require("../../pages/claim-status-hipaa.page");
const { getClaimStatusFrame } = require("../../pages/navigation.page");
const { PROVIDERS } = require("../../pages/claim-status-member.page");
const { runHipaaProviderSearch } = require("../../workflows/shared-claim-workflow");
const serviceDatesWorkflow = require("./tabs/service-date/workflow");

async function isServiceDatesTabVisible(page) {
  const frame = await getClaimStatusFrame(page, 5000).catch(() => null);
  if (!frame) return false;
  return frame
    .locator("button[role='tab']:has-text('Service Dates'), a[role='button']:has-text('Service Dates')")
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
}

async function processClaim(page, row, options = {}) {
  const providerOrder = Array.isArray(options.providerOrder) && options.providerOrder.length
    ? options.providerOrder
    : PROVIDERS;
  if (options.projectId === "charm") {
    const serviceDatesAvailable = await isServiceDatesTabVisible(page);
    logger.info(`Anthem-CA Charm tab priority detected: service_dates=${serviceDatesAvailable}`);
    if (serviceDatesAvailable) {
      logger.info("Using Anthem-CA workflow: Service Dates tab first for Charm.");
      return serviceDatesWorkflow.processClaim(page, row, {
        ...options,
        providerOrder
      });
    }
  }

  const { hipaaAvailable } = await waitForSearchTabs(page, 5000, { preferHipaa: true });

  if (hipaaAvailable) {
    logger.info("Using Anthem-CA workflow: HIPAA Standard tab first.");
    return runHipaaProviderSearch(page, row, providerOrder, {
      projectId: options.projectId,
      providerMode: options.providerMode,
      matchingPolicy: options.matchingPolicy
    });
  }

  logger.info("Anthem-CA HIPAA Standard tab is unavailable; falling back to Service Dates.");
  return serviceDatesWorkflow.processClaim(page, row, {
    ...options,
    providerOrder
  });
}

module.exports = {
  name: "anthem-ca",
  processClaim
};
