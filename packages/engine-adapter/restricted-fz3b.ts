import { RestrictedHardwareAdapter, type RestrictedHardwareAdapterOptions } from "./restricted-hardware";
export { RESTRICTED_FZ3B_TOOLS, type RestrictedFz3bToolName } from "./restricted-presets";
export type { RestrictedHardwareToolContext as RestrictedFz3bToolContext } from "./restricted-hardware";
export type RestrictedFz3bAdapterOptions = Omit<RestrictedHardwareAdapterOptions<"fz3b">, "preset">;

/** Host-selected, immutable FZ3B inventory. No caller-supplied tool definitions. */
export class RestrictedFz3bAdapter extends RestrictedHardwareAdapter<"fz3b"> {
  constructor(options: RestrictedFz3bAdapterOptions) { super({ ...options, preset: "fz3b" }); }
}
