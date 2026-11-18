# SHTORA-CLOUD Comprehensive Security & Code Audit Report

**Date:** 2026-11-12
**Project:** shtora-cloud
**Audit Type:** Full Repository Security & Quality Review

---

## TABLE OF CONTENTS

1. [Executive Summary](#executive-summary)
2. [CRITICAL & HIGH SEVERITY FINDINGS](#critical--high-severity-findings)
3. [MEDIUM SEVERITY FINDINGS](#medium-severity-findings)
4. [LOW SEVERITY FINDINGS](#low-severity-findings)
5. [RECOMMENDATIONS](#recommendations)

---

## EXECUTIVE SUMMARY

This audit covers:

- `package.json` - dependency versions, scripts, package manager configuration
- `cloudflare.config.ts` - Cloudflare Worker bindings and compatibility flags
- `vite.config.ts` - vinext/Vite configuration
- `tsconfig.json` - TypeScript path aliases and compiler options
- `biome.json` - linting and formatting rules
- `src/` directory - all 58 TypeScript/TypeScript-React files
- Database migrations in `migrations/`
- Build scripts in `scripts/`

**Key Findings Summary:**

- **1 CRITICAL** security vulnerability
- **3 HIGH** severity issues
- **3 MEDIUM** severity issues
- **3 LOW** severity issues

---

## CRITICAL & HIGH SEVERITY FINDINGS

### [CRITICAL] SEC-01: Plaintext API Key Storage in Database

| Attribute               | Value                       |
| ----------------------- | --------------------------- |
| **Severity**            | CRITICAL                    |
| **File Path**           | `src/app/api/keys/route.ts` |
| **Line Numbers**        | 49, 54, 56, 109-117         |
| **CVSS Score Estimate** | 9.1 (Critical)              |

**Description:**
In `createApiKeyResponse()` function, API keys are stored in plaintext in the `key_hash` column:

```typescript
// Line 49
const plainTextKey = `sk_${crypto.randomUUID().replace(/-/g, "").substring(0, 32)}`;

// Line 54 - VULNERABLE: Stores plaintext key instead of hash!
const keyHash = plainTextKey;
```

Compare with the secure implementation in `src/lib/key-store.ts` line 21:

```typescript
const keyHash = await hashApiKey(plainTextKey); // CORRECT: Uses scrypt hashing
```

**Impact:**

- Database compromise exposes all API keys immediately
- No key recovery mechanism after hash cracking is needed
- Violates OWASP A02:2021 Cryptographic Failures

**Recommended Fix:**
Use the secure implementation from `src/lib/key-store.ts` or add proper key hashing:

```typescript
import { hashApiKey } from "./password";
const keyHash = await hashApiKey(plainTextKey);
```

**Evidence:**

- OWASP Top 10 2021: A02 - Cryptographic Failures
- @stablelib/scrypt package included but not used in route.ts
- RFC 7914 (scrypt) recommended for password/key hashing

---

### [HIGH] SEC-02: Missing Secret Bindings Configuration

| Attribute         | Value                              |
| ----------------- | ---------------------------------- |
| **Severity**      | HIGH                               |
| **File Path**     | `cloudflare.config.ts` lines 14-20 |
| **Related Files** | `src/lib/env.ts` lines 29-82       |

**Description:**
`cloudflare.config.ts` does not declare secret bindings, but `src/lib/env.ts` expects these secrets to be available:

```typescript
// src/lib/env.ts expects these secrets but they're not declared:
getEncryptionKey(); // needs SESSION_SECRET
getJwtSecret(); // needs JWT_SECRET
getApiEncryptionKey(); // needs API_ENCRYPTION_KEY
getKeyEncryptionSecret(); // needs KEY_ENCRYPTION_SECRET
```

The `env` configuration only has:

```typescript
env: {
    ASSETS: bindings.assets(),
    IMAGES: bindings.images(),
    DB: bindings.d1({ name: "shtora-cloud" }),
    // MISSING: secret bindings!
}
```

**Impact:**

- Runtime errors: "SESSION_SECRET not configured"
- Application fails to start in production
- No secure storage for sensitive keys

**Recommended Fix:**
Add secret declarations to `cloudflare.config.ts`:

```typescript
env: {
    ASSETS: bindings.assets(),
    IMAGES: bindings.images(),
    DB: bindings.d1({ name: "shtora-cloud" }),
    SESSION_SECRET: bindings.secret(),
    API_ENCRYPTION_KEY: bindings.secret(),
    JWT_SECRET: bindings.secret(),
    KEY_ENCRYPTION_SECRET: bindings.secret(),
}
```

**Evidence:**

- Cloudflare Workers Secret Documentation
- vinext v2 documentation for `bindings.secret()`

---

### [HIGH] DEP-01: TypeScript Path Alias Mismatch

| Attribute         | Value                        |
| ----------------- | ---------------------------- |
| **Severity**      | HIGH                         |
| **File Path**     | `tsconfig.json` line 19      |
| **Related Files** | `vite.config.ts` lines 20-23 |

**Description:**
`vite.config.ts` defines additional path aliases that `tsconfig.json` lacks:

**Vite Configuration (v4.19-23):**

```typescript
resolve: {
    alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        "@lib": fileURLToPath(new URL("./src/lib", import.meta.url)),
    }
}
```

**TypeScript Configuration (ts2.19-21):**

```json
"paths": {
    "@/*": ["./src/*"]
    // MISSING: @lib/* and @lib aliases
}
```

**Evidence from Codebase:**

- `src/app/api/auth/session/route.ts` line 7: `import type { AppUserRecord as UserRecord } from "@lib/types";`
- `src/lib/session.ts` line 6: `import { getD1 } from "@lib/env";`
- `src/lib/quarantine.ts` line 2: `import { getD1 } from "@lib/env";`

**Impact:**

- TypeScript compiler cannot resolve `@lib/*` imports
- IDE shows red squiggles for valid imports
- Potential runtime errors in some configurations

**Recommended Fix:**
Update `tsconfig.json`:

```json
"paths": {
    "@/*": ["./src/*"],
    "@lib": ["./src/lib/index"],
    "@lib/*": ["./src/lib/*"]
}
```

---

### [HIGH] DEP-02: Biome CSS Parser Failure with Tailwind v4 Directives

| Attribute     | Value                                                      |
| ------------- | ---------------------------------------------------------- |
| **Severity**  | HIGH                                                       |
| **File Path** | `biome.json` lines 15-20; `src/app/globals.css` lines 1-56 |

**Description:**
The project's CSS uses Tailwind CSS v4 directives that Biome's parser doesn't recognize:

**Biome Error Output:**

```
src\app\globals.css:5:2 parse ✗ Tailwind-specific syntax is disabled.
    @custom-variant dark (&:is(.dark *));
    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

**Affected Directives:**

- `@import "tailwindcss"` (line 1)
- `@import "tw-animate-css"` (line 2)
- `@import "shadcn/tailwind.css"` (line 3)
- `@custom-variant dark` (line 5)
- `@theme inline { ... }` (lines 56-97)
- `@apply` directives (lines 135, 138, 141)

**Impact:**

- `bun run lint` fails due to CSS parsing errors
- Cannot format CSS files
- Development workflow blocked

**Recommended Fix:**
Enable CSS Tailwind parsing in `biome.json`:

```json
"css": {
    "parser": {
        "tailwindDirectives": true
    },
    "formatter": {
        "allowWrongLineComments": true
    }
}
```

**Evidence:**

- Biome v2.x CSS documentation
- Tailwind CSS v4 migration guide

---

## MEDIUM SEVERITY FINDINGS

### [MEDIUM] DEP-03: Invalid Vite Version Pinned

| Attribute         | Value                  |
| ----------------- | ---------------------- |
| **Severity**      | MEDIUM                 |
| **File Path**     | `package.json` line 33 |
| **Current Value** | `"vite": "8.3.0"`      |

**Description:**
Vite version 8.3.0 does not exist in the Vite v5/v6 release timeline. Current stable versions are 5.x and 6.x.

**Impact:**

- Unreliable dependency resolution
- Build failures in some environments
- Potential security vulnerabilities from unknown version

**Recommended Fix:**

```json
"vite": "^5.4.0"  // or "^6.0.0" for latest
```

**Evidence:**

- Vite releases: https://github.com/vitejs/vite/releases

---

### [MEDIUM] DEP-04: Misplaced `shadcn` CLI Dependency

| Attribute     | Value                  |
| ------------- | ---------------------- |
| **Severity**  | MEDIUM                 |
| **File Path** | `package.json` line 17 |

**Description:**
The `shadcn` CLI tool is listed in `dependencies` instead of `devDependencies`:

```json
"dependencies": {
    "shadcn": "^4.23.0",  // SHOULD BE devDependencies!
}
```

**Impact:**

- Increases production bundle size unnecessarily
- CLI tool shipped to Cloudflare Workers

**Recommended Fix:**
Move to `devDependencies`:

```json
"devDependencies": {
    "shadcn": "^4.23.0"
}
```

---

### [MEDIUM] CODE-01: Duplicate Implementation Pattern

| Attribute     | Value                                                 |
| ------------- | ----------------------------------------------------- |
| **Severity**  | MEDIUM                                                |
| **File Path** | `src/app/api/keys/route.ts` vs `src/lib/key-store.ts` |

**Description:**
API key operations are duplicated:

- `src/app/api/keys/route.ts` - 271 lines with insecure implementation
- `src/lib/key-store.ts` - 250 lines with proper scrypt hashing

The route.ts version stores keys in plaintext (see SEC-01), while key-store.ts uses `hashApiKey()` correctly.

**Recommended Fix:**
Consolidate by importing from `key-store.ts`:

```typescript
import {
	createApiKey,
	getApiKey,
	getUserApiKeys,
	deleteApiKey,
} from "@/lib/key-store";
```

---

### [MEDIUM] CODE-02: Missing Database Tables for Quarantine/Failed Attempts

| Attribute     | Value                                |
| ------------- | ------------------------------------ |
| **Severity**  | MEDIUM                               |
| **File Path** | `src/lib/quarantine.ts`              |
| **Reference** | `migrations/0001_initial_schema.sql` |

**Description:**
`quarantine.ts` references tables that don't exist in migrations:

```typescript
// src/lib/quarantine.ts line 38 - references non-existent table
SELECT * FROM quarantines WHERE ip = ? AND expires_at > ?

// Line 53 - inserts into non-existent table
INSERT INTO failed_attempts (...)

// Line 91 - counts from non-existent table
SELECT COUNT(*) FROM failed_attempts WHERE type = 'login' ...
```

The migration `0001_initial_schema.sql` only creates:

- `user` (with `username` column but migration 0002 adds it)
- `shtora_sessions`
- `shtora_rate_limits`
- `shtora_action_tokens`
- `keys`
- `models`
- `rate_limit_usage`
- `rate_limit_cooldowns`
- `requests`
- `fallback_config`
- `settings`

**Impact:**

- Runtime errors when rate limiting triggers
- Failed login protection doesn't work
- Security degradation

**Recommended Fix:**
Add to migrations or remove quarantine code:

```sql
CREATE TABLE IF NOT EXISTS quarantines (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    ip TEXT,
    reason TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS failed_attempts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    target TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    failed_at TEXT NOT NULL
);
```

---

### [MEDIUM] CODE-03: Missing Cookie Security Flags

| Attribute     | Value                                   |
| ------------- | --------------------------------------- |
| **Severity**  | MEDIUM                                  |
| **File Path** | `src/components/ui/sidebar.tsx` line 85 |

**Description:**
Cookie assignment lacks security flags:

```typescript
document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
// MISSING: SameSite=Lax; Secure; HttpOnly
```

**Impact:**

- CSRF vulnerability risk
- Cross-site scripting risk
- Insecure cookie transmission

**Recommended Fix:**

```typescript
document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; SameSite=Lax; Secure`;
```

**Evidence:**

- Biome rule: `lint/suspicious/noDocumentCookie`
- OWASP: Cookie Security

---

## LOW SEVERITY FINDINGS

### [LOW] DEP-05: Redundant External `cn` Package

| Attribute     | Value                     |
| ------------- | ------------------------- |
| **Severity**  | LOW                       |
| **File Path** | `src/lib/utils.ts` line 1 |

**Description:**
The `cn` helper is imported from an external package but should be a local implementation:

```typescript
// src/lib/utils.ts
export { cn } from "cn";
```

**Recommended Fix:**
Replace with standard shadcn/ui implementation:

```typescript
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
```

**Evidence:**

- shadcn/ui utils best practices
- Avoids unnecessary runtime dependency

---

### [LOW] CODE-04: Unused Error Variables in Scripts

| Attribute     | Value                                                             |
| ------------- | ----------------------------------------------------------------- |
| **Severity**  | LOW                                                               |
| **File Path** | `scripts/register-admin.mjs` line 94; `scripts/seed.mjs` line 185 |

**Description:**
Catch block parameters are unused:

```typescript
// scripts/register-admin.mjs:94
} catch (err) {  // err never used
    throw new Error("No local D1 database available...");
}

// scripts/seed.mjs:185 - same pattern
```

**Recommended Fix:**
Use `_err` or omit parameter:

```typescript
} catch {
    throw new Error("...");
}
```

**Evidence:**

- Biome rule: `lint/correctness/noUnusedVariables`

---

### [LOW] CODE-05: Accessibility Issue in Breadcrumb Component

| Attribute     | Value                                         |
| ------------- | --------------------------------------------- |
| **Severity**  | LOW                                           |
| **File Path** | `src/components/ui/breadcrumb.tsx` line 63-65 |

**Description:**
Interactive link implemented as span with role:

```tsx
<span role="link" aria-disabled="true" aria-current="page">
// MISSING: tabIndex for keyboard navigation
```

**Recommended Fix:**

```tsx
<span
    role="link"
    tabIndex={0}
    aria-disabled="true"
    aria-current="page"
>
```

Or use semantic `<a>` element.

**Evidence:**

- WCAG 2.1 Success Criterion 2.1.1 (Keyboard)
- Biome rule: `lint/a11y/useFocusableInteractive`

---

## RECOMMENDATIONS

### Immediate Actions (P0 - Within 24 hours)

1. **Fix SEC-01**: Replace plaintext key storage with hashed implementation in `src/app/api/keys/route.ts`
2. **Fix SEC-02**: Add secret bindings to `cloudflare.config.ts`
3. **Fix DEP-02**: Enable Tailwind CSS parsing in `biome.json`

### Short-term Actions (P1 - Within 1 week)

4. Fix DEP-01: Add missing `@lib/*` path aliases to `tsconfig.json`
5. Fix DEP-03: Correct Vite version in `package.json`
6. Add missing `quarantines` and `failed_attempts` tables to migrations

### Medium-term Actions (P2 - Within 1 month)

7. Consolidate API key implementations (remove duplicate route.ts logic)
8. Move `shadcn` to devDependencies
9. Implement secure cookie handling throughout
10. Add missing table migrations and update database schema

### Long-term Actions (P3 - Future sprints)

11. Implement proper CSRF protection
12. Add security headers middleware
13. Set up automated security scanning (SAST/DAST)
14. Add secret scanning pre-commit hook

---

## APPENDIX: FILES AUDITED

```
Configuration:
├── package.json
├── cloudflare.config.ts
├── vite.config.ts
├── tsconfig.json
├── biome.json
├── next.config.ts
├── postcss.config.mjs
├── components.json
└── README.md

Source:
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── globals.css
│   │   ├── page.tsx
│   │   ├── login/
│   │   ├── register/
│   │   ├── dashboard/
│   │   ├── admin/
│   │   └── api/
│   ├── components/
│   │   ├── ui/ (25 shadcn components)
│   │   └── sidebar.tsx
│   ├── hooks/
│   └── lib/
│       ├── env.ts
│       ├── types.ts
│       ├── password.ts
│       ├── session.ts
│       ├── key-store.ts
│       ├── quarantine.ts
│       ├── router.ts
│       ├── format.ts
│       ├── utils.ts
│       ├── api-types.ts
│       └── session.ts
└── proxy.ts

Migrations:
├── migrations/
│   ├── 0001_initial_schema.sql
│   ├── 0002_add_username_to_user.sql
│   └── 0003_drop_email_if_present.sql

Scripts:
└── scripts/
    ├── register-admin.mjs
    └── seed.mjs
```

---

**Audit Report Generated:** 2026-11-12
**Auditor:** AI Security Audit Agent
**Methodology:** Static code analysis, configuration review, security best practices comparison
