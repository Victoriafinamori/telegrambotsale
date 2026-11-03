import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, posix, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { runtimeFiles, runtimeSources } from '../server/runtime-package.js';
import lock from '../config/hyze-bot.package-lock.json' with { type: 'json' };

test('Isolated merchant package includes its entire local import graph and imports without platform services', async () => {
  const base = resolve('.local');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'runtime-package-test-'));
  try {
    const compiled = join(directory, 'compiled');
    await mkdir(compiled);
    for (const file of runtimeFiles) {
      const source = await readFile(resolve('server', file.replace(/\.js$/, '.ts')), 'utf8');
      const result = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      });
      await writeFile(join(compiled, file), result.outputText);
    }
    const sources = await runtimeSources(compiled);
    assert.equal(Object.keys(sources).length, runtimeFiles.length);
    assert.ok(sources['dist-server/server/local-shop-editor.js']);
    for (const [file, source] of Object.entries(sources)) {
      assert.doesNotMatch(
        source,
        /firebase-admin|\.\/accounts\.js|\.\/bot-store\.js|dotenv\/config/,
      );
      for (const match of source.matchAll(/\b(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g))
        assert.ok(
          sources[posix.normalize(posix.join(posix.dirname(file), match[1]))],
          file + ' missing ' + match[1],
        );
      await mkdir(resolve(directory, posix.dirname(file)), { recursive: true });
      await writeFile(resolve(directory, file), source);
    }
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    const url = pathToFileURL(join(directory, 'dist-server/server/bot-runner.js')).href;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', 'await import(' + JSON.stringify(url) + ');'],
      { encoding: 'utf8', timeout: 20000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(lock.packages[''].dependencies.zod, lock.packages['node_modules/zod'].version);
    assert.ok(lock.packages['node_modules/zod'].integrity);
  } finally {
    if (!directory.startsWith(base + sep)) throw Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  }
});
