import path from "node:path";
import ExcelJS from "exceljs";
import type { AvailityInputRow, AvailityMfaConfig, AvailityProviderMapping } from "./types";
import projectMfaConfig from "./config/project-mfa-config.json";
import { DEFAULT_AVAILITY_REQUIRED_FIELDS, getAvailityProjectConfig } from "./config/projects";
import type { AvailityProjectFieldConfig } from "./config/projects";
import type { AvailityPortalSelections } from "./config/projects";
import type { AvailityMatchingPolicy } from "./config/projects";
import type { AvailityProviderFieldPolicy } from "./config/projects";
import type { AvailityRuleWhen, AvailitySelectionRule } from "./config/projects";

export { AVAILITY_PROJECT_CONFIGS } from "./config/projects";

function asText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    return `${String(value.getMonth() + 1).padStart(2, "0")}/${String(value.getDate()).padStart(2, "0")}/${value.getFullYear()}`;
  }
  if (typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "").trim();
  }
  return String(value).trim();
}

function normalizeAlias(value: unknown): string {
  return asText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeHeader(value: unknown): string {
  return asText(value).replace(/\s+/g, " ").trim();
}

function normalizeLookup(value: unknown): string {
  return String(value || "").replace(/[^a-z0-9]+/gi, "").toLowerCase();
}

function stripBracketedPatientId(value: string): string {
  return String(value || "")
    .replace(/\s*\[[^\]]*]\s*/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripBracketedProviderId(value: string): string {
  return String(value || "")
    .replace(/\s*\[[^\]]*$/, "")
    .replace(/\s*\[[^\]]*]\s*/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function findDataValue(data: Record<string, string>, aliases: string[]): string {
  for (const alias of aliases) {
    const wanted = normalizeLookup(alias);
    for (const [key, value] of Object.entries(data)) {
      if (normalizeLookup(key) === wanted && value) {
        return String(value).trim();
      }
    }
  }
  return "";
}

function extractBracketedPatientId(value: string): string {
  return String(value || "").match(/\[\s*([^\]]+?)\s*]/)?.[1]?.trim() || "";
}

function dateToMmDdYyyy(value: string): string {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const numericMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (numericMatch) {
    return `${numericMatch[1].padStart(2, "0")}/${numericMatch[2].padStart(2, "0")}/${numericMatch[3]}`;
  }
  const namedMatch = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!namedMatch) return raw;
  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const monthIndex = monthNames.indexOf(namedMatch[1].slice(0, 3).toLowerCase());
  if (monthIndex < 0) return raw;
  return `${String(monthIndex + 1).padStart(2, "0")}/${namedMatch[2].padStart(2, "0")}/${namedMatch[3]}`;
}

function findRowValue(row: AvailityInputRow, aliases: string[]): string {
  const wanted = new Set(aliases.map(normalizeLookup));
  for (const [key, value] of Object.entries(row.data)) {
    if (wanted.has(normalizeLookup(key)) && value) {
      return String(value).trim();
    }
  }
  return "";
}

function matchesPolicyValue(ruleValue: string | undefined, actualValue: string): boolean {
  if (!ruleValue) return true;
  const normalizedRule = normalizeLookup(ruleValue);
  const normalizedActual = normalizeLookup(actualValue);
  if (!normalizedActual) return false;
  return normalizedRule === normalizedActual
    || normalizedActual.includes(normalizedRule)
    || normalizedRule.includes(normalizedActual);
}

function matchesAnyPolicyValue(ruleValue: string | string[] | undefined, actualValue: string): boolean {
  if (Array.isArray(ruleValue)) {
    return ruleValue.some((value) => matchesPolicyValue(value, actualValue));
  }
  return matchesPolicyValue(ruleValue, actualValue);
}

function ruleSpecificity(when: AvailityRuleWhen): number {
  return Object.values(when).filter((value) => Array.isArray(value) ? value.length > 0 : Boolean(value)).length;
}

function matchesRuleWhen(
  when: AvailityRuleWhen,
  context: { practice: string; payer: string; inputPayerName: string; login: string; state: string },
): boolean {
  return matchesPolicyValue(when.practice, context.practice)
    && (
      matchesAnyPolicyValue(when.payer, context.payer)
      || matchesAnyPolicyValue(when.payer, context.inputPayerName)
    )
    && matchesAnyPolicyValue(when.login, context.login)
    && matchesAnyPolicyValue(when.state, context.state);
}

function findBestSelectionRule(
  rules: AvailitySelectionRule[],
  context: { practice: string; payer: string; inputPayerName: string; login: string; state: string },
): AvailitySelectionRule | undefined {
  return rules
    .map((rule, index) => ({ rule, index, score: ruleSpecificity(rule.when) }))
    .filter(({ rule }) => matchesRuleWhen(rule.when, context))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.rule;
}

function parseMoney(value: unknown): number | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const isNegative = /^\(.*\)$/.test(raw);
  const numeric = Number(raw.replace(/[()$,\s]/g, ""));
  if (!Number.isFinite(numeric)) return null;
  return isNegative ? -numeric : numeric;
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}

export function normalizeProjectId(value: unknown): string {
  const normalized = normalizeAlias(value || "minimax");
  if (!normalized || normalized === "minimax") return "minimax";
  if (normalized === "medrevenu" || normalized === "medrevenue") return "medrevenu";
  if (normalized === "charm") return "charm";
  throw new Error(`Unsupported Availity project "${asText(value)}". Supported projects: Minimax, Medrevenu, Charm.`);
}

export function getMfaConfigForProject(projectId: string): AvailityMfaConfig {
  const configs = projectMfaConfig as Record<string, AvailityMfaConfig | undefined>;
  return configs[projectId] ?? configs.default ?? { totpSecretFormat: "base32" };
}

export function applyProjectColumnMapping(projectId: string, data: Record<string, string>): Record<string, string> {
  const config = getAvailityProjectConfig(projectId);
  const mapped: Record<string, string> = { ...data };
  for (const [canonicalField, fieldConfig] of Object.entries(config.fields)) {
    mapped[canonicalField] = resolveConfiguredField(data, canonicalField, fieldConfig);
  }
  return mapped;
}

function resolveConfiguredField(
  data: Record<string, string>,
  canonicalField: string,
  fieldConfig: AvailityProjectFieldConfig,
): string {
  let value = findDataValue(data, fieldConfig.aliases || []) || data[canonicalField] || "";
  if (!value && fieldConfig.combineAliases) {
    for (const aliases of fieldConfig.combineAliases) {
      const combined = aliases.map((alias) => findDataValue(data, [alias])).filter(Boolean).join(" ");
      if (combined) {
        value = combined;
        break;
      }
    }
  }
  value ||= fieldConfig.defaultValue || "";
  if (fieldConfig.normalizer === "stripBracketedPatientId") return stripBracketedPatientId(value);
  if (fieldConfig.normalizer === "extractBracketedPatientId") return extractBracketedPatientId(value);
  if (fieldConfig.normalizer === "stripBracketedProviderId") return stripBracketedProviderId(value);
  if (fieldConfig.normalizer === "dateToMmDdYyyy") return dateToMmDdYyyy(value);
  return value;
}

export function getRequiredFieldsForProject(projectId: string): string[] {
  return getAvailityProjectConfig(projectId).requiredFields || DEFAULT_AVAILITY_REQUIRED_FIELDS;
}

export function getMatchingPolicy(projectId: string, portalPayerName: string): AvailityMatchingPolicy {
  const config = getAvailityProjectConfig(projectId);
  const normalizedPayer = String(portalPayerName || "").toUpperCase();
  const override = Object.entries(config.payerMatchingOverrides || {})
    .find(([payerPattern]) => normalizedPayer.includes(payerPattern.toUpperCase()))?.[1];
  return { ...config.matching, ...override };
}

export function getPortalStateForRow(projectId: string, row: AvailityInputRow): string | undefined {
  const config = getAvailityProjectConfig(projectId);
  const sourceField = config.selections.state?.sourceField;
  if (!sourceField) return undefined;
  const stateConfig = config.fields[sourceField];
  const state = findRowValue(row, [sourceField]) || stateConfig?.defaultValue || "";
  return state || undefined;
}

export function resolvePortalSelections(
  projectId: string,
  row: AvailityInputRow,
  payerMapping: Map<string, string>,
  login = "",
): AvailityPortalSelections {
  const config = getAvailityProjectConfig(projectId);
  const payerConfig = config.selections.payer;
  const directPayer = payerConfig.directField ? findRowValue(row, [payerConfig.directField]) : "";
  const mappingValue = findRowValue(row, [payerConfig.mappingField]);
  const payer = directPayer || (mappingValue ? payerMapping.get(mappingValue.toLowerCase()) || "" : "");
  const state = getPortalStateForRow(projectId, row) || "";
  const practice = findRowValue(row, ["Group", "Practice", "Organization Group"]);

  const organizationConfig = config.selections.organization;
  let organization: string | undefined;
  if (organizationConfig) {
    const sourceValue = findRowValue(row, [organizationConfig.sourceField]);
    if (!sourceValue && organizationConfig.required) {
      throw new Error(`${projectId} Availity rows require ${organizationConfig.sourceField} to select the organization.`);
    }
    const skipOrganization = (organizationConfig.skipValues || [])
      .some((configuredValue) => normalizeLookup(configuredValue) === normalizeLookup(sourceValue));
    if (!skipOrganization) {
      organization = Object.entries(organizationConfig.values)
        .find(([configuredValue]) => normalizeLookup(configuredValue) === normalizeLookup(sourceValue))?.[1];
      if (sourceValue && !organization) {
        throw new Error(`No Availity organization mapping found for ${projectId} ${organizationConfig.sourceField} "${sourceValue}". Update its project configuration.`);
      }
    }
  }

  const selectionRule = findBestSelectionRule(config.selectionRules || [], {
    practice,
    payer,
    inputPayerName: directPayer || mappingValue,
    login,
    state,
  });
  if (selectionRule?.use.organization) {
    organization = selectionRule.use.organization;
  }

  return {
    organization,
    state: state || undefined,
    payer,
  };
}

export function getProjectInputHeaders(projectId: string, headers: string[]): string[] {
  const config = getAvailityProjectConfig(projectId);
  const headerMappings = config.outputHeaderMappings || {};
  const replacements = Object.fromEntries(
    Object.entries(headerMappings).map(([source, target]) => [normalizeLookup(source), target]),
  );
  return Array.from(new Set([
    ...headers.map((header) => replacements[normalizeLookup(header)] || header),
    ...(config.additionalOutputHeaders || []),
  ]));
}

export function applyProjectPreprocessing(projectId: string, rows: AvailityInputRow[]): AvailityInputRow[] {
  const strategy = getAvailityProjectConfig(projectId).preprocessingStrategy;
  return PREPROCESSING_STRATEGIES[strategy](rows);
}

function sumChargesByAccountEpisode(rows: AvailityInputRow[]): AvailityInputRow[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const accountNumber = findRowValue(row, ["Account Number", "Account No", "Account"]);
    const episodeDos = findRowValue(row, ["Episode_DOS", "Episode DOS", "Episode Dos"]);
    const billedAmount = parseMoney(findRowValue(row, ["Line Billed Amount", "Billed Amount", "Charges"]));
    if (!accountNumber || !episodeDos || billedAmount == null) {
      continue;
    }

    const groupKey = `${normalizeLookup(accountNumber)}|${normalizeLookup(episodeDos)}`;
    totals.set(groupKey, (totals.get(groupKey) || 0) + billedAmount);
  }

  return rows.map((row) => {
    const accountNumber = findRowValue(row, ["Account Number", "Account No", "Account"]);
    const episodeDos = findRowValue(row, ["Episode_DOS", "Episode DOS", "Episode Dos"]);
    const groupKey = `${normalizeLookup(accountNumber)}|${normalizeLookup(episodeDos)}`;
    const total = totals.get(groupKey);
    if (!accountNumber || !episodeDos || total == null) {
      return row;
    }

    return {
      ...row,
      data: {
        ...row.data,
        Charges: formatMoney(total),
        "Claim Level Billed Amount": formatMoney(total),
      },
    };
  });
}

const PREPROCESSING_STRATEGIES: Record<
  "none" | "sumChargesByAccountEpisode",
  (rows: AvailityInputRow[]) => AvailityInputRow[]
> = {
  none: (rows) => rows,
  sumChargesByAccountEpisode,
};

export function getOrganizationForRow(projectId: string, row: AvailityInputRow): string | undefined {
  return resolvePortalSelections(projectId, row, new Map()).organization;
}

export async function readAvailityProviderMapping(): Promise<AvailityProviderMapping[]> {
  const mappingPath = path.join(
    process.cwd(),
    "backend",
    "src",
    "workflows",
    "claim-status",
    "portals",
    "availity",
    "config",
    "Provider_mapping_ava.xlsx",
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(mappingPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error("Availity provider mapping workbook does not contain any worksheets.");
  }

  const headers: string[] = [];
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = normalizeHeader(cell.value);
  });

  const projectCol = headers.findIndex((header) => normalizeAlias(header) === normalizeAlias("Project"));
  const groupCol = headers.findIndex((header) => normalizeAlias(header) === normalizeAlias("Group"));
  const providerCol = headers.findIndex((header) => normalizeAlias(header) === normalizeAlias("Provider Name"));
  const activeCol = headers.findIndex((header) => normalizeAlias(header) === normalizeAlias("Active"));
  if (projectCol < 1 || groupCol < 1 || providerCol < 1) {
    throw new Error("Availity provider mapping must contain Project, Group, and Provider Name columns.");
  }

  const mappings: AvailityProviderMapping[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const project = normalizeProjectId(asText(row.getCell(projectCol).value));
    const group = asText(row.getCell(groupCol).value);
    const providerName = asText(row.getCell(providerCol).value);
    const activeText = activeCol >= 1 ? asText(row.getCell(activeCol).value) : "Yes";
    const active = !/^(no|false|inactive|0)$/i.test(activeText.trim());
    if (project && group && providerName) {
      mappings.push({ project, group, providerName, active });
    }
  });

  return mappings;
}

export function getProviderOrderForRow(projectId: string, row: AvailityInputRow, providerMappings: AvailityProviderMapping[]): string[] | undefined {
  const config = getAvailityProjectConfig(projectId);
  const providerConfig = config.provider;
  if (!providerConfig) return undefined;

  const group = findRowValue(row, [providerConfig.groupField]);
  const inputProviderName = findRowValue(row, [providerConfig.inputNameField]);
  const inputProviderNpi = providerConfig.inputNpiField
    ? findRowValue(row, [providerConfig.inputNpiField])
    : "";
  const inputProviderTaxId = providerConfig.inputTaxIdField
    ? findRowValue(row, [providerConfig.inputTaxIdField])
    : "";
  if (projectId === "charm") {
    const identifierOrder = Array.from(new Set([inputProviderNpi, inputProviderTaxId].filter(Boolean)));
    if (identifierOrder.length) return identifierOrder;
    throw new Error(`${projectId} Availity rows require ${providerConfig.inputNpiField || "Provider NPI"} or ${providerConfig.inputTaxIdField || "Provider Tax ID"} to select the provider.`);
  }
  if (inputProviderNpi) {
    return [inputProviderNpi];
  }
  if (!group) {
    if (inputProviderName && providerConfig.allowInputNameFallback) return [inputProviderName];
    if (inputProviderTaxId) return [inputProviderTaxId];
    if (providerConfig.requireGroup) {
      throw new Error(`${projectId} Availity rows require ${providerConfig.groupField} to select the provider.`);
    }
    if (providerConfig.requireProvider) {
      throw new Error(`${projectId} Availity rows require ${providerConfig.inputNpiField || providerConfig.inputNameField}, a mapped ${providerConfig.groupField}, or ${providerConfig.inputNameField}.`);
    }
    return undefined;
  }

  const configuredProvider = Object.entries(providerConfig.values || {})
    .find(([configuredGroup]) => normalizeLookup(configuredGroup) === normalizeLookup(group))?.[1];
  if (configuredProvider) {
    return Array.from(new Set([
      configuredProvider,
      providerConfig.includeInputNameAfterMapping ? inputProviderName : "",
    ].filter(Boolean)));
  }

  const match = providerMappings.find((mapping) => {
    return mapping.active
      && mapping.project === projectId
      && normalizeLookup(mapping.group) === normalizeLookup(group);
  });

  if (!match) {
    if (inputProviderName && providerConfig.allowInputNameFallback) return [inputProviderName];
    if (inputProviderTaxId) return [inputProviderTaxId];
    if (providerConfig.requireMapping || providerConfig.requireProvider) {
      throw new Error(`No Availity provider mapping found for ${projectId} ${providerConfig.groupField} "${group}"${providerConfig.allowInputNameFallback ? `, and no ${providerConfig.inputNameField} fallback was supplied` : ""}. Update Provider_mapping_ava.xlsx.`);
    }
    return undefined;
  }

  return Array.from(new Set([
    match.providerName,
    providerConfig.includeInputNameAfterMapping ? inputProviderName : "",
  ].filter(Boolean)));
}

export function getSelectionRuleProviderOrder(
  projectId: string,
  row: AvailityInputRow,
  portalPayerName: string,
  login = "",
): string[] | undefined {
  const config = getAvailityProjectConfig(projectId);
  const providerConfig = config.provider;
  const practice = findRowValue(row, ["Group", "Practice", "Organization Group"]);
  const inputPayerName = findRowValue(row, ["Portal Payer Name", "Payer Name"]);
  const state = getPortalStateForRow(projectId, row) || "";
  const rule = findBestSelectionRule(config.selectionRules || [], {
    practice,
    payer: portalPayerName,
    inputPayerName,
    login,
    state,
  });
  const providerName = rule?.use.providerName?.trim();
  const providerMode = rule?.use.providerMode || (providerName ? "groupNameOnly" : undefined);
  if (!providerMode) return undefined;

  const inputProviderNpi = providerConfig?.inputNpiField
    ? findRowValue(row, [providerConfig.inputNpiField])
    : "";
  const providerOrder = Array.from(new Set([
    ...(providerMode === "groupNameOnly" ? [providerName || ""] : providerMode === "groupNameFirst" ? [providerName || "", inputProviderNpi] : [inputProviderNpi, providerName || ""]),
  ].filter(Boolean)));

  return providerOrder.length ? providerOrder : undefined;
}

export function getSelectionRuleProviderMode(
  projectId: string,
  row: AvailityInputRow,
  portalPayerName: string,
  login = "",
): string | undefined {
  const config = getAvailityProjectConfig(projectId);
  const practice = findRowValue(row, ["Group", "Practice", "Organization Group"]);
  const inputPayerName = findRowValue(row, ["Portal Payer Name", "Payer Name"]);
  const state = getPortalStateForRow(projectId, row) || "";
  const rule = findBestSelectionRule(config.selectionRules || [], {
    practice,
    payer: portalPayerName,
    inputPayerName,
    login,
    state,
  });
  return rule?.use.providerMode || (rule?.use.providerName ? "groupNameOnly" : undefined);
}

export function getServiceDateProviderFieldPolicy(projectId: string, row: AvailityInputRow, portalPayerName: string, login = ""): AvailityProviderFieldPolicy | undefined {
  const config = getAvailityProjectConfig(projectId);
  void login;
  return findProviderFieldPolicy(config.fieldPolicies?.serviceDates || [], row, portalPayerName);
}

function findProviderFieldPolicy(
  rules: { practice?: string; payer?: string; fields: AvailityProviderFieldPolicy }[],
  row: AvailityInputRow,
  portalPayerName: string,
): AvailityProviderFieldPolicy | undefined {
  if (!rules.length) return undefined;

  const practice = findRowValue(row, ["Group", "Practice", "Organization Group"]);
  const inputPayerName = findRowValue(row, ["Portal Payer Name", "Payer Name"]);

  return rules.find((rule) => {
    const practiceMatches = matchesPolicyValue(rule.practice, practice);
    const payerMatches = matchesPolicyValue(rule.payer, portalPayerName) || matchesPolicyValue(rule.payer, inputPayerName);
    return practiceMatches && payerMatches;
  })?.fields;
}
