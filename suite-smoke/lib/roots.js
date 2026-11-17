import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
// SUITE_ROOT = folder that holds moneypenny, monopoly, partner-circle, api-hub, ... (C:\ct here, C:\dev\suite-smoke\repos on the partner laptop)
export const ROOT = process.env.SUITE_ROOT ?? resolve(here, '../../..');
export const imp = (rel) => import(pathToFileURL(resolve(ROOT, rel)).href);
