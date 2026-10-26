import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, truncate, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parseWorkbook, type ParseWorkbookOptions } from '../src/tasks/parser.js';
import { planTask } from '../src/tasks/planner.js';
import { checkDesign } from '../src/tasks/checker.js';
import { type DesignTask, type DocumentSnapshot } from '../src/tasks/model.js';

const headers = ['商品名称', 'SKU', '主标题', '副标题', '宽度', '高度', 'PSD路径', '商品图路径', '主标题图层', '副标题图层', '商品图层', '文件命名'];
const row = ['测试商品', '001234', '新品\n上市', '限时优惠', 1000, 1000, 'template.psd', 'product.png', '标题', '副标题', '商品', 'test-output'];
async function withWorkbook(fn: (file: string, workbook: ExcelJS.Workbook, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-xlsx-test-'));
  const workbook = new ExcelJS.Workbook();
  const file = path.join(directory, 'requirements.xlsx');
  try { await fn(file, workbook, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const parsing: ParseWorkbookOptions = { checkFiles: false, assetBindings: { templatePath: './template.psd', productImagePath: './product.png' } };

test('real xlsx: aliases, arbitrary column order, title exactness and row provenance', async () => {
  await withWorkbook(async (file, workbook, directory) => {
    const sheet = workbook.addWorksheet('电商需求');
    sheet.addRow(['活动需求表']);
    const order = [7, 10, 2, 0, 8, 5, 6, 4, 1, 11, 3, 9];
    sheet.addRow(order.map(index => headers[index]));
    sheet.addRow(order.map(index => row[index]));
    sheet.addRow([]);
    sheet.addRow(order.map(index => index === 1 ? '009999' : row[index]));
    await workbook.xlsx.writeFile(file);
    const tasks = await parseWorkbook(file, parsing);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]!.status, 'ready');
    assert.equal(tasks[0]!.title, '新品\n上市');
    assert.equal(tasks[0]!.sku, '001234');
    assert.equal(tasks[0]!.source.row, 3);
    assert.equal(tasks[0]!.source.sheet, '电商需求');
    assert.equal(tasks[0]!.productImagePath, path.join(directory, 'product.png'));
    assert.notEqual(tasks[0]!.id, tasks[1]!.id);
  });
});

test('missing assets and explicit layer mapping block execution without invented data', async () => {
  await withWorkbook(async (file, workbook) => {
    const sheet = workbook.addWorksheet('需求');
    sheet.addRow(headers);
    const incomplete = [...row]; incomplete[8] = '';
    sheet.addRow(incomplete);
    await workbook.xlsx.writeFile(file);
    const [task] = await parseWorkbook(file, { assetBindings: parsing.assetBindings });
    assert.equal(task!.status, 'needs_input');
    assert.equal(task!.titleLayer, undefined);
    assert.ok(task!.issues.some(issue => issue.code === 'ASSET_UNAVAILABLE'));
    assert.ok(task!.issues.some(issue => issue.field === 'titleLayer'));
    assert.throws(() => planTask(task!, snapshot()), /缺失|歧义/);
  });
});

test('cached formula results cannot become titles, paths or layout instructions', async () => {
  await withWorkbook(async (file, workbook) => {
    const sheet = workbook.addWorksheet('需求');
    sheet.addRow([...headers, '等比缩放']);
    sheet.addRow([...row, { formula: '50+50', result: 100 }]);
    sheet.getCell('C2').value = { formula: '"不执行"', result: '不执行' };
    sheet.getCell('G2').value = { formula: '"template.psd"', result: 'template.psd' };
    await workbook.xlsx.writeFile(file);
    const [task] = await parseWorkbook(file, parsing);
    assert.equal(task!.status, 'needs_input');
    assert.equal(task!.title, undefined);
    assert.equal(task!.templatePath, path.join(path.dirname(file), 'template.psd'));
    assert.equal(task!.layout, undefined);
    assert.equal(task!.issues.filter(issue => issue.code === 'INVALID_CELL').length, 2);
    assert.ok(task!.issues.some(issue => issue.code === 'WORKBOOK_PATH_IGNORED' && issue.field === 'templatePath'));
  });
});

test('ambiguous alias columns require explicit configuration', async () => {
  await withWorkbook(async (file, workbook) => {
    const sheet = workbook.addWorksheet('需求');
    sheet.addRow([...headers, 'headline']);
    sheet.addRow([...row, '另一版文案']);
    await workbook.xlsx.writeFile(file);
    const [ambiguous] = await parseWorkbook(file, parsing);
    assert.equal(ambiguous!.status, 'needs_input');
    assert.ok(ambiguous!.issues.some(issue => issue.code === 'AMBIGUOUS_HEADER'));
    const [resolved] = await parseWorkbook(file, { ...parsing, mapping: { title: 'headline' } });
    assert.equal(resolved!.status, 'ready');
    assert.equal(resolved!.title, '另一版文案');
  });
});

test('combined dimensions and Excel percentage formats parse; conflicting sizes block', async () => {
  await withWorkbook(async (file, workbook) => {
    const sheet = workbook.addWorksheet('需求');
    sheet.addRow([...headers, '尺寸', '等比缩放']);
    const combined = [...row]; combined[4] = ''; combined[5] = '';
    sheet.addRow([...combined, '1000 × 1000 px', 1.25]);
    sheet.getCell('N2').numFmt = '0%';
    sheet.addRow([...row, '800x800', '125%']);
    await workbook.xlsx.writeFile(file);
    const [ready, conflict] = await parseWorkbook(file, parsing);
    assert.equal(ready!.status, 'ready');
    assert.equal(ready!.width, 1000);
    assert.equal(ready!.layout!.scalePercent, 125);
    assert.equal(conflict!.status, 'needs_input');
    assert.ok(conflict!.issues.some(issue => issue.code === 'CONFLICTING_SIZE'));
  });
});

test('unsafe output paths and remote assets never become executable task paths', async () => {
  await withWorkbook(async (file, workbook) => {
    const sheet = workbook.addWorksheet('需求'); sheet.addRow(headers);
    const unsafe = [...row]; unsafe[7] = 'https://example.org/product.png'; unsafe[11] = '../overwrite';
    sheet.addRow(unsafe);
    await workbook.xlsx.writeFile(file);
    const [task] = await parseWorkbook(file, parsing);
    assert.equal(task!.status, 'needs_input');
    assert.ok(task!.issues.some(issue => issue.code === 'WORKBOOK_PATH_IGNORED' && issue.field === 'productImagePath'));
    assert.ok(task!.issues.some(issue => issue.code === 'UNSAFE_OUTPUT_NAME'));
  });
});

test('PSB templates and JPG product assets parse without modifying the source workbook', async () => {
  await withWorkbook(async (file, workbook, directory) => {
    const sheet = workbook.addWorksheet('需求');
    const sourceHeaders = [...headers]; sourceHeaders[6] = 'PSB路径';
    sheet.addRow(sourceHeaders);
    const psb = [...row]; psb[6] = '原始模板.PSB'; psb[7] = '商品正面.JPG';
    sheet.addRow(psb);
    await workbook.xlsx.writeFile(file);
    const before = await readFile(file);
    const [task] = await parseWorkbook(file, { ...parsing, assetBindings: { templatePath: './原始模板.PSB', productImagePath: './商品正面.JPG' } });
    assert.equal(task!.status, 'ready');
    assert.equal(task!.templatePath, path.join(directory, '原始模板.PSB'));
    assert.equal(task!.productImagePath, path.join(directory, '商品正面.JPG'));
    assert.equal(workbook.getWorksheet('需求')!.getCell('G2').value, '原始模板.PSB');
    assert.deepEqual(await readFile(file), before);
    assert.equal(planTask(task!, snapshot()).steps[2]!.args.path, path.join(directory, '商品正面.JPG'));
  });
});

test('unsupported product replacement formats block while text normalizes only line endings', async () => {
  await withWorkbook(async (file, workbook) => {
    const sheet = workbook.addWorksheet('需求'); sheet.addRow(headers);
    const unsupported = [...row]; unsupported[2] = ' 新品\r\n上市\r '; unsupported[7] = 'product.psb';
    sheet.addRow(unsupported);
    await workbook.xlsx.writeFile(file);
    const [task] = await parseWorkbook(file, { ...parsing, assetBindings: { ...parsing.assetBindings, productImagePath: './product.psb' } });
    assert.equal(task!.status, 'needs_input');
    assert.equal(task!.title, ' 新品\n上市\n ');
    assert.ok(task!.issues.some(issue => issue.field === 'productImagePath' && issue.code === 'ASSET_UNAVAILABLE'));
  });
});

test('workbook asset paths are always ignored, including formulas and duplicate path columns', async () => {
  await withWorkbook(async (file, workbook, directory) => {
    const sheet = workbook.addWorksheet('需求');
    sheet.addRow([...headers, 'PSB路径', '参考图路径']);
    const unsafe = [...row];
    unsafe[6] = 'C:/outside-allowed-root/never-read.psd';
    unsafe[7] = 'https://untrusted.invalid/never-download.jpg';
    sheet.addRow([...unsafe, { formula: '"D:/never-read.psb"', result: 'D:/never-read.psb' }, '\u0000not-a-file.png']);
    await workbook.xlsx.writeFile(file);
    // Presence-only parser fixtures; these are not valid Photoshop files and no PS call occurs.
    const trustedTemplate = path.join(directory, 'bound-template.psb');
    const trustedProduct = path.join(directory, 'bound-product.jpg');
    const trustedReference = path.join(directory, 'bound-reference.jpg');
    await Promise.all([trustedTemplate, trustedProduct, trustedReference].map(value => writeFile(value, 'parser presence fixture only')));
    const [task] = await parseWorkbook(file, {
      defaults: { templatePath: 'C:/outside-allowed-root/default-never-read.psd' },
      assetBindings: { templatePath: trustedTemplate, productImagePath: trustedProduct, referencePath: trustedReference },
    });
    assert.equal(task!.status, 'ready');
    assert.equal(task!.templatePath, trustedTemplate);
    assert.equal(task!.productImagePath, trustedProduct);
    assert.equal(task!.referencePath, trustedReference);
    const ignored = task!.issues.filter(issue => issue.code === 'WORKBOOK_PATH_IGNORED');
    assert.equal(ignored.length, 3);
    assert.deepEqual(new Set(ignored.map(issue => issue.field)), new Set(['templatePath', 'productImagePath', 'referencePath']));
    assert.equal(task!.issues.some(issue => issue.code === 'INVALID_CELL' || issue.code === 'AMBIGUOUS_HEADER' || issue.code === 'ASSET_UNAVAILABLE'), false);
    assert.equal(JSON.stringify(task).includes('outside-allowed-root'), false);
    assert.equal(JSON.stringify(task).includes('untrusted.invalid'), false);
  });
});

test('sheet paths cannot make a task executable without trusted bindings', async () => {
  await withWorkbook(async (file, workbook) => {
    const sheet = workbook.addWorksheet('需求'); sheet.addRow(headers); sheet.addRow(row);
    await workbook.xlsx.writeFile(file);
    const [task] = await parseWorkbook(file, { checkFiles: false });
    assert.equal(task!.status, 'needs_input');
    assert.equal(task!.templatePath, undefined);
    assert.equal(task!.productImagePath, undefined);
    assert.ok(task!.issues.some(issue => issue.code === 'MISSING_REQUIRED' && issue.field === 'templatePath'));
    assert.ok(task!.issues.some(issue => issue.code === 'MISSING_REQUIRED' && issue.field === 'productImagePath'));
  });
});

test('path-only rows do not become tasks even when trusted bindings and defaults exist', async () => {
  await withWorkbook(async (file, workbook) => {
    const sheet = workbook.addWorksheet('需求');
    sheet.addRow(['PSD路径', '商品图路径']); sheet.addRow(['never-read.psd', 'never-read.jpg']);
    await workbook.xlsx.writeFile(file);
    await assert.rejects(parseWorkbook(file, { ...parsing, defaults: { productName: '默认商品', title: '默认文案' } }), /未识别到设计需求行/);
  });
});

test('large workbook rejected before workbook decompression', async () => {
  await withWorkbook(async (file) => {
    await writeFile(file, 'oversize-fixture');
    await truncate(file, 26 * 1024 * 1024);
    await assert.rejects(parseWorkbook(file), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'XLSX_TOO_LARGE');
  });
});

function task(): DesignTask {
  return {
    id: 'fixture-task', source: { workbook: 'fixture.xlsx', sheet: '需求', row: 2 }, status: 'ready', issues: [],
    productName: '测试商品', title: '新品上市', subtitle: '优惠', width: 1000, height: 1000,
    templatePath: 'fixture.psd', productImagePath: 'fixture.png', titleLayer: '标题', subtitleLayer: '副标题', productLayer: '商品',
  };
}
function snapshot(): DocumentSnapshot {
  return {
    id: 7, width: 1000, height: 1000, layers: [
      { id: 1, name: '标题', kind: 'text', visible: true, text: '新品上市', bounds: { left: 10, top: 10, right: 200, bottom: 80 } },
      { id: 2, name: '副标题', kind: 'text', visible: true, text: '优惠', bounds: { left: 10, top: 100, right: 200, bottom: 180 } },
      { id: 3, name: '商品', kind: 'smartObject', visible: true, bounds: { left: 100, top: 200, right: 900, bottom: 950 } },
    ],
  };
}

test('planner chooses actual IDs and only explicit uniform transformations', () => {
  const requirement = task(); requirement.layout = { translateX: 5, translateY: -20, scalePercent: 90 };
  const plan = planTask(requirement, snapshot());
  assert.equal(plan.planner, 'deterministic-template-v1');
  assert.deepEqual(plan.steps.map(step => step.operation), ['set_text', 'set_text', 'replace_smart_object', 'transform_layer']);
  assert.equal(plan.steps[0]!.args.layerId, 1);
  assert.equal(plan.steps[2]!.args.layerId, 3);
  assert.equal(plan.steps[2]!.args.path, 'fixture.png');
  assert.deepEqual(plan.steps[3]!.args, { documentId: 7, layerId: 3, translateX: 5, translateY: -20, scalePercent: 90 });
  assert.ok(plan.humanReview.length > 0);
});

test('planner rejects duplicate nested names, wrong types and different canvas dimensions', () => {
  const duplicate = snapshot();
  duplicate.layers.push({ id: 4, name: '组', kind: 'group', visible: true, children: [{ ...duplicate.layers[0]!, id: 5 }] });
  assert.throws(() => planTask(task(), duplicate), /不唯一/);
  const wrongType = snapshot(); wrongType.layers[2]!.kind = 'pixel';
  assert.throws(() => planTask(task(), wrongType), /需要 smartObject/);
  assert.throws(() => planTask(task(), { ...snapshot(), width: 800 }), /不一致/);
});

test('checker detects exact text mismatch, inherited hidden state and off-canvas bounds', () => {
  const document = snapshot();
  const title = document.layers.shift()!; title.text = '旧文案'; title.bounds!.right = 1100;
  document.layers.push({ id: 4, name: '隐藏组', kind: 'group', visible: false, children: [title] });
  const report = checkDesign(task(), document);
  assert.equal(report.structuralPass, false);
  assert.ok(report.checks.some(check => check.code === 'TEXT_CONTENT' && check.status === 'fail'));
  assert.ok(report.checks.some(check => check.code === 'LAYER_VISIBLE' && check.layerId === 1 && check.status === 'fail'));
  assert.ok(report.checks.some(check => check.code === 'LAYER_BOUNDS' && check.layerId === 1 && check.status === 'fail'));
  assert.equal(report.correctionSuggestions[0]!.args.text, '新品上市');
});

test('successful structural checks still require product identity and visual review', () => {
  const report = checkDesign(task(), snapshot());
  assert.equal(report.structuralPass, true);
  assert.equal(report.requiresHumanReview, true);
  assert.ok(report.checks.some(check => check.code === 'VISUAL_REVIEW' && check.status === 'manual'));
});

test('checker treats CR/CRLF and LF as equivalent while preserving exact non-newline text', () => {
  const requirement = task(); requirement.title = '新品\r\n上市';
  const document = snapshot(); document.layers[0]!.text = '新品\n上市';
  assert.equal(checkDesign(requirement, document).structuralPass, true);
  document.layers[0]!.text = '新品 \n上市';
  assert.equal(checkDesign(requirement, document).structuralPass, false);
});
