import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

// The package must declare a dsh bundle and ship the patch it names, or the
// Web Plugins page refuses it (`not-a-bundle`) and has no row to switch.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
assert.ok(manifest.files?.includes('cordis.patch.yml'), 'cordis.patch.yml ships in the npm tarball')

// Parse through dsh's own overlay loader: `!!js`, anchors, and patch shapes
// fail here the same way they fail at profile boot.
const patches = loadOverlayPatches('bundle-test', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
const disabled = new Set(patches.filter((patch) => patch.disabled === true).map((patch) => patch.id))
for (const id of ['subprocess', 'sandbox', 'fs-sandbox']) {
  assert.ok(disabled.has(id), `the bundle layer disables ${id}`)
}

// The row the Plugins page switches: the bundle patch's inserts, composed the
// way `listBundles().rows` composes them.
const rows = composeEntries([patches.filter((patch) => patch.insert !== undefined)])
assert.deepEqual(rows, [{ id: 'opensandbox-world', name: manifest.name }])
