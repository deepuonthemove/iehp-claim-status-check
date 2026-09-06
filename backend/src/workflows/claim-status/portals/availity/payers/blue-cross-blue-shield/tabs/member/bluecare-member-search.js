"use strict";

const logger = require("../../../../utils/logger");
const { humanDelay, withRetry } = require("../../../../utils/browser");
const { getClaimStatusFrame } = require("../../../../pages/navigation.page");
const { clearProviderFormIfVisible, fillInputProviderIdentifiers } = require("../../../../pages/provider-identifiers.page");
const { throwIfVisibleFieldValidation } = require("../../../../pages/results.page");

const SELECTORS = {
  memberTabButton: "button[role='tab']:has-text('Member')",
  memberTabAnchor: "a[role='button']:has-text('Member')",
  providerControl: "#providerSelect .provider-select__control",
  providerDropdownIndicator: "#providerSelect .provider-select__dropdown-indicator",
  providerInput: "#providerSelect input#providerExpressEntry[role='combobox']",
  providerSelectedText: "#providerSelect .provider-select__single-value",
  memberId: "input#patientMemberId[name='patientMemberId']",
  serviceFromDate: "input#serviceDates-start[name='serviceDates-start']",
  serviceToDate: "input#serviceDates-end[name='serviceDates-end']",
  submitButton: "button#submit-byMember[type='submit']",
  resultsHeading: "span:has-text('Results (Displaying'), h5:has-text('Results (Displaying'), h5:has-text('Search Results')",
  tableRows: "tbody tr",
  noResultsMessage: "li:has-text('The payer could not find any results based on your search')",
  portalAlert: "[role='alert'], .MuiAlert-root"
};

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

async function getSelectedProviderText(frame) {
  return frame.locator(SELECTORS.providerSelectedText).first()
    .innerText({ timeout: 1500 })
    .then((text) => text.replace(/\s+/g, " ").trim())
    .catch(() => "");
}

async function clickExactProviderOption(frame, providerName) {
  const clicked = await frame.evaluate((expected) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
    const expectedValue = normalize(expected);
    const options = Array.from(document.querySelectorAll("[role='option'], [id^='react-select-'][id*='-option-'], .provider-select__option"));
    const exactOption = options.find((option) => normalize(option.textContent).includes(expectedValue));

    if (!exactOption) {
      return false;
    }

    exactOption.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    exactOption.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    exactOption.click();
    return true;
  }, providerName).catch(() => false);

  return Boolean(clicked);
}

async function waitAndClickExactProviderOption(frame, providerName, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await clickExactProviderOption(frame, providerName)) {
      return true;
    }

    await humanDelay(300, 500);
  }

  return false;
}

async function selectMemberTab(page) {
  await withRetry(
    "Selecting Bluecare Member tab",
    async () => {
      const frame = await getClaimStatusFrame(page);
      const buttonTab = frame.locator(SELECTORS.memberTabButton).first();
      const anchorTab = frame.locator(SELECTORS.memberTabAnchor).first();
      const tab = await buttonTab.isVisible({ timeout: 1500 }).catch(() => false)
        ? buttonTab
        : anchorTab;
      await tab.waitFor({ state: "visible", timeout: 5000 });
      await tab.click({ force: true });
      await humanDelay(500, 900);
    },
    { retries: 1, retryDelayMs: 1000 }
  );
}

async function selectProvider(page, providerName) {
  await withRetry(
    `Selecting Bluecare provider ${providerName}`,
    async () => {
      const frame = await getClaimStatusFrame(page);
      const selectedBefore = await getSelectedProviderText(frame);
      if (normalize(selectedBefore).includes(normalize(providerName))) {
        logger.info(`Bluecare provider ${providerName} already selected`);
        return;
      }

      const providerControl = frame.locator(SELECTORS.providerControl).first();
      const dropdownIndicator = frame.locator(SELECTORS.providerDropdownIndicator).first();
      const input = frame.locator(SELECTORS.providerInput).first();
      await input.waitFor({ state: "visible", timeout: 15000 });
      await providerControl.scrollIntoViewIfNeeded().catch(() => {});
      if (await dropdownIndicator.isVisible({ timeout: 1000 }).catch(() => false)) {
        await dropdownIndicator.click({ force: true });
      } else {
        await providerControl.click({ force: true });
      }
      await humanDelay(300, 600);
      await input.click({ force: true });
      await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
      await input.press("Backspace").catch(() => {});
      await input.pressSequentially(providerName, { delay: 60 });

      if (await waitAndClickExactProviderOption(frame, providerName, 3000)) {
        logger.info(`Clicked Bluecare provider dropdown option: ${providerName}`);
      } else {
        throw new Error(`Bluecare provider dropdown has no exact option for "${providerName}".`);
      }

      await humanDelay(500, 900);
      const selectedText = await getSelectedProviderText(frame);

      if (!normalize(selectedText).includes(normalize(providerName))) {
        throw new Error(`Bluecare provider ${providerName} was not selected. selected="${selectedText}"`);
      }
    },
    { retries: 2, retryDelayMs: 1200 }
  );
}

async function fillTextField(frame, selector, value) {
  const field = frame.locator(selector).first();
  await field.waitFor({ state: "visible", timeout: 10000 });
  await field.click({ force: true });
  await field.click();
  await field.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await field.press("Backspace").catch(() => {});
  await field.pressSequentially(String(value || ""), { delay: 40 });
}

async function fillDateField(frame, selector, value, label) {
  const normalizedValue = String(value || "").trim();
  const field = frame.locator(selector).first();
  await field.waitFor({ state: "visible", timeout: 10000 });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await field.click({ force: true });
    await field.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await field.press("Backspace");
    await field.pressSequentially(normalizedValue, { delay: 40 });
    await field.press("Tab");
    await humanDelay(200, 400);

    const actual = await field.inputValue().catch(() => "");
    if (actual === normalizedValue) {
      return;
    }

    logger.warn(`Bluecare ${label} date mismatch on attempt ${attempt}: expected="${normalizedValue}", actual="${actual}"`);
  }

  const finalValue = await field.inputValue().catch(() => "");
  throw new Error(`Bluecare ${label} date was not set correctly. Expected "${normalizedValue}", found "${finalValue}".`);
}

async function fillBluecareMemberSearchForm(page, rowData) {
  const frame = await getClaimStatusFrame(page);
  await fillTextField(frame, SELECTORS.memberId, rowData["Subscriber No"]);
  await fillDateField(frame, SELECTORS.serviceFromDate, rowData["Service Date"], "Service From");
  await fillDateField(frame, SELECTORS.serviceToDate, rowData["Service Date"], "Service To");
}

async function resultIndicatorAppeared(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const frame = await getClaimStatusFrame(page);
    const headingVisible = await frame.locator(SELECTORS.resultsHeading).first().isVisible({ timeout: 500 }).catch(() => false);
    const resultRowsVisible = await frame.locator(SELECTORS.tableRows).first().isVisible({ timeout: 500 }).catch(() => false);
    const noResultsVisible = await frame.locator(SELECTORS.noResultsMessage).first().isVisible({ timeout: 500 }).catch(() => false);
    const portalResponseVisible = await frame.locator(
      "#results [role='alert'], #results .MuiAlert-root, .MuiFormHelperText-root.Mui-error, .invalid-feedback"
    ).first().isVisible({ timeout: 500 }).catch(() => false);

    if (headingVisible || resultRowsVisible || noResultsVisible || portalResponseVisible) {
      return true;
    }

    await humanDelay(800, 1200);
  }

  return false;
}

async function submitBluecareMemberSearch(page) {
  await withRetry(
    "Submitting Bluecare Member search",
    async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const frame = await getClaimStatusFrame(page);
        await throwIfVisibleFieldValidation(page, "Bluecare Member");
        const submitButton = frame.locator(SELECTORS.submitButton).first();
        await submitButton.waitFor({ state: "visible", timeout: 15000 });
        await submitButton.scrollIntoViewIfNeeded().catch(() => {});
        await submitButton.click({ force: attempt > 1 });
        logger.info(`Bluecare Member Submit clicked (attempt ${attempt}/3). Waiting for portal response.`);
        await humanDelay(1500, 2500);

        if (await resultIndicatorAppeared(page, 5000)) {
          logger.info(`Bluecare Member search response appeared after submit attempt ${attempt}.`);
          return;
        }

        if (attempt < 3) {
          logger.warn(`Bluecare Member results did not appear within 5 seconds after submit attempt ${attempt}. Re-clicking Submit.`);
        }
      }

      throw new Error("Bluecare Member Submit did not produce results, no-results message, or validation response after 3 attempts.");
    },
    { retries: 1, retryDelayMs: 1200 }
  );
}

async function searchBluecareMemberWithProvider(page, providerName, rowData, options = {}) {
  logger.info(`Bluecare Member search provider attempt: ${providerName}`);
  await selectMemberTab(page);
  if (options.projectId === "charm") {
    await clearProviderFormIfVisible(page, { context: "Charm Bluecare Member", logger });
    const providerFill = await fillInputProviderIdentifiers(page, rowData, {
      charmRequiredOnly: true,
      logger,
      providerMode: options.providerMode,
    });
    if (providerFill?.providerIdentifierReady) {
      await fillBluecareMemberSearchForm(page, rowData);
      await submitBluecareMemberSearch(page);
      return;
    }
    if (!providerFill?.requiresProviderDropdown) {
      throw new Error("Charm Bluecare Member provider identifiers could not be filled deterministically.");
    }
  }
  await selectProvider(page, providerName);
  if (options.projectId === "charm") {
    const providerFillAfterDropdown = await fillInputProviderIdentifiers(page, rowData, {
      charmRequiredOnly: true,
      logger,
      providerMode: options.providerMode,
      providerDropdownSelected: true,
    });
    if (providerFillAfterDropdown?.requiresProviderDropdown) {
      throw new Error("Charm Bluecare Member provider dropdown was selected, but required provider fields were still not auto-filled.");
    }
    if (!providerFillAfterDropdown?.providerIdentifierReady) {
      throw new Error("Charm Bluecare Member provider identifiers were still incomplete after provider selection.");
    }
  }
  await fillBluecareMemberSearchForm(page, rowData);
  await submitBluecareMemberSearch(page);
}

module.exports = {
  searchBluecareMemberWithProvider
};
