// Which models the backend actually serves.
//
// The backend can't answer this per-request: the model id travels inside the body
// we HPKE-encrypt to the enclave, so the only component that can check a model
// before spending anything is this one. The backend's pricing endpoint doubles as
// the catalog — it lists what it can serve and price — and everything here is
// about getting that list, keeping it across restarts, and knowing when it's too
// old to act on.
import { fetchCatalog } from "./relay.js";
import { loadCatalog, saveCatalog } from "./config.js";
import { MODELS, mergeCatalog } from "./defaults.js";

// How long a cached catalog still counts as authoritative. Models are retired on
// the order of months, so a day is generous; past it we keep serving the cache but
// stop rejecting against it, since blocking a valid model is worse than letting a
// dead one through to the error it would have got anyway.
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

// How long to sit on a fallback list before trying the backend again. A cached or
// built-in list is not an answer from the backend, so it must not buy a full TTL of
// silence: a proxy that started while Ankara was down has to recover on its own,
// without re-fetching on every request while it stays down.
export const CATALOG_RETRY_MS = 5 * 60 * 1000;

// Fetch the live catalog, falling back to the last good one and then to the
// built-in list. Returns { models, source, servableIds } where `servableIds` is
// null whenever the list is too old or too unproven to reject a request over —
// callers hand it straight to relay.setServableModels.
//   source: "backend" | "cache" | "builtin"
export async function resolveCatalog(havenApiRoot, { now = Date.now() } = {}) {
  const fetched = await fetchCatalog(havenApiRoot);
  if (fetched.ok) {
    const models = mergeCatalog(fetched.models);
    saveCatalog(fetched.models, now);
    return { models, source: "backend", servableIds: models.map((m) => m.id) };
  }

  const cached = loadCatalog();
  if (cached) {
    const models = mergeCatalog(cached.models);
    const fresh = now - cached.fetchedAt < CATALOG_TTL_MS;
    return { models, source: "cache", servableIds: fresh ? models.map((m) => m.id) : null };
  }

  // Never rejects: the built-in list is an assumption about the backend, not a
  // statement from it, and it is exactly the thing that goes stale.
  return { models: MODELS, source: "builtin", servableIds: null };
}
