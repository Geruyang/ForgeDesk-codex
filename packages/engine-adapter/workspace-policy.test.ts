import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWorkspacePolicyConfig, assertWorkspacePolicyRequirements, WORKSPACE_PERMISSION_PROFILE,
  WORKSPACE_PERMISSION_PROFILE_ID, workspacePolicyConfigArgs, workspaceSandboxArgs,
} from "./workspace-policy";

function config(): Record<string, any> {
  return {
    approval_policy: "on-request", approvals_reviewer: "user", sandbox_mode: "workspace-write",
    sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
    default_permissions: WORKSPACE_PERMISSION_PROFILE_ID,
    permissions: { [WORKSPACE_PERMISSION_PROFILE_ID]: structuredClone(WORKSPACE_PERMISSION_PROFILE) },
  };
}

test("app-server and sandbox use the same fixed profile while preserving legacy restrictions", () => {
  const common = workspacePolicyConfigArgs({ windowsSandbox: "unelevated" });
  const args = workspaceSandboxArgs();
  assert.deepEqual(args.slice(0, common.length), common);
  assert.deepEqual(args.slice(common.length), ["sandbox", "--include-managed-config", "--permission-profile", WORKSPACE_PERMISSION_PROFILE_ID, "--"]);
  for (const setting of ['approval_policy="on-request"', 'approvals_reviewer="user"', 'sandbox_mode="workspace-write"',
    "sandbox_workspace_write.writable_roots=[]", "sandbox_workspace_write.network_access=false",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true", "sandbox_workspace_write.exclude_slash_tmp=true",
    'cli_auth_credentials_store="file"', "analytics.enabled=false"]) assert.ok(args.includes(setting));
  assert.ok(args.includes(`default_permissions="${WORKSPACE_PERMISSION_PROFILE_ID}"`));
  assert.ok(args.includes('permissions.forgedesk_workspace_v1={extends=":workspace",filesystem={":tmpdir"="read",":slash_tmp"="read"},network={enabled=false}}'));
  for (const mode of ["unelevated", "elevated", "mxc"] as const) {
    assert.ok(workspaceSandboxArgs(mode).includes(`windows.sandbox="${mode}"`));
  }
  assert.throws(() => workspaceSandboxArgs("disabled" as any), /Unsupported/);
  args.push("tampered");
  assert.ok(!workspaceSandboxArgs().includes("tampered"));
  assert.equal(Object.isFrozen(WORKSPACE_PERMISSION_PROFILE.filesystem), true);
});

test("merged policy accepts only the selected closed profile without ambient extra grants", () => {
  assert.doesNotThrow(() => assertWorkspacePolicyConfig(config()));
  const unrelated = config();
  unrelated.permissions.inactive_profile = { filesystem: { ":root": "write" } };
  assert.doesNotThrow(() => assertWorkspacePolicyConfig(unrelated));
  const mutations = [
    (value: any) => { delete value.default_permissions; },
    (value: any) => { value.default_permissions = ":workspace"; },
    (value: any) => { delete value.permissions; },
    (value: any) => { value.permissions[WORKSPACE_PERMISSION_PROFILE_ID] = null; },
    (value: any) => { value.permissions[WORKSPACE_PERMISSION_PROFILE_ID].extends = ":danger-full-access"; },
    (value: any) => { value.permissions[WORKSPACE_PERMISSION_PROFILE_ID].filesystem[":tmpdir"] = "write"; },
    (value: any) => { value.permissions[WORKSPACE_PERMISSION_PROFILE_ID].filesystem[":slash_tmp"] = "write"; },
    (value: any) => { value.permissions[WORKSPACE_PERMISSION_PROFILE_ID].filesystem["C:/ambient-extra-root"] = "write"; },
    (value: any) => { value.permissions[WORKSPACE_PERMISSION_PROFILE_ID].filesystem[":workspace_roots"] = "write"; },
    (value: any) => { value.permissions[WORKSPACE_PERMISSION_PROFILE_ID].workspace_roots = { "C:/ambient-extra-root": true }; },
    (value: any) => { value.permissions[WORKSPACE_PERMISSION_PROFILE_ID].network.enabled = true; },
    (value: any) => { value.permissions[WORKSPACE_PERMISSION_PROFILE_ID].network.allow_local_binding = true; },
    (value: any) => { value.permissions[WORKSPACE_PERMISSION_PROFILE_ID].description = "ambient merged field"; },
  ];
  for (const mutate of mutations) {
    const value = config(); mutate(value);
    assert.throws(() => assertWorkspacePolicyConfig(value), /fixed no-temp workspace policy/);
  }
});

test("legacy fields are still independently validated", () => {
  for (const mutate of [
    (value: any) => { value.approval_policy = "never"; },
    (value: any) => { value.approvals_reviewer = "guardian_subagent"; },
    (value: any) => { value.sandbox_mode = "danger-full-access"; },
    (value: any) => { value.sandbox_workspace_write.writable_roots = ["C:/extra"]; },
    (value: any) => { value.sandbox_workspace_write.network_access = true; },
    (value: any) => { value.sandbox_workspace_write.exclude_tmpdir_env_var = false; },
    (value: any) => { value.sandbox_workspace_write.exclude_slash_tmp = false; },
  ]) {
    const value = config(); mutate(value);
    assert.throws(() => assertWorkspacePolicyConfig(value), /product policy/);
  }
});

test("pinned config/read schema nulls are accepted only at their declared locations", () => {
  const value = config();
  const selected = value.permissions[WORKSPACE_PERMISSION_PROFILE_ID];
  selected.description = null;
  selected.workspace_roots = null;
  selected.filesystem.glob_scan_max_depth = null;
  for (const key of ["proxy_url", "enable_socks5", "socks_url", "enable_socks5_udp", "allow_upstream_proxy",
    "dangerously_allow_non_loopback_proxy", "dangerously_allow_all_unix_sockets", "mode", "domains", "unix_sockets",
    "allow_local_binding", "mitm"]) selected.network[key] = null;
  assert.doesNotThrow(() => assertWorkspacePolicyConfig(value));
  for (const table of [selected, selected.filesystem, selected.network]) {
    table.unknown_future_field = null;
    assert.throws(() => assertWorkspacePolicyConfig(value), /fixed no-temp workspace policy/);
    delete table.unknown_future_field;
  }
  for (const [table, key, changed] of [[selected, "description", "non-null"], [selected, "workspace_roots", {}],
    [selected.filesystem, "glob_scan_max_depth", 1], [selected.network, "proxy_url", "http://127.0.0.1"],
    [selected.network, "allow_local_binding", false], [selected.network, "domains", {}]] as const) {
    table[key] = changed;
    assert.throws(() => assertWorkspacePolicyConfig(value), /fixed no-temp workspace policy/);
    table[key] = null;
  }
});

test("managed profile constraints fail closed instead of silently choosing another profile", () => {
  for (const value of [null, {}, { allowedPermissionProfiles: null, defaultPermissions: null },
    { allowedPermissionProfiles: { [WORKSPACE_PERMISSION_PROFILE_ID]: true }, defaultPermissions: WORKSPACE_PERMISSION_PROFILE_ID }]) {
    assert.doesNotThrow(() => assertWorkspacePolicyRequirements(value));
  }
  for (const value of [undefined, [], { allowedPermissionProfiles: [] }, { allowedPermissionProfiles: {} },
    { allowedPermissionProfiles: { ":workspace": true } },
    { allowedPermissionProfiles: { [WORKSPACE_PERMISSION_PROFILE_ID]: false } },
    { allowedPermissionProfiles: { [WORKSPACE_PERMISSION_PROFILE_ID]: "true" } },
    { defaultPermissions: ":workspace" }, { defaultPermissions: 1 }]) {
    assert.throws(() => assertWorkspacePolicyRequirements(value), /requirements|[Mm]anaged/);
  }
});
