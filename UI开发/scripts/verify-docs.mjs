#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const uiDir = dirname(scriptDir);
const errors = [];

const expectedDocs = [
  'README.md',
  '00-产品目标范围与完成定义.md',
  '01-技术基线与上游锁定.md',
  '02-总体架构与进程边界.md',
  '03-全量功能清单.md',
  '04-工程骨架与公共合同.md',
  '05-Electron主进程与安全外壳.md',
  '06-Harness运行时管理.md',
  '07-Bridge传输与官方客户端兼容层.md',
  '08-Workspace与Session领域模块.md',
  '09-Conversation投影模块.md',
  '10-Vue状态与应用外壳.md',
  '11-Conversation与Composer界面.md',
  '12-工具卡审批问题Subagent与Goal.md',
  '13-设置凭据设计系统与GSAP.md',
  '14-安全可观测性与故障恢复.md',
  '15-测试性能与质量门禁.md',
  '16-打包更新迁移与回滚.md',
  '17-开发阶段任务与里程碑.md',
  '18-功能追踪矩阵.md',
  '19-编码提交与文档维护规范.md',
  '20-风险登记与ADR索引.md',
];

const featureRanges = [
  ['PRD', 1, 18, '00-产品目标范围与完成定义.md'],
  ['BASE', 1, 16, '01-技术基线与上游锁定.md'],
  ['ARCH', 1, 18, '02-总体架构与进程边界.md'],
  ['ENG', 1, 18, '04-工程骨架与公共合同.md'],
  ['ELM', 1, 12, '05-Electron主进程与安全外壳.md'],
  ['HRS', 1, 11, '06-Harness运行时管理.md'],
  ['BRG', 1, 18, '07-Bridge传输与官方客户端兼容层.md'],
  ['WS', 1, 7, '08-Workspace与Session领域模块.md'],
  ['SES', 1, 11, '08-Workspace与Session领域模块.md'],
  ['CP', 1, 11, '09-Conversation投影模块.md'],
  ['VUE', 1, 11, '10-Vue状态与应用外壳.md'],
  ['CONV', 1, 9, '11-Conversation与Composer界面.md'],
  ['COMP', 1, 10, '11-Conversation与Composer界面.md'],
  ['TOOL', 1, 7, '12-工具卡审批问题Subagent与Goal.md'],
  ['INT', 1, 4, '12-工具卡审批问题Subagent与Goal.md'],
  ['SUB', 1, 5, '12-工具卡审批问题Subagent与Goal.md'],
  ['GOAL', 1, 4, '12-工具卡审批问题Subagent与Goal.md'],
  ['SET', 1, 6, '13-设置凭据设计系统与GSAP.md'],
  ['CRED', 1, 4, '13-设置凭据设计系统与GSAP.md'],
  ['DS', 1, 5, '13-设置凭据设计系统与GSAP.md'],
  ['GSAP', 1, 5, '13-设置凭据设计系统与GSAP.md'],
  ['I18N', 1, 3, '13-设置凭据设计系统与GSAP.md'],
  ['A11Y', 1, 4, '13-设置凭据设计系统与GSAP.md'],
  ['SEC', 1, 7, '14-安全可观测性与故障恢复.md'],
  ['OBS', 1, 5, '14-安全可观测性与故障恢复.md'],
  ['REC', 1, 6, '14-安全可观测性与故障恢复.md'],
  ['TEST', 1, 14, '15-测试性能与质量门禁.md'],
  ['PERF', 1, 7, '15-测试性能与质量门禁.md'],
  ['PKG', 1, 5, '16-打包更新迁移与回滚.md'],
  ['UPD', 1, 11, '16-打包更新迁移与回滚.md'],
  ['DOC', 1, 8, 'README.md'],
];

const detailedHeadingCounts = new Map([
  ['05-Electron主进程与安全外壳.md', 12],
  ['06-Harness运行时管理.md', 11],
  ['07-Bridge传输与官方客户端兼容层.md', 18],
  ['08-Workspace与Session领域模块.md', 18],
  ['09-Conversation投影模块.md', 11],
  ['10-Vue状态与应用外壳.md', 11],
  ['11-Conversation与Composer界面.md', 19],
  ['12-工具卡审批问题Subagent与Goal.md', 20],
  ['13-设置凭据设计系统与GSAP.md', 27],
  ['14-安全可观测性与故障恢复.md', 18],
  ['15-测试性能与质量门禁.md', 21],
  ['16-打包更新迁移与回滚.md', 16],
]);

function fail(message) {
  errors.push(message);
}

function read(name) {
  const path = join(uiDir, name);
  if (!existsSync(path)) {
    fail(`缺少文档：${name}`);
    return '';
  }
  return readFileSync(path, 'utf8');
}

function featureId(prefix, number) {
  return `${prefix}-${String(number).padStart(3, '0')}`;
}

function multisetDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

for (const name of expectedDocs) {
  const path = join(uiDir, name);
  if (!existsSync(path)) {
    fail(`索引要求的文件不存在：${name}`);
    continue;
  }
  if (statSync(path).size < 2_000) {
    fail(`文档内容异常短（< 2000 bytes）：${name}`);
  }
  const text = readFileSync(path, 'utf8');
  if (!text.startsWith('# ')) {
    fail(`文档缺少一级标题：${name}`);
  }
  const fenceCount = (text.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 !== 0) {
    fail(`代码围栏未闭合：${name}（${fenceCount} 个）`);
  }
}

const actualMarkdown = readdirSync(uiDir)
  .filter((name) => name.endsWith('.md'))
  .sort();
const unexpectedNumbered = actualMarkdown.filter(
  (name) => /^\d{2}-/.test(name) && !expectedDocs.includes(name),
);
if (unexpectedNumbered.length > 0) {
  fail(`存在未进入 README 固定序列的编号文档：${unexpectedNumbered.join(', ')}`);
}

const masterText = read('03-全量功能清单.md');
const masterRows = [...masterText.matchAll(
  /^\|\s*`([A-Z][A-Z0-9]*-\d{3})`\s*\|\s*(P[0-3])\s*\|/gm,
)].map((match) => ({ id: match[1], priority: match[2] }));
const masterIds = masterRows.map(({ id }) => id);
const masterSet = new Set(masterIds);
const masterDuplicates = multisetDuplicates(masterIds);
if (masterDuplicates.length > 0) {
  fail(`03 总账存在重复功能 ID：${masterDuplicates.join(', ')}`);
}

const expectedIds = [];
const ownerById = new Map();
for (const [prefix, start, end, owner] of featureRanges) {
  for (let number = start; number <= end; number += 1) {
    const id = featureId(prefix, number);
    expectedIds.push(id);
    ownerById.set(id, owner);
  }
}
const expectedSet = new Set(expectedIds);

const missingFromMaster = expectedIds.filter((id) => !masterSet.has(id));
const unknownInMaster = masterIds.filter((id) => !expectedSet.has(id));
if (missingFromMaster.length > 0) {
  fail(`03 总账缺少基线 ID：${missingFromMaster.join(', ')}`);
}
if (unknownInMaster.length > 0) {
  fail(`03 总账出现未登记 ID：${[...new Set(unknownInMaster)].join(', ')}`);
}
if (masterRows.length !== 280) {
  fail(`03 总账应为 280 项，实际 ${masterRows.length} 项`);
}

const priorities = masterRows.reduce((counts, { priority }) => {
  counts[priority] = (counts[priority] ?? 0) + 1;
  return counts;
}, {});
for (const [priority, expected] of Object.entries({ P0: 134, P1: 125, P2: 21, P3: 0 })) {
  const actual = priorities[priority] ?? 0;
  if (actual !== expected) {
    fail(`优先级 ${priority} 应为 ${expected} 项，实际 ${actual} 项`);
  }
}

const ownerTexts = new Map();
for (const owner of new Set(ownerById.values())) {
  ownerTexts.set(owner, read(owner));
}
for (const id of expectedIds) {
  const owner = ownerById.get(id);
  const ownerText = ownerTexts.get(owner) ?? '';
  const occurrence = new RegExp(`(^|[^A-Z0-9-])${id.replace('-', '\\-')}([^A-Z0-9-]|$)`).test(ownerText);
  if (!occurrence) {
    fail(`责任文档 ${owner} 未展开 ${id}`);
  }
}

for (const [name, expectedCount] of detailedHeadingCounts) {
  const text = read(name);
  const headingIds = [...text.matchAll(/^###\s+([A-Z][A-Z0-9]*-\d{3})[：:]/gm)].map(
    (match) => match[1],
  );
  const duplicates = multisetDuplicates(headingIds);
  if (duplicates.length > 0) {
    fail(`${name} 存在重复功能标题：${duplicates.join(', ')}`);
  }
  if (headingIds.length !== expectedCount) {
    fail(`${name} 应有 ${expectedCount} 个逐功能标题，实际 ${headingIds.length} 个`);
  }
  const unknown = headingIds.filter((id) => !masterSet.has(id));
  if (unknown.length > 0) {
    fail(`${name} 含总账外功能标题：${unknown.join(', ')}`);
  }
  const expectedForOwner = expectedIds.filter((id) => ownerById.get(id) === name);
  const headingSet = new Set(headingIds);
  const missingHeadings = expectedForOwner.filter((id) => !headingSet.has(id));
  const wrongOwnerHeadings = headingIds.filter((id) => ownerById.get(id) !== name);
  if (missingHeadings.length > 0) {
    fail(`${name} 缺少逐功能标题：${missingHeadings.join(', ')}`);
  }
  if (wrongOwnerHeadings.length > 0) {
    fail(`${name} 包含责任归属错误的标题：${wrongOwnerHeadings.join(', ')}`);
  }
}

const matrixText = read('18-功能追踪矩阵.md');
const matrixRows = [...matrixText.matchAll(
  /^\|\s*`([A-Z][A-Z0-9]*-\d{3})\.\.([A-Z][A-Z0-9]*-\d{3})`\s*\|\s*(\d+)\s*\|/gm,
)];
const matrixIds = [];
for (const match of matrixRows) {
  const [, first, last, countText] = match;
  const [firstPrefix, firstNumberText] = first.split('-');
  const [lastPrefix, lastNumberText] = last.split('-');
  if (firstPrefix !== lastPrefix) {
    fail(`18 矩阵区间跨前缀：${first}..${last}`);
    continue;
  }
  const firstNumber = Number(firstNumberText);
  const lastNumber = Number(lastNumberText);
  const declaredCount = Number(countText);
  const actualCount = lastNumber - firstNumber + 1;
  if (actualCount !== declaredCount) {
    fail(`18 矩阵区间数量错误：${first}..${last} 声明 ${declaredCount}，实际 ${actualCount}`);
  }
  for (let number = firstNumber; number <= lastNumber; number += 1) {
    matrixIds.push(featureId(firstPrefix, number));
  }
}
const matrixDuplicates = multisetDuplicates(matrixIds);
if (matrixDuplicates.length > 0) {
  fail(`18 矩阵重复覆盖：${matrixDuplicates.join(', ')}`);
}
const matrixSet = new Set(matrixIds);
const missingFromMatrix = expectedIds.filter((id) => !matrixSet.has(id));
const unknownInMatrix = matrixIds.filter((id) => !expectedSet.has(id));
if (missingFromMatrix.length > 0) {
  fail(`18 矩阵缺少 ID：${missingFromMatrix.join(', ')}`);
}
if (unknownInMatrix.length > 0) {
  fail(`18 矩阵出现未登记 ID：${[...new Set(unknownInMatrix)].join(', ')}`);
}

for (const name of expectedDocs) {
  const text = read(name);
  for (const match of text.matchAll(/`([^`\r\n]+\.md)`/g)) {
    const reference = match[1];
    if (reference.includes('/') || reference.includes('\\') || reference.includes('*')) continue;
    if (!existsSync(join(uiDir, reference))) {
      fail(`${name} 引用了不存在的同目录文档：${reference}`);
    }
  }
}

const readme = read('README.md');
for (const requiredStatement of [
  '所有官方代码位于隔离边界内',
  'Renderer 只消费稳定合同',
  '服务仅限本机托管',
  'GSAP 只属于表现层',
]) {
  if (!readme.includes(requiredStatement)) {
    fail(`README 缺少不可破坏原则：${requiredStatement}`);
  }
}

if (errors.length > 0) {
  console.error(`UI 开发文档验证失败，共 ${errors.length} 项：`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('UI 开发文档验证通过');
  console.log(`- 文档：${expectedDocs.length} 份（README + 00..20）`);
  console.log(`- 功能：${masterRows.length} 项（P0 ${priorities.P0} / P1 ${priorities.P1} / P2 ${priorities.P2}）`);
  console.log(`- 矩阵：${matrixRows.length} 个闭区间，展开 ${matrixIds.length} 项`);
  console.log(`- 逐功能规格：${[...detailedHeadingCounts.values()].reduce((a, b) => a + b, 0)} 个标题`);
  console.log('- 文件、ID、责任、链接、围栏和架构原则检查均通过');
}
