#!/usr/bin/env node
/**
 * Pre-bake SS14 resources for static deployment.
 *
 * This script:
 * 1. Scans Resources/Prototypes/ for YAML files and generates manifest JSONs
 * 2. Copies required Resources into public/resources/ for static serving
 *
 * Usage: node scripts/prebuild-resources.mjs [--textures=minimal|full|none] [--fork-name=Name]
 *   --textures=minimal  (default) Tiles + Structures + Markers + fork content (~27 MB)
 *   --textures=full     All textures (~150 MB)
 *   --textures=none     Prototypes only, no textures (~8 MB)
 *   --fork-name=Name    Label shown for the built-in resources in the UI. If omitted,
 *                       it is auto-detected from a single fork directory under
 *                       Prototypes/ (e.g. _MyFork -> "MyFork"), else "Built-in".
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listPrototypeFiles } from './prototypeManifests.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const resourcesRoot = path.resolve(projectRoot, '../../Resources');
const publicResources = path.join(projectRoot, 'public/resources');

// Parse args
const textureMode = process.argv.find(a => a.startsWith('--textures='))?.split('=')[1] ?? 'minimal';
const forkNameArg = process.argv.find(a => a.startsWith('--fork-name='))?.split('=')[1];

const TEXTURE_SETS = {
  none: [],
  // Base SS14 texture directories. Fork-specific texture directories (under any
  // discovered _Fork prefix) are appended automatically below.
  minimal: ['Tiles', 'Structures', 'Markers', 'Decals'],
  full: null, // copy entire Textures dir
};

// ---- Helpers ----

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`  Warning: ${src} does not exist, skipping`);
    return 0;
  }
  let count = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

// ---- Main ----

console.log(`Pre-baking SS14 resources (textures: ${textureMode})`);
console.log(`  Source: ${resourcesRoot}`);
console.log(`  Target: ${publicResources}`);
console.log();

// Clean target
if (fs.existsSync(publicResources)) {
  fs.rmSync(publicResources, { recursive: true });
}
fs.mkdirSync(publicResources, { recursive: true });

// Step 1: Generate prototype manifests
console.log('Step 1: Generating prototype manifests...');

const { forkPrefixes, base, fork } = listPrototypeFiles(resourcesRoot);
const manifests = {
  tiles: [...base.tiles, ...fork.tiles],
  entities: [...base.entities, ...fork.entities],
  catalog: [...base.catalog, ...fork.catalog],
  decals: [...base.decals, ...fork.decals],
};

const manifestDir = path.join(publicResources, '_manifests');
fs.mkdirSync(manifestDir, { recursive: true });
for (const [name, files] of Object.entries(manifests)) {
  fs.writeFileSync(path.join(manifestDir, `${name}.json`), JSON.stringify(files));
}

// Determine the built-in fork name shown in the UI. Prefer an explicit --fork-name;
// otherwise auto-detect when there is exactly one fork directory (e.g. _MyFork ->
// "MyFork"). Base SS14 (no fork directories) falls back to a generic "Built-in".
const builtInForkName = forkNameArg
  ?? (forkPrefixes.length === 1 ? forkPrefixes[0].replace(/^_/, '') : 'Built-in');
fs.writeFileSync(path.join(manifestDir, 'fork.json'), JSON.stringify({ name: builtInForkName }));
console.log(`  Built-in fork name: ${builtInForkName}`);
for (const [label, kind] of [['Tile', 'tiles'], ['Entity', 'entities'], ['Catalog', 'catalog'], ['Decal', 'decals']]) {
  console.log(`  ${label} prototypes: ${manifests[kind].length} files (${base[kind].length} base + ${fork[kind].length} fork)`);
}

// Step 2: Copy prototype YAML files
console.log('\nStep 2: Copying prototype files...');

let protoCount = 0;
for (const relPath of Object.values(manifests).flat()) {
  const src = path.join(resourcesRoot, relPath);
  const dest = path.join(publicResources, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  protoCount++;
}
console.log(`  Copied ${protoCount} prototype files`);

// Step 3: Copy textures
console.log(`\nStep 3: Copying textures (mode: ${textureMode})...`);

const textureSrc = path.join(resourcesRoot, 'Textures');
const textureDest = path.join(publicResources, 'Textures');

if (textureMode === 'full') {
  const count = copyDirRecursive(textureSrc, textureDest);
  console.log(`  Copied ${count} texture files`);
} else if (textureMode !== 'none') {
  const dirs = [...(TEXTURE_SETS[textureMode] ?? TEXTURE_SETS.minimal)];
  // Mirror the base texture set under any discovered fork directory (e.g. a fork's
  // _MyFork/Structures). Missing directories are skipped by copyDirRecursive.
  const baseSet = TEXTURE_SETS.minimal;
  for (const fork of forkPrefixes) {
    for (const sub of baseSet) dirs.push(`${fork}/${sub}`);
  }
  let totalCount = 0;
  for (const subdir of dirs) {
    const src = path.join(textureSrc, subdir);
    const dest = path.join(textureDest, subdir);
    const count = copyDirRecursive(src, dest);
    console.log(`  ${subdir}: ${count} files`);
    totalCount += count;
  }
  console.log(`  Total: ${totalCount} texture files`);
}

// Summary
const totalSize = dirSize(publicResources);
console.log(`\nDone! Total size: ${formatSize(totalSize)}`);
console.log(`Output: ${publicResources}`);
