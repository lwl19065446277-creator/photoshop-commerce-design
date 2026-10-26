import ExcelJS from 'exceljs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic parser input only. This script intentionally creates no PSD/PSB or product image.
// The two missing asset paths keep the task needs_input until real materials are supplied.
const workspaceRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const target = fileURLToPath(new URL('../examples/generated/requirements.xlsx', import.meta.url));
const examplesDirectory = await realpath(fileURLToPath(new URL('../examples/', import.meta.url)));
const relativeExamples = relative(workspaceRoot, examplesDirectory);
if (isAbsolute(relativeExamples) || relativeExamples === '..' || relativeExamples.startsWith(`..${sep}`)) {
  throw new Error('示例目录必须在项目内；拒绝通过符号链接写入其他目录');
}
await mkdir(dirname(target), { recursive: true });
const targetDirectory = await realpath(dirname(target));
const relativeDirectory = relative(workspaceRoot, targetDirectory);
if (isAbsolute(relativeDirectory) || relativeDirectory === '..' || relativeDirectory.startsWith(`..${sep}`)) {
  throw new Error('示例输出目录必须在项目内；拒绝通过符号链接写入其他目录');
}

const workbook = new ExcelJS.Workbook();
workbook.creator = 'Design Agent Studio';
workbook.description = 'Synthetic requirement sample; missing assets are intentional. Not a production design task.';
const sheet = workbook.addWorksheet('示例需求', { views: [{ state: 'frozen', ySplit: 1 }] });
sheet.columns = [
  { header: '商品图路径', key: 'productImagePath', width: 22 },
  { header: '输出文件名', key: 'outputName', width: 26 },
  { header: '主标题', key: 'title', width: 30 },
  { header: '商品编号', key: 'sku', width: 20 },
  { header: '高度', key: 'height', width: 12 },
  { header: '商品名称', key: 'productName', width: 28 },
  { header: '主标题图层', key: 'titleLayer', width: 22 },
  { header: 'PSD路径', key: 'templatePath', width: 22 },
  { header: '宽度', key: 'width', width: 12 },
  { header: '商品图层', key: 'productLayer', width: 24 },
  { header: '设计要求', key: 'requirements', width: 65 },
];
sheet.addRow({
  productImagePath: './product.png',
  outputName: 'example-only',
  title: '示例主标题（请替换）',
  sku: 'EXAMPLE-001',
  height: 1000,
  productName: '演示商品（非真实业务）',
  titleLayer: '主标题',
  templatePath: './template.psd',
  width: 1000,
  productLayer: '商品智能对象',
  requirements: '仅用于解析测试。图层名称和尺寸均为占位，需用真实 Photoshop 文档核对。',
});
sheet.getRow(1).font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FFFFFFFF' } };
sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF243650' } };
sheet.getRow(1).height = 28;
sheet.getRow(2).height = 44;
sheet.getRow(2).alignment = { vertical: 'middle', wrapText: true };
sheet.getCell('A2').note = '故意缺失的占位素材；脚本不创建图片。请先提供真实材料再运行设计。';
sheet.getCell('H2').note = '故意缺失的占位模板；脚本不生成或伪造 PSD。';
sheet.autoFilter = { from: 'A1', to: 'K2' };

const bytes = await workbook.xlsx.writeBuffer();
try {
  await writeFile(target, Buffer.from(bytes), { flag: 'wx' });
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
    throw new Error(`示例文件已存在，拒绝覆盖：${target}。如需重新生成，请自行保留或移走旧示例。`);
  }
  throw error;
}
process.stdout.write(`已创建真实 .xlsx 示例：${target}\n此文件只有一条合成需求；模板和商品图故意缺失，应解析为 needs_input。未执行 Photoshop。\n`);
