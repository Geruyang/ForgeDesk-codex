# T3 Snapshot And Second-User Work

Started: 2026-10-14, Asia/Shanghai. The original H0 remains 13:03; it is not reset. User requested parallel T3 work and explicitly deferred hardware. All artifacts stay in ForgeDesk-codex.

## Scope

- B-level task-owned input snapshot and separate build output for one trusted software template. Existing A-level tasks remain compatible.
- Actual copied inputs, source/config/tool/output manifests, cancellation/recovery and stale-current-workspace behavior.
- Actual write-denial checks for the model sandbox and constrained build process. Hash equality alone is not an input-freezing guarantee.
- A second real Windows user/SID installation regression, with independent official authentication. A new data directory under the current SID is not a second-user test.
- No board, probe, serial, flash or other hardware operations.

## Ownership

| Owner | Model / effort | Responsibility |
| --- | --- | --- |
| Main | Current main session | Contracts, main/preload integration, packaging, human instructions |
| Runner | gpt-6.1-sol / xhigh | Snapshot runner, evidence, recovery, constrained template |
| Engine | gpt-6.1-sol / xhigh | Actual sandbox isolation probe and bounded receipt |
| QA | gpt-6.1-sol / xhigh | Independent input/output isolation and installed regression |
| Desktop | gpt-6.1-sol / high | Snapshot controls, read-only fixed acceptance, B evidence display |
| MCP | gpt-6-sol / high | Build request-key contract and bridge validation |
| Second user | gpt-6.1-sol / high | Authorized per-SID runtime-data DACL preparation, prerequisite inspection, self-contained second-user kit |

The original second-user worker (`gpt-6-sol / high`) stopped after a model capacity error. The replacement worker (`gpt-6.1-sol / high`) took over the same project-owned scripts, documentation, and outputs; the failed observations and original ACL descriptor backup were retained.

## Acceptance Boundaries

T1 version 0.1.0 remains the historical accepted baseline. New T3 work is not accepted until the updated installed application is tested. A trusted supported template is not arbitrary-project support. Snapshot isolation does not claim protection against arbitrary malicious processes under the same Windows account.

Second-user testing needs a human-controlled Windows account and its own official login. Platform sandbox service accounts are excluded. No account creation, ACL changes, elevation or session switching is performed without the applicable user authorization.

The user confirmed an existing second Windows account and will switch/login after the kit is ready. The user additionally authorized restricting only project-owned per-account runtime-data ACLs to the owning SID, SYSTEM and Administrators. Primary app shutdown was confirmed before this change. The shared workspace's inherited Authenticated Users modify access must not be mistaken for operating-system account isolation; data ACL results and actual second-SID checks are recorded separately in SECOND_USER.md.

Follow-up clarification: the reported login email still executed under the original Windows SID 1002, so its Preflight remained BLOCKED. The user then explicitly authorized creation of a separate local standard account. On 2026-10-14, `ForgeDeskTest` (SID ending 1006) was created through a visible elevated helper with a human-entered, unrecorded password. No administrator membership, automatic login, or remote-login configuration was added. Actual second-user application acceptance still requires the new account's interactive desktop and official product login.

Latest reviewed milestone: actual SID 1006 completed independent login, upgraded to 0.2.1 and passed real-model fixed-template B workflow `snapshot-1791984171287`. This closes that software workflow scope, not the entire second-user matrix. Remaining controls, process-owner, missing-tool, cross-account-denial and uninstall checks are listed in `SECOND_USER_RESULT.md`. Hardware stays deferred; earlier failed runs remain preserved.
