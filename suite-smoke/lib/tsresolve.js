// Lets plain node import the TypeScript sources of SUITE_ROOT/corporate-tambola in-process (no bun, no build step, no network).
//  - '@tambola/<pkg>' workspace names -> packages/<pkg>/src/index.ts
//  - extensionless relative imports inside .ts ("./types") -> ./types.ts or ./types/index.ts; .json imports get the json attribute bun does not need
//  - third-party packages a .ts file needs (@noble/*, libphonenumber-js) come from, in order: the clone's own node_modules,
//    TAMBOLA_NODE_MODULES, <SUITE_ROOT or C:\ct>/tambola-live-check/node_modules (an installed checkout of the same repo)
//  - .ts is compiled with node's own stripTypeScriptTypes (strip mode). A file that uses syntax strip mode refuses
//    (parameter properties in game.ts RoundStore) is transpiled by a local esbuild (TS_ESBUILD_DIR, or the first <C:\ct>/*/node_modules/esbuild).
//    The product source on disk is never edited.
import { registerHooks, stripTypeScriptTypes, createRequire } from 'node:module';
import { existsSync, readFileSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, join, dirname } from 'node:path';
import { ROOT } from './roots.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOME = resolve(here, '../../..'); // C:\ct on this laptop
// realpath: node resolves a junction/symlinked clone to its real path, so aliases must point at the same path (one module instance per file)
const repoLink = resolve(ROOT, 'corporate-tambola');
export const REPO_DIR = existsSync(repoLink) ? realpathSync(repoLink) : repoLink;
const ALIAS = {
  '@tambola/shared': 'packages/shared/src/index.ts', '@tambola/engine': 'packages/engine/src/index.ts',
  '@tambola/beacon': 'packages/beacon/src/index.ts', '@tambola/billing': 'packages/billing/src/index.ts',
};
export const DEP_DIRS = [join(REPO_DIR, 'node_modules'), process.env.TAMBOLA_NODE_MODULES, resolve(ROOT, 'tambola-live-check/node_modules'), resolve(HOME, 'tambola-live-check/node_modules')]
  .filter((d, i, a) => d && existsSync(d) && a.indexOf(d) === i);
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

let esb = null;
function esbuild() {
  if (esb) return esb;
  const cands = [process.env.TS_ESBUILD_DIR];
  try { for (const d of readdirSync(HOME)) cands.push(join(HOME, d, 'node_modules')); } catch { /* none */ }
  for (const d of cands) if (d && existsSync(join(d, 'esbuild', 'package.json'))) { esb = createRequire(join(d, '_x.js'))('esbuild'); esb.__dir = d; return esb; }
  throw new Error('a .ts file needs more than type stripping and no local esbuild was found (set TS_ESBUILD_DIR to a node_modules folder holding esbuild)');
}
export const transpiled = []; // which files needed esbuild (reported in the summary)

let installed = false;
export function installTsHooks() {
  if (installed) return; installed = true;
  registerHooks({
    resolve(spec, ctx, next) {
      if (ALIAS[spec]) return { url: pathToFileURL(join(REPO_DIR, ALIAS[spec])).href, shortCircuit: true };
      const fromTs = !!ctx.parentURL && ctx.parentURL.endsWith('.ts');
      if (fromTs && spec.endsWith('.json') && spec.startsWith('.')) return { url: new URL(spec, ctx.parentURL).href, importAttributes: { type: 'json' }, format: 'json', shortCircuit: true };
      if (fromTs && (spec.startsWith('./') || spec.startsWith('../')) && !/\.(ts|js|mjs|cjs|json)$/.test(spec)) {
        const base = fileURLToPath(new URL(spec, ctx.parentURL));
        for (const c of [`${base}.ts`, join(base, 'index.ts'), `${base}.js`]) if (isFile(c)) return { url: pathToFileURL(c).href, shortCircuit: true };
      }
      if (fromTs && !spec.startsWith('.') && !spec.startsWith('node:') && !spec.startsWith('file:')) {
        try { return next(spec, ctx); } catch (e) {
          for (const d of DEP_DIRS) { try { return next(spec, { ...ctx, parentURL: pathToFileURL(join(d, '_from_here.js')).href }); } catch { /* next dir */ } }
          throw e;
        }
      }
      return next(spec, ctx);
    },
    load(url, ctx, next) {
      if (url.startsWith('file:') && url.endsWith('.ts')) {
        const file = fileURLToPath(url), src = readFileSync(file, 'utf8');
        let out;
        try { out = stripTypeScriptTypes(src, { mode: 'strip', sourceUrl: url }); } catch (e) {
          if (e?.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw e;
          out = esbuild().transformSync(src, { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: file }).code;
          transpiled.push(file);
        }
        return { format: 'module', source: out, shortCircuit: true };
      }
      return next(url, ctx);
    },
  });
}
installTsHooks();
