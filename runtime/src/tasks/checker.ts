import { type DesignTask, type DocumentSnapshot, type LayerSnapshot } from './model.js';
import { uniqueLayer } from './planner.js';

export interface DesignCheck {
  code: string;
  status: 'pass' | 'fail' | 'manual';
  message: string;
  layerId?: number;
}
export interface CheckReport {
  taskId: string;
  structuralPass: boolean;
  requiresHumanReview: true;
  checks: DesignCheck[];
  /** Evidence-gathering checker; no automatic corrections are asserted as applied. */
  correctionSuggestions: Array<{ operation: 'set_text'; args: Record<string, unknown>; reason: string }>;
}

const normalizeLineEndings = (text: string): string => text.replace(/\r\n?/g, '\n');

function isEffectivelyVisible(layers: LayerSnapshot[], id: number, parentVisible = true): boolean | undefined {
  for (const layer of layers) {
    const visible = parentVisible && layer.visible;
    if (layer.id === id) return visible;
    const found = isEffectivelyVisible(layer.children ?? [], id, visible);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Compare DOM evidence only. Pixel/aesthetic/product-identity review remains explicitly manual. */
export function checkDesign(task: DesignTask, document: DocumentSnapshot): CheckReport {
  const checks: DesignCheck[] = [];
  const correctionSuggestions: CheckReport['correctionSuggestions'] = [];
  checks.push({ code: 'DIMENSIONS', status: document.width === task.width && document.height === task.height ? 'pass' : 'fail', message: `当前画布 ${document.width}×${document.height}；要求 ${task.width}×${task.height}` });
  for (const [name, expectedText, kind, optional] of [[task.titleLayer, task.title, 'text', false], [task.subtitleLayer, task.subtitle, 'text', true], [task.productLayer, undefined, 'smartObject', false]] as const) {
    if (optional && expectedText === undefined) continue;
    if (kind === 'text' && expectedText === undefined) { checks.push({ code: 'MISSING_EXPECTED_TEXT', status: 'fail', message: '缺少需要核对的主标题文案' }); continue; }
    if (!name) { checks.push({ code: 'MISSING_LAYER_MAPPING', status: 'fail', message: `缺少 ${kind} 图层映射` }); continue; }
    let layer: LayerSnapshot;
    try { layer = uniqueLayer(document.layers, name, kind); }
    catch (error) { checks.push({ code: 'LAYER_MAPPING', status: 'fail', message: error instanceof Error ? error.message : String(error) }); continue; }
    checks.push({ code: 'LAYER_KIND', status: 'pass', layerId: layer.id, message: `${name} 图层类型为 ${kind}` });
    checks.push({ code: 'LAYER_VISIBLE', status: isEffectivelyVisible(document.layers, layer.id) ? 'pass' : 'fail', layerId: layer.id, message: `${name} 及其父组须可见` });
    if (expectedText !== undefined) {
      // Photoshop may return CR while Excel uses LF; all other characters/spaces stay exact.
      const matches = layer.text !== undefined && normalizeLineEndings(layer.text) === normalizeLineEndings(expectedText);
      checks.push({ code: 'TEXT_CONTENT', status: matches ? 'pass' : 'fail', layerId: layer.id, message: `${name} 文案${matches ? '与需求逐字一致' : '与需求不一致'}` });
      if (!matches) correctionSuggestions.push({ operation: 'set_text', args: { documentId: document.id, layerId: layer.id, text: expectedText }, reason: '恢复需求中的准确文案' });
    }
    if (!layer.bounds) { checks.push({ code: 'BOUNDS_UNAVAILABLE', status: 'manual', layerId: layer.id, message: `${name} 缺少图层边界，需查看预览` }); continue; }
    const { left, top, right, bottom } = layer.bounds;
    const valid = [left, top, right, bottom].every(Number.isFinite) && right > left && bottom > top;
    const fits = valid && left >= -0.5 && top >= -0.5 && right <= document.width + 0.5 && bottom <= document.height + 0.5;
    checks.push({ code: 'LAYER_BOUNDS', status: fits ? 'pass' : 'fail', layerId: layer.id, message: `${name} ${fits ? '图层边界在画布内' : '图层边界无效或超出画布，请审核并提供修正数值'}` });
  }
  checks.push({ code: 'VISUAL_REVIEW', status: 'manual', message: '需查看 Photoshop 真实预览，核对构图、字体、段落溢出、商品比例与素材身份。图层类型、文案和边界检查不能代替视觉模型或人工审核。' });
  return { taskId: task.id, structuralPass: checks.every(check => check.status !== 'fail'), requiresHumanReview: true, checks, correctionSuggestions };
}
