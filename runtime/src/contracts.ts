import { z } from 'zod';
const id = z.number().int().positive();
const path = z.string().min(1).max(4096).refine(v => !/[\x00-\x1f]/.test(v), 'Invalid path');
const doc = { documentId: id };
const layer = { ...doc, layerId: id };
const text = z.string().max(20000);
export const operationSchemas = {
  preflight_assets: z.object({ templatePath: path, productImagePath: path, referencePath: path.optional() }).strict(),
  ping: z.object({}).strict(),
  get_document_info: z.object({ documentId: id.optional() }).strict(),
  list_layers: z.object(doc).strict(),
  find_layer: z.object({ ...doc, name: z.string().min(1).max(500) }).strict(),
  open_working_copy: z.object({ templatePath: path }).strict(),
  set_text: z.object({ ...layer, text }).strict(),
  replace_smart_object: z.object({ ...layer, path }).strict(),
  set_visibility: z.object({ ...layer, visible: z.boolean() }).strict(),
  transform_layer: z.object({ ...layer, translateX: z.number().finite().min(-50000).max(50000).optional(), translateY: z.number().finite().min(-50000).max(50000).optional(), scalePercent: z.number().finite().min(1).max(1000).optional() }).strict().refine(v => v.translateX !== undefined || v.translateY !== undefined || v.scalePercent !== undefined, 'No transform supplied'),
  create_text: z.object({ ...doc, name: z.string().min(1).max(500), text, x: z.number().finite(), y: z.number().finite(), fontSize: z.number().positive().max(2000) }).strict(),
  get_preview: z.object({ ...doc, name: z.string().max(100).optional() }).strict(),
  save_psd: z.object({ ...doc, name: z.string().max(100).optional() }).strict(),
  export_image: z.object({ ...doc, name: z.string().max(100).optional(), format: z.enum(['png','jpg']), quality: z.number().int().min(0).max(12).optional() }).strict(),
  close_document: z.object({ ...doc, save: z.literal(false).default(false) }).strict()
} as const;
export type Operation = keyof typeof operationSchemas;
export type Command = { id: string; operation: string; args: Record<string, unknown> };
export const resultSchema = z.object({
  sessionId: z.string(), id: z.string(), ok: z.boolean(), result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).optional()
}).strict().refine(v => v.ok || !!v.error, 'Failed result requires error');
export const helloSchema = z.object({ pluginVersion: z.string(), photoshopVersion: z.string(), protocolVersion: z.literal(1) }).strict();
export const mutatingOperations = new Set(['open_document','set_text','replace_smart_object','set_visibility','transform_layer','create_text','save_psd','export_image','get_preview','close_document']);
