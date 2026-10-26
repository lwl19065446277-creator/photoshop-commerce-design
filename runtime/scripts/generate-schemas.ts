import { zodToJsonSchema } from 'zod-to-json-schema';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { operationSchemas, resultSchema, helloSchema } from '../src/contracts.js';
import { designTaskSchema } from '../src/tasks/model.js';
import { compositionSchema } from '../src/design/plan.js';
import { catalogPlanSchema } from '../src/design/catalog-plan.js';
import { nativeSlicePlanSchema } from '../src/design/slice-plan.js';
import { variantPlanSchema } from '../src/design/variant-plan.js';
const dir = resolve('schemas');
await mkdir(dir, { recursive: true });
const operations = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Design Agent Studio operation request',
  oneOf: Object.entries(operationSchemas).map(([name, schema]) => ({
    type: 'object', additionalProperties: false, required: ['operation','args'],
    properties: { operation: { const: name }, args: zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }) }
  }))
};
for (const [name, value] of Object.entries({ operations, task: zodToJsonSchema(designTaskSchema, 'DesignTask'), 'plugin-result': zodToJsonSchema(resultSchema, 'PluginResult'), 'plugin-hello': zodToJsonSchema(helloSchema, 'PluginHello'), composition: zodToJsonSchema(compositionSchema, 'Composition'), catalog: zodToJsonSchema(catalogPlanSchema, 'NativeCatalog'), slices: zodToJsonSchema(nativeSlicePlanSchema, 'NativeSlices'), variant: zodToJsonSchema(variantPlanSchema, 'NativeVariant') })) {
  await writeFile(resolve(dir, `${name}.schema.json`), JSON.stringify(value, null, 2) + '\n');
}
process.stdout.write('Wrote JSON Schemas under schemas/. Runtime Zod refinements remain authoritative.\n');
