/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { JsonAstString, JsonParseMode, dirname, join, normalize, parseJsonAst, resolve } from '@angular-devkit/core';
import { DirEntry, Rule, chain } from '@angular-devkit/schematics';
import { findPropertyInAstObject } from '../../utility/json-utils';
import { getWorkspace } from '../../utility/workspace';

const SOLUTIONS_TS_CONFIG_HEADER = '// This is a "Solution Style" tsconfig.json file, and is used by editors and TypeScript’s' +
  'language server to improve development experience.\n' +
  '// It is not intended to be used to perform a compilation.\n';

function* visitExtendedJsonFiles(directory: DirEntry): IterableIterator<[string, JsonAstString]> {
  for (const path of directory.subfiles) {
    if (!path.endsWith('.json')) {
      continue;
    }

    const entry = directory.file(path);
    if (!entry) {
      continue;
    }

    const jsonAst = parseJsonAst(entry.content.toString(), JsonParseMode.Loose);
    if (jsonAst.kind !== 'object') {
      continue;
    }

    const extendsAst = findPropertyInAstObject(jsonAst, 'extends');
    // Check if this config has the potential of extended the workspace tsconfig.
    // Unlike tslint configuration, tsconfig "extends" cannot be an array.
    if (extendsAst?.kind === 'string' && extendsAst.value.endsWith('tsconfig.json')) {
      yield [join(directory.path, path), extendsAst];
    }
  }

  for (const path of directory.subdirs) {
    if (path === 'node_modules') {
      continue;
    }

    yield* visitExtendedJsonFiles(directory.dir(path));
  }
}

function updateTsconfigExtendsRule(): Rule {
  return host => {
    if (!host.exists('tsconfig.json')) {
      return;
    }

    // Rename workspace tsconfig to base tsconfig.
    host.rename('tsconfig.json', 'tsconfig.base.json');

    // Iterate over all tsconfig files and change the extends from 'tsconfig.json' 'tsconfig.base.json'
    for (const [tsconfigPath, extendsAst] of visitExtendedJsonFiles(host.root)) {
      const tsConfigDir = dirname(normalize(tsconfigPath));
      if ('/tsconfig.json' !== resolve(tsConfigDir, normalize(extendsAst.value))) {
        // tsconfig extends doesn't refer to the workspace tsconfig path.
        continue;
      }

      // Replace last path, json -> base.json
      const recorder = host.beginUpdate(tsconfigPath);
      const offset = extendsAst.end.offset - 5;
      recorder.remove(offset, 4);
      recorder.insertLeft(offset, 'base.json');
      host.commitUpdate(recorder);
    }
  };
}

function addSolutionTsConfigRule(): Rule {
  return async host => {
    const tsConfigPaths = new Set<string>();
    const workspace = await getWorkspace(host);

    // Find all tsconfig which are refereces used by builders
    for (const [, project] of workspace.projects) {
      for (const [, target] of project.targets) {
        if (!target.options) {
          continue;
        }

        for (const [key, value] of Object.entries(target.options)) {
          if ((key === 'tsConfig' || key === 'webWorkerTsConfig') && typeof value === 'string') {
            tsConfigPaths.add(value);
          }
        }
      }
    }

    // Generate the solutions style tsconfig/
    const tsConfigContent = {
      files: [],
      references: [...tsConfigPaths].map(p => ({ path: `./${p}` })),
    };

    host.create('tsconfig.json', SOLUTIONS_TS_CONFIG_HEADER + JSON.stringify(tsConfigContent, undefined, 2));
  };
}

export default function (): Rule {
  return (host, context) => {
    const logger = context.logger;

    if (host.exists('tsconfig.base.json')) {
      logger.info('Migration has already been executed.');

      return;
    }

    return chain([
      updateTsconfigExtendsRule,
      addSolutionTsConfigRule,
    ]);
  };
}
