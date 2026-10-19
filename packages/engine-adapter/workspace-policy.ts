export type WindowsWorkspaceSandbox = "unelevated" | "elevated" | "mxc";

export const WORKSPACE_PERMISSION_PROFILE_ID = "forgedesk_workspace_v1";
export const WORKSPACE_PERMISSION_PROFILE = Object.freeze({
  extends: ":workspace",
  filesystem: Object.freeze({ ":tmpdir": "read", ":slash_tmp": "read" }),
  network: Object.freeze({ enabled: false }),
});

const PROFILE_TOML = 'permissions.forgedesk_workspace_v1={extends=":workspace",filesystem={":tmpdir"="read",":slash_tmp"="read"},network={enabled=false}}';

export function workspacePolicyConfigArgs(options: { windowsSandbox?: WindowsWorkspaceSandbox } = {}): string[] {
  if (options.windowsSandbox !== undefined && !["unelevated", "elevated", "mxc"].includes(options.windowsSandbox)) {
    throw new Error("Unsupported Windows workspace sandbox");
  }
  return [
    "-c", 'approval_policy="on-request"', "-c", 'approvals_reviewer="user"',
    "-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.writable_roots=[]",
    "-c", "sandbox_workspace_write.network_access=false", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c", "sandbox_workspace_write.exclude_slash_tmp=true", "-c", 'cli_auth_credentials_store="file"',
    "-c", "analytics.enabled=false",
    "-c", `default_permissions="${WORKSPACE_PERMISSION_PROFILE_ID}"`, "-c", PROFILE_TOML,
    ...(options.windowsSandbox === undefined ? [] : ["-c", `windows.sandbox="${options.windowsSandbox}"`]),
  ];
}

export function workspaceSandboxArgs(mode: WindowsWorkspaceSandbox = "unelevated"): string[] {
  return [...workspacePolicyConfigArgs({ windowsSandbox: mode }), "sandbox", "--include-managed-config",
    "--permission-profile", WORKSPACE_PERMISSION_PROFILE_ID, "--"];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: unknown, expected: unknown): boolean {
  if (!record(expected)) return value === expected;
  if (!record(value)) return false;
  const keys = Object.keys(expected);
  return Object.keys(value).length === keys.length && keys.every((key) =>
    Object.hasOwn(value, key) && exact(value[key], expected[key]));
}

function omitKnownNulls(value: unknown, keys: readonly string[]): unknown {
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key, field]) => field !== null || !keys.includes(key)));
}

function exactProfile(value: unknown): boolean {
  const profile = omitKnownNulls(value, ["description", "workspace_roots"]);
  if (!record(profile)) return false;
  // The pinned config/read serializes these schema-defined Option fields as
  // null. Unknown fields, or non-null optional values, must still be rejected.
  const filesystem = omitKnownNulls(profile.filesystem, ["glob_scan_max_depth"]);
  const network = omitKnownNulls(profile.network, ["proxy_url", "enable_socks5", "socks_url", "enable_socks5_udp",
    "allow_upstream_proxy", "dangerously_allow_non_loopback_proxy", "dangerously_allow_all_unix_sockets",
    "mode", "domains", "unix_sockets", "allow_local_binding", "mitm"]);
  return exact({ ...profile, filesystem, network }, WORKSPACE_PERMISSION_PROFILE);
}

export function assertWorkspacePolicyConfig(config: unknown): void {
  if (!record(config) || config.approval_policy !== "on-request" || config.sandbox_mode !== "workspace-write" ||
    config.approvals_reviewer !== "user") {
    throw new Error("Effective engine policy does not match the product policy");
  }
  const workspace = config.sandbox_workspace_write;
  if (!record(workspace) || workspace.network_access !== false || workspace.exclude_tmpdir_env_var !== true ||
    workspace.exclude_slash_tmp !== true || !Array.isArray(workspace.writable_roots) || workspace.writable_roots.length !== 0) {
    throw new Error("Effective engine workspace sandbox does not match the product policy");
  }
  // CLI tables merge across layers. Checking only the supplied flags would miss
  // extra grants inherited from an ambient profile with the same name.
  if (config.default_permissions !== WORKSPACE_PERMISSION_PROFILE_ID || !record(config.permissions) ||
    !Object.hasOwn(config.permissions, WORKSPACE_PERMISSION_PROFILE_ID) ||
    !exactProfile(config.permissions[WORKSPACE_PERMISSION_PROFILE_ID])) {
    throw new Error("Effective engine permission profile is not the fixed no-temp workspace policy");
  }
}

export function assertWorkspacePolicyRequirements(requirements: unknown): void {
  if (requirements === null) return;
  if (!record(requirements)) throw new Error("Engine returned invalid config requirements");
  const allowed = requirements.allowedPermissionProfiles;
  if (allowed !== undefined && allowed !== null && (!record(allowed) ||
    !Object.hasOwn(allowed, WORKSPACE_PERMISSION_PROFILE_ID) || allowed[WORKSPACE_PERMISSION_PROFILE_ID] !== true)) {
    throw new Error("Managed policy disallows the fixed workspace permission profile");
  }
  const selected = requirements.defaultPermissions;
  if (selected !== undefined && selected !== null && selected !== WORKSPACE_PERMISSION_PROFILE_ID) {
    throw new Error("Managed default permission profile conflicts with the fixed workspace policy");
  }
}
