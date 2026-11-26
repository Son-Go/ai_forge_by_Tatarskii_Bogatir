import { writeFile } from 'node:fs/promises'
import openapiTS, { astToString } from 'openapi-typescript'
for (const [name, output] of [['public', 'schema'], ['manager', 'manager-schema']]) {
  const text = astToString(await openapiTS(new URL(`../contracts/${name}.openapi.yaml`, import.meta.url)))
  await writeFile(new URL(`../src/shared/api/${output}.d.ts`, import.meta.url), text)
}
