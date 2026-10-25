// Discovery for the public Aromatory. The registry is one static JSON file in
// the opensmell-web repository; authors keep hosting their own manifests. There
// is no official tier. The desktop app never treats a registry entry as trust:
// it turns the entry into an install URL and sends the manifest through the same
// local gate as a file import.

export const VIAL_REGISTRY_URL =
  'https://raw.githubusercontent.com/OpenSmell/OpenSmell-web/main/public/vials/registry.json';

export interface RegistryVialEntry {
  id: string;
  name: string;
  version: string;
  author: string;
  license: string;
  domain: string;
  tagline: string;
  summary: string;
  /** The manifest contract the registry reviewed. Missing means the entry
   *  predates v2; it remains installable as Ungated. */
  schema?: 'osmograph.domain-pack/1' | 'osmograph.domain-pack/2';
  hasUi?: boolean;
  evidence?: 'A' | 'B' | 'C' | 'D';
  atlasRefs?: string[];
  /** sha256 hex of the manifest file, so an install can detect upstream edits. */
  hash?: string;
  /** sha256 hex of every sandboxed UI asset, keyed by its relative filename. */
  assets?: Record<string, string>;
  manifestUrl: string | null;
  sourceUrl: string | null;
  install: string;
}

interface RegistryFile {
  schema: string;
  updated?: string;
  vials: RegistryVialEntry[];
}

function asEntry(value: unknown): RegistryVialEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const str = (key: string): string => (typeof raw[key] === 'string' ? raw[key] as string : '');
  const id = str('id');
  const manifestUrl = str('manifestUrl') || null;
  if (!id || !str('name')) return null;
  const evidence = ['A', 'B', 'C', 'D'].includes(str('evidence'))
    ? (str('evidence') as 'A' | 'B' | 'C' | 'D')
    : undefined;
  const schema = str('schema') === 'osmograph.domain-pack/2'
    ? 'osmograph.domain-pack/2' as const
    : str('schema') === 'osmograph.domain-pack/1'
      ? 'osmograph.domain-pack/1' as const
      : undefined;
  const atlasRefs = Array.isArray(raw.atlasRefs)
    ? raw.atlasRefs.filter((ref): ref is string => typeof ref === 'string')
    : undefined;
  const assets = raw.assets && typeof raw.assets === 'object' && !Array.isArray(raw.assets)
    ? Object.fromEntries(
        Object.entries(raw.assets as Record<string, unknown>)
          .filter(([key, value]) => /^[a-z0-9][a-z0-9._-]*\.html$/i.test(key)
            && typeof value === 'string'
            && /^[a-f0-9]{64}$/i.test(value)) as Array<[string, string]>
      )
    : undefined;
  return {
    id,
    name: str('name'),
    version: str('version'),
    author: str('author'),
    license: str('license'),
    domain: str('domain'),
    tagline: str('tagline'),
    summary: str('summary'),
    schema,
    hasUi: raw.hasUi === true,
    evidence,
    atlasRefs,
    hash: str('hash') || undefined,
    assets: assets && Object.keys(assets).length ? assets : undefined,
    manifestUrl,
    sourceUrl: str('sourceUrl') || null,
    install: str('install'),
  };
}

export async function fetchVialRegistry(timeoutMs = 9000): Promise<RegistryVialEntry[]> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(VIAL_REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      // GitHub's raw host caches for a few minutes. A newly approved Vial
      // should appear on the next Aromatory open, not after a restart.
      cache: 'no-cache',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}.`);
    const text = await response.text();
    if (text.length > 1_500_000) throw new Error('Registry is larger than 1.5 MB.');
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('Registry is not an object.');
    const vials = (parsed as RegistryFile).vials;
    if (!Array.isArray(vials)) throw new Error('Registry has no vials list.');
    return vials.map(asEntry).filter((entry): entry is RegistryVialEntry => entry !== null);
  } finally {
    window.clearTimeout(timer);
  }
}
