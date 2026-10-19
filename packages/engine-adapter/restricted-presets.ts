export const RESTRICTED_HARDWARE_TOOLS = Object.freeze([
  "embedded_status", "embedded_build", "embedded_inspect", "embedded_request_flash", "embedded_verify", "embedded_export",
] as const);
export const RESTRICTED_FZ3B_TOOLS = Object.freeze([
  "fz3b_status", "fz3b_build", "fz3b_inspect", "fz3b_request_semantic", "fz3b_semantic", "fz3b_export",
] as const);
export type RestrictedPreset = "stm32" | "fz3b";
export type RestrictedHardwareToolName = typeof RESTRICTED_HARDWARE_TOOLS[number];
export type RestrictedFz3bToolName = typeof RESTRICTED_FZ3B_TOOLS[number];
export type RestrictedToolName = RestrictedHardwareToolName | RestrictedFz3bToolName;
export type PresetToolName<P extends RestrictedPreset> = P extends "fz3b" ? RestrictedFz3bToolName : RestrictedHardwareToolName;

const descriptions: Readonly<Record<RestrictedToolName, string>> = Object.freeze({
  embedded_status: "Read the host-owned embedded run state. No parameters.",
  embedded_build: "Request the fixed trusted firmware build. No parameters or source editing.",
  embedded_inspect: "Request the host-bound read-only target identity check. No parameters.",
  embedded_request_flash: "Request native user confirmation for the host-bound artifact and board. This does not grant flash authorization itself. No parameters.",
  embedded_verify: "Request the fixed host-bound verification after an authorized flash. No parameters.",
  embedded_export: "Request the bounded host-owned evidence export. No parameters.",
  fz3b_status: "Read cached host-owned FZ3B run state. This does not connect to the board. No parameters.",
  fz3b_build: "Build and validate the fixed trusted FZ3B application resources. No source editing or PL programming. No parameters.",
  fz3b_inspect: "Request the fixed authenticated FZ3B readiness inspection. No arbitrary host, command, path, or device input. No parameters.",
  fz3b_request_semantic: "Request separate native operator consent for the fixed bounded text/image semantic run and its explicit existing-runtime effects. A model request is not authorization. No parameters.",
  fz3b_semantic: "Request the one-use host-bound semantic run only after native consent. It replaces query state, may re-load the same approved candidate008 bitstream and its dedicated clock/lease/R5/device state, and writes the fixed operation audit. It is not read-only and never authorizes a new PL candidate. No parameters.",
  fz3b_export: "Export the fixed host-owned FZ3B evidence and its explicit acceptance limits. No parameters.",
});

export function presetTools(preset: RestrictedPreset): readonly RestrictedToolName[] {
  if (preset === "stm32") return RESTRICTED_HARDWARE_TOOLS;
  if (preset === "fz3b") return RESTRICTED_FZ3B_TOOLS;
  throw new Error("Unknown restricted tool preset");
}

export function presetToolSpecs(preset: RestrictedPreset): Record<string, unknown>[] {
  return presetTools(preset).map(name => ({ type: "function", name, description: descriptions[name],
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } }));
}
