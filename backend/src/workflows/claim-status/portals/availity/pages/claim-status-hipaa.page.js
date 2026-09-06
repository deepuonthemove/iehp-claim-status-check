"use strict";

const logger = require("../utils/logger");
const { humanDelay, withRetry } = require("../utils/browser");
const { getClaimStatusFrame } = require("./navigation.page");
const { clearProviderFormIfVisible, clearProviderStateForTaxIdFallback, fillInputProviderIdentifiers, getInputProviderIdentifiers, hasInputProviderIdentifiers, verifyProviderNpiMatches } = require("./provider-identifiers.page");
const { throwIfVisibleFieldValidation } = require("./results.page");

const HIPAA_SELECTORS = {
  hipaaTab: "button[role='tab']:has-text('HIPAA Standard')",
  hipaaAnchorTab: "a[role='button']:has-text('HIPAA Standard')",
  memberTab: "button[role='tab']:has-text('Member')",
  memberAnchorTab: "a#Member[role='button'], a[role='button']:has-text('Member')",
  providerInput: "input#providerExpressEntry[role='combobox']",
  providerControl: "#providerSelect .provider-select__control",
  providerSelectedValue: "#providerSelect .provider-select__single-value",
  providerDropdownIndicator: "#providerSelect .provider-select__dropdown-indicator",
  memberId: "input#patientMemberId, input#subscriberMemberId",
  patientFirstName: "input#patientFirstName",
  patientLastName: "input#patientLastName",
  patientDob: "input#patientBirthDate",
  patientIsSubscriber: "input[id^='patientIsSubscriber-'][type='checkbox']",
  serviceFromDate: "input#serviceDates-start",
  serviceToDate: "input#serviceDates-end",
  submitButton: "button[type='submit'][data-analytics-form-name='HIPAA Standard']",
  resultsHeading: "span:has-text('Results (Displaying'), h5:has-text('Search Results'), h5:has-text('Results (Displaying')",
  tableRows: "tbody tr",
  noResultsMessage: "li:has-text('The payer could not find any results based on your search')",
  portalAlert: "[role='alert'], .MuiAlert-root"
};

async function isHipaaFormVisible(frame, timeout = 700) {
  const submitVisible = await frame.locator(HIPAA_SELECTORS.submitButton).first().isVisible({ timeout }).catch(() => false);
  const providerVisible = await frame.locator(HIPAA_SELECTORS.providerInput).first().isVisible({ timeout }).catch(() => false);
  const memberVisible = await frame.locator(HIPAA_SELECTORS.memberId).first().isVisible({ timeout }).catch(() => false);
  return submitVisible || (providerVisible && memberVisible);
}

function splitPatientName(patientName) {
  const raw = String(patientName || "").replace(/\s+/g, " ").trim();
  const parts = raw.split(",");

  if (parts.length < 2) {
    return {
      firstName: "",
      lastName: raw
    };
  }

  const firstNameParts = parts.slice(1).join(",").trim().split(/\s+/).filter(Boolean);
  if (firstNameParts.length > 1 && /^[A-Za-z]\.?$/.test(firstNameParts[firstNameParts.length - 1])) {
    firstNameParts.pop();
  }

  return {
    lastName: parts[0].trim(),
    firstName: firstNameParts.join(" ")
  };
}

function normalizeProviderWord(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function providerWords(value) {
  return String(value || "")
    .replace(/\s*\[[^\]]*$/, "")
    .replace(/\s*\[[^\]]*]\s*/g, " ")
    .split(/[\s,]+/)
    .map(normalizeProviderWord)
    .filter((word) => word.length >= 2);
}

function fuzzyProviderNameParts(providerName) {
  const cleaned = String(providerName || "")
    .replace(/\s*\[[^\]]*$/, "")
    .replace(/\s*\[[^\]]*]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.includes(",")) {
    const [lastPart, firstPart] = cleaned.split(",", 2);
    return {
      firstWords: providerWords(firstPart),
      lastWords: providerWords(lastPart)
    };
  }

  const words = providerWords(cleaned);
  if (words.length < 2) {
    return {
      firstWords: words,
      lastWords: []
    };
  }

  return {
    firstWords: [words[0]],
    lastWords: [words[words.length - 1]]
  };
}

function fuzzyProviderOptionMatches(optionText, providerName) {
  const { firstWords, lastWords } = fuzzyProviderNameParts(providerName);
  const optionWords = new Set(providerWords(optionText));
  if (firstWords.length && !lastWords.length) {
    return firstWords.some((word) => optionWords.has(word));
  }
  if (!firstWords.length || !lastWords.length) {
    return false;
  }

  return firstWords.some((word) => optionWords.has(word)) && lastWords.some((word) => optionWords.has(word));
}

function extractProviderIdentifiers(providerText) {
  return String(providerText || "").match(/\b\d{10}\b/g) || [];
}

async function selectAutocompleteOption(scope, inputLocator, value) {
  await inputLocator.scrollIntoViewIfNeeded().catch(() => {});
  await inputLocator.click({ force: true });
  await inputLocator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await inputLocator.press("Backspace").catch(() => {});
  await inputLocator.pressSequentially(String(value || ""), { delay: 60 });
  await humanDelay(500, 1000);

  const option = scope.getByText(value, { exact: true }).last();
  if (await option.isVisible({ timeout: 3000 }).catch(() => false)) {
    await option.click();
  } else {
    const containingOption = scope.locator("[role='option'], [id*='-option-'], .provider-select__option").filter({ hasText: String(value || "") }).first();
    if (await containingOption.isVisible({ timeout: 2000 }).catch(() => false)) {
      await containingOption.click();
    } else {
      throw new Error(`No Availity dropdown option was found for "${value}".`);
    }
  }
}

async function getSelectedProviderText(frame) {
  const muiInput = await getProviderInput(frame).catch(() => null);
  const muiValue = muiInput ? await muiInput.inputValue({ timeout: 1000 }).catch(() => "") : "";
  if (muiValue) {
    return muiValue;
  }

  const reactSelectValue = await frame.locator(HIPAA_SELECTORS.providerSelectedValue).first().innerText({ timeout: 1000 }).catch(() => "");
  return reactSelectValue || "";
}

async function getProviderFieldState(frame) {
  const input = await getProviderInput(frame).catch(() => null);
  const inputValue = input ? await input.inputValue({ timeout: 1000 }).catch(() => "") : "";
  const selectedText = await frame.locator(HIPAA_SELECTORS.providerSelectedValue).first().innerText({ timeout: 1000 }).catch(() => "");
  const hiddenValue = await frame.locator("input[name='providerExpressEntry']").first().inputValue({ timeout: 1000 }).catch(() => "");
  const providerNpi = await frame.locator("input#providerNpi[name='providerNpi'], input[name='providerNpi']").first().inputValue({ timeout: 1000 }).catch(() => "");

  return {
    inputValue: inputValue.trim(),
    selectedText: selectedText.trim(),
    hiddenValue: hiddenValue.trim(),
    providerNpi: providerNpi.trim()
  };
}

function providerStateMatchesProvider(state, providerName) {
  const expected = String(providerName || "").trim().toUpperCase();
  const selectedText = String(state.selectedText || "").trim().toUpperCase();
  const hiddenValue = String(state.hiddenValue || "").trim();
  const inputValue = String(state.inputValue || "").trim().toUpperCase();
  const inputHasProviderIdentifier = /\d{10}/.test(state.inputValue || "");

  // Typed text in the combobox is not enough. React Select keeps a hidden
  // provider value only after an option is actually selected. The MUI variant
  // confirms selection by replacing typed text with provider + NPI/Tax ID.
  return Boolean(
    expected
      && (
        (selectedText.includes(expected) && hiddenValue)
        || (inputValue.includes(expected) && inputHasProviderIdentifier)
      )
  );
}

async function waitForProviderSelection(frame, providerName, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await getProviderFieldState(frame);

    if (providerStateMatchesProvider(lastState, providerName)) {
      return lastState;
    }

    await humanDelay(400, 700);
  }

  const stateText = lastState
    ? `input="${lastState.inputValue}", selected="${lastState.selectedText}", hidden="${lastState.hiddenValue}", npi="${lastState.providerNpi}"`
    : "state unavailable";
  throw new Error(`HIPAA provider selection was not verified after ${timeoutMs} ms: ${stateText}`);
}

async function clickFuzzyProviderOption(frame, providerName) {
  const clickedText = await frame.locator("[role='option'], [id^='react-select-'][id*='-option-'], .provider-select__option").evaluateAll(
    (elements, expectedProviderName) => {
      const normalizeProviderWord = (value) => String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
      const providerWords = (value) => String(value || "")
        .replace(/\s*\[[^\]]*$/, "")
        .replace(/\s*\[[^\]]*]\s*/g, " ")
        .split(/[\s,]+/)
        .map(normalizeProviderWord)
        .filter((word) => word.length >= 2);
      const fuzzyProviderNameParts = (providerName) => {
        const cleaned = String(providerName || "")
          .replace(/\s*\[[^\]]*$/, "")
          .replace(/\s*\[[^\]]*]\s*/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        if (cleaned.includes(",")) {
          const [lastPart, firstPart] = cleaned.split(",", 2);
          return {
            firstWords: providerWords(firstPart),
            lastWords: providerWords(lastPart)
          };
        }

        const words = providerWords(cleaned);
        if (words.length < 2) {
          return {
            firstWords: words,
            lastWords: []
          };
        }

        return {
          firstWords: [words[0]],
          lastWords: [words[words.length - 1]]
        };
      };
      const { firstWords, lastWords } = fuzzyProviderNameParts(expectedProviderName);
      if (!firstWords.length) {
        return "";
      }

      const candidates = Array.from(elements);
      const match = candidates.find((element) => {
        const optionText = String(element.textContent || "").replace(/\s+/g, " ").trim();
        const optionWords = new Set(providerWords(optionText));
        if (!lastWords.length) {
          return firstWords.some((word) => optionWords.has(word));
        }
        return firstWords.some((word) => optionWords.has(word)) && lastWords.some((word) => optionWords.has(word));
      });

      if (!match) {
        return "";
      }

      const text = String(match.textContent || "").replace(/\s+/g, " ").trim();
      match.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      match.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      match.click();
      return text;
    },
    providerName
  ).catch(() => "");

  if (clickedText) {
    logger.info(`Clicked fuzzy HIPAA provider option "${clickedText}" for input provider "${providerName}".`);
    await humanDelay(300, 600);
    return clickedText;
  }

  return "";
}

async function clickFirstVisibleFuzzyProviderOption(frame, providerName) {
  const optionSelectors = [
    "[role='option']",
    "[id^='react-select-'][id*='-option-']",
    ".provider-select__option",
    ".css-1n7v3ny-option",
    ".css-9gakcf-option",
    ".css-yt9ioa-option"
  ];

  for (const selector of optionSelectors) {
    const options = frame.locator(selector);
    const count = await options.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      if (!await option.isVisible({ timeout: 300 }).catch(() => false)) {
        continue;
      }

      const optionText = (await option.innerText({ timeout: 500 }).catch(() => "")).replace(/\s+/g, " ").trim();
      if (!optionText) {
        continue;
      }

      if (fuzzyProviderOptionMatches(optionText, providerName) || providerWords(providerName).some((word) => providerWords(optionText).includes(word))) {
        await option.click({ force: true });
        logger.info(`Clicked first visible fuzzy HIPAA provider option "${optionText}" for input provider "${providerName}".`);
        await humanDelay(300, 600);
        return optionText;
      }
    }
  }

  return "";
}

async function clickProviderOption(frame, providerName, options = {}) {
  const providerText = String(providerName || "").trim();
  const deadline = Date.now() + 8000;
  let lastVisibleOptions = "";

  while (Date.now() < deadline) {
    const optionLocators = [
      frame.locator(`[id^='react-select-'][id*='-option-']:has-text("${providerText}")`).last(),
      frame.locator(`[role='option']:has-text("${providerText}")`).last(),
      frame.locator(`.provider-select__menu *:has-text("${providerText}")`).last()
    ];

    for (const option of optionLocators) {
      if (await option.isVisible({ timeout: 500 }).catch(() => false)) {
        const optionText = (await option.innerText({ timeout: 500 }).catch(() => "")).replace(/\s+/g, " ").trim();
        await option.click({ force: true });
        await humanDelay(300, 600);
        return optionText || providerText;
      }
    }

    if (options.allowFuzzyProviderFallback) {
      const clickedText = await clickFuzzyProviderOption(frame, providerName);
      if (clickedText) {
        return clickedText;
      }
    }

    if (options.allowFuzzyProviderFallback) {
      const clickedText = await clickFirstVisibleFuzzyProviderOption(frame, providerName);
      if (clickedText) {
        return clickedText;
      }
    }

    lastVisibleOptions = await frame.locator("[role='option'], .provider-select__menu *")
      .evaluateAll((elements) => elements
        .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 10)
        .join(" | "))
      .catch(() => "");

    await humanDelay(500, 800);
  }

  throw new Error(`HIPAA provider option not visible after typing: ${providerName}. Visible provider options: ${lastVisibleOptions || "none"}`);
}

async function getProviderInput(frame) {
  const oldHipaaInput = frame.locator(HIPAA_SELECTORS.providerInput).first();
  if (await oldHipaaInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    return oldHipaaInput;
  }

  const providerLabel = frame.locator("label").filter({ hasText: "Select a Provider" }).last();
  const muiProviderInput = providerLabel.locator("xpath=ancestor::*[contains(@class,'MuiFormControl-root')][1]//input[@role='combobox']").first();
  await muiProviderInput.waitFor({ state: "visible", timeout: 15000 });
  return muiProviderInput;
}

async function clickProviderDropdown(frame, providerInput) {
  const oldDropdownIndicator = frame.locator(HIPAA_SELECTORS.providerDropdownIndicator).first();
  if (await oldDropdownIndicator.isVisible({ timeout: 1000 }).catch(() => false)) {
    await oldDropdownIndicator.click({ force: true });
    return;
  }

  const oldProviderControl = frame.locator(HIPAA_SELECTORS.providerControl).first();
  if (await oldProviderControl.isVisible({ timeout: 1000 }).catch(() => false)) {
    await oldProviderControl.click({ force: true });
    return;
  }

  const muiOpenButton = providerInput.locator("xpath=ancestor::*[contains(@class,'MuiFormControl-root')][1]//button[@aria-label='Open']").first();
  if (await muiOpenButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await muiOpenButton.click({ force: true });
    return;
  }

  await providerInput.click({ force: true });
}

async function isMemberTabAvailable(page) {
  const frame = await getClaimStatusFrame(page);
  const muiTabVisible = await frame.locator(HIPAA_SELECTORS.memberTab).first().isVisible({ timeout: 1500 }).catch(() => false);
  const anchorTabVisible = await frame.locator(HIPAA_SELECTORS.memberAnchorTab).first().isVisible({ timeout: 1500 }).catch(() => false);
  return muiTabVisible || anchorTabVisible;
}

async function isHipaaTabAvailable(page) {
  const frame = await getClaimStatusFrame(page);
  const muiTabVisible = await frame.locator(HIPAA_SELECTORS.hipaaTab).first().isVisible({ timeout: 1500 }).catch(() => false);
  const anchorTabVisible = await frame.locator(HIPAA_SELECTORS.hipaaAnchorTab).first().isVisible({ timeout: 1500 }).catch(() => false);
  return muiTabVisible || anchorTabVisible || await isHipaaFormVisible(frame, 1500);
}

async function waitForSearchTabs(page, timeoutMs = 5000, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastAvailability = {
    memberAvailable: false,
    hipaaAvailable: false
  };

  while (Date.now() < deadline) {
    const frame = await getClaimStatusFrame(page);
    const memberAvailable = await frame.locator(`${HIPAA_SELECTORS.memberTab}, ${HIPAA_SELECTORS.memberAnchorTab}`).first().isVisible({ timeout: 700 }).catch(() => false);
    const hipaaTabAvailable = await frame.locator(`${HIPAA_SELECTORS.hipaaTab}, ${HIPAA_SELECTORS.hipaaAnchorTab}`).first().isVisible({ timeout: 700 }).catch(() => false);
    const hipaaAvailable = hipaaTabAvailable || await isHipaaFormVisible(frame);

    lastAvailability = {
      memberAvailable,
      hipaaAvailable
    };

    if (options.preferMember && memberAvailable) {
      return lastAvailability;
    }

    if (options.preferHipaa && hipaaAvailable) {
      return lastAvailability;
    }

    if (!options.preferMember && !options.preferHipaa && (memberAvailable || hipaaAvailable)) {
      return lastAvailability;
    }

    await humanDelay(800, 1200);
  }

  return lastAvailability;
}

async function selectHipaaTab(page) {
  await withRetry(
    "Selecting HIPAA Standard tab",
    async () => {
      const frame = await getClaimStatusFrame(page);
      if (await isHipaaFormVisible(frame, 1500)) {
        logger.info("HIPAA Standard form is already active.");
        return;
      }
      const muiTab = frame.locator(HIPAA_SELECTORS.hipaaTab).first();
      const anchorTab = frame.locator(HIPAA_SELECTORS.hipaaAnchorTab).first();
      const tab = await muiTab.isVisible({ timeout: 3000 }).catch(() => false) ? muiTab : anchorTab;
      await tab.waitFor({ state: "visible", timeout: 5000 });
      await tab.click();
      await frame.waitForSelector(`${HIPAA_SELECTORS.hipaaTab}[aria-selected='true']`, { timeout: 10000 }).catch(() => {});
      await Promise.race([
        frame.locator(HIPAA_SELECTORS.memberId).first().waitFor({ state: "visible", timeout: 20000 }),
        frame.locator(HIPAA_SELECTORS.providerInput).first().waitFor({ state: "attached", timeout: 20000 }),
        frame.locator(HIPAA_SELECTORS.submitButton).first().waitFor({ state: "visible", timeout: 20000 })
      ]);
    },
    { retries: 1, retryDelayMs: 1000 }
  );
}

async function selectProvider(page, providerName, options = {}) {
  await withRetry(
    `Selecting HIPAA provider ${providerName}`,
    async () => {
      const frame = await getClaimStatusFrame(page);
      await frame.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await humanDelay(300, 700);

      const providerInput = await getProviderInput(frame);

      const currentState = await getProviderFieldState(frame);
      logger.info(
        `HIPAA provider current state before select: input="${currentState.inputValue}", selected="${currentState.selectedText}", hidden="${currentState.hiddenValue}", npi="${currentState.providerNpi}"`
      );
      if (providerStateMatchesProvider(currentState, providerName)) {
        logger.info(`HIPAA provider ${providerName} already selected and verified`);
        return;
      }

      await clickProviderDropdown(frame, providerInput);

      await humanDelay(300, 700);
      await providerInput.evaluate((input) => input.focus()).catch(() => {});
      await frame.page().keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await frame.page().keyboard.press("Backspace");
      await frame.page().keyboard.type(String(providerName));
      await humanDelay(700, 1200);
      const clickedProviderOptionText = await clickProviderOption(frame, providerName, options);
      const clickedProviderIdentifiers = extractProviderIdentifiers(clickedProviderOptionText);

      const selectedState = await waitForProviderSelection(frame, providerName, 10000).catch(async (error) => {
        if (!options.allowFuzzyProviderFallback) {
          throw error;
        }

        const state = await getProviderFieldState(frame);
        const selectedProviderText = state.selectedText || "";
        const selectedIdentifiers = [state.hiddenValue, state.providerNpi].filter(Boolean);
        const matchedClickedIdentifier = clickedProviderIdentifiers.length > 0
          && clickedProviderIdentifiers.some((identifier) => selectedIdentifiers.includes(identifier));

        if (clickedProviderIdentifiers.length > 0 && !matchedClickedIdentifier) {
          const refreshedState = await getProviderFieldState(frame);
          const refreshedIdentifiers = [refreshedState.hiddenValue, refreshedState.providerNpi].filter(Boolean);
          if (clickedProviderIdentifiers.some((identifier) => refreshedIdentifiers.includes(identifier))) {
            logger.info(`Fuzzy HIPAA provider selection verified by clicked option identifier: "${clickedProviderOptionText}".`);
            return refreshedState;
          }
          throw error;
        }

        if (!fuzzyProviderOptionMatches(selectedProviderText, providerName)) {
          throw error;
        }
        if (!/\d{10}/.test(state.providerNpi || "") && !state.hiddenValue) {
          throw error;
        }
        logger.info(`Fuzzy HIPAA provider selection verified: "${selectedProviderText}" matched "${providerName}".`);
        return state;
      });
      logger.info(
        `HIPAA provider selected state after select: input="${selectedState.inputValue}", selected="${selectedState.selectedText}", hidden="${selectedState.hiddenValue}", npi="${selectedState.providerNpi}"`
      );
      await verifyProviderNpiMatches(frame, providerName, { context: "HIPAA", logger });
    },
    { retries: 2, retryDelayMs: 1200 }
  );
}

async function fillTextField(scope, selector, value) {
  const field = scope.locator(selector).first();
  await field.waitFor({ state: "visible", timeout: 15000 });
  await field.click();
  await field.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await field.press("Backspace").catch(() => {});
  await field.pressSequentially(String(value || ""), { delay: 40 });
}

async function getMuiDateBoxText(dateBox) {
  return dateBox.innerText({ timeout: 1000 })
    .then((text) => text.replace(/\s+/g, "").trim())
    .catch(() => "");
}

async function fillMuiDateByLabel(scope, labelText, value) {
  const normalizedValue = String(value || "").trim();
  const [month, day, year] = normalizedValue.split("/");
  const label = scope.locator("label").filter({ hasText: labelText }).first();
  await label.waitFor({ state: "visible", timeout: 15000 });

  const container = label.locator("xpath=ancestor::*[contains(@class,'MuiFormControl-root')][1]");
  const dateBox = container.locator("[contenteditable='false']").first();
  await dateBox.waitFor({ state: "visible", timeout: 15000 });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    for (const segment of [
      { label: "Month", value: month },
      { label: "Day", value: day },
      { label: "Year", value: year }
    ]) {
      // MUI replaces the date-section DOM after every value change. Rebuild
      // the full locator for each section instead of retaining a stale child.
      const currentLabel = scope.locator("label").filter({ hasText: labelText }).first();
      const currentContainer = currentLabel.locator("xpath=ancestor::*[contains(@class,'MuiFormControl-root')][1]");
      const currentSegment = currentContainer.locator(`[role='spinbutton'][contenteditable='true'][aria-label='${segment.label}']`).first();
      await currentSegment.waitFor({ state: "visible", timeout: 5000 });
      await currentSegment.click({ force: true, clickCount: 3 });
      await scope.page().keyboard.type(segment.value, { delay: 60 });
      await humanDelay(150, 250);
    }

    await scope.page().keyboard.press("Tab");
    await humanDelay(250, 500);

    const actualValue = await getMuiDateBoxText(dateBox);
    if (actualValue === normalizedValue) {
      return;
    }

    logger.warn(`HIPAA ${labelText} value mismatch after MUI fill attempt ${attempt}: expected="${normalizedValue}", actual="${actualValue}". Retrying.`);
  }

  const finalValue = await getMuiDateBoxText(dateBox);
  if (finalValue !== normalizedValue) {
    throw new Error(`HIPAA ${labelText} was not set correctly. Expected "${normalizedValue}", found "${finalValue}".`);
  }
}

async function fillHipaaPatientDob(scope, value) {
  const oldDobField = scope.locator(HIPAA_SELECTORS.patientDob).first();
  if (await oldDobField.isVisible({ timeout: 1500 }).catch(() => false)) {
    const expectedValue = String(value || "").trim();
    const expectedDigits = expectedValue.replace(/\D/g, "");
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await oldDobField.click({ force: true });
      await oldDobField.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
      await oldDobField.press("Backspace").catch(() => {});
      await oldDobField.pressSequentially(expectedDigits, { delay: 60 });
      await oldDobField.press("Tab");
      await humanDelay(250, 500);

      const actualValue = await oldDobField.inputValue().catch(() => "");
      if (actualValue.replace(/\D/g, "") === expectedDigits) {
        return;
      }
      logger.warn(`HIPAA Patient Date of Birth mismatch after masked fill attempt ${attempt}: expected="${expectedValue}", actual="${actualValue}". Retrying.`);
    }

    const finalValue = await oldDobField.inputValue().catch(() => "");
    throw new Error(`HIPAA Patient Date of Birth was not set correctly. Expected "${expectedValue}", found "${finalValue}".`);
  }

  await fillMuiDateByLabel(scope, "Patient Date of Birth", value);
}

async function fillAndVerifyDateField(scope, selector, value, fieldName) {
  const expectedValue = String(value || "").trim();
  const field = scope.locator(selector).first();
  if (!await field.isVisible({ timeout: 1500 }).catch(() => false)) {
    await fillMuiDateByLabel(scope, fieldName === "Service From" ? "Service From Date" : "Service To Date", expectedValue);
    return;
  }

  await field.waitFor({ state: "visible", timeout: 15000 });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await field.click({ force: true });
    await field.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await field.press("Backspace");
    const [month, day, year] = expectedValue.split("/");
    await field.pressSequentially(month, { delay: 60 });
    await field.press("/");
    await field.pressSequentially(day, { delay: 60 });
    await field.press("/");
    await field.pressSequentially(year, { delay: 60 });
    await field.press("Tab");
    await humanDelay(250, 500);

    const actualValue = await field.inputValue().catch(() => "");
    if (actualValue.trim() === expectedValue) {
      return;
    }

    logger.warn(`HIPAA ${fieldName} date value mismatch after fill attempt ${attempt}: expected="${expectedValue}", actual="${actualValue}". Retrying.`);
  }

  const finalValue = await field.inputValue().catch(() => "");
  if (finalValue.trim() !== expectedValue) {
    throw new Error(`HIPAA ${fieldName} date was not set correctly. Expected "${expectedValue}", found "${finalValue}".`);
  }
}

async function ensureChecked(scope, selector) {
  const checkbox = scope.locator(selector).first();
  if (!await checkbox.isVisible({ timeout: 1500 }).catch(() => false)) {
    logger.info("HIPAA subscriber-same-as-patient checkbox not visible; continuing because this form variant does not require it.");
    return;
  }

  if (!await checkbox.isChecked().catch(() => false)) {
    await checkbox.check({ force: true });
  }
}

async function fillHipaaSearchForm(page, rowData) {
  const frame = await getClaimStatusFrame(page);
  const name = splitPatientName(rowData["Patient Name"]);

  await fillTextField(frame, HIPAA_SELECTORS.memberId, rowData["Subscriber No"]);
  await fillTextField(frame, HIPAA_SELECTORS.patientFirstName, name.firstName);
  await fillTextField(frame, HIPAA_SELECTORS.patientLastName, name.lastName);
  await fillHipaaPatientDob(frame, rowData["Patient DOB"]);
  await ensureChecked(frame, HIPAA_SELECTORS.patientIsSubscriber);
  await fillAndVerifyDateField(frame, HIPAA_SELECTORS.serviceFromDate, rowData["Service Date"], "Service From");
  await fillAndVerifyDateField(frame, HIPAA_SELECTORS.serviceToDate, rowData["Service Date"], "Service To");
}

async function resultIndicatorAppeared(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const frame = await getClaimStatusFrame(page);
    const headingVisible = await frame.locator(HIPAA_SELECTORS.resultsHeading).first().isVisible({ timeout: 500 }).catch(() => false);
    const resultRowsVisible = await frame.locator(HIPAA_SELECTORS.tableRows).first().isVisible({ timeout: 500 }).catch(() => false);
    const noResultsVisible = await frame.locator(HIPAA_SELECTORS.noResultsMessage).first().isVisible({ timeout: 500 }).catch(() => false);
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

async function submitHipaaSearch(page) {
  await withRetry(
    "Submitting HIPAA Standard search",
    async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const frame = await getClaimStatusFrame(page);
        const submitButton = frame.locator(HIPAA_SELECTORS.submitButton).first();
        await submitButton.waitFor({ state: "visible", timeout: 15000 });
        await submitButton.scrollIntoViewIfNeeded().catch(() => {});
        await submitButton.click({ force: attempt > 1 });
        logger.info(`HIPAA Standard Submit clicked (attempt ${attempt}/3). Waiting for portal response.`);
        await humanDelay(1500, 2500);

        if (await resultIndicatorAppeared(page, 5000)) {
          logger.info(`HIPAA Standard search response appeared after submit attempt ${attempt}.`);
          return;
        }

        if (attempt < 3) {
          logger.warn(`HIPAA Standard results did not appear within 5 seconds after submit attempt ${attempt}. Re-clicking Submit.`);
        }
      }

      throw new Error("HIPAA Standard submit did not produce results, no-results message, or validation response after 3 attempts.");
    },
    { retries: 1, retryDelayMs: 1200 }
  );
}

async function searchHipaaWithProvider(page, providerName, rowData, options = {}) {
  logger.info(`HIPAA Standard search provider attempt: ${providerName}`);
  await selectHipaaTab(page);
  const isCharm = options.projectId === "charm";
  const groupNameOnly = isCharm && options.providerMode === "groupNameOnly";
  if (isCharm) {
    await clearProviderFormIfVisible(page, { context: "Charm HIPAA", logger });
    const providerFill = await fillInputProviderIdentifiers(page, rowData, {
      charmRequiredOnly: true,
      logger,
      providerMode: options.providerMode,
    });
    if (providerFill?.providerIdentifierReady) {
      await fillHipaaSearchForm(page, rowData);
      await throwIfVisibleFieldValidation(page, "Charm HIPAA");
      await submitHipaaSearch(page);
      return;
    }
    if (!providerFill?.requiresProviderDropdown) {
      throw new Error("Charm HIPAA provider identifiers could not be filled deterministically.");
    }
  }
  const providerIdentifiers = getInputProviderIdentifiers(rowData);
  const providerAsTaxId = Boolean(providerIdentifiers.taxId && String(providerName || "").replace(/\D/g, "") === providerIdentifiers.taxId);
  let fillTaxIdOnly = false;
  let providerDropdownSelected = false;
  if (providerAsTaxId && providerIdentifiers.taxId) {
    logger.info(`HIPAA provider identifier "${providerName}" is a Tax ID. Filling Provider Tax ID directly.`);
    await clearProviderStateForTaxIdFallback(page, { context: "HIPAA Tax ID fallback", logger });
    fillTaxIdOnly = true;
  } else {
    try {
      await selectProvider(page, providerName, options);
      providerDropdownSelected = true;
    } catch (error) {
      if (groupNameOnly) {
        error.providerSelectionFailed = true;
        throw error;
      }
      if (providerIdentifiers.taxId) {
        fillTaxIdOnly = true;
        const frame = await getClaimStatusFrame(page);
        const providerInput = await getProviderInput(frame).catch(() => null);
        if (providerInput) {
          await providerInput.click({ force: true }).catch(() => {});
          await providerInput.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
          await providerInput.press("Backspace").catch(() => {});
        }
        await clearProviderStateForTaxIdFallback(page, { context: "HIPAA Tax ID fallback", logger });
        logger.warn(`HIPAA provider "${providerName}" was not available. Filling input Provider Tax ID "${providerIdentifiers.taxId}" directly.`);
      } else if (options.requireDropdownProviderSelection) {
        error.providerSelectionFailed = true;
        throw error;
      } else {
        if (!hasInputProviderIdentifiers(rowData)) throw error;
        logger.warn(`HIPAA provider "${providerName}" was not available. Continuing with input Provider NPI/Tax ID.`);
      }
    }
  }
  const providerFillAfterDropdown = await fillInputProviderIdentifiers(page, fillTaxIdOnly ? { ...rowData, "Provider NPI": "" } : rowData, {
    charmRequiredOnly: isCharm,
    logger,
    providerMode: options.providerMode,
    providerDropdownSelected,
  });
  if (isCharm && providerFillAfterDropdown?.requiresProviderDropdown) {
    throw new Error("Charm HIPAA provider dropdown was selected, but required provider fields were still not auto-filled.");
  }
  if (isCharm && !providerFillAfterDropdown?.providerIdentifierReady && !providerFillAfterDropdown?.requiresProviderDropdown) {
    throw new Error("Charm HIPAA provider identifiers were still incomplete after provider selection.");
  }
  await fillHipaaSearchForm(page, rowData);
  if (isCharm) {
    await throwIfVisibleFieldValidation(page, "Charm HIPAA");
  }
  await submitHipaaSearch(page);
}

module.exports = {
  HIPAA_SELECTORS,
  fillHipaaSearchForm,
  isHipaaTabAvailable,
  isMemberTabAvailable,
  selectHipaaTab,
  selectProvider,
  searchHipaaWithProvider,
  splitPatientName,
  waitForSearchTabs
};
