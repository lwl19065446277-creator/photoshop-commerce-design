import { designTaskSchema, type DesignPlan, type DesignTask, type DocumentSnapshot, type LayerSnapshot, TaskPlanningError } from './model.js';

export function flattenLayers(layers: LayerSnapshot[]): LayerSnapshot[] {
  return layers.flatMap(layer => [layer, ...flattenLayers(layer.children ?? [])]);
}

export function uniqueLayer(layers: LayerSnapshot[], name: string, expectedKind: string): LayerSnapshot {
  const matches = flattenLayers(layers).filter(layer => layer.name === name);
  if (!matches.length) throw new TaskPlanningError('LAYER_NOT_FOUND', `未找到图层“${name}”`);
  if (matches.length !== 1) throw new TaskPlanningError('AMBIGUOUS_LAYER', `图层名称“${name}”不唯一，请在 PSD 内重命名或明确映射`);
  const layer = matches[0]!;
  if (layer.kind !== expectedKind) throw new TaskPlanningError('WRONG_LAYER_KIND', `图层“${name}”为 ${layer.kind}，需要 ${expectedKind}`);
  if (!Number.isInteger(layer.id) || layer.id <= 0) throw new TaskPlanningError('INVALID_LAYER_ID', `图层“${name}”缺少有效 ID`);
  return layer;
}

/** A conservative, transparent PSD/PSB-template planner. It does not claim autonomous design judgment. */
export function planTask(rawTask: DesignTask, document: DocumentSnapshot): DesignPlan {
  const parsed = designTaskSchema.safeParse(rawTask);
  if (!parsed.success) throw new TaskPlanningError('INVALID_TASK', parsed.error.message);
  const task = parsed.data;
  if (task.status !== 'ready' || task.issues.some(issue => issue.severity === 'error')) throw new TaskPlanningError('TASK_NEEDS_INPUT', '当前任务仍有缺失或歧义，必须先解决需求问题');
  if (!task.title?.trim() || !task.templatePath || !task.productImagePath || !task.titleLayer || !task.productLayer || !task.width || !task.height) throw new TaskPlanningError('INCOMPLETE_TASK', '缺少文案、模板、商品素材、图层映射或画布尺寸');
  if (!Number.isInteger(document.id) || document.id <= 0 || !Array.isArray(document.layers)) throw new TaskPlanningError('INVALID_DOCUMENT', 'Photoshop 文档快照不完整');
  if (document.width !== task.width || document.height !== task.height) throw new TaskPlanningError('DIMENSION_MISMATCH', `PSD 尺寸 ${document.width}×${document.height} 与需求 ${task.width}×${task.height} 不一致；MVP 不自动缩放画布`);
  const title = uniqueLayer(document.layers, task.titleLayer, 'text');
  const product = uniqueLayer(document.layers, task.productLayer, 'smartObject');
  const steps: DesignPlan['steps'] = [{ operation: 'set_text', args: { documentId: document.id, layerId: title.id, text: task.title }, purpose: '将主标题逐字写入指定文字图层' }];
  if (task.subtitle !== undefined) {
    if (!task.subtitleLayer) throw new TaskPlanningError('INCOMPLETE_TASK', '副标题缺少图层映射');
    const subtitle = uniqueLayer(document.layers, task.subtitleLayer, 'text');
    if (subtitle.id === title.id) throw new TaskPlanningError('CONFLICTING_LAYERS', '主标题与副标题不能指向同一个图层');
    steps.push({ operation: 'set_text', args: { documentId: document.id, layerId: subtitle.id, text: task.subtitle }, purpose: '将副标题逐字写入指定文字图层' });
  }
  steps.push({ operation: 'replace_smart_object', args: { documentId: document.id, layerId: product.id, path: task.productImagePath }, purpose: '使用指定原始商品素材替换智能对象，不生成或改写商品像素' });
  if (task.layout && Object.values(task.layout).some(value => value !== undefined)) {
    steps.push({ operation: 'transform_layer', args: { documentId: document.id, layerId: product.id, ...task.layout }, purpose: '按明确的位移及统一百分比缩放调整商品图层' });
  }
  const humanReview = ['检查预览中的商品结构、形状及内容与原素材一致；自动化不保证语义或审美判断。', '检查字体替换、段落文字溢出和实际商品主体边界；图层边界不能完全验证这些问题。'];
  if (task.requirements || task.style || task.referencePath || task.delivery || task.taskType) humanReview.push('本计划只执行明确的文案、素材替换及布局数值；请结合原始设计要求、风格、参考图和交付说明审核计划与预览。');
  return {
    version: 1,
    taskId: task.id,
    planner: 'deterministic-template-v1',
    documentId: document.id,
    intent: `在已有 PSD/PSB 模板上完成 ${task.productName ?? task.sku ?? task.id} 的 ${task.width}×${task.height} 电商视觉需求`,
    priorities: ['沿用实际 PSD 的商品、文字、背景层次，先核对指定图层。', '准确替换营销文字与商品素材，保留模板图层结构。', '仅按明确数值进行基础位移和等比缩放。'],
    protectedContent: ['原始 PSD 和商品素材文件', '商品本身的结构、内容、纹理与颜色', '未被明确映射的图层内容', '商品长宽比例（仅允许统一缩放）'],
    steps,
    humanReview,
  };
}
