// Exercise the actual CLI in a disposable tree; never rewrite working API types.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'

const frontend = process.cwd() // pnpm test runs from frontend/; the CLI itself runs in Node.
const schemas = [['public', 'schema'], ['manager', 'manager-schema']] as const
const originals = new Map(schemas.map(([name, output]) => [name,
  readFileSync(join(frontend, `src/shared/api/${output}.d.ts`), 'utf8').replace(/\r\n?/g, '\n')]))
let fixture: string
const typePath = (output: string) => join(fixture, `src/shared/api/${output}.d.ts`)
const run = () => spawnSync(process.execPath, [join(fixture, 'scripts/check-contract.mjs')], { encoding: 'utf8', timeout: 20_000 })

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'softline-contract-check-'))
  for (const dir of ['scripts', 'contracts', 'src/shared/api']) mkdirSync(join(fixture, dir), { recursive: true })
  cpSync(join(frontend, 'scripts/check-contract.mjs'), join(fixture, 'scripts/check-contract.mjs'))
  for (const [name] of schemas) cpSync(join(frontend, `contracts/${name}.openapi.yaml`), join(fixture, `contracts/${name}.openapi.yaml`))
  cpSync(join(frontend, 'contracts/examples'), join(fixture, 'contracts/examples'), { recursive: true, dereference: true })
  symlinkSync(join(frontend, 'node_modules'), join(fixture, 'node_modules'), 'dir')
})
beforeEach(() => { for (const [name, output] of schemas) writeFileSync(typePath(output), originals.get(name)!) })
afterAll(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }) })

it.each(['LF', 'CRLF'])('accepts identical public and manager declarations with %s endings', (ending) => {
  if (ending === 'CRLF') for (const [name, output] of schemas) writeFileSync(typePath(output), originals.get(name)!.replace(/\n/g, '\r\n'))
  const result = run()
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  for (const [name] of schemas) expect(result.stdout).toContain(`Типы соответствуют frontend/contracts/${name}.openapi.yaml`)
})

it.each(schemas)('still rejects a changed %s API declaration with CRLF endings', (name, output) => {
  const changed = originals.get(name)!.replace('export interface paths {', 'export interface paths {\n    "/synthetic-changed-contract": never;')
  expect(changed).not.toBe(originals.get(name))
  writeFileSync(typePath(output), changed.replace(/\n/g, '\r\n'))
  const result = run()
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`Типы ${name} API устарели.`)
  const other = name === 'public' ? 'manager' : 'public'
  expect(result.stdout).toContain(`Типы соответствуют frontend/contracts/${other}.openapi.yaml`)
})
