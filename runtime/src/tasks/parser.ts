import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { type DesignTask, type Field, type TaskIssue, type TaskValues, taskValuesSchema } from './model.js';

export const FIELD_ALIASES: Record<Field, string[]> = {
  productName: ['商品名称', '产品名称', '品名', '商品', 'product name', 'product'],
  sku: ['SKU', '商品编号', '产品编号', '款号', '货号', '商品SKU', 'product id', 'item id'],
  taskType: ['设计任务类型', '任务类型', '设计类型', 'task type'],
  title: ['主标题', '标题', '主文案', 'title', 'headline'],
  subtitle: ['副标题', '副文案', 'subtitle', 'subheading'],
  width: ['宽度', '画布宽度', '宽', 'width', 'width px'],
  height: ['高度', '画布高度', '高', 'height', 'height px'],
  size: ['设计尺寸', '尺寸', '画布尺寸', 'size', 'dimensions'],
  templatePath: ['PSD路径', 'PSB路径', '模板路径', '参考PSD', '参考PSB', 'PSD模板', 'PSB模板', 'template path', 'psd', 'psb', 'template'],
  productImagePath: ['商品图路径', '商品素材路径', '素材路径', '产品图片', '商品图', 'product image', 'image path', 'asset path'],
  titleLayer: ['主标题图层', '标题图层', 'title layer'],
  subtitleLayer: ['副标题图层', 'subtitle layer'],
  productLayer: ['商品图层', '商品智能对象', '产品图层', 'product layer', 'smart object layer'],
  outputName: ['文件命名', '输出文件名', '文件名', '交付文件名', 'output name', 'filename'],
  style: ['视觉风格', '设计风格', '风格', 'style'],
  requirements: ['设计要求', '需求说明', '设计约束', 'requirements', 'constraints'],
  referencePath: ['参考图', '参考图路径', 'reference', 'reference path'],
  delivery: ['交付要求', '导出要求', 'delivery'],
  translateX: ['水平位移', '水平偏移', '位移X', '偏移X', 'translate x', 'translateX'],
  translateY: ['垂直位移', '垂直偏移', '位移Y', '偏移Y', 'translate y', 'translateY'],
  scalePercent: ['等比缩放', '缩放百分比', '等比缩放百分比', 'scale percent', 'scalePercent'],
};

export interface ParseWorkbookOptions {
  sheetName?: string;
  headerRow?: number;
  materialRoot?: string;
  /** Canonical field -> exact workbook header; mapping overrides aliases for that field. */
  mapping?: Partial<Record<Field, string>>;
  /** Explicit business defaults; no model-generated defaults are inserted. */
  defaults?: TaskValues;
  /** Trusted material bindings supplied outside the workbook; worksheet path cells are always ignored. */
  assetBindings?: Pick<TaskValues, 'templatePath' | 'productImagePath' | 'referencePath'>;
  /** Leave true for preflight; false is for parsing a moved workbook before staging assets. */
  checkFiles?: boolean;
  maxRows?: number;
}

export class WorkbookParseError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'WorkbookParseError'; }
}

const normalize = (value: string): string => value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_\-（）()]/g, '');
const pathFields = new Set<Field>(['templatePath', 'productImagePath', 'referencePath']);
const layoutFields = new Set<Field>(['translateX', 'translateY', 'scalePercent']);
const numericFields = new Set<Field>(['width', 'height', ...layoutFields]);

function cellValue(cell: ExcelJS.Cell): { value?: string | number; invalid?: string } {
  const value = cell.value;
  if (value == null) return {};
  if (typeof value === 'number') return Number.isFinite(value) ? { value } : { invalid: '非有限数值' };
  if (typeof value === 'string') return { value };
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) return { invalid: '公式单元格不作为执行指令；请改为确认后的文本或数值' };
    if ('richText' in value) return { value: value.richText.map(part => part.text).join('') };
    if ('hyperlink' in value) return { value: value.text };
  }
  return { invalid: '不支持该单元格类型，请使用文本或数值' };
}

function headerText(cell: ExcelJS.Cell): string {
  const { value } = cellValue(cell);
  return value == null ? '' : String(value);
}

function resolveColumns(row: ExcelJS.Row, mapping: ParseWorkbookOptions['mapping']): Map<Field, number[]> {
  const result = new Map<Field, number[]>();
  row.eachCell((cell, col) => {
    const value = normalize(headerText(cell));
    if (!value) return;
    for (const field of Object.keys(FIELD_ALIASES) as Field[]) {
      const names = mapping?.[field] === undefined ? FIELD_ALIASES[field] : [mapping[field]!];
      if (names.some(name => normalize(name) === value)) result.set(field, [...(result.get(field) ?? []), col]);
    }
  });
  return result;
}

function determineHeader(sheet: ExcelJS.Worksheet, options: ParseWorkbookOptions): number {
  if (options.headerRow !== undefined) {
    if (!Number.isInteger(options.headerRow) || options.headerRow < 1) throw new Error('headerRow 必须是正整数');
    return options.headerRow;
  }
  let bestRow = 0;
  let bestScore = 0;
  for (let row = 1; row <= Math.min(20, sheet.rowCount); row++) {
    const score = resolveColumns(sheet.getRow(row), options.mapping).size;
    if (score > bestScore) { bestScore = score; bestRow = row; }
  }
  if (!bestRow || bestScore < 2) throw new Error(`工作表“${sheet.name}”未识别到需求表头，请提供 headerRow 和 mapping`);
  return bestRow;
}

function resolveAssetPath(value: string, base: string): string {
  if (/\x00|[\x01-\x1f]/.test(value)) throw new Error('路径不能包含控制字符');
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) throw new Error('MVP 仅接受本地文件路径，不下载 URL');
  return path.resolve(base, value.trim());
}

export function isSafeOutputName(name: string): boolean {
  return Boolean(name.trim()) && name === name.trim() && name.length <= 100
    && !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name)
    && name !== '.' && name !== '..' && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name);
}

function requiredIssue(issues: TaskIssue[], field: Field, message: string): void {
  if (!issues.some(issue => issue.field === field && issue.severity === 'error')) issues.push({ code: 'MISSING_REQUIRED', field, message, severity: 'error' });
}

/** Read real .xlsx data; missing assets/ambiguous headers/formulas remain needs_input. */
export async function parseWorkbook(workbookPath: string, options: ParseWorkbookOptions = {}): Promise<DesignTask[]> {
  const absoluteWorkbook = path.resolve(workbookPath);
  if (path.extname(absoluteWorkbook).toLowerCase() !== '.xlsx') throw new Error('仅支持 .xlsx 需求表');
  const file = await stat(absoluteWorkbook);
  if (!file.isFile()) throw new WorkbookParseError('XLSX_NOT_FILE', '需求表路径不是文件');
  if (file.size > 25 * 1024 * 1024) throw new WorkbookParseError('XLSX_TOO_LARGE', '需求表超过 25 MiB。请从原表另存一份仅含需求数据、不含嵌入图片的 .xlsx；原文件未修改。');
  if (options.defaults) taskValuesSchema.parse(options.defaults);
  if (options.assetBindings) taskValuesSchema.pick({ templatePath: true, productImagePath: true, referencePath: true }).parse(options.assetBindings);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(absoluteWorkbook);
  const sheets = options.sheetName ? workbook.worksheets.filter(sheet => sheet.name === options.sheetName) : workbook.worksheets.filter(sheet => sheet.state === 'visible');
  if (!sheets.length) throw new Error('未找到指定的可用工作表');
  const tasks: DesignTask[] = [];
  const maxRows = options.maxRows ?? 10000;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100000) throw new WorkbookParseError('INVALID_ROW_LIMIT', 'maxRows 必须为 1–100000 的整数');
  const assetBase = path.resolve(options.materialRoot ?? path.dirname(absoluteWorkbook));
  for (const sheet of sheets) {
    if (!sheet.actualRowCount) continue;
    let headerRow: number;
    try { headerRow = determineHeader(sheet, options); }
    catch (error) { if (options.sheetName || sheets.length === 1) throw error; continue; }
    const columns = resolveColumns(sheet.getRow(headerRow), options.mapping);
    if (!columns.size) throw new Error(`工作表“${sheet.name}”未找到已映射的字段`);
    for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      if (!row.hasValues) continue;
      if (tasks.length >= maxRows) throw new Error(`需求行数超过上限 ${maxRows}`);
      const values: Record<string, unknown> = { ...options.defaults, ...options.assetBindings, layout: options.defaults?.layout ? { ...options.defaults.layout } : undefined };
      const issues: TaskIssue[] = [];
      let hasRecognizedData = false;
      let combinedSize: string | undefined;
      for (const [field, matches] of columns) {
        // Workbook paths are untrusted provenance only. Do not decode formulas, resolve,
        // validate, or stat them; source files may only come from trusted local bindings.
        if (pathFields.has(field)) {
          const provided = matches.some(col => {
            const value = row.getCell(col).value;
            return value != null && (typeof value !== 'string' || value.trim() !== '');
          });
          if (provided) issues.push({ code: 'WORKBOOK_PATH_IGNORED', field, severity: 'warning', message: `工作表中的 ${field} 路径已忽略；只使用表格外明确绑定的素材` });
          continue;
        }
        if (matches.length > 1) {
          issues.push({ code: 'AMBIGUOUS_HEADER', field, severity: 'error', message: `字段 ${field} 匹配到多列表头，请用 mapping 明确指定唯一列` });
          continue;
        }
        const cell = row.getCell(matches[0]!);
        const decoded = cellValue(cell);
        if (decoded.invalid) {
          hasRecognizedData = true;
          issues.push({ code: 'INVALID_CELL', field, message: `${cell.address}: ${decoded.invalid}`, severity: 'error' });
          continue;
        }
        if (decoded.value === undefined || (typeof decoded.value === 'string' && !decoded.value.trim())) continue;
        hasRecognizedData = true;
        if (field === 'size') { combinedSize = String(decoded.value); continue; }
        if (numericFields.has(field)) {
          const raw = String(decoded.value).trim().replace(field === 'scalePercent' ? /%$/ : /(?:px|像素)$/i, '').trim();
          let number = raw === '' ? NaN : Number(raw);
          if (field === 'scalePercent' && typeof decoded.value === 'number' && cell.numFmt.includes('%')) number *= 100;
          if (!Number.isFinite(number)) { issues.push({ code: 'INVALID_NUMBER', field, severity: 'error', message: `${cell.address}: 需要明确的像素值或百分比数值` }); continue; }
          if (layoutFields.has(field)) {
            const layout = (values.layout ??= {}) as Record<string, number>;
            layout[field] = number;
          }
          else values[field] = number;
          continue;
        }
        if (field === 'sku' && typeof decoded.value === 'number' && (!Number.isSafeInteger(decoded.value) || Math.abs(decoded.value) >= 1e15)) {
          issues.push({ code: 'SKU_PRECISION', field, severity: 'error', message: '长 SKU 的数值单元格可能已丢失精度，请提供文本格式的商品编号' });
        }
        const textValue = typeof decoded.value === 'number' ? String(decoded.value) : decoded.value;
        values[field] = field === 'title' || field === 'subtitle' ? textValue.replace(/\r\n?/g, '\n') : textValue;
      }
      // Ignore notes-only rows that do not carry any recognized demand data.
      if (!hasRecognizedData) continue;
      if (combinedSize) {
        const match = combinedSize.trim().match(/^(\d+)\s*[xX×*]\s*(\d+)\s*(?:px|像素)?$/);
        if (!match) issues.push({ code: 'INVALID_SIZE', field: 'size', severity: 'error', message: '尺寸应为明确像素值，如 1000×1000；画面比例不能代替尺寸' });
        else {
          const width = Number(match[1]); const height = Number(match[2]);
          if ((values.width !== undefined && values.width !== width) || (values.height !== undefined && values.height !== height)) issues.push({ code: 'CONFLICTING_SIZE', field: 'size', severity: 'error', message: '尺寸列与宽度/高度列存在冲突' });
          values.width ??= width; values.height ??= height;
        }
      }
      const validated = taskValuesSchema.safeParse(values);
      if (!validated.success) {
        for (const failure of validated.error.issues) {
          const field = String(failure.path[0] ?? 'task');
          issues.push({ code: 'INVALID_FIELD', field, message: `${failure.path.join('.')}: ${failure.message}`, severity: 'error' });
          // Keep the row serializable and unsuitable for execution instead of returning NaN/invalid parameters.
          delete values[field];
        }
      }
      for (const field of ['title', 'templatePath', 'productImagePath', 'titleLayer', 'productLayer', 'width', 'height'] as Field[]) {
        if (values[field] === undefined || String(values[field]).trim() === '') requiredIssue(issues, field, `缺少 ${field}，不能执行设计任务`);
      }
      if (!String(values.productName ?? '').trim() && !String(values.sku ?? '').trim()) requiredIssue(issues, 'productName', '至少提供商品名称或 SKU，确保可追踪商品身份');
      if (values.subtitle !== undefined && !values.subtitleLayer) requiredIssue(issues, 'subtitleLayer', '副标题有内容，但没有明确指定副标题图层');
      for (const field of pathFields) {
        if (!values[field]) continue;
        try {
          const resolved = resolveAssetPath(String(values[field]), assetBase);
          values[field] = resolved;
          if (field === 'templatePath' && !['.psd', '.psb'].includes(path.extname(resolved).toLowerCase())) throw new Error('模板必须是 .psd 或 .psb 文件');
          if (field === 'productImagePath' && !['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.psd'].includes(path.extname(resolved).toLowerCase())) throw new Error('MVP 商品替换素材仅支持 PNG、JPG、JPEG、TIF、TIFF、PSD');
          if (options.checkFiles !== false && !(await stat(resolved)).isFile()) throw new Error('路径不是文件');
        } catch (error) { issues.push({ code: 'ASSET_UNAVAILABLE', field, severity: 'error', message: `${field}: ${error instanceof Error ? error.message : String(error)}` }); }
      }
      if (values.outputName && !isSafeOutputName(String(values.outputName))) issues.push({ code: 'UNSAFE_OUTPUT_NAME', field: 'outputName', severity: 'error', message: '输出文件名必须是单个文件名，不能包含目录、保留设备名或非法字符' });
      const id = `task-${createHash('sha256').update(`${absoluteWorkbook}\0${sheet.name}\0${rowNumber}`).digest('hex').slice(0, 16)}`;
      if (!values.outputName) {
        values.outputName = id;
        issues.push({ code: 'DEFAULT_OUTPUT_NAME', field: 'outputName', severity: 'warning', message: `未指定文件命名，使用任务编号 ${id}` });
      }
      tasks.push({ ...values, id, source: { workbook: absoluteWorkbook, sheet: sheet.name, row: rowNumber }, status: issues.some(issue => issue.severity === 'error') ? 'needs_input' : 'ready', issues } as DesignTask);
    }
  }
  if (!tasks.length) throw new Error('未识别到设计需求行');
  return tasks;
}
