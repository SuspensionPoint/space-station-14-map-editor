import fs from 'fs';
import path from 'path';

function walkDir(dir, ext) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * List the prototype files that go into each manifest, as resource paths like
 * `/Prototypes/Tiles/floors.yml`. `base` holds the files of base SS14 and `fork`
 * the files under any leading-underscore fork directory.
 */
export function listPrototypeFiles(resourcesRoot) {
  const prototypesDir = path.join(resourcesRoot, 'Prototypes');
  const list = (dir) => walkDir(path.join(prototypesDir, dir), '.yml').map(f =>
    '/' + path.relative(resourcesRoot, f).replace(/\\/g, '/')
  );

  const forkPrefixes = fs.readdirSync(prototypesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('_'))
    .map(entry => entry.name);

  return {
    forkPrefixes,
    base: {
      tiles: list('Tiles'),
      entities: list('Entities'),
      catalog: list('Catalog'),
      decals: list('Decals'),
    },
    fork: {
      tiles: forkPrefixes.flatMap(fork => list(`${fork}/Tiles`)),
      entities: forkPrefixes.flatMap(fork => list(`${fork}/Entities`)),
      catalog: forkPrefixes.flatMap(fork => list(`${fork}/Catalog`)),
      decals: forkPrefixes.flatMap(fork => list(`${fork}/Decals`)),
    },
  };
}
