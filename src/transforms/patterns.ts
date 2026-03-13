// src/transforms/patterns.ts
// Named nested-transform pattern library for common SailPoint ISC use cases.
// All patterns are fully offline — no tenant access required.

export type NamedPattern = {
  pattern_name: string;
  description: string;
  keywords: string[];
  example_transform: any;
};

// ---------------------------------------------------------------------------
// Pattern library
// ---------------------------------------------------------------------------

const PATTERNS: NamedPattern[] = [
  // ── 1. Fallback email chain ─────────────────────────────────────────────
  {
    pattern_name: "Fallback email chain",
    description:
      "Returns the first non-null email from a priority chain: work email → personal email → a generated placeholder. Uses firstValid with accountAttribute / identityAttribute sources and a static fallback.",
    keywords: ["email", "fallback", "first valid", "first non-null", "preferred email", "work email", "personal email"],
    example_transform: {
      type: "firstValid",
      name: "Fallback Email Chain",
      attributes: {
        values: [
          {
            type: "accountAttribute",
            attributes: { sourceName: "HR Source", attributeName: "workEmail" },
          },
          {
            type: "accountAttribute",
            attributes: { sourceName: "Directory", attributeName: "personalEmail" },
          },
          {
            type: "static",
            attributes: { value: "noemail@placeholder.com" },
          },
        ],
      },
    },
  },

  // ── 2. Conditional department → building code ───────────────────────────
  {
    pattern_name: "Conditional department to building code",
    description:
      "Maps a department attribute to a building code. If department equals 'Engineering', returns 'BLDG-E'; otherwise returns 'BLDG-A'. Uses conditional with an accountAttribute variable.",
    keywords: ["conditional", "department", "building", "location", "if equals", "if department", "map value", "conditional mapping"],
    example_transform: {
      type: "conditional",
      name: "Department to Building Code",
      attributes: {
        department: {
          type: "accountAttribute",
          attributes: { sourceName: "HR Source", attributeName: "department" },
        },
        expression: "$department eq Engineering",
        positiveCondition: "BLDG-E",
        negativeCondition: "BLDG-A",
      },
    },
  },

  // ── 3. Username: first initial + last name + uniqueCounter ──────────────
  {
    pattern_name: "Username first initial last name uniqueCounter",
    description:
      "Generates a unique username using the first letter of givenName plus the full sn (surname). Falls back to a counter-suffixed variant for conflict resolution. Uses usernameGenerator with dynamic variables.",
    keywords: ["username", "login", "unique", "first initial", "last name", "uniquecounter", "user id", "account name"],
    example_transform: {
      type: "usernameGenerator",
      name: "Username Generator",
      attributes: {
        patterns: [
          "${fi}${ln}",
          "${fi}${ln}${uniqueCounter}",
        ],
        fi: {
          type: "substring",
          attributes: {
            begin: 0,
            end: 1,
            input: {
              type: "identityAttribute",
              attributes: { name: "givenName" },
            },
          },
        },
        ln: {
          type: "lower",
          attributes: {
            input: {
              type: "identityAttribute",
              attributes: { name: "sn" },
            },
          },
        },
      },
    },
  },

  // ── 4. Epoch timestamp → ISO8601 ────────────────────────────────────────
  {
    pattern_name: "Date format EPOCH to ISO8601",
    description:
      "Converts a Java-epoch (milliseconds since 1970-01-01T00:00:00Z) timestamp from an HR source into an ISO8601 date string. Uses dateFormat with inputFormat=EPOCH_TIME_JAVA and outputFormat=ISO8601.",
    keywords: ["epoch", "iso8601", "date format", "convert date", "timestamp", "java epoch", "epoch_time_java"],
    example_transform: {
      type: "dateFormat",
      name: "Epoch to ISO8601",
      attributes: {
        inputFormat: "EPOCH_TIME_JAVA",
        outputFormat: "ISO8601",
        input: {
          type: "accountAttribute",
          attributes: { sourceName: "HR Source", attributeName: "hireDate" },
        },
      },
    },
  },

  // ── 5. Normalize + lowercase name ───────────────────────────────────────
  {
    pattern_name: "Normalize and lowercase name",
    description:
      "Normalizes a name (handles Mc/Mac, de/von, Roman numerals, etc.) then lowercases it. Useful for email prefix generation from display names. Uses concat around lower(normalizeNames(givenName)) and lower(normalizeNames(sn)).",
    keywords: ["normalize name", "lowercase name", "email prefix", "first last", "decompose", "diacritic", "normalize lower"],
    example_transform: {
      type: "concat",
      name: "Normalized Lowercase Full Name",
      attributes: {
        values: [
          {
            type: "lower",
            attributes: {
              input: {
                type: "normalizeNames",
                attributes: {
                  input: {
                    type: "identityAttribute",
                    attributes: { name: "givenName" },
                  },
                },
              },
            },
          },
          ".",
          {
            type: "lower",
            attributes: {
              input: {
                type: "normalizeNames",
                attributes: {
                  input: {
                    type: "identityAttribute",
                    attributes: { name: "sn" },
                  },
                },
              },
            },
          },
        ],
      },
    },
  },

  // ── 6. Lookup country code → region label ───────────────────────────────
  {
    pattern_name: "Lookup country code to region label",
    description:
      "Maps a 2-letter ISO country code from an HR source to a human-readable region label (AMER, EMEA, APAC, etc.). Uses lookup with a table of known codes and a 'default' fallback.",
    keywords: ["lookup", "country", "region", "amer", "emea", "apac", "map code", "country code to region"],
    example_transform: {
      type: "lookup",
      name: "Country to Region",
      attributes: {
        table: {
          US: "AMER", CA: "AMER", MX: "AMER",
          GB: "EMEA", DE: "EMEA", FR: "EMEA", IN: "EMEA",
          AU: "APAC", JP: "APAC", SG: "APAC",
          default: "UNKNOWN",
        },
        input: {
          type: "accountAttribute",
          attributes: { sourceName: "HR Source", attributeName: "countryCode" },
        },
      },
    },
  },

  // ── 7. Email from first.last@domain ─────────────────────────────────────
  {
    pattern_name: "Email from first dot last at domain",
    description:
      "Builds an email address from givenName + '.' + sn + '@domain.com'. Uses concat with identityAttribute sources and a static domain literal. Lowercases both name parts.",
    keywords: ["email", "concat", "first name last name", "firstname.lastname", "email address", "build email"],
    example_transform: {
      type: "concat",
      name: "First Last Email Address",
      attributes: {
        values: [
          {
            type: "lower",
            attributes: {
              input: { type: "identityAttribute", attributes: { name: "givenName" } },
            },
          },
          ".",
          {
            type: "lower",
            attributes: {
              input: { type: "identityAttribute", attributes: { name: "sn" } },
            },
          },
          "@",
          {
            type: "static",
            attributes: { value: "example.com" },
          },
        ],
      },
    },
  },

  // ── 8. Date compare lifecycle state ─────────────────────────────────────
  {
    pattern_name: "Date compare lifecycle state",
    description:
      "Compares today ('now') against an identity's termination date. If today is before the termination date, the identity is active; otherwise it is terminated. Uses dateCompare with operator LT.",
    keywords: ["date compare", "lifecycle", "termination", "expiry", "active", "terminated", "before after date"],
    example_transform: {
      type: "dateCompare",
      name: "Lifecycle State from Termination Date",
      attributes: {
        firstDate: "now",
        secondDate: {
          type: "dateFormat",
          attributes: {
            inputFormat: "EPOCH_TIME_JAVA",
            outputFormat: "ISO8601",
            input: {
              type: "accountAttribute",
              attributes: { sourceName: "HR Source", attributeName: "terminationDate" },
            },
          },
        },
        operator: "LT",
        positiveCondition: "active",
        negativeCondition: "terminated",
      },
    },
  },

  // ── 9. Phone number E.164 normalisation ─────────────────────────────────
  {
    pattern_name: "Phone number E164 normalisation",
    description:
      "Normalises a phone number from an account attribute into E.164 international format (e.g. +12125551234). The defaultRegion ensures country-code insertion for numbers without an explicit country prefix.",
    keywords: ["phone", "e164", "e.164", "international", "normalize phone", "phone format", "mobile"],
    example_transform: {
      type: "e164phone",
      name: "Normalise Phone Number",
      attributes: {
        defaultRegion: "US",
        input: {
          type: "accountAttribute",
          attributes: { sourceName: "HR Source", attributeName: "mobilePhone" },
        },
      },
    },
  },

  // ── 10. Split and extract domain from email ──────────────────────────────
  {
    pattern_name: "Split extract domain from email",
    description:
      "Extracts the domain part from an email address by splitting on '@' and returning the second segment (index 1). Uses split with delimiter='@' and index=1.",
    keywords: ["split", "extract domain", "email domain", "domain from email", "after @"],
    example_transform: {
      type: "split",
      name: "Extract Email Domain",
      attributes: {
        delimiter: "@",
        index: 1,
        input: {
          type: "identityAttribute",
          attributes: { name: "email" },
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function suggestPattern(description: string): {
  pattern_name: string;
  description: string;
  example_transform: any;
  other_matches: string[];
} {
  const lower = description.toLowerCase();
  const scored = PATTERNS.map((p) => {
    const hit = p.keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
    return { pattern: p, score: hit };
  })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0]?.pattern ?? PATTERNS[0]!;
  const others = scored.slice(1, 4).map((r) => r.pattern.pattern_name);

  return {
    pattern_name: best.pattern_name,
    description: best.description,
    example_transform: best.example_transform,
    other_matches: others,
  };
}

export function listPatterns(): Array<{ pattern_name: string; description: string }> {
  return PATTERNS.map((p) => ({
    pattern_name: p.pattern_name,
    description: p.description,
  }));
}

export function getPattern(name: string): NamedPattern | undefined {
  return PATTERNS.find((p) => p.pattern_name.toLowerCase() === name.toLowerCase());
}
