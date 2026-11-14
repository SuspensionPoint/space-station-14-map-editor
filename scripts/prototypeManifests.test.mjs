import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listPrototypeFiles } from './prototypeManifests.mjs';

const FILES = [
  'Prototypes/Tiles/floors.yml',
  'Prototypes/Entities/Structures/walls.yml',
  'Prototypes/Catalog/Fills/lockers.yml',
  'Prototypes/Decals/markings.yml',
  'Prototypes/Recipes/walls.yml',
  'Prototypes/_Fork/Tiles/floors.yml',
  'Prototypes/_Fork/Entities/Structures/walls.yml',
  'Prototypes/_Fork/Catalog/Fills/lockers.yml',
  'Prototypes/_Fork/Decals/markings.yml',
  'Prototypes/_Fork/Recipes/walls.yml',
  'Prototypes/_Other/Entities/Structures/pipes.yml',
];

let root;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-manifests-'));
  for (const file of FILES) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '');
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true });
});

describe('listPrototypeFiles', () => {
  it('lists the base files of each kind', () => {
    expect(listPrototypeFiles(root).base).toEqual({
      tiles: ['/Prototypes/Tiles/floors.yml'],
      entities: ['/Prototypes/Entities/Structures/walls.yml'],
      catalog: ['/Prototypes/Catalog/Fills/lockers.yml'],
      decals: ['/Prototypes/Decals/markings.yml'],
    });
  });

  it('finds the fork directories', () => {
    expect(listPrototypeFiles(root).forkPrefixes).toEqual(['_Fork', '_Other']);
  });

  it('lists the files of each kind from every fork directory', () => {
    expect(listPrototypeFiles(root).fork).toEqual({
      tiles: ['/Prototypes/_Fork/Tiles/floors.yml'],
      entities: [
        '/Prototypes/_Fork/Entities/Structures/walls.yml',
        '/Prototypes/_Other/Entities/Structures/pipes.yml',
      ],
      catalog: ['/Prototypes/_Fork/Catalog/Fills/lockers.yml'],
      decals: ['/Prototypes/_Fork/Decals/markings.yml'],
    });
  });
});
