// The build: lib/ is committed, so it must stay a faithful copy of src/ and the
// client bundle must stay wrapped the way window.__ModuleLoader__ expects.

import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { wrapClient } from '../scripts/wrap-client.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const HOST_MODULES = ['table.js', 'personas.js', 'rng.js', 'facts.js', 'speaker.js', 'export.js', 'sample.js']

function read(file) {
  return readFileSync(join(root, file), 'utf8')
}

test('lib/ is a faithful copy of src/ for every host module', () => {
  assert.equal(read('lib/index.js'), read('src/host.js'), 'lib/index.js is src/host.js')
  for (const file of HOST_MODULES) {
    assert.equal(read(join('lib', file)), read(join('src', file)), 'lib/' + file + ' matches src/' + file)
  }
})

test('the client bundle is the wrapped source with the stylesheet inlined', () => {
  const css = require('../src/client-css.cjs')
  assert.equal(typeof css, 'string')
  const CSS_REQUIRE = /require\((['"])\.\/client-css\.cjs\1\)/
  const source = read('src/client.cjs')
  assert.match(source, CSS_REQUIRE, 'the source still requires its stylesheet')
  const expected = wrapClient(source.replace(CSS_REQUIRE, JSON.stringify(css)), pkg.name)
  assert.equal(read('lib/client.js'), expected, 'rebuild with node scripts/build.mjs')
})

test('the bundle carries no relative require and registers under the package name', () => {
  const bundle = read('lib/client.js')
  assert.ok(!bundle.includes("require('./"), 'the stylesheet is inlined, not required')
  assert.ok(!bundle.includes('require("./'), 'nor with double quotes')
  assert.ok(bundle.includes('window.__ModuleLoader__.load('), 'wrapped for the GUI loader')
  assert.ok(bundle.includes('id: ' + JSON.stringify(pkg.name)))
  assert.ok(bundle.includes('module.exports'), 'still CommonJS inside the factory')
})

test('lib/index.js exports the Cordis plugin shape', async () => {
  const host = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  assert.equal(host.name, pkg.name)
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(typeof host.apply, 'function')
  assert.equal(typeof host.safeFileName, 'function')
})

test('package.json declares a real bundle patch, client half and zero dependencies', () => {
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length >= 1)
  assert.ok(existsSync(join(root, pkg.dsh.bundle.patch)), 'the patch file exists')
  assert.deepEqual(pkg.dependencies || {}, {})
  assert.deepEqual(pkg.devDependencies || {}, {}, 'the build needs no bundler')
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('examples'))
  assert.ok(pkg.exports['./client'])
})

test('cordis.patch.yml inserts exactly this plugin', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /insert:/)
  assert.match(patch, /id: dsh-turing-table/)
  assert.match(patch, /name: dsh-turing-table/)
})

test('the sample generator is reachable from the built lib too', async () => {
  const sample = await import(pathToFileURL(join(root, 'lib', 'sample.js')).href)
  const generated = await sample.generateSample()
  assert.equal(generated.jsonl, read('examples/sample-round.jsonl'), 'the built copy generates the same round')
})
