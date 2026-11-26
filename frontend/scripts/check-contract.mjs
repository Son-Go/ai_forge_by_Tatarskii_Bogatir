import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import openapiTS, { astToString } from 'openapi-typescript'

const generated = astToString(await openapiTS(new URL('../../contracts/public.openapi.yaml', import.meta.url)))
const current = await readFile(new URL('../src/shared/api/schema.d.ts', import.meta.url), 'utf8')
// The CLI adds a generated-file banner; compare the actual declarations.
const declarations = (text) => text.slice(text.indexOf('export interface paths'))
if (declarations(generated) !== declarations(current)) {
  console.error('Типы API устарели. Выполните pnpm api:generate и проверьте изменения.')
  process.exitCode = 1
} else {
  console.log(`Типы соответствуют ${fileURLToPath(new URL('../../contracts/public.openapi.yaml', import.meta.url))}`)
}
