/** Derive the user preset from the pinned source declaration, without copying framework code. */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const repo = resolve(process.argv[2])
const require = createRequire(repo + '/vendor/include/package.json')
const { entryListSchema } = await import(pathToFileURL(repo + '/vendor/include/lib/index.js'))
const rows = require('js-yaml').load(readFileSync(repo + '/packages/bundle/web-app/presets/standard.patch.yml', 'utf8'), { schema: entryListSchema })
const config = rows.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-standard')?.config
if (!config || config.id !== 'standard') throw Error('Pinned standard preset declaration is missing')
const disabled = new Set(['tool-plugin-manager', 'tool-plugin-market', 'tool-schedule'])
function filter(entries) {
  return entries.filter(entry => !disabled.has(entry.id)).map(entry => entry.group && Array.isArray(entry.config) ? { ...entry, config: filter(entry.config) } : entry)
}
console.log(JSON.stringify({ ...config, plugins: filter(config.plugins) }))
