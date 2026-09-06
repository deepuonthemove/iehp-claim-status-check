import { DEFAULT_AVAILITY_REQUIRED_FIELDS, type AvailityProjectConfig } from "./types";

export const charmAvailityConfig: AvailityProjectConfig = {
  id: "charm",
  fields: {
    "Claim No": { aliases: ["Invoice #", "Invoice Number", "Invoice"] },
    "Payer Name": { aliases: ["Master Payer Name", "Payer Name"] },
    "Portal Payer Name": { aliases: ["Payer to choose in Availity"] },
    "Portal State": { aliases: ["State to choose in Availity"] },
    "Patient Name": {
      aliases: ["Patient Name"],
      combineAliases: [["Patient first name", "Patient last name"]],
      normalizer: "stripBracketedPatientId",
    },
    "Patient ID": { aliases: ["Patient Name"], normalizer: "extractBracketedPatientId" },
    "Patient DOB": { aliases: ["Date Of Birth", "Date of Birth", "DOB"], normalizer: "dateToMmDdYyyy" },
    "Subscriber No": { aliases: ["Insured's ID", "Insured ID", "Member ID", "Subscriber No"] },
    "Service Date": { aliases: ["Date Of Service", "Date of Service", "DOS", "Service Date"], normalizer: "dateToMmDdYyyy" },
    Charges: { aliases: ["Claim Amount", "Charges", "Billed Amount"] },
    "Provider Name": { aliases: ["Provider Name"], normalizer: "stripBracketedProviderId" },
    "Provider NPI": { aliases: ["Provider NPI"] },
    "Provider Tax ID": { aliases: ["Tax ID", "Provider Tax ID", "Provider TIN"] },
    Group: { aliases: ["Practice", "Group", "Organization Group"] },
  },
  outputHeaderMappings: {
    Practice: "Group",
    "Claim Amount": "Charges",
  },
  additionalOutputHeaders: ["Patient ID", "Patient Identity Match"],
  patientIdentityOutput: {
    patientIdField: "Patient ID",
    matchStatusField: "Patient Identity Match",
    mismatchStatus: "Patient name not matched; Patient ID matched",
  },
  requiredFields: [...DEFAULT_AVAILITY_REQUIRED_FIELDS, "Portal Payer Name", "Portal State", "Group"],
  selections: {
    organization: {
      sourceField: "Group",
      values: {
        "Open Mind": "Open Mind Health",
        Matushka: "Open Mind Health",
        ICM: "Institute on Complementary Medicine",
        "Feel Better": "FEEL BETTER BEHAVIORAL HEALTH SERVICES LLC",
        Columbia: "Columbia River Natural Medicine, LLC",
        "Grey Matters": "William Nields, PLLC",
        Dumont: "Dumont medical PLLC",
        Premier: "Premier Health",
        Bentonville: "BENTONVILLE PEDIATRICS, P.A.",
      },
      skipValues: ["Sharon"],
      required: true,
    },
    state: { sourceField: "Portal State" },
    payer: { directField: "Portal Payer Name", mappingField: "Payer Name" },
  },
  selectionRules: [
    {
      when: {
        practice: "Feel Better",
        login: "rcmjeff",
      },
      use: {
        organization: "Open Mind Health",
        providerMode: "individualNpiFirst",
      },
    },
    {
      when: {
        practice: "Feel Better",
        login: "rcmben",
      },
      use: {
        organization: "FEEL BETTER BEHAVIORAL HEALTH SERVICES LLC",
      },
    },
    {
      when: {
        practice: "Open Mind",
        login: "rcmben",
        state: "California",
        payer: "AETNA (COMMERCIAL & MEDICARE)",
      },
      use: {
        organization: "Open Mind Health",
        providerName: "OPEN MIND MENTAL HEALTH PHYSICIANS, INC.",
        providerMode: "groupNameOnly",
      },
    },
    {
      when: {
        practice: "Open Mind",
        login: "rcmben",
        state: "California",
      },
      use: {
        organization: "Open Mind Health",
        providerName: "OPEN MIND MENTAL HEALTH PHYSICIANS, INC.",
        providerMode: "groupNameFirst",
      },
    },
    {
      when: {
        practice: "Grey Matters",
        login: "rcmbrandon",
      },
      use: {
        organization: "William Nields, PLLC",
      },
    },
  ],
  provider: {
    groupField: "Group",
    inputNameField: "Provider Name",
    inputNpiField: "Provider NPI",
    inputTaxIdField: "Provider Tax ID",
    requireProvider: true,
    allowInputNameFallback: true,
    includeInputNameAfterMapping: true,
  },
  matching: {
    matchBilledAmount: true,
    memberIdMode: "disabled",
    patientNameFallback: false,
    patientNameWithoutInitialFallback: false,
    fuzzyPatientNameFallback: false,
    patientIdFallback: true,
    reportCombinedMemberPatientMismatch: false,
    allowFuzzyProviderSelection: true,
  },
  preprocessingStrategy: "none",
  outputStrategy: "default",
};
