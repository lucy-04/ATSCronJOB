import type { Adapter, Ats } from "../core/types.js";
import { greenhouseAdapter } from "./greenhouse.js";

// Registry of implemented adapters, keyed by ATS. Additional adapters
// (lever, ashby, smartrecruiters, workable, workday) are registered here as
// they land in later phases.
const registry: Partial<Record<Ats, Adapter>> = {
  greenhouse: greenhouseAdapter,
};

export function getAdapter(ats: Ats): Adapter {
  const adapter = registry[ats];
  if (!adapter) {
    throw new Error(`No adapter registered for ATS "${ats}"`);
  }
  return adapter;
}

export function supportedAtses(): Ats[] {
  return Object.keys(registry) as Ats[];
}
