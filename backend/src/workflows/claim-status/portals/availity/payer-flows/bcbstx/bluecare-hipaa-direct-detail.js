"use strict";

const logger = require("../../utils/logger");
const { humanDelay, withRetry } = require("../../utils/browser");
const { getClaimStatusFrame } = require("../../pages/navigation.page");
const { PROVIDERS } = require("../../pages/claim-status-member.page");
const { fillHipaaSearchForm, HIPAA_SELECTORS, selectHipaaTab, selectProvider } = require("../../pages/claim-status-hipaa.page");
const { normalizeDateText, normalizeMoney, throwIfVisibleFieldValidation } = require("../../pages/results.page");
const { normalizeStatus } = require("../../services/status-normalizer");
const { renderClaimSummary, renderFailedSummary } = require("../../services/summary-renderer");

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function waitForBluecareHipaaDetailOrAlert(page, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const frame = await getClaimStatusFrame(page);
    const hasDetail = await hasBluecareHipaaDetail(page);
    const hasAlert = await frame.locator("[role='alert'], .MuiAlert-root").first().isVisible({ timeout: 500 }).catch(() => false);

    if (hasDetail || hasAlert) {
      return true;
    }

    await humanDelay(800, 1200);
  }

  return false;
}

async function hasBluecareHipaaDetail(page) {
  const frame = await getClaimStatusFrame(page);
  const hasClaim = await frame.getByText("Claim", { exact: true }).first().isVisible({ timeout: 500 }).catch(() => false);
  const hasDatesOfService = await frame.getByText("Dates of Service", { exact: true }).first().isVisible({ timeout: 500 }).catch(() => false);
  const hasBilled = await frame.getByText("Billed", { exact: true }).first().isVisible({ timeout: 500 }).catch(() => false);
  return hasClaim && hasDatesOfService && hasBilled;
}

async function submitBluecareHipaaSearchExpectingDetail(page) {
  await withRetry(
    "Submitting Bluecare HIPAA search",
    async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const frame = await getClaimStatusFrame(page);
        await throwIfVisibleFieldValidation(page, "Bluecare HIPAA");
        const submitButton = frame.locator(HIPAA_SELECTORS.submitButton).first();
        await submitButton.waitFor({ state: "visible", timeout: 15000 });
        await submitButton.scrollIntoViewIfNeeded().catch(() => {});
        await submitButton.click({ force: attempt > 1 });
        logger.info(`Bluecare HIPAA Submit clicked (attempt ${attempt}/3). Waiting for direct detail page.`);
        await humanDelay(1500, 2500);

        if (await waitForBluecareHipaaDetailOrAlert(page, 5000)) {
          logger.info(`Bluecare HIPAA direct detail/alert appeared after submit attempt ${attempt}.`);
          return;
        }

        if (attempt < 3) {
          logger.warn(`Bluecare HIPAA detail did not appear within 5 seconds after submit attempt ${attempt}. Re-clicking Submit.`);
        }
      }

      throw new Error("Bluecare HIPAA Submit did not produce direct detail page or validation response after 3 attempts.");
    },
    { retries: 1, retryDelayMs: 1200 }
  );
}

async function searchBluecareHipaaWithProvider(page, providerName, rowData) {
  logger.info(`Bluecare HIPAA search provider attempt: ${providerName}`);
  await selectHipaaTab(page);
  await selectProvider(page, providerName);
  await fillHipaaSearchForm(page, rowData);
  await submitBluecareHipaaSearchExpectingDetail(page);
}

async function readLabelValue(frame, labelText) {
  return frame.evaluate((targetLabel) => {
    function cleanText(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    const labels = Array.from(document.querySelectorAll("span, div, p"))
      .filter((element) => cleanText(element.textContent) === targetLabel);

    for (const label of labels) {
      const container = label.closest(".mb-1, [data-testid='labelValuePairTest'], .row, li") || label.parentElement;
      if (!container) {
        continue;
      }

      const bold = container.querySelector(".font-weight-bold");
      const value = cleanText(bold && bold.textContent);
      if (value && value !== targetLabel) {
        return value;
      }
    }

    return "";
  }, labelText).catch(() => "");
}

async function readLineItems(frame) {
  const rawLines = await frame.evaluate(() => {
    function cleanText(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function readLabel(container, labelText) {
      const labels = Array.from(container.querySelectorAll("span, div, p"))
        .filter((element) => cleanText(element.textContent) === labelText);

      for (const label of labels) {
        let group = label.parentElement;
        for (let depth = 0; group && depth < 8; depth += 1) {
          const bold = group.querySelector(".font-weight-bold");
          const value = cleanText(bold && bold.textContent);
          if (value && value !== labelText) {
            return value;
          }
          group = group.parentElement;
        }
      }

      return "";
    }

    function hasLabel(container, labelText) {
      return Array.from(container.querySelectorAll("span, div, p"))
        .some((element) => cleanText(element.textContent) === labelText);
    }

    function findLineContainerFromProcedureLabel(label) {
      const listItem = label.closest("li.list-group-item, .list-group-item, [class*='list-group-item'], .card, [class*='card']");
      if (listItem && hasLabel(listItem, "Procedure Code") && (hasLabel(listItem, "Billed") || hasLabel(listItem, "Paid"))) {
        return listItem;
      }

      let candidate = label.parentElement;
      for (let depth = 0; candidate && depth < 12; depth += 1) {
        if (hasLabel(candidate, "Procedure Code") && (hasLabel(candidate, "Billed") || hasLabel(candidate, "Paid"))) {
          return candidate;
        }
        candidate = candidate.parentElement;
      }

      return null;
    }

    const candidates = Array.from(document.querySelectorAll("span, div, p"))
      .filter((element) => cleanText(element.textContent) === "Procedure Code")
      .map(findLineContainerFromProcedureLabel)
      .filter(Boolean);

    const uniqueItems = [];
    for (const candidate of candidates) {
      if (uniqueItems.includes(candidate)) {
        continue;
      }
      if (hasLabel(candidate, "Procedure Code") && (hasLabel(candidate, "Billed") || hasLabel(candidate, "Paid"))) {
        uniqueItems.push(candidate);
      }
    }

    return uniqueItems.map((item) => {
      const statusDetails = Array.from(item.querySelectorAll("[data-testid^='statusDetails'], ul li"))
        .map((node) => cleanText(node.textContent))
        .filter(Boolean);

      return {
        serviceDates: readLabel(item, "Dates of Service"),
        procedureCode: readLabel(item, "Procedure Code"),
        modifier: readLabel(item, "Modifier"),
        quantity: readLabel(item, "Quantity"),
        status: readLabel(item, "Status"),
        billed: readLabel(item, "Billed"),
        paid: readLabel(item, "Paid"),
        statusDetails
      };
    });
  }).catch(() => []);

  const lines = rawLines.filter((line) => line.procedureCode || line.billed || line.paid);
  logger.info(`Bluecare HIPAA CPT box scan extracted ${lines.length} line item(s).`);
  return lines;
}

async function parseBluecareHipaaDetail(page) {
  const frame = await getClaimStatusFrame(page);
  const claimNumber = await readLabelValue(frame, "Claim");
  const claimStatus = await readLabelValue(frame, "Status");
  const serviceDates = await readLabelValue(frame, "Dates of Service");
  const finalizedDate = await readLabelValue(frame, "Processed");
  const billedAmount = await readLabelValue(frame, "Billed");
  const paidAmount = await readLabelValue(frame, "Paid");
  const checkNumber = await readLabelValue(frame, "Check Number");
  const checkDate = await readLabelValue(frame, "Check Date");
  const status = normalizeStatus(claimStatus);
  const lineItems = await readLineItems(frame);

  const lines = lineItems.map((line) => {
    const details = (line.statusDetails || []).filter((text) => !/^Status as of/i.test(text));
    return {
      procedureCode: line.procedureCode,
      serviceDates: line.serviceDates,
      paid: line.paid,
      billed: line.billed,
      allowed: "",
      deductible: "",
      copay: "",
      coinsurance: "",
      remarkCode: "",
      description: details.join(" "),
      reasonRemarkCode: ""
    };
  });

  logger.info(
    `Bluecare HIPAA detail parsed: claim="${claimNumber}", status="${claimStatus}", service_dates="${serviceDates}", processed="${finalizedDate}", billed="${billedAmount}", paid="${paidAmount}", lines=${lines.length}`
  );

  return {
    type: status.type,
    lineSummaryMode: "status_details",
    claimNumber,
    claimStatus: status.display,
    serviceDate: normalizeDateText(serviceDates),
    finalizedDate: normalizeDateText(finalizedDate),
    billedAmount,
    paidAmount,
    checkNumber,
    checkDate,
    lines
  };
}

function detailMatchesInput(detail, rowData) {
  return detail.serviceDate === normalizeDateText(rowData["Service Date"])
    && normalizeMoney(detail.billedAmount) === normalizeMoney(rowData.Charges);
}

async function returnToHipaaSearch(page) {
  const frame = await getClaimStatusFrame(page);
  const searchLink = frame.locator("a[aria-label='Search'], a:has-text('Search')").first();

  if (await searchLink.isVisible({ timeout: 3000 }).catch(() => false)) {
    await searchLink.click();
    logger.info("Clicked Bluecare HIPAA Search link to return to search form.");
    await humanDelay(1000, 1800);
    return;
  }

  logger.warn("Bluecare HIPAA Search link was not visible; falling back to browser history.");
  await frame.evaluate(() => window.history.back()).catch(async () => {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
  });
  await humanDelay(1000, 1800);
}

async function runBluecareHipaaDirectSearch(page, row, providerOrder = PROVIDERS) {
  let lastProviderFailure = "";

  for (const provider of providerOrder) {
    await searchBluecareHipaaWithProvider(page, provider, row.data);

    const frame = await getClaimStatusFrame(page);
    const portalAlertMessage = await frame.locator("[role='alert'], .MuiAlert-root").first()
      .innerText({ timeout: 1000 })
      .then((text) => clean(text))
      .catch(() => "");

    const detailVisible = await hasBluecareHipaaDetail(page);
    if (portalAlertMessage && !detailVisible) {
      logger.warn(`Bluecare HIPAA provider ${provider} returned portal alert: ${portalAlertMessage}`);
      lastProviderFailure = `Provider ${provider}: ${portalAlertMessage}`;
      await returnToHipaaSearch(page);
      continue;
    }

    if (portalAlertMessage && detailVisible) {
      logger.info(`Bluecare HIPAA provider ${provider} returned an informational alert with direct detail. Continuing extraction. Alert="${portalAlertMessage}"`);
    }

    const detail = await parseBluecareHipaaDetail(page);
    if (!detailMatchesInput(detail, row.data)) {
      lastProviderFailure = `Provider ${provider}: direct detail did not match input Service Date ${row.data["Service Date"]} and Charges ${row.data.Charges}. Returned service_date=${detail.serviceDate || "blank"}, billed=${detail.billedAmount || "blank"}, claim=${detail.claimNumber || "blank"}, status=${detail.claimStatus || "blank"}.`;
      logger.warn(lastProviderFailure);
      await returnToHipaaSearch(page);
      continue;
    }

    const extracted = {
      ...detail,
      payerName: row.data["Payer Name"] || ""
    };
    await returnToHipaaSearch(page);

    return {
      status: "success",
      summaries: [renderClaimSummary(extracted)],
      matchCount: 1,
      provider,
      sourceTab: "HIPAA Standard",
      notes: "Bluecare HIPAA direct detail matched input Service Date + Charges."
    };
  }

  return {
    status: "failed",
    summaries: [renderFailedSummary(lastProviderFailure || "Claim not found in Bluecare HIPAA direct detail search for matching Service Date and Charges.")],
    matchCount: 0,
    provider: providerOrder.join(", "),
    sourceTab: "HIPAA Standard",
    notes: lastProviderFailure
      ? `Searched Bluecare HIPAA providers: ${providerOrder.join(", ")}. Last provider failure: ${lastProviderFailure}`
      : `Searched Bluecare HIPAA providers: ${providerOrder.join(", ")}. No matching Service Date + Charges found.`
  };
}

module.exports = {
  parseBluecareHipaaDetail,
  runBluecareHipaaDirectSearch
};
