import { CLI_VERSION } from './release';

export const COMMENT_MARKER = '<!-- openapi-radar:report -->';
export const MAX_COMMENTED_CHANGES = 35;

const NO_CHANGES_MESSAGE = 'No changes found between specifications';

export interface ReportChange {
  breaking: boolean;
  change?: number;
  changeHash?: string;
  changeText?: string;
  kind?: string;
  new?: string;
  newEncoded?: string;
  original?: string;
  originalEncoded?: string;
  path?: string;
  property?: string;
  rawPath?: string;
  reference?: string;
  type?: string;
}

export interface ParsedChangeReport {
  changes: ReportChange[];
  totalChanges: number;
  breakingCount: number;
}

export interface RenderedReport extends ParsedChangeReport {
  markdown: string;
  breakingChanges: ReportChange[];
}

interface SummaryCounts {
  totalChanges: number;
  breakingChanges: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function getOptionalString(change: Record<string, unknown>, key: string): string | undefined {
  const value = change[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('openapi-changes returned an invalid change field: ' + key + '.');
  return value;
}

function parseChange(value: unknown, index: number): ReportChange {
  if (!isRecord(value)) throw new Error('openapi-changes returned a malformed change at index ' + index + '.');
  if (typeof value.breaking !== 'boolean') {
    throw new Error('openapi-changes returned a change without a boolean breaking flag at index ' + index + '.');
  }
  if (value.change !== undefined && (!Number.isSafeInteger(value.change) || (value.change as number) < 0)) {
    throw new Error('openapi-changes returned an invalid numeric change type at index ' + index + '.');
  }

  return {
    breaking: value.breaking,
    change: value.change as number | undefined,
    changeHash: getOptionalString(value, 'changeHash'),
    changeText: getOptionalString(value, 'changeText'),
    kind: getOptionalString(value, 'kind'),
    new: getOptionalString(value, 'new'),
    newEncoded: getOptionalString(value, 'newEncoded'),
    original: getOptionalString(value, 'original'),
    originalEncoded: getOptionalString(value, 'originalEncoded'),
    path: getOptionalString(value, 'path'),
    property: getOptionalString(value, 'property'),
    rawPath: getOptionalString(value, 'rawPath'),
    reference: getOptionalString(value, 'reference'),
    type: getOptionalString(value, 'type')
  };
}

function parseSummary(value: unknown): SummaryCounts {
  if (!isRecord(value)) throw new Error('openapi-changes returned a report without a valid reportSummary object.');
  const sections = Object.entries(value);
  if (sections.length === 0) {
    throw new Error('openapi-changes returned a report with an empty reportSummary object.');
  }

  let totalChanges = 0;
  let breakingChanges = 0;
  for (const [section, rawCounts] of sections) {
    if (!isRecord(rawCounts) || !isCount(rawCounts.totalChanges) || !isCount(rawCounts.breakingChanges)) {
      throw new Error('openapi-changes returned malformed summary counts for ' + section + '.');
    }
    if (rawCounts.breakingChanges > rawCounts.totalChanges) {
      throw new Error('openapi-changes returned more breaking than total changes for ' + section + '.');
    }
    totalChanges += rawCounts.totalChanges;
    breakingChanges += rawCounts.breakingChanges;
    if (!Number.isSafeInteger(totalChanges) || !Number.isSafeInteger(breakingChanges)) {
      throw new Error('openapi-changes returned summary counts outside the safe integer range.');
    }
  }
  return { totalChanges, breakingChanges };
}

/** Validate the pinned CLI's JSON shape and ensure its summary matches the detail list. */
export function parseChangeReport(text: string): ParsedChangeReport {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw new Error('openapi-changes returned invalid JSON; check the runner log for parser diagnostics.');
  }

  if (isRecord(decoded) && Object.keys(decoded).length === 1 && decoded.message === NO_CHANGES_MESSAGE) {
    return { changes: [], totalChanges: 0, breakingCount: 0 };
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.changes)) {
    throw new Error('openapi-changes returned a report without a changes array.');
  }

  const changes = decoded.changes.map((change, index) => parseChange(change, index));
  const summary = parseSummary(decoded.reportSummary);
  const breakingCount = changes.filter((change) => change.breaking).length;
  if (summary.totalChanges !== changes.length || summary.breakingChanges !== breakingCount) {
    throw new Error('openapi-changes report summary counts do not match the detailed change list.');
  }
  return { changes, totalChanges: changes.length, breakingCount };
}

function concise(value: string | undefined, maxLength = 180): string {
  let text = (value || 'unspecified').replace(/\s+/g, ' ').trim();
  if (!text) text = 'unspecified';
  if (text.length > maxLength) text = text.slice(0, maxLength - 1) + '…';
  return text;
}

function inlineCode(value: string): string {
  const runs = value.match(/`+/g) || [];
  let longestRun = 0;
  for (const run of runs) longestRun = Math.max(longestRun, run.length);
  const fence = '`'.repeat(longestRun + 1);
  return fence + ' ' + value + ' ' + fence;
}

function migrationHint(change: ReportChange): string {
  const details = [change.path, change.rawPath, change.type, change.property, change.kind, change.changeText]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (details.includes('required')) {
    return 'Keep the field optional or update every affected client to send it before merging.';
  }
  if (details.includes('path') && (details.includes('removed') || details.includes('deleted'))) {
    return 'Keep the existing endpoint during migration, or provide a versioned replacement and a deprecation window.';
  }
  if (details.includes('response')) {
    return 'Preserve the previous response shape or status, or update and release affected clients before removing it.';
  }
  if (details.includes('type') || details.includes('schema')) {
    return 'Keep a compatible schema during transition, or regenerate and release every client that depends on this type.';
  }
  if (details.includes('removed') || details.includes('delete')) {
    return 'Restore the removed element or migrate its consumers before merging the contract change.';
  }
  return 'Update affected clients to handle this contract change, or keep a compatibility path until they have migrated.';
}

/** Render an already validated report using safe inline-code boundaries for untrusted spec text. */
export function renderChangeReport(
  report: ParsedChangeReport,
  specPath: string,
  baseSha: string,
  headSha: string
): RenderedReport {
  const breakingChanges = report.changes.filter((change) => change.breaking);
  let markdown = COMMENT_MARKER;
  markdown += '\n## OpenAPI compatibility report\n\n';
  markdown += '**Spec:** ' + inlineCode(concise(specPath, 240)) + '  \n';
  markdown += '**Compared:** ' + inlineCode(concise(baseSha.slice(0, 7))) + ' → ' + inlineCode(concise(headSha.slice(0, 7))) + '  \n';
  markdown += '**Changes:** ' + String(report.totalChanges) + ' total, ' + String(report.breakingCount) + ' breaking\n\n';

  if (report.breakingCount === 0) {
    markdown += '✅ No breaking changes were reported.';
    if (report.totalChanges > 0) markdown += ' The detected changes appear backward-compatible.';
  } else {
    markdown += '### Breaking changes\n\n';
    const shown = breakingChanges.slice(0, MAX_COMMENTED_CHANGES);
    shown.forEach((change, index) => {
      const label = concise(change.path || change.rawPath || change.property || change.type, 240);
      const kind = [change.type, change.kind, change.changeText, change.property]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map((value) => inlineCode(concise(value, 100)))
        .join(' · ');
      markdown += String(index + 1) + '. ' + inlineCode(label);
      if (kind) markdown += ' — ' + kind;
      if (change.original !== undefined || change.new !== undefined) {
        markdown += ' (' + inlineCode(concise(change.original)) + ' → ' + inlineCode(concise(change.new)) + ')';
      }
      markdown += '\n   - Migration: ' + migrationHint(change) + '\n';
    });
    if (report.breakingCount > shown.length) {
      markdown += '\n_' + String(report.breakingCount - shown.length) + ' additional breaking changes are omitted from this concise report._\n';
    }
  }
  markdown += '\n\nGenerated by OpenAPI Radar with openapi-changes ' + CLI_VERSION + '.';
  return { ...report, markdown, breakingChanges };
}

/** Return a safe format-specific extension for a repository-relative spec path. */
export function specExtension(filePath: string): string {
  const match = /(?:^|\/)[^/]+(\.[^./]+)$/.exec(filePath);
  return match?.[1] || '.yaml';
}
