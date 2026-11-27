import { readFile } from 'node:fs/promises'
import openapiTS, { astToString } from 'openapi-typescript'
const declarations = (text) => {
  const normalized = text.replace(/\r\n?/g, '\n')
  return normalized.slice(normalized.indexOf('export interface paths'))
}
for (const [name, output] of [['public', 'schema'], ['manager', 'manager-schema']]) {
  const generated = astToString(await openapiTS(new URL(`../contracts/${name}.openapi.yaml`, import.meta.url)))
  const current = await readFile(new URL(`../src/shared/api/${output}.d.ts`, import.meta.url), 'utf8')
  if (declarations(generated) !== declarations(current)) {
    console.error(`Типы ${name} API устарели. Выполните pnpm api:generate.`)
    process.exitCode = 1
  } else console.log(`Типы соответствуют frontend/contracts/${name}.openapi.yaml`)
}
