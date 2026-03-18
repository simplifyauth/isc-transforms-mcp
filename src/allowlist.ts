import type { McpMode } from "./config.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type AllowRule = {
  method: HttpMethod;
  // simple prefix match for Phase 1
  pathPrefix: string; // e.g. "/v3/transforms"
  modes: McpMode[];   // which modes can call it
};

const RULES: AllowRule[] = [
  // Phase 1: discovery only (readonly)
  { method: "POST", pathPrefix: "/v3/search", modes: ["readonly", "write"] },
  { method: "GET",  pathPrefix: "/v3/transforms", modes: ["readonly", "write"] },
  { method: "GET",  pathPrefix: "/v3/identity-profiles", modes: ["readonly", "write"] },
  { method: "GET",  pathPrefix: "/v3/workflow-library", modes: ["readonly", "write"] },
  { method: "GET",  pathPrefix: "/v3/workflow-executions", modes: ["readonly", "write"] },
  { method: "POST", pathPrefix: "/v3/workflow-executions", modes: ["write"] },
  { method: "GET",  pathPrefix: "/v3/workflows", modes: ["readonly", "write"] },
  // Phase 2: Transforms write path
  { method: "POST", pathPrefix: "/v3/transforms", modes: ["write"] },        // create Docs: https://developer.sailpoint.com/docs/api/v3/create-transform/
  { method: "PUT",  pathPrefix: "/v3/transforms", modes: ["write"] },  // update Docs: https://developer.sailpoint.com/docs/api/v3/update-transform/
  { method: "POST", pathPrefix: "/v3/identity-profiles", modes: ["write"] },
  { method: "PUT",  pathPrefix: "/v3/identity-profiles", modes: ["write"] },
  { method: "PATCH",  pathPrefix: "/v3/identity-profiles", modes: ["write"] },  // update via JSON Patch (Content-Type: application/json-patch+json) // Docs: https://developer.sailpoint.com/docs/api/v3/update-identity-profile/

  { method: "POST", pathPrefix: "/v3/workflows", modes: ["write"] },
  { method: "PUT",  pathPrefix: "/v3/workflows", modes: ["write"] },
  { method: "PATCH", pathPrefix: "/v3/workflows", modes: ["write"] },
  { method: "DELETE", pathPrefix: "/v3/workflows", modes: ["write"] },
  { method: "POST", pathPrefix: "/v3/workflows/execute/external", modes: ["write"] },


// Phase Forms: Custom Forms (v2024)
// Docs: https://developer.sailpoint.com/docs/api/v2024/custom-forms/  (form definitions + form instances)
{ method: "GET",    pathPrefix: "/v2024/form-definitions", modes: ["readonly", "write"] },
{ method: "POST",   pathPrefix: "/v2024/form-definitions", modes: ["write"] }, // create-form-definition
{ method: "PATCH",  pathPrefix: "/v2024/form-definitions", modes: ["write"] }, // patch-form-definition
{ method: "DELETE", pathPrefix: "/v2024/form-definitions", modes: ["write"] }, // delete-form-definition
{ method: "GET",    pathPrefix: "/v2024/form-instances",   modes: ["readonly", "write"] },
{ method: "PATCH",  pathPrefix: "/v2024/form-instances",   modes: ["write"] } // patch-form-instance


];

export function isAllowed(mode: McpMode, method: HttpMethod, path: string): boolean {
  return RULES.some(r => {
    if (r.method !== method || !r.modes.includes(mode)) return false;
    if (!path.startsWith(r.pathPrefix)) return false;
    // Ensure prefix is followed by end-of-string, '/', or '?' to prevent
    // matching unintended paths (e.g. /v3/transforms-evil matching /v3/transforms)
    const rest = path.slice(r.pathPrefix.length);
    return rest === "" || rest[0] === "/" || rest[0] === "?";
  });
}

export function getAllowlist(): AllowRule[] {
  return RULES;
}
