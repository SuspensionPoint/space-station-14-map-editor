import yaml from 'js-yaml';
import { SS14_SCHEMA } from '../import/ss14Schema';
import type { RawTilePrototype, RawEntityPrototype, RawDecalPrototype } from './registryTypes';
import type { ResourceProvider } from './resourceProvider';

export interface ParsedPrototypes {
  tiles: RawTilePrototype[];
  entities: RawEntityPrototype[];
  decals: RawDecalPrototype[];
  sourceCategory: string;
}

/** Derive entity category from file path. "/Prototypes/Entities/Structures/Power/apc.yml" -> "Structures/Power" */
export function deriveCategory(filePath: string): string {
  // Handle base and fork paths: /Prototypes/Entities/... and /Prototypes/_MyFork/Entities/...
  const entityMatch = filePath.match(/\/Prototypes\/(?:_[^/]+\/)?Entities\/(.+)\//);
  if (entityMatch) return entityMatch[1].split('/').join('/');
  // Handle Catalog paths: /Prototypes/Catalog/Fills/Lockers/... -> "Catalog/Fills/Lockers"
  const catalogMatch = filePath.match(/\/Prototypes\/(?:_[^/]+\/)?Catalog\/(.+)\//);
  if (catalogMatch) return 'Catalog/' + catalogMatch[1].split('/').join('/');
  return 'Other';
}

interface VariantList {
  values?: unknown[];
  sequences?: unknown[];
}

function isVariantList(node: unknown): node is VariantList {
  return typeof node === 'object' && node !== null && (node as { _ss14Tag?: string })._ss14Tag === '!type:CreateVariants';
}

function pickVariant(node: unknown, index: number): unknown {
  if (isVariantList(node)) return (node.values ?? node.sequences)?.[index];
  if (Array.isArray(node)) return node.map(item => pickVariant(item, index));
  if (typeof node === 'object' && node !== null) {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, pickVariant(value, index)]));
  }
  return node;
}

/**
 * Some forks declare several prototypes in one entry: `id` and any field that differs
 * hold a CreateVariants list with one value per prototype.
 */
function expandVariants<T extends { id: unknown }>(entry: T): T[] {
  const ids = entry.id;
  if (!isVariantList(ids)) return [entry];
  return (ids.values ?? []).map((_, index) => pickVariant(entry, index) as T);
}

/** Parse a YAML string containing prototype definitions. */
export function parsePrototypeYaml(yamlContent: string, filePath: string): ParsedPrototypes {
  const docs = yaml.loadAll(yamlContent, undefined, { schema: SS14_SCHEMA }) as unknown[];
  const tiles: RawTilePrototype[] = [];
  const entities: RawEntityPrototype[] = [];
  const decals: RawDecalPrototype[] = [];

  for (const doc of docs) {
    if (!Array.isArray(doc)) continue;
    for (const declared of doc) {
      if (!declared || typeof declared !== 'object' || !('type' in declared) || !('id' in declared)) continue;
      for (const entry of expandVariants(declared)) {
        if (entry.type === 'tile') {
          tiles.push(entry as RawTilePrototype);
        } else if (entry.type === 'entity') {
          entities.push(entry as RawEntityPrototype);
        } else if (entry.type === 'decal') {
          decals.push(entry as RawDecalPrototype);
        }
      }
    }
  }

  return { tiles, entities, decals, sourceCategory: deriveCategory(filePath) };
}

/**
 * Discover fork subdirectories under Prototypes/ (any leading-underscore directory,
 * e.g. _MyFork) by scanning existing file paths from the provider.
 */
async function discoverForkPrefixes(provider: ResourceProvider): Promise<string[]> {
  try {
    const files = await provider.listFiles('Prototypes', '.yml');
    const forkDirs = new Set<string>();
    for (const f of files) {
      const match = f.match(/^\/Prototypes\/(_[^/]+)\//);
      if (match) forkDirs.add(match[1]);
    }
    return Array.from(forkDirs);
  } catch {
    return [];
  }
}

/** Discover all prototype YAML files via the provider, then fetch and parse each one. */
export async function discoverPrototypes(
  provider: ResourceProvider,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ tiles: RawTilePrototype[]; entities: { proto: RawEntityPrototype; category: string }[]; decals: RawDecalPrototype[] }> {
  // Scan base directories
  const tileFiles = await provider.listFiles('Prototypes/Tiles', '.yml');
  const entityFiles = await provider.listFiles('Prototypes/Entities', '.yml');
  const decalFiles: string[] = [];

  // Scan Catalog directory (contains "Filled" entity variants like LockerRepresentativeFilled)
  try {
    const catalogFiles = await provider.listFiles('Prototypes/Catalog', '.yml');
    entityFiles.push(...catalogFiles);
  } catch { /* Catalog dir may not exist */ }

  // Scan Decals directory
  try {
    const baseDecalFiles = await provider.listFiles('Prototypes/Decals', '.yml');
    decalFiles.push(...baseDecalFiles);
  } catch { /* Decals dir may not exist */ }

  // Discover and scan fork directories (any leading-underscore directory)
  const forkDirs = await discoverForkPrefixes(provider);
  for (const fork of forkDirs) {
    try {
      const forkTiles = await provider.listFiles(`Prototypes/${fork}/Tiles`, '.yml');
      tileFiles.push(...forkTiles);
    } catch { /* fork may not have Tiles/ */ }
    try {
      const forkEntities = await provider.listFiles(`Prototypes/${fork}/Entities`, '.yml');
      entityFiles.push(...forkEntities);
    } catch { /* fork may not have Entities/ */ }
    try {
      const forkCatalog = await provider.listFiles(`Prototypes/${fork}/Catalog`, '.yml');
      entityFiles.push(...forkCatalog);
    } catch { /* fork may not have Catalog/ */ }
    try {
      const forkDecals = await provider.listFiles(`Prototypes/${fork}/Decals`, '.yml');
      decalFiles.push(...forkDecals);
    } catch { /* fork may not have Decals/ */ }
  }

  const allFiles = [...tileFiles, ...entityFiles, ...decalFiles];
  const allTiles: RawTilePrototype[] = [];
  const allEntities: { proto: RawEntityPrototype; category: string }[] = [];
  const allDecals: RawDecalPrototype[] = [];

  let loaded = 0;
  const BATCH_SIZE = 20;
  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (filePath) => {
        try {
          const text = await provider.readText(filePath);
          return parsePrototypeYaml(text, filePath);
        } catch {
          // Skip files that fail to parse (e.g., unsupported YAML features)
          return { tiles: [], entities: [], decals: [], sourceCategory: 'Other' } as ParsedPrototypes;
        }
      }),
    );
    for (const result of results) {
      allTiles.push(...result.tiles);
      for (const entity of result.entities) {
        allEntities.push({ proto: entity, category: result.sourceCategory });
      }
      allDecals.push(...result.decals);
    }
    loaded += batch.length;
    onProgress?.(loaded, allFiles.length);
  }

  return { tiles: allTiles, entities: allEntities, decals: allDecals };
}
