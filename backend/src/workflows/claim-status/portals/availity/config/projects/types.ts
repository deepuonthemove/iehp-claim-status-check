export type AvailityProjectFieldConfig = {
  aliases?: string[];
  combineAliases?: string[][];
  defaultValue?: string;
  normalizer?: "stripBracketedPatientId" | "extractBracketedPatientId" | "stripBracketedProviderId" | "dateToMmDdYyyy";
};

export type AvailityProjectConfig = {
  id: "minimax" | "medrevenu" | "charm";
  fields: Record<string, AvailityProjectFieldConfig>;
  outputHeaderMappings?: Record<string, string>;
  additionalOutputHeaders?: string[];
  patientIdentityOutput?: {
    patientIdField: string;
    matchStatusField: string;
    mismatchStatus: string;
  };
  requiredFields?: string[];
  selections: {
    organization?: {
      sourceField: string;
      values: Record<string, string>;
      skipValues?: string[];
      required?: boolean;
    };
    state?: { sourceField: string };
    payer: {
      directField?: string;
      mappingField: string;
    };
  };
  selectionRules?: AvailitySelectionRule[];
  provider?: {
    groupField: string;
    values?: Record<string, string>;
    inputNameField: string;
    inputNpiField?: string;
    inputTaxIdField?: string;
    requireGroup?: boolean;
    requireProvider?: boolean;
    requireMapping?: boolean;
    allowInputNameFallback?: boolean;
    includeInputNameAfterMapping?: boolean;
  };
  fieldPolicies?: {
    serviceDates?: AvailityServiceDateFieldPolicyRule[];
  };
  matching: AvailityMatchingPolicy;
  payerMatchingOverrides?: Record<string, Partial<AvailityMatchingPolicy>>;
  preprocessingStrategy: "none" | "sumChargesByAccountEpisode";
  outputStrategy: "default" | "cptLineDetail";
};

export type AvailityFieldFillPolicy = {
  fill?: boolean;
  clear?: boolean;
  value?: string;
  valueFrom?: string;
  required?: boolean;
};

export type AvailityProviderFieldPolicy = {
  providerDropdown?: AvailityFieldFillPolicy;
  providerNpi?: AvailityFieldFillPolicy;
  providerTaxId?: AvailityFieldFillPolicy;
};

export type AvailityServiceDateFieldPolicyRule = {
  practice?: string;
  payer?: string;
  fields: AvailityProviderFieldPolicy;
};

export type AvailityRuleWhen = {
  practice?: string;
  payer?: string | string[];
  login?: string | string[];
  state?: string | string[];
};

export type AvailityProviderSelectionMode = "individualNpiFirst" | "groupNameFirst" | "groupNameOnly";

export type AvailitySelectionRule = {
  when: AvailityRuleWhen;
  use: {
    organization?: string;
    providerName?: string;
    providerMode?: AvailityProviderSelectionMode;
  };
};

export type AvailityMatchingPolicy = {
  matchBilledAmount: boolean;
  memberIdMode: "required" | "whenPresent" | "disabled";
  patientNameFallback: boolean;
  patientNameWithoutInitialFallback: boolean;
  fuzzyPatientNameFallback: boolean;
  patientIdFallback?: boolean;
  reportCombinedMemberPatientMismatch: boolean;
  allowFuzzyProviderSelection: boolean;
};

export type AvailityPortalSelections = {
  organization?: string;
  state?: string;
  payer: string;
};

export const DEFAULT_AVAILITY_REQUIRED_FIELDS = [
  "Payer Name",
  "Patient Name",
  "Patient DOB",
  "Subscriber No",
  "Service Date",
  "Charges",
];
