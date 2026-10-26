import { z } from 'zod';

const limitedString = z.string().max(20000);
export const taskValuesSchema = z.object({
  productName: limitedString.optional(),
  sku: limitedString.optional(),
  taskType: limitedString.optional(),
  title: limitedString.optional(),
  subtitle: limitedString.optional(),
  width: z.number().int().positive().max(30000).optional(),
  height: z.number().int().positive().max(30000).optional(),
  templatePath: limitedString.optional(),
  productImagePath: limitedString.optional(),
  titleLayer: limitedString.optional(),
  subtitleLayer: limitedString.optional(),
  productLayer: limitedString.optional(),
  outputName: limitedString.optional(),
  style: limitedString.optional(),
  requirements: limitedString.optional(),
  referencePath: limitedString.optional(),
  delivery: limitedString.optional(),
  layout: z.object({
    translateX: z.number().finite().min(-50000).max(50000).optional(),
    translateY: z.number().finite().min(-50000).max(50000).optional(),
    scalePercent: z.number().finite().min(1).max(1000).optional(),
  }).strict().optional(),
}).strict();

export type TaskValues = z.infer<typeof taskValuesSchema>;
export type Field = Exclude<keyof TaskValues, 'layout'> | 'size' | 'translateX' | 'translateY' | 'scalePercent';
export const issueSchema = z.object({
  code: z.string(), field: z.string().optional(), message: z.string(),
  severity: z.enum(['error', 'warning']),
}).strict();
export type TaskIssue = z.infer<typeof issueSchema>;
export const designTaskSchema = taskValuesSchema.extend({
  id: z.string().min(1).max(200),
  source: z.object({ workbook: z.string(), sheet: z.string(), row: z.number().int().positive() }).strict(),
  status: z.enum(['ready', 'needs_input']),
  issues: z.array(issueSchema),
}).strict();
export type DesignTask = z.infer<typeof designTaskSchema>;

export interface Bounds { left: number; top: number; right: number; bottom: number }
export interface LayerSnapshot {
  id: number;
  name: string;
  kind: string;
  visible: boolean;
  bounds?: Bounds;
  text?: string;
  children?: LayerSnapshot[];
}
export interface DocumentSnapshot {
  id: number;
  name?: string;
  width: number;
  height: number;
  layers: LayerSnapshot[];
}
export interface PlanStep {
  operation: 'set_text' | 'replace_smart_object' | 'transform_layer';
  args: Record<string, unknown>;
  purpose: string;
}
export interface DesignPlan {
  version: 1;
  taskId: string;
  planner: 'deterministic-template-v1';
  documentId: number;
  intent: string;
  priorities: string[];
  protectedContent: string[];
  steps: PlanStep[];
  humanReview: string[];
}
export class TaskPlanningError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TaskPlanningError';
  }
}
