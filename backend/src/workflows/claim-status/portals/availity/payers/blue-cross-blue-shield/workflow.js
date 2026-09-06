"use strict";

const logger = require("../../utils/logger");
const { waitForSearchTabs } = require("../../pages/claim-status-hipaa.page");
const { getClaimStatusFrame } = require("../../pages/navigation.page");
const { PROVIDERS } = require("../../pages/claim-status-member.page");
const { renderFailedSummary } = require("../../services/summary-renderer");
const { runBluecareHipaaDirectSearch } = require("./tabs/hipaa-standard/bluecare-hipaa-direct-detail");
const { runBluecareMemberProviderSearch } = require("./tabs/member/bluecare-member-results");
const { runHipaaProviderSearch, runMemberProviderSearch } = require("../../workflows/shared-claim-workflow");
const serviceDatesWorkflow = require("../anthem-ca/tabs/service-date/workflow");

async function isSearchTabVisible(page, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const frame = await getClaimStatusFrame(page, 5000).catch(() => null);
    if (frame) {
      const visible = await frame
        .locator(`button[role='tab']:has-text('${label}'), a[role='button']:has-text('${label}')`)
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false);
      if (visible) {
        return true;
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function isBluecarePayer(row) {
  return normalize(row.data["Payer Name"]) === "BLUE CROSS MEDICARE ADVANTAGE PLAN";
}

function isRecoverableRowError(message) {
  return /Target page, context or browser has been closed|Browser page was closed|page was closed|context.*closed|browser.*closed|submit did not produce results, no-results message, or validation response/i.test(String(message || ""));
}

async function processClaim(page, row, options = {}) {
  logger.info("Using Blue Cross-family tab priority: HIPAA Standard, Service Dates, Member Search, then Claim Number.");
  const providerOrder = Array.isArray(options.providerOrder) && options.providerOrder.length
    ? options.providerOrder
    : PROVIDERS;

  if (options.projectId === "charm" && await isSearchTabVisible(page, "Service Dates")) {
    logger.info("Using Blue Cross-family Charm tab priority: Service Dates tab first.");
    return serviceDatesWorkflow.processClaim(page, row, {
      ...options,
      providerOrder
    });
  }

  if (await isSearchTabVisible(page, "HIPAA Standard")) {
    logger.info("HIPAA Standard tab is available; selecting it as the highest-priority search.");
    if (isBluecarePayer(row)) {
      return runBluecareHipaaDirectSearch(page, row, providerOrder);
    }
    return runHipaaProviderSearch(page, row, providerOrder, {
      projectId: options.projectId,
      providerMode: options.providerMode,
      matchingPolicy: options.matchingPolicy
    });
  }

  if (await isSearchTabVisible(page, "Service Dates")) {
    logger.info("HIPAA Standard is unavailable; selecting the Service Dates tab.");
    return serviceDatesWorkflow.processClaim(page, row, {
      ...options,
      providerOrder
    });
  }

  if (isBluecarePayer(row)) {
    logger.info("BCBSTX workflow detected Blue Cross Medicare Advantage Plan. Using Bluecare Member search path first.");
    const memberResult = await runBluecareMemberProviderSearch(page, row, providerOrder, {
      projectId: options.projectId,
      providerMode: options.providerMode,
    });
    if (memberResult.status === "success") {
      return memberResult;
    }

    if (memberResult.status !== "not_found") {
      logger.warn(`Bluecare Member search did not return a not_found result, so Bluecare HIPAA fallback will not run. Result=${memberResult.status}`);
      return memberResult;
    }

    logger.warn("Bluecare Member search did not find a matching Service Date + Charges row. Falling back to Bluecare HIPAA direct-detail search.");
    const hipaaResult = await runBluecareHipaaDirectSearch(page, row, providerOrder);
    if (hipaaResult.status !== "success") {
      const memberNote = memberResult.notes || "Bluecare Member search did not find a matching Service Date + Charges row.";
      const hipaaNote = hipaaResult.notes || "Bluecare HIPAA direct-detail search did not find a matching Service Date + Charges row.";
      return {
        ...hipaaResult,
        summaries: [
          renderFailedSummary(`${memberNote} ${hipaaNote}`)
        ],
        notes: `${memberNote} ${hipaaNote}`
      };
    }

    return hipaaResult;
  }

  const groupNumber = String(row.data["Group No"] || "").trim();
  let { memberAvailable, hipaaAvailable } = await waitForSearchTabs(page, 3000, {
    preferMember: Boolean(groupNumber),
    preferHipaa: !groupNumber
  });
  logger.info(`BCBSTX workflow tabs detected: member=${memberAvailable}, hipaa_standard=${hipaaAvailable}`);

  if (memberAvailable && groupNumber) {
    logger.info("Member tab is available and Group No is present. Trying Member search first.");
    const memberResult = await runMemberProviderSearch(page, row, providerOrder, undefined, {
      projectId: options.projectId,
      providerMode: options.providerMode,
    });
    if (memberResult.status === "success") {
      return memberResult;
    }

    if (memberResult.status !== "not_found") {
      logger.warn(`Member search did not return a not_found result, so HIPAA fallback will not run. Result=${memberResult.status}`);
      return memberResult;
    }

    if (!hipaaAvailable) {
      logger.info("Waiting up to 3 seconds for HIPAA Standard tab before Member-to-HIPAA fallback");
      const latestTabs = await waitForSearchTabs(page, 3000, { preferHipaa: true });
      hipaaAvailable = latestTabs.hipaaAvailable;
    }

    if (!hipaaAvailable) {
      return memberResult;
    }

    logger.warn("Member search did not find a matching Service Date + Charges row. Falling back to HIPAA Standard search.");
    let hipaaResult;
    try {
      hipaaResult = await runHipaaProviderSearch(page, row, providerOrder, {
        projectId: options.projectId,
        providerMode: options.providerMode,
        matchingPolicy: options.matchingPolicy
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (isRecoverableRowError(message)) {
        throw error;
      }
      logger.warn(`HIPAA fallback failed after Member no-match. Keeping Member no-match as the row result. HIPAA error: ${message}`);
      return memberResult;
    }

    if (hipaaResult.status !== "success") {
      const memberNote = memberResult.notes || "Member search did not find a matching Service Date + Charges row.";
      const hipaaNote = hipaaResult.notes || "HIPAA Standard search did not find a matching Service Date + Charges row.";
      return {
        ...hipaaResult,
        summaries: [
          renderFailedSummary(`${memberNote} ${hipaaNote}`)
        ],
        notes: `${memberNote} ${hipaaNote}`
      };
    }

    return hipaaResult;
  }

  if (memberAvailable && !groupNumber) {
    logger.warn("Group No is missing, so Member search is skipped and HIPAA Standard search will be used.");
  } else if (!memberAvailable) {
    logger.warn("Member tab is not available for this payer, so HIPAA Standard search will be used.");
  }

  if (!hipaaAvailable) {
    return {
      status: "failed",
      summaries: [renderFailedSummary("Neither a usable Member search nor HIPAA Standard tab is available for this payer.")],
      matchCount: 0,
      provider: "",
      sourceTab: "",
      notes: "Member unavailable/missing required Group No and HIPAA Standard tab was not visible."
    };
  }

  return runHipaaProviderSearch(page, row, providerOrder, {
    projectId: options.projectId,
    providerMode: options.providerMode,
    matchingPolicy: options.matchingPolicy
  });
}

module.exports = {
  name: "bcbstx",
  processClaim
};
