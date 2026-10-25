import { accessSync, constants, existsSync, renameSync, unlinkSync } from 'fs';
import { basename, dirname, join } from 'path';
import * as XLSX from 'xlsx';
import { columnKey, LinkKind } from './generate-prompt';

export interface GenerateRow {
  /** 1-based sheet row number (the header row is row 1). */
  rowIndex: number;
  title: string;
  /** The Prompt Template cell. The CLI fills its placeholders before the run, so the output shows the prompt as sent. */
  prompt: string;
  links: Record<LinkKind, string>;
  /** The other columns' cells, in the order of GenerateWorkbook.extraColumns. */
  extra: string[];
  /** Generated Content: empty until an article has been written for the row. */
  content: string;
}

type Field = 'title' | 'prompt' | LinkKind | 'content';

/** Header -> field, ignoring case, spaces and underscores, so a Supabase export ("Prompt_Template", "Custom_Link") loads too. */
const FIELDS: Record<string, Field> = {
  'report title': 'title',
  'prompt template': 'prompt',
  'sample download link': 'sample',
  'discount link': 'discount',
  'customization link': 'customization',
  'customisation link': 'customization',
  'custom link': 'customization',
  'generated content': 'content',
};

/** The workflow's output columns. Other input columns go between the links and Generated Content. */
const OUTPUT_HEADERS = ['Report Title', 'Prompt Template', 'Sample Download Link', 'Discount Link', 'Customization Link'];
const CONTENT_HEADER = 'Generated Content';

const normalizeHeader = (header: string) => header.trim().toLowerCase().replace(/[\s_]+/g, ' ');

/**
 * Input records in, output records out. The input needs Report Title and Prompt Template columns; the
 * output has the workflow's output columns and is rewritten after every article. A workbook that already
 * has a Generated Content column is an earlier output: it is continued in place, and only its rows
 * without content still need an article.
 */
export class GenerateWorkbook {
  readonly rows: GenerateRow[] = [];
  /** Headers of the input's other columns, in sheet order. */
  readonly extraColumns: string[];
  /** True when the workbook already has a Generated Content column. */
  readonly isOutput: boolean;
  private outputPath: string | null = null;

  private constructor(filePath: string, aoa: string[][]) {
    const header = aoa[0] || [];
    const fieldColumns = new Map<Field, number>();
    const extraColumns: number[] = [];
    header.forEach((text, col) => {
      const field = FIELDS[normalizeHeader(text)];
      if (field && !fieldColumns.has(field)) fieldColumns.set(field, col);
      else if (text.trim()) extraColumns.push(col);
    });
    if (!fieldColumns.has('title') || !fieldColumns.has('prompt')) {
      throw new Error(`The first sheet needs 'Report Title' and 'Prompt Template' header columns: ${filePath}`);
    }

    this.isOutput = fieldColumns.has('content');
    this.extraColumns = extraColumns.map(col => header[col].trim());

    for (let i = 1; i < aoa.length; i++) {
      const cells = aoa[i];
      if (cells.every(cell => cell.trim().length === 0)) continue;
      const get = (field: Field) => {
        const col = fieldColumns.get(field);
        return col === undefined ? '' : (cells[col] || '').trim();
      };
      this.rows.push({
        rowIndex: i + 1,
        title: get('title'),
        prompt: get('prompt'),
        links: { sample: get('sample'), discount: get('discount'), customization: get('customization') },
        extra: extraColumns.map(col => (cells[col] || '').trim()),
        content: get('content'),
      });
    }
  }

  static load(filePath: string): GenerateWorkbook {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error(`Workbook has no sheets: ${filePath}`);
    // raw: false reads cells as Excel shows them, so "7.8%" goes into a template as 7.8%, not 0.078.
    const raw = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false });
    const aoa = raw.map(row => row.map(cell => String(cell ?? '')));
    return new GenerateWorkbook(filePath, aoa);
  }

  /** Rows that still need an article. */
  get pendingRows(): GenerateRow[] {
    return this.rows.filter(row => row.content.length === 0);
  }

  /** What the row's template can use as {{name}}: its links and other columns, by columnKey(header). Blank cells are left out. */
  templateValues(row: GenerateRow): Record<string, string> {
    const values: Record<string, string> = {};
    const add = (header: string, value: string) => {
      const key = columnKey(header);
      if (key && value && !(key in values)) values[key] = value;
    };
    add('Report Title', row.title);
    add('Sample Download Link', row.links.sample);
    add('Discount Link', row.links.discount);
    add('Customization Link', row.links.customization);
    this.extraColumns.forEach((header, i) => add(header, row.extra[i]));
    return values;
  }

  /** Chooses the output file and writes it now, so a locked or read-only file fails before any model call. */
  writeTo(filePath: string): void {
    this.outputPath = filePath;
    this.save();
  }

  /** Records a row's article and rewrites the output file immediately (crash-safe). */
  markGenerated(row: GenerateRow, content: string): void {
    row.content = content;
    this.save();
  }

  /**
   * Writes to a temp file next to the output and renames it over the original, so a crash mid-write
   * cannot leave a half-written file. A read-only or locked output throws before anything is changed.
   */
  private save(): void {
    const target = this.outputPath;
    if (!target) throw new Error('Choose the output file with writeTo() first');

    const aoa = [
      [...OUTPUT_HEADERS, ...this.extraColumns, CONTENT_HEADER],
      ...this.rows.map(row => [
        row.title,
        row.prompt,
        row.links.sample,
        row.links.discount,
        row.links.customization,
        ...row.extra,
        row.content,
      ]),
    ];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet['!cols'] = aoa[0].map((_, col) => {
      const longest = aoa.reduce((max, cells) => Math.max(max, String(cells[col] ?? '').length), 0);
      return { wch: Math.min(70, Math.max(12, longest + 2)) };
    });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');

    accessSync(existsSync(target) ? target : dirname(target), constants.W_OK);
    const temp = join(dirname(target), `.~${basename(target)}`);
    try {
      // Shared strings, as Excel itself (and the workflow's output records) store text.
      XLSX.writeFile(workbook, temp, { bookSST: true });
      renameSync(temp, target);
    } catch (err) {
      try {
        unlinkSync(temp);
      } catch {
        // nothing to clean up
      }
      throw err;
    }
  }
}

export function loadGenerateWorkbook(filePath: string): GenerateWorkbook {
  return GenerateWorkbook.load(filePath);
}
