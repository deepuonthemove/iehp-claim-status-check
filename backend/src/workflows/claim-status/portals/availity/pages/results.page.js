"use strict";

const { getClaimStatusFrame } = require("./navigation.page");
const { humanDelay } = require("../utils/browser");
const logger = require("../utils/logger");
const { normalizeStatus } = require("../services/status-normalizer");

const SELECTORS = {
  searchResultsHeading: "h5:has-text('Search Results')",
  hipaaResultsHeading: "span:has-text('Results (Displaying')",
  tableRows: "tbody tr",
  noResultsMessage: "li:has-text('The payer could not find any results based on your search')",
  portalAlert: "[role='alert'], .MuiAlert-root"
};

function normalizeMessageText(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function inferMessageSeverity(className) {
  const classes = String(className || "").toLowerCase();
  if (/danger|error/.test(classes)) return "ERROR";
  if (/warning/.test(classes)) return "WARNING";
  if (/info/.test(classes)) return "INFO";
  if (/success/.test(classes)) return "SUCCESS";
  return "MESSAGE";
}

function deduplicatePortalMessages(messages) {
  const seen = new Set();
  return messages.filter((message) => {
    const key = `${message.severity}|${message.text}`.toLowerCase();
    if (!message.text || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatPortalMessages(messages) {
  if (!messages.length) return "";
  return ["Portal Response:", ...messages.map((message) => `${message.severity}: ${message.text}`)].join("\n");
}

async function getPortalMessages(page) {
  const frame = await getClaimStatusFrame(page);
  const resultAlerts = await frame.locator("#results [role='alert'], #results .MuiAlert-root").evaluateAll((nodes) => nodes
    .filter((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    })
    .map((node) => ({ text: node.innerText || node.textContent || "", className: node.className || "" })))
    .catch(() => []);

  const invalidFieldMessages = await frame.locator(
    "[aria-invalid='true'][aria-describedby], .MuiFormHelperText-root.Mui-error, .invalid-feedback"
  ).evaluateAll((nodes) => {
    const messages = [];
    for (const node of nodes) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (style.visibility === "hidden" || style.display === "none" || rect.width === 0 || rect.height === 0) continue;
      if (node.matches("[aria-invalid='true'][aria-describedby]")) {
        const ids = (node.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
        for (const id of ids) {
          const description = document.getElementById(id);
          if (description) messages.push({ text: description.innerText || description.textContent || "", className: "error" });
        }
      } else {
        messages.push({ text: node.innerText || node.textContent || "", className: `${node.className || ""} error` });
      }
    }
    return messages;
  }).catch(() => []);

  return deduplicatePortalMessages([...resultAlerts, ...invalidFieldMessages].map((message) => ({
    severity: inferMessageSeverity(message.className),
    text: normalizeMessageText(message.text)
  })));
}

async function getVisibleFieldValidationMessages(page) {
  const frame = await getClaimStatusFrame(page);
  const invalidFieldMessages = await frame.locator(
    "[aria-invalid='true'][aria-describedby], .MuiFormHelperText-root.Mui-error, .invalid-feedback"
  ).evaluateAll((nodes) => {
    const messages = [];
    for (const node of nodes) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (style.visibility === "hidden" || style.display === "none" || rect.width === 0 || rect.height === 0) continue;
      if (node.matches("[aria-invalid='true'][aria-describedby]")) {
        const ids = (node.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
        for (const id of ids) {
          const description = document.getElementById(id);
          if (description) messages.push({ text: description.innerText || description.textContent || "", className: "error" });
        }
      } else {
        messages.push({ text: node.innerText || node.textContent || "", className: `${node.className || ""} error` });
      }
    }
    return messages;
  }).catch(() => []);

  return deduplicatePortalMessages(invalidFieldMessages.map((message) => ({
    severity: inferMessageSeverity(message.className),
    text: normalizeMessageText(message.text)
  })));
}

async function throwIfVisibleFieldValidation(page, context = "Availity") {
  const messages = await getVisibleFieldValidationMessages(page);
  if (!messages.length) return;

  throw new Error(`${context} field validation failed before submit. ${formatPortalMessages(messages)}`);
}

function normalizeMoney(value) {
  const numeric = Number(String(value || "").replace(/[$,\s]/g, "").trim());
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "";
}

function normalizeDateText(value) {
  const match = String(value || "").match(/\d{2}\/\d{2}\/\d{4}/);
  return match ? match[0] : "";
}

function parseDateValue(value) {
  const normalized = normalizeDateText(value);
  const [month, day, year] = normalized.split("/").map((part) => Number(part));
  if (!month || !day || !year) {
    return null;
  }

  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function readRowCells(rowLocator) {
  const cells = await rowLocator.locator("td").evaluateAll((nodes) => nodes.map((node) => node.textContent || ""));
  return cells.map((cell) => cell.replace(/\s+/g, " ").trim());
}

async function readColumnHeaders(frame) {
  const headers = await frame.locator("thead th").evaluateAll((nodes) => nodes.map((node) => node.textContent || "")).catch(() => []);
  return headers.map((header) => header.replace(/\s+/g, " ").trim().toLowerCase());
}

function cellByHeader(cells, headers, headerName) {
  const target = String(headerName || "").toLowerCase();
  const index = headers.findIndex((header) => header === target || header.includes(target));
  return index >= 0 ? cells[index] || "" : "";
}

function inferClaimNumber(cells) {
  return cells.find((cell) => /^[A-Za-z0-9-]{8,}$/.test(cell)) || "";
}

function inferBilledAmount(cells) {
  const moneyCells = cells.filter((cell) => /\$[\d,]+\.\d{2}/.test(cell));
  return moneyCells.length ? moneyCells[moneyCells.length - 1] : "";
}

function inferServiceDate(cells) {
  for (const cell of cells) {
    const date = normalizeDateText(cell);
    if (date) {
      return date;
    }
  }
  return "";
}

function inferStatus(cells) {
  return cells.find((cell) => /(IN\s*-?\s*PROCESS|PENDING|PAID|DENIED)/i.test(cell)) || "";
}

async function getResultRows(page) {
  const frame = await getClaimStatusFrame(page);
  const headers = await readColumnHeaders(frame);
  const rows = frame.locator(SELECTORS.tableRows);
  const count = await rows.count();
  const results = [];

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const cells = await readRowCells(row);
    if (cells.length < 2) {
      continue;
    }

    const statusText = await row.locator(".badge").first().innerText({ timeout: 1000 }).catch(() => inferStatus(cells));
    const headerServiceDate = cellByHeader(cells, headers, "service dates");
    const headerBilledAmount = cellByHeader(cells, headers, "billed amount");
    const headerClaimNumber = cellByHeader(cells, headers, "claim number") || cellByHeader(cells, headers, "claim #");
    const headerFinalizedDate = cellByHeader(cells, headers, "finalized date");
    const headerPatientAccountNumber = cellByHeader(cells, headers, "patient account number")
      || cellByHeader(cells, headers, "patient id");
    const headerPatientName = cellByHeader(cells, headers, "patient name")
      || cellByHeader(cells, headers, "member name");
    results.push({
      index,
      row,
      cells,
      serviceDate: normalizeDateText(headerServiceDate) || inferServiceDate(cells),
      billedAmount: headerBilledAmount || inferBilledAmount(cells),
      claimNumber: headerClaimNumber || inferClaimNumber(cells),
      finalizedDate: normalizeDateText(headerFinalizedDate),
      finalizedDateValue: parseDateValue(headerFinalizedDate),
      patientId: headerPatientAccountNumber,
      patientName: headerPatientName,
      status: normalizeStatus(statusText || inferStatus(cells))
    });
  }

  return results;
}

async function findMatchingRows(page, rowData) {
  const results = await getResultRows(page);
  const inputDate = normalizeDateText(rowData["Service Date"]);
  const inputCharge = normalizeMoney(rowData.Charges);

  results.forEach((result) => {
    logger.info(
      `Parsed result row ${result.index + 1}: service_date="${result.serviceDate}", billed="${result.billedAmount}", normalized_billed="${normalizeMoney(result.billedAmount)}", finalized_date="${result.finalizedDate}", claim="${result.claimNumber}", status="${result.status.display}"`
    );
  });

  return results.filter((result) => {
    return result.serviceDate === inputDate && normalizeMoney(result.billedAmount) === inputCharge;
  });
}

async function getSearchResultSummary(page) {
  const frame = await getClaimStatusFrame(page);
  const noResultsMessageVisible = await frame.locator(SELECTORS.noResultsMessage).isVisible().catch(() => false);
  const resultRowCount = await frame.locator(SELECTORS.tableRows).evaluateAll((rows) => {
    return rows.filter((row) => row.querySelectorAll("td").length >= 2).length;
  }).catch(() => 0);
  const portalMessages = await getPortalMessages(page);
  const portalAlertMessage = formatPortalMessages(portalMessages);
  let headingText = await frame.locator(SELECTORS.searchResultsHeading).first().innerText().catch(() => "");
  if (!headingText) {
    headingText = await frame.locator(SELECTORS.hipaaResultsHeading).first().innerText().catch(() => "");
  }
  const displayMatch = headingText.match(/Displaying\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i);
  const total = displayMatch ? Number(displayMatch[3]) : null;

  return {
    headingText,
    total,
    hasResults: Number.isFinite(total) && total > 0,
    hasResultRows: resultRowCount > 0,
    resultRowCount,
    hasZeroResults: noResultsMessageVisible || total === 0,
    noResultsMessageVisible,
    hasPortalAlert: Boolean(portalAlertMessage),
    portalAlertMessage,
    portalMessages
  };
}

async function waitForSearchResultsToSettle(page, timeoutMs = 5000) {
  let latestSummary = null;
  const initialDeadline = Date.now() + timeoutMs;
  let deadline = initialDeadline;
  let responseDetectedAt = 0;
  let previousSignature = "";
  let stableSamples = 0;

  while (Date.now() < deadline) {
    latestSummary = await getSearchResultSummary(page);

    if (latestSummary.hasResultRows || latestSummary.noResultsMessageVisible || latestSummary.hasPortalAlert) {
      if (!responseDetectedAt) {
        responseDetectedAt = Date.now();
        deadline = Math.max(initialDeadline, responseDetectedAt + 6000);
      }
      const signature = JSON.stringify({
        rows: latestSummary.resultRowCount,
        heading: latestSummary.headingText,
        messages: latestSummary.portalMessages
      });
      stableSamples = signature === previousSignature ? stableSamples + 1 : 0;
      previousSignature = signature;

      // Rows are enough to continue quickly; alerts/no-results get a shorter
      // settling window so the detailed portal message can finish rendering.
      const settleMs = latestSummary.hasResultRows ? 1200 : 2500;
      if (Date.now() - responseDetectedAt >= settleMs && stableSamples >= 1) {
        return latestSummary;
      }
    }

    await humanDelay(500, 750);
  }

  return getSearchResultSummary(page).catch(() => latestSummary);
}

async function hasNoResults(page) {
  const frame = await getClaimStatusFrame(page);
  return frame.locator(SELECTORS.noResultsMessage).isVisible().catch(() => false);
}

module.exports = {
  findMatchingRows,
  getSearchResultSummary,
  getResultRows,
  hasNoResults,
  waitForSearchResultsToSettle,
  normalizeMoney,
  normalizeDateText,
  getPortalMessages,
  formatPortalMessages,
  getVisibleFieldValidationMessages,
  throwIfVisibleFieldValidation
};
