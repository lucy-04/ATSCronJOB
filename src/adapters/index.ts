import type { Ats, CompanyAdapter, Provider, QueryAdapter } from "../core/types.js";
import { greenhouseAdapter } from "./greenhouse.js";

// Company ATS adapters, keyed by ATS. Others (lever, ashby, …) register here.
const companyRegistry: Partial<Record<Ats, CompanyAdapter>> = {
  greenhouse: greenhouseAdapter,
};

// Aggregator query adapters, keyed by provider. Adzuna registers in Task 2.
const queryRegistry: Partial<Record<Provider, QueryAdapter>> = {};

export function getCompanyAdapter(ats: Ats): CompanyAdapter {
  const adapter = companyRegistry[ats];
  if (!adapter) throw new Error(`No adapter registered for ATS "${ats}"`);
  return adapter;
}

export function supportedAtses(): Ats[] {
  return Object.keys(companyRegistry) as Ats[];
}

export function getQueryAdapter(provider: Provider): QueryAdapter {
  const adapter = queryRegistry[provider];
  if (!adapter) throw new Error(`No adapter registered for provider "${provider}"`);
  return adapter;
}

export function supportedProviders(): Provider[] {
  return Object.keys(queryRegistry) as Provider[];
}

export { queryRegistry };
