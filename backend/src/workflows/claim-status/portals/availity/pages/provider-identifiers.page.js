"use strict";

const { getClaimStatusFrame } = require("./navigation.page");

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function getInputProviderIdentifiers(rowData) {
  return {
    npi: digitsOnly(rowData?.["Provider NPI"]),
    taxId: digitsOnly(rowData?.["Provider Tax ID"] || rowData?.["Tax ID"])
  };
}

function hasInputProviderIdentifiers(rowData) {
  const { npi, taxId } = getInputProviderIdentifiers(rowData);
  return Boolean(npi || taxId);
}

async function getProviderNpiValue(frame) {
  const providerNpiInput = frame.locator("input#providerNpi[name='providerNpi'], input#providerNpi, input[name='providerNpi']").first();
  return providerNpiInput.inputValue({ timeout: 1000 }).then((value) => digitsOnly(value)).catch(() => "");
}

async function clearProviderNpiField(frame, options = {}) {
  const providerNpiInput = frame.locator("input#providerNpi[name='providerNpi'], input#providerNpi, input[name='providerNpi']").first();
  if (!await providerNpiInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    return;
  }

  await providerNpiInput.click({ force: true }).catch(() => {});
  await providerNpiInput.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await providerNpiInput.press("Backspace").catch(() => {});
  await providerNpiInput.evaluate((input) => {
    if (!input || !("value" in input)) return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }).catch(() => {});

  const remainingNpi = await getProviderNpiValue(frame);
  if (remainingNpi) {
    options.logger?.warn?.(`${options.context || "Availity"} Provider NPI stayed populated after clear: "${remainingNpi}".`);
  }
}

async function getClearableFieldValues(frame) {
  return frame.evaluate(() => {
    const normalize = (value) => String(value || "").trim();
    const labelsFor = new Map();
    for (const label of Array.from(document.querySelectorAll("label"))) {
      const forId = label.getAttribute("for");
      if (forId) labelsFor.set(forId, normalize(label.textContent));
    }

    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };

    const isExcluded = (element, labelText) => {
      const id = normalize(element.id).toLowerCase();
      const name = normalize(element.getAttribute("name")).toLowerCase();
      const ariaLabel = normalize(element.getAttribute("aria-label")).toLowerCase();
      const label = normalize(labelText).toLowerCase();
      const combined = `${id} ${name} ${ariaLabel} ${label}`;
      return /\borganization\b/.test(combined)
        || /\bpayer\b/.test(combined)
        || /\brelationship\b/.test(combined);
    };

    const isSearchValueField = (element, labelText) => {
      const id = normalize(element.id).toLowerCase();
      const name = normalize(element.getAttribute("name")).toLowerCase();
      const ariaLabel = normalize(element.getAttribute("aria-label")).toLowerCase();
      const label = normalize(labelText).toLowerCase();
      const placeholder = normalize(element.getAttribute("placeholder")).toLowerCase();
      const combined = `${id} ${name} ${ariaLabel} ${label} ${placeholder}`;
      return /provider|member|patient|claim|service|from date|to date|birth|account|institutional|bill|tax|npi/.test(combined);
    };

    return Array.from(document.querySelectorAll("input, textarea"))
      .filter((element) => {
        if (!isVisible(element)) return false;
        const type = normalize(element.getAttribute("type")).toLowerCase();
        if (["button", "submit", "reset", "radio", "checkbox", "hidden"].includes(type)) return false;
        const labelText = labelsFor.get(element.id) || "";
        if (isExcluded(element, labelText)) return false;
        if (!isSearchValueField(element, labelText)) return false;
        return Boolean(normalize(element.value));
      })
      .map((element) => ({
        id: normalize(element.id),
        name: normalize(element.getAttribute("name")),
        label: labelsFor.get(element.id) || normalize(element.getAttribute("aria-label")),
        value: normalize(element.value),
        readonly: Boolean(element.readOnly || element.disabled || element.getAttribute("aria-readonly") === "true")
      }));
  }).catch(() => []);
}

async function clearEditableFieldsBelowPayer(frame, options = {}) {
  const cleared = await frame.evaluate(() => {
    const normalize = (value) => String(value || "").trim();
    const labelsFor = new Map();
    for (const label of Array.from(document.querySelectorAll("label"))) {
      const forId = label.getAttribute("for");
      if (forId) labelsFor.set(forId, normalize(label.textContent));
    }

    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };

    const isExcluded = (element, labelText) => {
      const id = normalize(element.id).toLowerCase();
      const name = normalize(element.getAttribute("name")).toLowerCase();
      const ariaLabel = normalize(element.getAttribute("aria-label")).toLowerCase();
      const label = normalize(labelText).toLowerCase();
      const combined = `${id} ${name} ${ariaLabel} ${label}`;
      return /\borganization\b/.test(combined)
        || /\bpayer\b/.test(combined)
        || /\brelationship\b/.test(combined);
    };

    const isSearchValueField = (element, labelText) => {
      const id = normalize(element.id).toLowerCase();
      const name = normalize(element.getAttribute("name")).toLowerCase();
      const ariaLabel = normalize(element.getAttribute("aria-label")).toLowerCase();
      const label = normalize(labelText).toLowerCase();
      const placeholder = normalize(element.getAttribute("placeholder")).toLowerCase();
      const combined = `${id} ${name} ${ariaLabel} ${label} ${placeholder}`;
      return /provider|member|patient|claim|service|from date|to date|birth|account|institutional|bill|tax|npi/.test(combined);
    };

    let count = 0;
    for (const element of Array.from(document.querySelectorAll("input, textarea"))) {
      if (!isVisible(element)) continue;
      const type = normalize(element.getAttribute("type")).toLowerCase();
      if (["button", "submit", "reset", "radio", "checkbox", "hidden"].includes(type)) continue;
      const labelText = labelsFor.get(element.id) || "";
      if (isExcluded(element, labelText)) continue;
      if (!isSearchValueField(element, labelText)) continue;
      if (element.readOnly || element.disabled || element.getAttribute("aria-readonly") === "true") continue;
      if (!normalize(element.value)) continue;

      element.value = "";
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      count += 1;
    }
    return count;
  }).catch(() => 0);

  if (cleared) {
    options.logger?.warn?.(`${options.context || "Availity"}: manually cleared ${cleared} editable field(s) left behind by Clear Form.`);
  }
}

async function clearProviderStateForTaxIdFallback(page, options = {}) {
  const frame = await getClaimStatusFrame(page);
  const context = options.context || "Availity Tax ID fallback";
  const clearButton = frame.locator("button:has-text('Clear Form'), input[type='button'][value='Clear Form']").first();

  if (await clearButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    options.logger?.info?.(`${context}: clicking Clear Form before filling Provider Tax ID.`);
    await clearButton.click({ force: true });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    let remainingNpi = await getProviderNpiValue(frame);
    if (!remainingNpi) {
      return frame;
    }

    options.logger?.warn?.(`${context}: Provider NPI still populated 1 second after Clear Form: "${remainingNpi}". Waiting 1 more second.`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    remainingNpi = await getProviderNpiValue(frame);
    if (!remainingNpi) {
      return frame;
    }

    const clearButtonEnabled = await clearButton.isEnabled({ timeout: 1000 }).catch(() => false);
    if (clearButtonEnabled) {
      options.logger?.warn?.(`${context}: Provider NPI still populated after 2 seconds. Clicking Clear Form again.`);
      await clearButton.click({ force: true });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      remainingNpi = await getProviderNpiValue(frame);
      if (!remainingNpi) {
        return frame;
      }
    }

    options.logger?.warn?.(`${context}: Provider NPI stayed populated after Clear Form: "${remainingNpi}".`);
  } else {
    options.logger?.warn?.(`${context}: Clear Form button was not visible; clearing Provider NPI field directly.`);
  }

  await clearProviderNpiField(frame, options);
  return frame;
}

async function clearProviderFormIfVisible(page, options = {}) {
  const frame = await getClaimStatusFrame(page);
  const context = options.context || "Availity";
  const clearButton = frame.locator("button:has-text('Clear Form'), input[type='button'][value='Clear Form']").first();
  if (!await clearButton.isVisible({ timeout: 1500 }).catch(() => false)) {
    options.logger?.info?.(`${context}: Clear Form button was not visible before provider fill.`);
    return frame;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    options.logger?.info?.(`${context}: clicking Clear Form before filling this claim (attempt ${attempt}/3).`);
    await clearButton.click({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const staleFields = await getClearableFieldValues(frame);
    if (!staleFields.length) {
      options.logger?.info?.(`${context}: Clear Form completed; fields below payer are blank.`);
      return frame;
    }

    const staleSummary = staleFields
      .map((field) => field.label || field.name || field.id || "unnamed field")
      .slice(0, 6)
      .join(", ");
    options.logger?.warn?.(`${context}: Clear Form attempt ${attempt}/3 left ${staleFields.length} field(s) populated: ${staleSummary}.`);
  }

  await clearEditableFieldsBelowPayer(frame, { context, logger: options.logger });
  const remainingFields = await getClearableFieldValues(frame);
  if (remainingFields.length) {
    const remainingSummary = remainingFields
      .map((field) => `${field.label || field.name || field.id || "unnamed field"}${field.readonly ? " (read-only)" : ""}`)
      .slice(0, 6)
      .join(", ");
    options.logger?.warn?.(`${context}: ${remainingFields.length} field(s) still populated after manual clear: ${remainingSummary}.`);
  }
  return frame;
}

async function verifyProviderNpiMatches(frame, providerName, options = {}) {
  const expectedNpi = digitsOnly(providerName);
  if (!/^\d{10}$/.test(expectedNpi)) {
    return;
  }

  const deadline = Date.now() + (options.timeoutMs || 5000);
  let actualNpi = "";
  while (Date.now() < deadline) {
    actualNpi = await getProviderNpiValue(frame);
    if (actualNpi) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (actualNpi !== expectedNpi) {
    throw new Error(`${options.context || "Availity"} selected provider NPI mismatch. Expected "${expectedNpi}", found "${actualNpi || "blank"}".`);
  }
}

function providerPolicySkipsProviderDropdown(providerFieldPolicy = {}) {
  return providerFieldPolicy?.providerDropdown?.fill === false;
}

function getProviderTaxIdForPolicy(rowData, providerFieldPolicy = {}) {
  const valueFrom = providerFieldPolicy?.providerTaxId?.valueFrom;
  const configuredValue = valueFrom ? rowData?.[valueFrom] : "";
  return digitsOnly(configuredValue || rowData?.["Provider Tax ID"] || rowData?.["Tax ID"] || rowData?.["Provider TIN"]);
}

async function typeAndVerify(input, value, label, options = {}) {
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.click({ force: true });
  await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await input.press("Backspace").catch(() => {});
  await input.pressSequentially(value, { delay: 60 });
  if (options.pressTab !== false) {
    await input.press("Tab").catch(() => {});
  }
  const actual = digitsOnly(await input.inputValue());
  if (actual !== value) {
    throw new Error(`${label} was not filled correctly. Expected "${value}", found "${actual || "blank"}".`);
  }
}

async function selectExactAutocompleteOptionIfVisible(frame, value, options = {}) {
  const option = frame.getByText(value, { exact: true }).last();
  let visible = await option.isVisible({ timeout: options.initialTimeoutMs || 1200 }).catch(() => false);
  if (!visible) {
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs || 800));
    visible = await option.isVisible({ timeout: options.retryTimeoutMs || 1200 }).catch(() => false);
  }
  if (!visible) return false;

  await option.click();
  return true;
}

async function isInputReadonly(input) {
  return input.evaluate((element) => Boolean(element.readOnly || element.disabled || element.getAttribute("aria-readonly") === "true"))
    .catch(() => false);
}

async function isProviderFieldRequired(frame, input, labelText) {
  const requiredAttr = await input.evaluate((element) => {
    return Boolean(
      element.required
      || element.getAttribute("aria-required") === "true"
      || element.getAttribute("required") != null
    );
  }).catch(() => false);
  if (requiredAttr) return true;

  const label = frame.locator("label").filter({ hasText: labelText }).first();
  const labelTextValue = await label.innerText({ timeout: 1000 }).catch(() => "");
  return /\*/.test(labelTextValue);
}

async function isProviderDropdownRequired(frame) {
  const providerInput = frame.locator("input[role='combobox']").first();
  const label = frame.locator("label").filter({ hasText: "Select a Provider" }).first();
  const labelTextValue = await label.innerText({ timeout: 1000 }).catch(() => "");
  if (/\*/.test(labelTextValue)) return true;

  const labelledInput = label.locator("xpath=ancestor::*[contains(@class,'MuiFormControl-root')][1]//input[@role='combobox']").first();
  const input = await labelledInput.isVisible({ timeout: 500 }).catch(() => false) ? labelledInput : providerInput;
  return input.evaluate((element) => Boolean(
    element.required
    || element.getAttribute("aria-required") === "true"
    || element.getAttribute("required") != null
  )).catch(() => false);
}

function extractProviderIdentifiersFromText(value) {
  const digitGroups = String(value || "").match(/\d{9,10}/g) || [];
  return {
    npi: digitGroups.find((group) => /^\d{10}$/.test(group)) || "",
    taxId: digitGroups.find((group) => /^\d{9}$/.test(group)) || "",
  };
}

async function getSelectedProviderTextForIdentifiers(frame, options = {}) {
  const candidates = [options.providerDropdownText || ""];
  const pageValues = await frame.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const values = [];

    for (const input of Array.from(document.querySelectorAll("input[role='combobox'], input[name='providerExpressEntry']"))) {
      const value = normalize(input.value);
      if (value && /provider|npi|tax|\d{9,10}/i.test(value)) {
        values.push(value);
      }
    }

    for (const element of Array.from(document.querySelectorAll(".provider-select__single-value, [class*='singleValue'], [class*='single-value']"))) {
      const value = normalize(element.textContent);
      if (value) {
        values.push(value);
      }
    }

    return values;
  }).catch(() => []);

  candidates.push(...pageValues);
  return candidates.find((value) => /\d{9,10}/.test(String(value || ""))) || "";
}

async function fillCharmMandatoryProviderIdentifiers(page, rowData, options = {}) {
  const { npi, taxId } = getInputProviderIdentifiers(rowData);
  const frame = await getClaimStatusFrame(page);
  const requiredFields = [];
  let providerIdentifierReady = false;
  let requiresProviderDropdown = false;
  const groupNameOnly = options.providerMode === "groupNameOnly";
  const hasConfiguredProviderSelection = Boolean(options.providerMode);
  const providerDropdownSelected = Boolean(options.providerDropdownSelected);
  const selectedProviderText = providerDropdownSelected ? await getSelectedProviderTextForIdentifiers(frame, options) : "";
  const selectedProviderIdentifiers = extractProviderIdentifiersFromText(selectedProviderText);

  const npiInput = frame.locator("input#providerNpi[name='providerNpi'], input#providerNpi").first();
  if (await npiInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    const npiRequired = await isProviderFieldRequired(frame, npiInput, "Provider NPI");
    if (npiRequired) requiredFields.push("Provider NPI");
    const currentNpi = digitsOnly(await npiInput.inputValue({ timeout: 1000 }).catch(() => ""));
    if (npiRequired && !currentNpi) {
      if (providerDropdownSelected && selectedProviderIdentifiers.npi) {
        if (await isInputReadonly(npiInput)) {
          throw new Error(`Provider NPI is mandatory and read-only. Selected provider value contains NPI "${selectedProviderIdentifiers.npi}", but Availity did not auto-fill the field.`);
        }
        options.logger?.info?.(`Charm provider fill: Provider NPI was not auto-filled. Filling selected provider NPI "${selectedProviderIdentifiers.npi}" from dropdown value "${selectedProviderText}".`);
        await typeAndVerify(npiInput, selectedProviderIdentifiers.npi, "Provider NPI", { pressTab: false });
        providerIdentifierReady = true;
      } else if (groupNameOnly) {
        if (hasConfiguredProviderSelection) {
          options.logger?.info?.("Charm provider fill: Provider NPI is mandatory and expects mapped provider selection to auto-fill it.");
          requiresProviderDropdown = true;
        } else {
          throw new Error("Provider NPI is mandatory on this Availity form, but no deterministic provider mapping is configured to auto-fill it.");
        }
      } else if (await isInputReadonly(npiInput)) {
        if (hasConfiguredProviderSelection) {
          options.logger?.info?.("Charm provider fill: Provider NPI is mandatory but read-only. Provider dropdown selection is required to auto-fill it.");
          requiresProviderDropdown = true;
        } else {
          throw new Error(`Provider NPI is mandatory and read-only on this Availity form, but no provider mapping/mode is configured to auto-fill it. Claim file Provider NPI="${npi || "blank"}".`);
        }
      } else {
        if (!npi) {
          throw new Error("Provider NPI is mandatory on this Availity form, but Provider NPI is blank in the claim file.");
        }
        if (!/^[1-4]\d{9}$/.test(npi)) {
          throw new Error(`Provider NPI must contain 10 digits and begin with 1, 2, 3, or 4. Received "${npi}".`);
        }
        options.logger?.info?.(`Charm provider fill: Provider NPI is mandatory and blank. Filling "${npi}".`);
        await typeAndVerify(npiInput, npi, "Provider NPI", { pressTab: false });
        providerIdentifierReady = true;
      }
    } else if (npiRequired && providerDropdownSelected && currentNpi) {
      options.logger?.info?.(`Charm provider fill: Provider NPI was auto-filled from selected provider as "${currentNpi}". Leaving it unchanged.`);
      providerIdentifierReady = true;
    } else if (npiRequired && npi && currentNpi !== npi) {
      if (await isInputReadonly(npiInput)) {
        if (hasConfiguredProviderSelection) {
          options.logger?.warn?.(`Charm provider fill: Provider NPI is mandatory but has stale value "${currentNpi}". Provider dropdown selection is required to replace it with "${npi}".`);
          requiresProviderDropdown = true;
        } else {
          throw new Error(`Provider NPI is mandatory and read-only with stale value "${currentNpi}", but claim file Provider NPI is "${npi}" and no provider mapping/mode is configured.`);
        }
      } else {
        options.logger?.warn?.(`Charm provider fill: Provider NPI had stale value "${currentNpi}". Replacing with "${npi}".`);
        await typeAndVerify(npiInput, npi, "Provider NPI", { pressTab: false });
        providerIdentifierReady = true;
      }
    } else if (npiRequired) {
      options.logger?.info?.(`Charm provider fill: Provider NPI is mandatory and already populated as "${currentNpi}".`);
      providerIdentifierReady = Boolean(currentNpi);
    } else {
      options.logger?.info?.("Charm provider fill: Provider NPI is not mandatory. Leaving it unchanged.");
    }
  }

  const taxIdInput = frame.locator("input#providerTaxId[name='providerTaxId'], input#providerTaxId").first();
  if (await taxIdInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    const taxIdRequired = await isProviderFieldRequired(frame, taxIdInput, "Provider Tax ID");
    if (taxIdRequired) requiredFields.push("Provider Tax ID");
    const currentTaxId = digitsOnly(await taxIdInput.inputValue({ timeout: 1000 }).catch(() => ""));
    if (taxIdRequired && !currentTaxId) {
      if (providerDropdownSelected && selectedProviderIdentifiers.taxId) {
        if (await isInputReadonly(taxIdInput)) {
          throw new Error(`Provider Tax ID is mandatory and read-only. Selected provider value contains Tax ID "${selectedProviderIdentifiers.taxId}", but Availity did not auto-fill the field.`);
        }
        options.logger?.info?.(`Charm provider fill: Provider Tax ID was not auto-filled. Filling selected provider Tax ID "${selectedProviderIdentifiers.taxId}" from dropdown value "${selectedProviderText}".`);
        await typeAndVerify(taxIdInput, selectedProviderIdentifiers.taxId, "Provider Tax ID", { pressTab: false });
        const selected = await selectExactAutocompleteOptionIfVisible(frame, selectedProviderIdentifiers.taxId);
        if (selected) {
          options.logger?.info?.(`Charm provider fill: selected Provider Tax ID dropdown option "${selectedProviderIdentifiers.taxId}".`);
        }
        providerIdentifierReady = true;
      } else if (!taxId) {
        throw new Error("Provider Tax ID is mandatory on this Availity form, but Provider Tax ID is blank in the claim file.");
      } else {
        options.logger?.info?.(`Charm provider fill: Provider Tax ID is mandatory and blank. Filling "${taxId}".`);
        await typeAndVerify(taxIdInput, taxId, "Provider Tax ID", { pressTab: false });
        const selected = await selectExactAutocompleteOptionIfVisible(frame, taxId);
        if (selected) {
          options.logger?.info?.(`Charm provider fill: selected Provider Tax ID dropdown option "${taxId}".`);
        }
        providerIdentifierReady = true;
      }
    } else if (taxIdRequired && providerDropdownSelected && currentTaxId) {
      options.logger?.info?.(`Charm provider fill: Provider Tax ID was auto-filled from selected provider as "${currentTaxId}". Leaving it unchanged.`);
      providerIdentifierReady = true;
    } else if (taxIdRequired && taxId && currentTaxId !== taxId) {
      if (await isInputReadonly(taxIdInput)) {
        throw new Error(`Provider Tax ID is mandatory and read-only with stale value "${currentTaxId}", but claim file Provider Tax ID is "${taxId}".`);
      }
      options.logger?.warn?.(`Charm provider fill: Provider Tax ID had stale value "${currentTaxId}". Replacing with "${taxId}".`);
      await typeAndVerify(taxIdInput, taxId, "Provider Tax ID", { pressTab: false });
      const selected = await selectExactAutocompleteOptionIfVisible(frame, taxId);
      if (selected) {
        options.logger?.info?.(`Charm provider fill: selected Provider Tax ID dropdown option "${taxId}".`);
      }
      providerIdentifierReady = true;
    } else if (taxIdRequired) {
      options.logger?.info?.(`Charm provider fill: Provider Tax ID is mandatory and already populated as "${currentTaxId}".`);
      providerIdentifierReady = Boolean(currentTaxId) || providerIdentifierReady;
    } else {
      options.logger?.info?.("Charm provider fill: Provider Tax ID is not mandatory. Leaving it unchanged.");
    }
  }

  if (await isProviderDropdownRequired(frame)) {
    requiredFields.push("Select a Provider");
    if (!hasConfiguredProviderSelection) {
      throw new Error("Select a Provider is mandatory on this Availity form, but no deterministic provider mapping/mode is configured.");
    }
    requiresProviderDropdown = true;
  }

  if (requiresProviderDropdown) {
    return { providerIdentifierReady: false, requiresProviderDropdown };
  }

  return { providerIdentifierReady: providerIdentifierReady || requiredFields.length === 0, requiresProviderDropdown: false };
}

async function fillInputProviderIdentifiers(page, rowData, options = {}) {
  if (options.charmRequiredOnly) {
    return fillCharmMandatoryProviderIdentifiers(page, rowData, options);
  }

  const { npi, taxId } = getInputProviderIdentifiers(rowData);
  const frame = await getClaimStatusFrame(page);

  if (npi) {
    if (!/^[1-4]\d{9}$/.test(npi)) {
      throw new Error(`Provider NPI must contain 10 digits and begin with 1, 2, 3, or 4. Received "${npi}".`);
    }
    await typeAndVerify(frame.locator("input#providerNpi[name='providerNpi'], input#providerNpi").first(), npi, "Provider NPI");
  }

  if (taxId) {
    const taxIdInput = frame.locator("input#providerTaxId[name='providerTaxId'], input#providerTaxId").first();
    if (await taxIdInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      await typeAndVerify(taxIdInput, taxId, "Provider Tax ID");
    }
  }

  return { providerIdentifierReady: Boolean(npi || taxId) };
}

module.exports = {
  clearProviderNpiField,
  clearProviderFormIfVisible,
  clearProviderStateForTaxIdFallback,
  fillInputProviderIdentifiers,
  getProviderTaxIdForPolicy,
  getInputProviderIdentifiers,
  hasInputProviderIdentifiers,
  providerPolicySkipsProviderDropdown,
  verifyProviderNpiMatches
};
