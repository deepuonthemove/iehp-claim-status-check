"use strict";

const logger = require("../../utils/logger");
const { waitForSearchTabs } = require("../../pages/claim-status-hipaa.page");
const { PROVIDERS } = require("../../pages/claim-status-member.page");
const { renderFailedSummary } = require("../../services/summary-renderer");
const { runBluecareHipaaDirectSearch } = require("./bluecare-hipaa-direct-detail");
const { runBluecareMemberProviderSearch } = require("./bluecare-member-results");
const { runHipaaProviderSearch, runMemberProviderSearch } = require("../../workflows/shared-claim-workflow");

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
  logger.info("Using BCBSTX workflow: Member search first, then HIPAA Standard fallback when applicable.");

  if (isBluecarePayer(row)) {
    logger.info("BCBSTX workflow detected Blue Cross Medicare Advantage Plan. Using Bluecare Member search path first.");
    const memberResult = await runBluecareMemberProviderSearch(page, row, PROVIDERS, {
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
    const hipaaResult = await runBluecareHipaaDirectSearch(page, row, PROVIDERS);
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
    const memberResult = await runMemberProviderSearch(page, row, PROVIDERS, undefined, {
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
      hipaaResult = await runHipaaProviderSearch(page, row, PROVIDERS, {
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

  return runHipaaProviderSearch(page, row, PROVIDERS, {
    projectId: options.projectId,
    providerMode: options.providerMode,
    matchingPolicy: options.matchingPolicy
  });
}

module.exports = {
  name: "bcbstx",
  processClaim
};
